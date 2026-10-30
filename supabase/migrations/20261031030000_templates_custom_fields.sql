-- Increment 9: workspace/project custom fields and project templates on the one shared task engine.
-- Fields are definitions per workspace (optionally limited to one project); values live on the task (tasks.custom) and are checked here.
-- Templates store milestones/tasks/fields with day offsets; instantiating them makes ordinary projects, milestones and tasks, so every task rule applies.

-- ---------------------------------------------------------------- field definitions
create table public.field_defs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label text not null check (char_length(label) between 1 and 60),
  type text not null check (type in ('text','number','date','select','checkbox')),
  options text[] not null default '{}',
  required boolean not null default false,
  sort int not null default 0,
  archived boolean not null default false,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  constraint select_has_options check (type <> 'select' or cardinality(options) between 1 and 50)
);
comment on column public.field_defs.required is 'Must be filled in (checkbox: ticked) before a task can be completed.';
create unique index field_defs_key_active on public.field_defs (workspace_id, key) where not archived;
create index on public.field_defs (workspace_id);
alter table public.field_defs enable row level security;
create policy "field defs: members read" on public.field_defs for select to authenticated using (public.is_ws_member(workspace_id));
create policy "field defs: writers add" on public.field_defs for insert to authenticated with check (public.can_write_ws(workspace_id) and created_by = (select auth.uid()));
create policy "field defs: writers edit" on public.field_defs for update to authenticated using (public.can_write_ws(workspace_id)) with check (public.can_write_ws(workspace_id));

create or replace function public.field_defs_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.project_id is not null and not exists (select 1 from public.projects where id = new.project_id and workspace_id = new.workspace_id) then
    raise exception 'project_wrong_workspace: the project belongs to a different workspace';
  end if;
  if tg_op = 'UPDATE' and (new.key, new.type, new.workspace_id, new.project_id) is distinct from (old.key, old.type, old.workspace_id, old.project_id) then
    raise exception 'field_locked: a field''s key, type and scope can''t change — archive it and add a new one';
  end if;
  new.options := array(select distinct trim(o) from unnest(new.options) o where trim(o) <> '');
  return new;
end $$;
create trigger field_defs_guard before insert or update on public.field_defs for each row execute function public.field_defs_guard();

-- ---------------------------------------------------------------- values on tasks
alter table public.tasks add column custom jsonb not null default '{}'::jsonb;

create or replace function public.tasks_custom_guard() returns trigger language plpgsql set search_path = '' as $$
declare k text; v jsonb; d public.field_defs; v_missing text;
begin
  if tg_op = 'UPDATE' and new.custom is not distinct from old.custom and new.status is not distinct from old.status and new.project_id is not distinct from old.project_id then
    return new;
  end if;
  new.custom := coalesce(new.custom, '{}'::jsonb);
  if jsonb_typeof(new.custom) <> 'object' then raise exception 'bad_custom: custom fields must be an object'; end if;
  for k, v in select * from jsonb_each(new.custom) loop
    if tg_op = 'UPDATE' and (old.custom -> k) is not distinct from v then continue; end if;   -- unchanged values stay even if the field was archived
    if jsonb_typeof(v) = 'null' or v = '""'::jsonb then new.custom := new.custom - k; continue; end if;
    select * into d from public.field_defs where workspace_id = new.workspace_id and key = k and not archived and (project_id is null or project_id is not distinct from new.project_id);
    if not found then raise exception 'unknown_field: "%" isn''t a field in this workspace or project', k; end if;
    if d.type in ('text','select','date') and jsonb_typeof(v) <> 'string' then raise exception 'bad_value: % must be text', d.label; end if;
    if d.type = 'text' and char_length(v #>> '{}') > 500 then raise exception 'bad_value: % is longer than 500 characters', d.label; end if;
    if d.type = 'number' and jsonb_typeof(v) <> 'number' then raise exception 'bad_value: % must be a number', d.label; end if;
    if d.type = 'checkbox' and jsonb_typeof(v) <> 'boolean' then raise exception 'bad_value: % must be yes or no', d.label; end if;
    if d.type = 'select' and not ((v #>> '{}') = any(d.options)) then raise exception 'bad_value: "%" isn''t one of the choices for %', v #>> '{}', d.label; end if;
    if d.type = 'date' then
      if (v #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'bad_value: % must be a date', d.label; end if;
      perform (v #>> '{}')::date;
    end if;
  end loop;
  if new.status = 'completed' and (tg_op = 'INSERT' or old.status is distinct from 'completed') then
    select string_agg(label, ', ' order by sort, label) into v_missing from public.field_defs f
      where f.workspace_id = new.workspace_id and f.required and not f.archived and (f.project_id is null or f.project_id is not distinct from new.project_id)
        and (new.custom -> f.key is null or (f.type = 'checkbox' and new.custom -> f.key <> 'true'::jsonb));
    if v_missing is not null then raise exception 'field_required: fill in % before completing', v_missing; end if;
  end if;
  return new;
end $$;
create trigger tasks_custom_guard before insert or update on public.tasks for each row execute function public.tasks_custom_guard();

create or replace function public.tasks_custom_log() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_changes jsonb := '{}'::jsonb; k text;
begin
  if new.custom is not distinct from old.custom then return null; end if;
  for k in select jsonb_object_keys(old.custom) union select jsonb_object_keys(new.custom) loop
    if old.custom -> k is distinct from new.custom -> k then v_changes := v_changes || jsonb_build_object(k, jsonb_build_array(old.custom -> k, new.custom -> k)); end if;
  end loop;
  insert into public.activity (workspace_id, entity_type, entity_id, actor_id, action, changes)
    values (new.workspace_id, 'task', new.id, (select auth.uid()), 'fields_changed', jsonb_build_object('custom', v_changes));
  return null;
end $$;
create trigger tasks_custom_log after update of custom on public.tasks for each row execute function public.tasks_custom_log();

-- ---------------------------------------------------------------- project templates
create table public.project_templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  description text,
  body jsonb not null,
  source_project_id uuid references public.projects(id) on delete set null,
  archived boolean not null default false,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.project_templates (workspace_id);
alter table public.project_templates enable row level security;
create policy "templates: members read" on public.project_templates for select to authenticated using (public.is_ws_member(workspace_id));
create policy "templates: writers add" on public.project_templates for insert to authenticated with check (public.can_write_ws(workspace_id) and created_by = (select auth.uid()));
create policy "templates: writers edit" on public.project_templates for update to authenticated using (public.can_write_ws(workspace_id)) with check (public.can_write_ws(workspace_id));

-- body: {milestones:[{title, offset_days, weight, is_critical}], tasks:[{title, description, offset_days|null, priority, milestone|null (index), criteria:[text], next_action}],
--        fields:[{key, label, type, options, required}]}
create or replace function public.template_body_check(b jsonb) returns void language plpgsql immutable set search_path = '' as $$
declare x jsonb; n int;
begin
  if jsonb_typeof(b) <> 'object' then raise exception 'bad_template: body must be an object'; end if;
  if jsonb_typeof(coalesce(b->'milestones','[]')) <> 'array' or jsonb_typeof(coalesce(b->'tasks','[]')) <> 'array' or jsonb_typeof(coalesce(b->'fields','[]')) <> 'array' then
    raise exception 'bad_template: milestones, tasks and fields must be lists';
  end if;
  n := jsonb_array_length(coalesce(b->'milestones','[]'));
  if n > 50 or jsonb_array_length(coalesce(b->'tasks','[]')) > 300 or jsonb_array_length(coalesce(b->'fields','[]')) > 30 then raise exception 'bad_template: too many items'; end if;
  for x in select * from jsonb_array_elements(coalesce(b->'milestones','[]')) loop
    if coalesce(trim(x->>'title'), '') = '' then raise exception 'bad_template: every milestone needs a title'; end if;
    if x ? 'offset_days' and jsonb_typeof(x->'offset_days') <> 'null' and abs((x->>'offset_days')::int) > 3650 then raise exception 'bad_template: offsets must be within 10 years'; end if;
  end loop;
  for x in select * from jsonb_array_elements(coalesce(b->'tasks','[]')) loop
    if coalesce(trim(x->>'title'), '') = '' then raise exception 'bad_template: every task needs a title'; end if;
    if x ? 'offset_days' and jsonb_typeof(x->'offset_days') <> 'null' and abs((x->>'offset_days')::int) > 3650 then raise exception 'bad_template: offsets must be within 10 years'; end if;
    if x ? 'milestone' and jsonb_typeof(x->'milestone') <> 'null' and ((x->>'milestone')::int < 0 or (x->>'milestone')::int >= n) then raise exception 'bad_template: a task points at a milestone that isn''t in the template'; end if;
    if coalesce(x->>'priority', 'medium') not in ('low','medium','high','critical') then raise exception 'bad_template: unknown priority'; end if;
  end loop;
  for x in select * from jsonb_array_elements(coalesce(b->'fields','[]')) loop
    if coalesce(x->>'key','') !~ '^[a-z][a-z0-9_]{0,39}$' or coalesce(x->>'type','') not in ('text','number','date','select','checkbox') then raise exception 'bad_template: field % is malformed', coalesce(x->>'label', x->>'key'); end if;
  end loop;
end $$;
create or replace function public.project_templates_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  perform public.template_body_check(new.body);
  if tg_op = 'UPDATE' and new.workspace_id <> old.workspace_id then raise exception 'workspace_locked'; end if;
  new.updated_at := now();
  return new;
end $$;
create trigger project_templates_guard before insert or update on public.project_templates for each row execute function public.project_templates_guard();

-- make a project from a template (runs as the person: every row goes through the normal permissions and task rules)
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
  insert into public.activity (workspace_id, entity_type, entity_id, actor_id, action, changes)
    values (t.workspace_id, 'project', v_pid, (select auth.uid()), 'created_from_template', jsonb_build_object('template', t.name, 'template_id', t.id, 'start', p_start));
  return v_pid;
end $$;

-- save an existing project's structure (not its data) as a template
create or replace function public.save_project_as_template(p_project uuid, p_name text, p_description text default null) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare p public.projects; v_anchor date; v_tz text; v_ms jsonb; v_tasks jsonb; v_fields jsonb; v_id uuid;
begin
  select * into p from public.projects where id = p_project;
  if not found then raise exception 'not_found: project not found'; end if;
  if not public.can_write_ws(p.workspace_id) then raise exception 'forbidden: you can''t add templates to this workspace'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'name_required: name the template'; end if;
  select coalesce(timezone, 'Asia/Qatar') into v_tz from public.profiles where id = (select auth.uid());
  v_tz := coalesce(v_tz, 'Asia/Qatar');
  v_anchor := coalesce(p.start_date, (select min(planned_date) from public.milestones where project_id = p.id), (p.created_at at time zone v_tz)::date);
  select coalesce(jsonb_agg(jsonb_build_object('title', m.title, 'offset_days', m.planned_date - v_anchor, 'weight', m.weight, 'is_critical', m.is_critical, '_id', m.id) order by m.sort, m.planned_date nulls last), '[]')
    into v_ms from public.milestones m where m.project_id = p.id;
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('title', t.title, 'description', t.description, 'priority', t.priority, 'next_action', t.next_action,
      'offset_days', case when t.due_at is not null then (t.due_at at time zone v_tz)::date - v_anchor end,
      'milestone', (select (o.idx - 1)::int from jsonb_array_elements(v_ms) with ordinality o(m, idx) where (o.m->>'_id')::uuid = t.milestone_id),
      'criteria', (select jsonb_agg(c->>'text') from jsonb_array_elements(coalesce(t.completion_criteria, '[]')) c where coalesce(c->>'text','') <> '')))
      order by t.due_at nulls last, t.sort, t.created_at), '[]')
    into v_tasks from public.tasks t where t.project_id = p.id and t.deleted_at is null and t.status <> 'cancelled' and t.parent_id is null;
  select coalesce(jsonb_agg(jsonb_build_object('key', f.key, 'label', f.label, 'type', f.type, 'options', to_jsonb(f.options), 'required', f.required) order by f.sort, f.label), '[]')
    into v_fields from public.field_defs f where f.project_id = p.id and not f.archived;
  select coalesce(jsonb_agg(m - '_id'), '[]') into v_ms from jsonb_array_elements(v_ms) m;
  insert into public.project_templates (workspace_id, name, description, body, source_project_id, created_by)
    values (p.workspace_id, trim(p_name), coalesce(nullif(trim(p_description), ''), p.description), jsonb_build_object('milestones', v_ms, 'tasks', v_tasks, 'fields', v_fields), p.id, (select auth.uid()))
    returning id into v_id;
  return v_id;
end $$;

revoke execute on function public.field_defs_guard(), public.tasks_custom_guard(), public.tasks_custom_log(), public.project_templates_guard() from public, anon, authenticated;
revoke execute on function public.create_project_from_template(uuid, text, date, date), public.save_project_as_template(uuid, text, text), public.template_body_check(jsonb) from public, anon;
grant execute on function public.create_project_from_template(uuid, text, date, date), public.save_project_as_template(uuid, text, text), public.template_body_check(jsonb) to authenticated;
