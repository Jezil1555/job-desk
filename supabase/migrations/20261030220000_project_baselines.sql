-- Increment 3: schedule baselines. Original (baseline) dates are stored separately from current planned dates; once a project
-- is baselined, every change to its start/target date or a milestone's planned date needs a reason and is logged as a revision.
-- Baselines themselves change only through rebaseline (with a reason), and the old baseline is kept in the revision log.

alter table public.projects add column baseline_start_date date, add column baseline_target_date date,
  add column baselined_at timestamptz, add column baselined_by uuid references auth.users(id) on delete set null;
alter table public.milestones add column baseline_date date;

create table public.schedule_revisions (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  milestone_id uuid references public.milestones(id) on delete cascade,
  field text not null check (field in ('start_date','target_date','planned_date','baseline')),
  old_date date, new_date date,
  reason text not null check (char_length(reason) between 3 and 500),
  revised_by uuid references auth.users(id) on delete set null default auth.uid(),
  revised_at timestamptz not null default now()
);
create index on public.schedule_revisions (project_id, revised_at);
alter table public.schedule_revisions enable row level security;
create policy "schedule revisions: members read" on public.schedule_revisions for select to authenticated using (public.is_ws_member(workspace_id));
-- written only by the triggers and functions below

create or replace function public.projects_schedule_guard() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_reason text := nullif(trim(current_setting('app.schedule_reason', true)), ''); v_base text := coalesce(current_setting('app.baseline', true), '');
begin
  if v_base <> 'on' and (new.baseline_start_date is distinct from old.baseline_start_date or new.baseline_target_date is distinct from old.baseline_target_date
      or new.baselined_at is distinct from old.baselined_at or new.baselined_by is distinct from old.baselined_by) then
    raise exception 'baseline_via_function: use Set baseline / Re-baseline';
  end if;
  if old.baselined_at is not null and v_base <> 'on' and (new.start_date is distinct from old.start_date or new.target_date is distinct from old.target_date) then
    if v_reason is null or char_length(v_reason) < 3 then raise exception 'reason_required: the schedule is baselined — give a reason for changing the date'; end if;
    if new.start_date is distinct from old.start_date then
      insert into public.schedule_revisions (workspace_id, project_id, field, old_date, new_date, reason) values (new.workspace_id, new.id, 'start_date', old.start_date, new.start_date, v_reason);
    end if;
    if new.target_date is distinct from old.target_date then
      insert into public.schedule_revisions (workspace_id, project_id, field, old_date, new_date, reason) values (new.workspace_id, new.id, 'target_date', old.target_date, new.target_date, v_reason);
    end if;
  end if;
  return new;
end $$;
create trigger projects_schedule_guard before update on public.projects for each row execute function public.projects_schedule_guard();

create or replace function public.milestones_schedule_guard() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_reason text := nullif(trim(current_setting('app.schedule_reason', true)), ''); v_base text := coalesce(current_setting('app.baseline', true), ''); v_ws uuid;
begin
  if tg_op = 'UPDATE' and v_base <> 'on' and new.baseline_date is distinct from old.baseline_date then
    raise exception 'baseline_via_function: use Set baseline / Re-baseline';
  end if;
  if tg_op = 'INSERT' then
    -- a milestone added after the project was baselined starts its own baseline at its first planned date
    if v_base <> 'on' then new.baseline_date := case when exists (select 1 from public.projects where id = new.project_id and baselined_at is not null) then new.planned_date end; end if;
    return new;
  end if;
  if old.baseline_date is not null and v_base <> 'on' and new.planned_date is distinct from old.planned_date then
    if v_reason is null or char_length(v_reason) < 3 then raise exception 'reason_required: the schedule is baselined — give a reason for changing the date'; end if;
    select workspace_id into v_ws from public.projects where id = new.project_id;
    insert into public.schedule_revisions (workspace_id, project_id, milestone_id, field, old_date, new_date, reason) values (v_ws, new.project_id, new.id, 'planned_date', old.planned_date, new.planned_date, v_reason);
  elsif old.baseline_date is null and old.planned_date is null and new.planned_date is not null and v_base <> 'on'
        and exists (select 1 from public.projects where id = new.project_id and baselined_at is not null) then
    new.baseline_date := new.planned_date; -- first date given after baselining becomes its baseline
  end if;
  return new;
end $$;
create trigger milestones_schedule_guard before insert or update on public.milestones for each row execute function public.milestones_schedule_guard();

-- Freeze today's planned dates as the baseline. Re-baselining needs a reason; the old baseline is kept in the revision log.
create or replace function public.set_project_baseline(p_project uuid, p_reason text default null) returns void language plpgsql security definer set search_path = '' as $$
declare p public.projects; m record;
begin
  select * into p from public.projects where id = p_project;
  if not found or not public.can_write_ws(p.workspace_id) then raise exception 'not_found: project not found or not editable'; end if;
  if p.baselined_at is not null and char_length(coalesce(trim(p_reason), '')) < 3 then raise exception 'reason_required: give a reason for re-baselining'; end if;
  if p.target_date is null then raise exception 'target_required: set a target date before baselining'; end if;
  if p.baselined_at is not null then
    insert into public.schedule_revisions (workspace_id, project_id, field, old_date, new_date, reason) values (p.workspace_id, p.id, 'baseline', p.baseline_target_date, p.target_date, 'Re-baseline: ' || trim(p_reason));
    for m in select * from public.milestones where project_id = p_project and baseline_date is distinct from planned_date loop
      insert into public.schedule_revisions (workspace_id, project_id, milestone_id, field, old_date, new_date, reason) values (p.workspace_id, p.id, m.id, 'baseline', m.baseline_date, m.planned_date, 'Re-baseline: ' || trim(p_reason));
    end loop;
  end if;
  perform set_config('app.baseline', 'on', true);
  update public.projects set baseline_start_date = start_date, baseline_target_date = target_date, baselined_at = now(), baselined_by = (select auth.uid()) where id = p_project;
  if not found then raise exception 'forbidden: you can''t edit this project'; end if;
  update public.milestones set baseline_date = planned_date where project_id = p_project;
  perform set_config('app.baseline', 'off', true);
end $$;

-- Change baselined dates with a reason (null keeps a date unchanged; use p_clear_* to remove).
create or replace function public.revise_project_dates(p_project uuid, p_start date, p_target date, p_reason text) returns void language plpgsql security invoker set search_path = '' as $$
begin
  if char_length(coalesce(trim(p_reason), '')) < 3 then raise exception 'reason_required: give a reason for changing the date'; end if;
  if p_start is not null and p_target is not null and p_target < p_start then raise exception 'bad_dates: target is before start'; end if;
  perform set_config('app.schedule_reason', trim(p_reason), true);
  update public.projects set start_date = coalesce(p_start, start_date), target_date = coalesce(p_target, target_date) where id = p_project;
  if not found then raise exception 'not_found: project not found or not editable'; end if;
  perform set_config('app.schedule_reason', '', true);
end $$;
create or replace function public.revise_milestone_date(p_milestone uuid, p_planned date, p_reason text) returns void language plpgsql security invoker set search_path = '' as $$
begin
  if char_length(coalesce(trim(p_reason), '')) < 3 then raise exception 'reason_required: give a reason for changing the date'; end if;
  perform set_config('app.schedule_reason', trim(p_reason), true);
  update public.milestones set planned_date = p_planned where id = p_milestone;
  if not found then raise exception 'not_found: milestone not found or not editable'; end if;
  perform set_config('app.schedule_reason', '', true);
end $$;

-- Slip analysis: baseline vs current vs actual for every baselined project and milestone.
create or replace view public.schedule_variance with (security_invoker = true) as
  select p.workspace_id, p.id as project_id, null::uuid as milestone_id, p.name as title, 'project' as kind,
         p.baseline_target_date as baseline_date, p.target_date as current_date_planned, null::date as actual_date,
         (p.target_date - p.baseline_target_date) as slip_days,
         (select count(*) from public.schedule_revisions r where r.project_id = p.id and r.milestone_id is null and r.field = 'target_date') as revisions
  from public.projects p where p.baselined_at is not null
  union all
  select p.workspace_id, p.id, m.id, m.title, 'milestone', m.baseline_date, m.planned_date, m.actual_date,
         (coalesce(m.actual_date, m.planned_date) - m.baseline_date),
         (select count(*) from public.schedule_revisions r where r.milestone_id = m.id and r.field = 'planned_date')
  from public.milestones m join public.projects p on p.id = m.project_id where m.baseline_date is not null;

revoke execute on function public.projects_schedule_guard(), public.milestones_schedule_guard() from public, anon, authenticated;
revoke execute on function public.set_project_baseline(uuid, text), public.revise_project_dates(uuid, date, date, text), public.revise_milestone_date(uuid, date, text) from public, anon;
grant execute on function public.set_project_baseline(uuid, text), public.revise_project_dates(uuid, date, date, text), public.revise_milestone_date(uuid, date, text) to authenticated;
grant select on public.schedule_variance to authenticated;
