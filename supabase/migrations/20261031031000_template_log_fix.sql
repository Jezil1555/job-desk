-- Fix for 20261031030000: the person can't write to the activity log directly (only system functions can),
-- so recording "created from template" goes through a small checked helper.
insert into private.migration_snapshots (migration, object, definition) values
  ('20261031031000', 'public.create_project_from_template(uuid,text,date,date)', pg_get_functiondef('public.create_project_from_template(uuid,text,date,date)'::regprocedure))
on conflict do nothing;
create or replace function public.log_template_use(p_project uuid, p_template uuid, p_start date) returns void language plpgsql security definer set search_path = '' as $$
declare p public.projects; t public.project_templates;
begin
  select * into p from public.projects where id = p_project;
  select * into t from public.project_templates where id = p_template;
  if p.id is null or t.id is null or p.workspace_id <> t.workspace_id or not public.can_write_ws(p.workspace_id) then raise exception 'forbidden'; end if;
  insert into public.activity (workspace_id, entity_type, entity_id, actor_id, action, changes)
    values (p.workspace_id, 'project', p.id, (select auth.uid()), 'created_from_template', jsonb_build_object('template', t.name, 'template_id', t.id, 'start', p_start));
end $$;
revoke execute on function public.log_template_use(uuid, uuid, date) from public, anon;
grant execute on function public.log_template_use(uuid, uuid, date) to authenticated;

create or replace function public.create_project_from_template(p_template uuid, p_name text, p_start date, p_target date default null) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare t public.project_templates; v_pid uuid; v_tz text; x jsonb; i int := 0; v_ms uuid[] := '{}'; v_mid uuid; v_max int; v_off int; v_crit jsonb;
begin
  select * into t from public.project_templates where id = p_template and not archived;
  if not found then raise exception 'not_found: template not found'; end if;
  if not public.can_write_ws(t.workspace_id) then raise exception 'forbidden: you can''t add projects to this workspace'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'name_required: name the project'; end if;
  if p_start is null then raise exception 'start_required: choose the start date — task dates are counted from it'; end if;
  select coalesce(timezone, 'Asia/Qatar') into v_tz from public.profiles where id = (select auth.uid());
  v_tz := coalesce(v_tz, 'Asia/Qatar');
  select max(o) into v_max from (select (m->>'offset_days')::int o from jsonb_array_elements(coalesce(t.body->'milestones','[]')) m
                                  union all select (k->>'offset_days')::int from jsonb_array_elements(coalesce(t.body->'tasks','[]')) k) z;
  if p_target is not null and p_target < p_start then raise exception 'bad_dates: the target date is before the start'; end if;
  insert into public.projects (workspace_id, name, description, owner_id, start_date, target_date, created_by)
    values (t.workspace_id, trim(p_name), t.description, (select auth.uid()), p_start, coalesce(p_target, case when v_max is not null and v_max > 0 then p_start + v_max end), (select auth.uid()))
    returning id into v_pid;
  for x in select * from jsonb_array_elements(coalesce(t.body->'milestones','[]')) loop
    insert into public.milestones (project_id, title, planned_date, weight, is_critical, sort)
      values (v_pid, trim(x->>'title'), case when jsonb_typeof(x->'offset_days') = 'number' then p_start + (x->>'offset_days')::int end,
              greatest(coalesce((x->>'weight')::numeric, 1), 0.01), coalesce((x->>'is_critical')::boolean, false), i)
      returning id into v_mid;
    v_ms := v_ms || v_mid; i := i + 1;
  end loop;
  for x in select * from jsonb_array_elements(coalesce(t.body->'fields','[]')) loop
    if not exists (select 1 from public.field_defs where workspace_id = t.workspace_id and key = x->>'key' and not archived) then
      insert into public.field_defs (workspace_id, project_id, key, label, type, options, required, created_by)
        values (t.workspace_id, v_pid, x->>'key', coalesce(nullif(trim(x->>'label'), ''), x->>'key'), x->>'type',
                coalesce((select array_agg(o) from jsonb_array_elements_text(coalesce(x->'options','[]')) o), '{}'), coalesce((x->>'required')::boolean, false), (select auth.uid()));
    end if;
  end loop;
  i := 0;
  for x in select * from jsonb_array_elements(coalesce(t.body->'tasks','[]')) loop
    v_off := case when jsonb_typeof(x->'offset_days') = 'number' then (x->>'offset_days')::int end;
    select coalesce(jsonb_agg(jsonb_build_object('text', c, 'done', false)), '[]'::jsonb) into v_crit from jsonb_array_elements_text(coalesce(x->'criteria','[]')) c where trim(c) <> '';
    insert into public.tasks (workspace_id, project_id, milestone_id, title, description, priority, owner_id, created_by, due_at, due_all_day, completion_criteria, next_action, sort)
      values (t.workspace_id, v_pid, case when jsonb_typeof(x->'milestone') = 'number' then v_ms[(x->>'milestone')::int + 1] end, trim(x->>'title'), nullif(trim(x->>'description'), ''),
              coalesce(x->>'priority', 'medium'), (select auth.uid()), (select auth.uid()),
              case when v_off is not null then ((p_start + v_off)::text || ' 23:59')::timestamp at time zone v_tz end, true, v_crit, nullif(trim(x->>'next_action'), ''), i);
    i := i + 1;
  end loop;
  perform public.log_template_use(v_pid, t.id, p_start);
  return v_pid;
end $$;

