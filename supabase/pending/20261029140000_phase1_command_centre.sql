-- =====================================================================================
-- Phase 1: Command Centre foundation
--   * projects  -> workspaces (ids preserved), project_members -> workspace_members
--   * new projects (inside workspaces), milestones, contacts, follow-ups, activity log
--   * universal task engine: 7 statuses, 4 priorities, subtasks, dependencies,
--     completion criteria, waiting/blocked details, recurrence, soft delete
--   * rule-based project health view, server-side reminders with de-duplication
-- Rollback: data snapshot taken beforehand in schema backup.b20261029_* (not API-exposed).
-- =====================================================================================

-- ---------- 0. drop old triggers, functions and policies that reference old names ----------
drop trigger if exists tasks_touch on public.tasks;
drop trigger if exists tasks_check_assignee on public.tasks;
drop trigger if exists tasks_notify on public.tasks;
drop trigger if exists task_updates_notify on public.task_updates;
drop trigger if exists projects_add_owner on public.projects;
drop trigger if exists project_members_unassign on public.project_members;
drop trigger if exists project_members_notify on public.project_members;
drop function if exists public.touch_task(), public.check_task_assignee(), public.notify_task_change(), public.notify_task_update(),
  public.add_project_owner(), public.unassign_removed_member(), public.notify_member_added(), public.notify_overdue(),
  public.add_project_member(uuid, text);

do $$ declare r record; begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public'
           and tablename in ('projects','project_members','tasks','task_updates','profiles','notifications') loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

drop function if exists public.can_see_task(uuid), public.is_project_member(uuid), public.is_project_owner(uuid), public.shares_project(uuid);
select cron.unschedule('jobdesk-overdue');

-- ---------- 1. workspaces & members (renamed, ids preserved) ----------
alter table public.projects rename to workspaces;
alter table public.workspaces rename column user_id to owner_id;
alter table public.workspaces add column description text, add column kind text not null default 'business'
  check (kind in ('business','professional','personal','other'));
alter index if exists projects_user_idx rename to workspaces_owner_idx;

alter table public.project_members rename to workspace_members;
alter table public.workspace_members rename column project_id to workspace_id;
do $$ declare c text; begin
  select conname into c from pg_constraint where conrelid = 'public.workspace_members'::regclass and contype = 'c';
  if c is not null then execute format('alter table public.workspace_members drop constraint %I', c); end if;
end $$;
alter table public.workspace_members add constraint workspace_members_role_check check (role in ('owner','member','viewer'));
alter index if exists project_members_user_idx rename to workspace_members_user_idx;

-- ---------- 2. profiles: timezone, preferences, admin flag ----------
alter table public.profiles add column timezone text not null default 'Asia/Qatar',
  add column prefs jsonb not null default '{}'::jsonb,
  add column is_admin boolean not null default false;

-- ---------- 3. helper functions (security definer, avoid RLS recursion) ----------
create or replace function public.ws_role(ws uuid)
returns text language sql stable security definer set search_path = '' as $$
  select role from public.workspace_members where workspace_id = ws and user_id = (select auth.uid());
$$;
create or replace function public.is_ws_member(ws uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspace_members where workspace_id = ws and user_id = (select auth.uid()));
$$;
create or replace function public.can_write_ws(ws uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspace_members where workspace_id = ws and user_id = (select auth.uid()) and role in ('owner','member'));
$$;
create or replace function public.is_ws_owner(ws uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspaces where id = ws and owner_id = (select auth.uid()));
$$;
create or replace function public.shares_workspace(other uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspace_members a join public.workspace_members b on a.workspace_id = b.workspace_id
                 where a.user_id = (select auth.uid()) and b.user_id = other);
$$;

-- ---------- 4. contacts & organisations ----------
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  organisation text,
  kind text not null default 'person' check (kind in ('person','company','supplier','customer','partner','colleague','other')),
  email text, phone text, notes text,
  archived boolean not null default false,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index contacts_ws_idx on public.contacts(workspace_id);

-- ---------- 5. projects (inside workspaces) & milestones ----------
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  description text,
  owner_id uuid references auth.users(id) on delete set null default auth.uid(),
  priority text not null default 'medium' check (priority in ('critical','high','medium','low')),
  start_date date,
  target_date date,
  manual_status text check (manual_status in ('planned','on_track','at_risk','blocked','completed','cancelled')),
  manual_status_reason text,
  budget numeric(14,2),
  budget_currency text,
  next_action text,
  archived boolean not null default false,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint manual_status_needs_reason check (manual_status is null or char_length(coalesce(manual_status_reason, '')) > 2),
  constraint project_dates check (target_date is null or start_date is null or target_date >= start_date)
);
create index projects_ws_idx on public.projects(workspace_id);

create table public.milestones (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  planned_date date,
  actual_date date,
  weight numeric(6,2) not null default 1 check (weight > 0),
  is_critical boolean not null default false,
  notes text,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index milestones_project_idx on public.milestones(project_id);

-- ---------- 6. tasks: the universal task engine ----------
alter table public.tasks rename column user_id to created_by;
alter table public.tasks rename column project_id to workspace_id;
alter table public.tasks rename column details to description;
alter table public.tasks rename column assignee_id to owner_id;
alter table public.tasks rename column done_at to completed_at;
alter table public.tasks rename column ref to reference;
alter table public.tasks rename column client to client_name;
alter index if exists tasks_user_idx rename to tasks_created_by_idx;
alter index if exists tasks_project_idx rename to tasks_ws_idx;
alter index if exists tasks_assignee_idx rename to tasks_owner_idx;
drop index if exists tasks_due_idx;

do $$ declare r record; begin
  for r in select conname from pg_constraint where conrelid = 'public.tasks'::regclass and contype = 'c' and conname in ('tasks_status_check','tasks_priority_check') loop
    execute format('alter table public.tasks drop constraint %I', r.conname);
  end loop;
end $$;

update public.tasks set status = case status when 'todo' then 'not_started' when 'doing' then 'in_progress' when 'done' then 'completed' else status end;
update public.tasks set owner_id = created_by where owner_id is null;

alter table public.tasks
  alter column status set default 'not_started',
  alter column owner_id set default auth.uid(),
  alter column created_by set default auth.uid(),
  add constraint tasks_status_check check (status in ('inbox','not_started','in_progress','waiting','blocked','completed','cancelled')),
  add constraint tasks_priority_check check (priority in ('critical','high','medium','low')),
  add column project_id uuid references public.projects(id) on delete set null,
  add column milestone_id uuid references public.milestones(id) on delete set null,
  add column parent_id uuid references public.tasks(id) on delete cascade,
  add column category text,
  add column start_date date,
  add column follow_up_at timestamptz,
  add column progress smallint not null default 0 check (progress between 0 and 100),
  add column next_action text,
  add column completion_criteria jsonb not null default '[]'::jsonb check (jsonb_typeof(completion_criteria) = 'array'),
  add column waiting_on text,
  add column waiting_on_contact_id uuid references public.contacts(id) on delete set null,
  add column waiting_for text,
  add column blocker text,
  add column blocker_impact text,
  add column unblock_action text,
  add column recurrence text check (recurrence in ('daily','weekdays','weekly','monthly','yearly')),
  add column recurrence_parent_id uuid references public.tasks(id) on delete set null,
  add column cancelled_reason text,
  add column deleted_at timestamptz,
  add column due_soon_for timestamptz,
  add column followup_reminded_for timestamptz,
  add constraint tasks_not_own_parent check (parent_id is null or parent_id <> id);

create index tasks_owner_open_idx on public.tasks(owner_id) where status not in ('completed','cancelled') and deleted_at is null;
create index tasks_due_open_idx on public.tasks(due_at) where status not in ('completed','cancelled') and deleted_at is null;
create index tasks_followup_idx on public.tasks(follow_up_at) where follow_up_at is not null and status not in ('completed','cancelled');
create index tasks_parent_idx on public.tasks(parent_id);
create index tasks_project_idx on public.tasks(project_id);

alter table public.task_updates rename to task_comments;
alter index if exists task_updates_task_idx rename to task_comments_task_idx;
alter index if exists task_updates_user_idx rename to task_comments_author_idx;

create table public.task_dependencies (
  task_id uuid not null references public.tasks(id) on delete cascade,
  depends_on_id uuid not null references public.tasks(id) on delete cascade,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (task_id, depends_on_id),
  check (task_id <> depends_on_id)
);
create index task_dependencies_dep_idx on public.task_dependencies(depends_on_id);

create table public.task_contacts (
  task_id uuid not null references public.tasks(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  role text,
  primary key (task_id, contact_id)
);

-- ---------- 7. follow-ups ----------
create table public.follow_ups (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  counterpart text,
  subject text not null check (char_length(subject) between 1 and 300),
  direction text not null default 'they_owe' check (direction in ('they_owe','i_owe')),
  last_contact_at date,
  expected_at date,
  next_follow_up_at timestamptz,
  escalate_at date,
  status text not null default 'open' check (status in ('open','escalated','closed','cancelled')),
  notes text,
  document_url text,
  owner_id uuid default auth.uid() references auth.users(id) on delete set null,
  reminded_for timestamptz,
  closed_at timestamptz,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint follow_up_party check (contact_id is not null or char_length(coalesce(counterpart, '')) > 0)
);
create index follow_ups_ws_idx on public.follow_ups(workspace_id);
create index follow_ups_next_idx on public.follow_ups(next_follow_up_at) where status in ('open','escalated');

create table public.follow_up_logs (
  id uuid primary key default gen_random_uuid(),
  follow_up_id uuid not null references public.follow_ups(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 2000),
  contacted_at timestamptz not null default now(),
  author_id uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index follow_up_logs_fu_idx on public.follow_up_logs(follow_up_id, contacted_at desc);

-- ---------- 8. activity / audit log (append-only, written only by triggers) ----------
create table public.activity (
  id bigint generated always as identity primary key,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  changes jsonb not null default '{}'::jsonb,
  note text,
  created_at timestamptz not null default now()
);
create index activity_entity_idx on public.activity(entity_type, entity_id, created_at desc);
create index activity_ws_idx on public.activity(workspace_id, created_at desc);

-- ---------- 9. notifications: link to workspace / follow-up ----------
alter table public.notifications rename column project_id to workspace_id;
alter table public.notifications add column follow_up_id uuid references public.follow_ups(id) on delete cascade;

-- ---------- 10. visibility helper for tasks ----------
create or replace function public.can_see_task(tid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tasks t join public.workspace_members m on m.workspace_id = t.workspace_id
                 where t.id = tid and m.user_id = (select auth.uid()));
$$;
create or replace function public.can_write_task(tid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tasks t join public.workspace_members m on m.workspace_id = t.workspace_id
                 where t.id = tid and m.user_id = (select auth.uid()) and m.role in ('owner','member'));
$$;

-- ---------- 11. task rules (before write) ----------
create or replace function public.tasks_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_open int; v_reason text;
begin
  new.updated_at := now();
  new.title := trim(new.title);

  -- integrity of links
  if new.owner_id is not null and not exists (select 1 from public.workspace_members where workspace_id = new.workspace_id and user_id = new.owner_id) then
    raise exception 'owner_not_member: the owner must be a member of this workspace';
  end if;
  if new.project_id is not null and not exists (select 1 from public.projects where id = new.project_id and workspace_id = new.workspace_id) then
    raise exception 'project_wrong_workspace: the project belongs to a different workspace';
  end if;
  if new.milestone_id is not null and (new.project_id is null or not exists (select 1 from public.milestones where id = new.milestone_id and project_id = new.project_id)) then
    raise exception 'milestone_wrong_project: the milestone belongs to a different project';
  end if;
  if new.parent_id is not null and not exists (select 1 from public.tasks where id = new.parent_id and workspace_id = new.workspace_id and parent_id is null) then
    raise exception 'bad_parent: a subtask must sit under a top-level task in the same workspace';
  end if;

  -- status-specific required details
  if new.status = 'waiting' and char_length(coalesce(trim(new.waiting_on), '')) = 0 and new.waiting_on_contact_id is null then
    raise exception 'waiting_needs_person: say who you are waiting on';
  end if;
  if new.status = 'blocked' and char_length(coalesce(trim(new.blocker), '')) = 0 then
    raise exception 'blocked_needs_reason: describe what is blocking this task';
  end if;

  -- completion rules
  if new.status = 'completed' and (tg_op = 'INSERT' or old.status <> 'completed') then
    if exists (select 1 from jsonb_array_elements(new.completion_criteria) e where coalesce((e->>'done')::boolean, false) = false) then
      raise exception 'criteria_incomplete: tick every completion criterion before completing';
    end if;
    if tg_op = 'UPDATE' then
      select count(*) into v_open from public.tasks where parent_id = new.id and status not in ('completed','cancelled') and deleted_at is null;
      if v_open > 0 then raise exception 'subtasks_incomplete: % subtask(s) still open', v_open; end if;
      select count(*) into v_open from public.task_dependencies d join public.tasks p on p.id = d.depends_on_id
        where d.task_id = new.id and p.status not in ('completed','cancelled') and p.deleted_at is null;
      if v_open > 0 then raise exception 'dependencies_incomplete: % prerequisite task(s) still open', v_open; end if;
    end if;
    new.completed_at := now();
    new.progress := 100;
  end if;

  if tg_op = 'UPDATE' and old.status = 'completed' and new.status <> 'completed' then
    v_reason := nullif(trim(current_setting('app.reopen_reason', true)), '');
    if v_reason is null then raise exception 'reopen_reason_required: give a reason for reopening'; end if;
    new.completed_at := null;
  end if;
  if new.status <> 'completed' and new.completed_at is not null and tg_op = 'INSERT' then new.completed_at := null; end if;
  if new.status = 'cancelled' and (tg_op = 'INSERT' or old.status <> 'cancelled') and char_length(coalesce(trim(new.cancelled_reason), '')) = 0 then
    raise exception 'cancel_reason_required: give a reason for cancelling';
  end if;

  -- reset reminder markers when dates move
  if tg_op = 'UPDATE' then
    if new.due_at is distinct from old.due_at then new.overdue_notified_at := null; new.due_soon_for := null; end if;
    if new.follow_up_at is distinct from old.follow_up_at then new.followup_reminded_for := null; end if;
  end if;
  return new;
end $$;
create trigger tasks_before_write before insert or update on public.tasks for each row execute function public.tasks_before_write();

-- ---------- 12. task audit, recurrence and notifications (after write) ----------
create or replace function public.actor_name()
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select nullif(display_name, '') from public.profiles where id = (select auth.uid())), 'Someone');
$$;

create or replace function public.next_occurrence(ts timestamptz, rule text)
returns timestamptz language plpgsql immutable set search_path = '' as $$
declare n timestamptz;
begin
  if ts is null then return null; end if;
  n := case rule when 'daily' then ts + interval '1 day' when 'weekly' then ts + interval '7 days'
                 when 'monthly' then ts + interval '1 month' when 'yearly' then ts + interval '1 year'
                 when 'weekdays' then ts + interval '1 day' else null end;
  if rule = 'weekdays' then
    while extract(isodow from (n at time zone 'Asia/Qatar')) in (5, 6) loop n := n + interval '1 day'; end loop; -- Qatar weekend: Fri, Sat
  end if;
  return n;
end $$;

create or replace function public.tasks_after_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_changes jsonb := '{}'::jsonb;
  v_ws text; f text;
  v_fields text[] := array['title','status','priority','owner_id','due_at','start_date','follow_up_at','project_id','workspace_id',
                           'parent_id','progress','next_action','waiting_on','blocker','category','recurrence','deleted_at','cancelled_reason'];
  o jsonb; nw jsonb;
begin
  select name into v_ws from public.workspaces where id = new.workspace_id;
  if tg_op = 'INSERT' then
    insert into public.activity (workspace_id, entity_type, entity_id, actor_id, action, changes)
    values (new.workspace_id, 'task', new.id, v_actor, 'created', jsonb_build_object('title', new.title, 'status', new.status, 'priority', new.priority));
  else
    o := to_jsonb(old); nw := to_jsonb(new);
    foreach f in array v_fields loop
      if o->f is distinct from nw->f then v_changes := v_changes || jsonb_build_object(f, jsonb_build_array(o->f, nw->f)); end if;
    end loop;
    if v_changes <> '{}'::jsonb then
      insert into public.activity (workspace_id, entity_type, entity_id, actor_id, action, changes, note)
      values (new.workspace_id, 'task', new.id, v_actor,
              case when old.status <> 'completed' and new.status = 'completed' then 'completed'
                   when old.status = 'completed' and new.status <> 'completed' then 'reopened'
                   when old.deleted_at is null and new.deleted_at is not null then 'deleted'
                   when old.deleted_at is not null and new.deleted_at is null then 'restored'
                   else 'updated' end,
              v_changes,
              case when old.status = 'completed' and new.status <> 'completed' then nullif(current_setting('app.reopen_reason', true), '') end);
    end if;
  end if;

  -- recurrence: completing a recurring task creates the next occurrence once
  if new.recurrence is not null and new.status = 'completed' and (tg_op = 'INSERT' or old.status <> 'completed')
     and not exists (select 1 from public.tasks where recurrence_parent_id = new.id) then
    insert into public.tasks (workspace_id, project_id, parent_id, title, description, category, priority, owner_id, created_by,
                              start_date, due_at, due_all_day, next_action, completion_criteria, recurrence, recurrence_parent_id, status, client_name, reference)
    values (new.workspace_id, new.project_id, new.parent_id, new.title, new.description, new.category, new.priority, new.owner_id, new.created_by,
            (public.next_occurrence(new.start_date::timestamptz, new.recurrence))::date,
            public.next_occurrence(coalesce(new.due_at, now()), new.recurrence), new.due_all_day, new.next_action,
            coalesce((select jsonb_agg(e || '{"done": false}'::jsonb) from jsonb_array_elements(new.completion_criteria) e), '[]'::jsonb),
            new.recurrence, new.id, 'not_started', new.client_name, new.reference);
  end if;

  -- notifications
  if new.deleted_at is null and new.owner_id is not null and new.owner_id is distinct from v_actor
     and (tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id) then
    insert into public.notifications (user_id, kind, title, body, url, task_id, workspace_id, actor_id)
    values (new.owner_id, 'assigned', public.actor_name() || ' assigned you a task', v_ws || ': ' || new.title, '/#/t/' || new.id, new.id, new.workspace_id, v_actor);
  end if;
  if tg_op = 'UPDATE' and new.status = 'completed' and old.status <> 'completed' and new.created_by is distinct from v_actor and v_actor is not null then
    insert into public.notifications (user_id, kind, title, body, url, task_id, workspace_id, actor_id)
    values (new.created_by, 'completed', public.actor_name() || ' completed a task', v_ws || ': ' || new.title, '/#/t/' || new.id, new.id, new.workspace_id, v_actor);
  end if;
  if tg_op = 'UPDATE' and new.status = 'blocked' and old.status <> 'blocked' and new.created_by is distinct from v_actor and v_actor is not null then
    insert into public.notifications (user_id, kind, title, body, url, task_id, workspace_id, actor_id)
    values (new.created_by, 'blocked', public.actor_name() || ' marked a task blocked', v_ws || ': ' || new.title || ' — ' || left(coalesce(new.blocker, ''), 120), '/#/t/' || new.id, new.id, new.workspace_id, v_actor);
  end if;
  return new;
end $$;
create trigger tasks_after_write after insert or update on public.tasks for each row execute function public.tasks_after_write();

-- reopen with a recorded reason (the only way to move a task out of Completed)
create or replace function public.reopen_task(p_task uuid, p_reason text, p_status text default 'in_progress')
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if char_length(coalesce(trim(p_reason), '')) < 3 then raise exception 'reopen_reason_required: give a reason for reopening'; end if;
  if p_status not in ('inbox','not_started','in_progress','waiting','blocked') then raise exception 'bad_status'; end if;
  perform set_config('app.reopen_reason', trim(p_reason), true);
  update public.tasks set status = p_status where id = p_task;
  if not found then raise exception 'not_found: task not found or not editable'; end if;
  insert into public.task_comments (task_id, body, kind) values (p_task, 'Reopened: ' || trim(p_reason), 'status');
end $$;

-- dependency cycle prevention
create or replace function public.task_dependencies_check()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    with recursive chain(id) as (
      select depends_on_id from public.task_dependencies where task_id = new.depends_on_id
      union select d.depends_on_id from public.task_dependencies d join chain c on d.task_id = c.id
    ) select 1 from chain where id = new.task_id
  ) or new.depends_on_id = new.task_id then
    raise exception 'dependency_cycle: this would create a circular dependency';
  end if;
  insert into public.activity (workspace_id, entity_type, entity_id, actor_id, action, changes)
  select workspace_id, 'task', new.task_id, (select auth.uid()), 'dependency_added', jsonb_build_object('depends_on', new.depends_on_id) from public.tasks where id = new.task_id;
  return new;
end $$;
create trigger task_dependencies_check before insert on public.task_dependencies for each row execute function public.task_dependencies_check();

-- comments notify the task's owner and creator
create or replace function public.task_comments_notify()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_task public.tasks; v_ws text;
begin
  if new.kind <> 'note' then return new; end if;
  select * into v_task from public.tasks where id = new.task_id;
  select name into v_ws from public.workspaces where id = v_task.workspace_id;
  insert into public.notifications (user_id, kind, title, body, url, task_id, workspace_id, actor_id)
  select r, 'update', public.actor_name() || ' updated "' || left(v_task.title, 60) || '"', v_ws || ': ' || left(new.body, 140),
         '/#/t/' || v_task.id, v_task.id, v_task.workspace_id, new.author_id
  from (select distinct unnest(array[v_task.created_by, v_task.owner_id]) as r) x
  where r is not null and r is distinct from new.author_id;
  return new;
end $$;
create trigger task_comments_notify after insert on public.task_comments for each row execute function public.task_comments_notify();

-- ---------- 13. workspace membership automation & RPCs ----------
create or replace function public.workspace_add_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.workspace_members (workspace_id, user_id, role, added_by) values (new.id, new.owner_id, 'owner', new.owner_id) on conflict do nothing;
  return new;
end $$;
create trigger workspaces_add_owner after insert on public.workspaces for each row execute function public.workspace_add_owner();

create or replace function public.workspace_member_removed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- whole workspace being deleted: nothing to reassign or log
  if not exists (select 1 from public.workspaces where id = old.workspace_id) then return old; end if;
  -- tasks owned by the leaver go back to the workspace owner
  update public.tasks set owner_id = (select owner_id from public.workspaces where id = old.workspace_id)
    where workspace_id = old.workspace_id and owner_id = old.user_id;
  insert into public.activity (workspace_id, entity_type, entity_id, actor_id, action, changes)
  values (old.workspace_id, 'workspace', old.workspace_id, (select auth.uid()), 'member_removed', jsonb_build_object('user_id', old.user_id, 'role', old.role));
  return old;
end $$;
create trigger workspace_members_removed after delete on public.workspace_members for each row execute function public.workspace_member_removed();

create or replace function public.workspace_member_added()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_ws text;
begin
  insert into public.activity (workspace_id, entity_type, entity_id, actor_id, action, changes)
  values (new.workspace_id, 'workspace', new.workspace_id, (select auth.uid()), 'member_added', jsonb_build_object('user_id', new.user_id, 'role', new.role));
  if new.role = 'owner' or new.user_id = new.added_by then return new; end if;
  select name into v_ws from public.workspaces where id = new.workspace_id;
  insert into public.notifications (user_id, kind, title, body, url, workspace_id, actor_id)
  values (new.user_id, 'added', public.actor_name() || ' added you to a workspace', v_ws, '/#/w/' || new.workspace_id, new.workspace_id, new.added_by);
  return new;
end $$;
create trigger workspace_members_added after insert on public.workspace_members for each row execute function public.workspace_member_added();

create or replace function public.add_workspace_member(p_workspace uuid, p_email text, p_role text default 'member')
returns json language plpgsql security definer set search_path = '' as $$
declare v_user public.profiles;
begin
  if not public.is_ws_owner(p_workspace) then raise exception 'not_owner: only the workspace owner can add people'; end if;
  if p_role not in ('member','viewer') then raise exception 'bad_role'; end if;
  select * into v_user from public.profiles where lower(email) = lower(trim(p_email));
  if v_user.id is null then raise exception 'not_registered'; end if;
  insert into public.workspace_members (workspace_id, user_id, role, added_by) values (p_workspace, v_user.id, p_role, (select auth.uid()))
  on conflict (workspace_id, user_id) do nothing;
  return json_build_object('id', v_user.id, 'email', v_user.email, 'display_name', v_user.display_name);
end $$;

create or replace function public.set_workspace_member_role(p_workspace uuid, p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_ws_owner(p_workspace) then raise exception 'not_owner'; end if;
  if p_role not in ('member','viewer') then raise exception 'bad_role'; end if;
  update public.workspace_members set role = p_role where workspace_id = p_workspace and user_id = p_user and role <> 'owner';
  insert into public.activity (workspace_id, entity_type, entity_id, actor_id, action, changes)
  values (p_workspace, 'workspace', p_workspace, (select auth.uid()), 'role_changed', jsonb_build_object('user_id', p_user, 'role', p_role));
end $$;

-- ---------- 14. project / follow-up / milestone audit + timestamps ----------
create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;
create trigger projects_touch before update on public.projects for each row execute function public.touch_updated_at();
create trigger milestones_touch before update on public.milestones for each row execute function public.touch_updated_at();
create trigger contacts_touch before update on public.contacts for each row execute function public.touch_updated_at();

create or replace function public.follow_ups_before_write()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  if new.status in ('closed','cancelled') and (tg_op = 'INSERT' or old.status not in ('closed','cancelled')) then new.closed_at := now(); end if;
  if new.status in ('open','escalated') then new.closed_at := null; end if;
  if tg_op = 'UPDATE' and new.next_follow_up_at is distinct from old.next_follow_up_at then new.reminded_for := null; end if;
  return new;
end $$;
create trigger follow_ups_before_write before insert or update on public.follow_ups for each row execute function public.follow_ups_before_write();

create or replace function public.generic_audit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_ws uuid; v_id uuid; v_changes jsonb := '{}'::jsonb; k text; o jsonb; nw jsonb;
begin
  if tg_op = 'DELETE' then o := to_jsonb(old); nw := '{}'::jsonb; else nw := to_jsonb(new); o := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end; end if;
  v_id := coalesce((nw->>'id')::uuid, (o->>'id')::uuid);
  v_ws := coalesce((nw->>'workspace_id')::uuid, (o->>'workspace_id')::uuid);
  if tg_table_name = 'workspaces' then v_ws := v_id; end if;
  if v_ws is null and tg_table_name = 'milestones' then
    select workspace_id into v_ws from public.projects where id = coalesce((nw->>'project_id')::uuid, (o->>'project_id')::uuid);
  end if;
  -- during a cascading workspace delete the parent row is already gone: keep the audit row, drop the link
  if v_ws is not null and not exists (select 1 from public.workspaces where id = v_ws) then v_ws := null; end if;
  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(nw) loop
      if k not in ('updated_at','reminded_for') and o->k is distinct from nw->k then v_changes := v_changes || jsonb_build_object(k, jsonb_build_array(o->k, nw->k)); end if;
    end loop;
    if v_changes = '{}'::jsonb then return new; end if;
  elsif tg_op = 'DELETE' then v_changes := o;
  end if;
  insert into public.activity (workspace_id, entity_type, entity_id, actor_id, action, changes)
  values (v_ws, rtrim(tg_table_name, 's'), v_id, (select auth.uid()), lower(tg_op), v_changes);
  return coalesce(new, old);
end $$;
create trigger projects_audit after insert or update or delete on public.projects for each row execute function public.generic_audit();
create trigger milestones_audit after insert or update or delete on public.milestones for each row execute function public.generic_audit();
create trigger follow_ups_audit after insert or update or delete on public.follow_ups for each row execute function public.generic_audit();
create trigger workspaces_audit after update or delete on public.workspaces for each row execute function public.generic_audit();

-- ---------- 15. project health (documented rules, RLS-respecting view) ----------
-- progress: weighted share of milestones with an actual date; if no milestones, share of completed
--           top-level tasks (cancelled excluded); no milestones and no tasks -> null.
-- calculated_status, first match wins:
--   completed : has tasks or milestones, none open, all milestones done
--   blocked   : a critical milestone is overdue, or a critical/high task is blocked
--   at_risk   : any milestone overdue, any critical/high task overdue, target date passed while open,
--               or open work with no task activity for 14 days (stalled)
--   planned   : start date in the future and no task started yet
--   on_track  : otherwise
-- effective_status = manual_status (with reason) if set, else calculated_status.
create or replace view public.project_health with (security_invoker = true) as
with t as (
  select project_id,
    count(*) filter (where parent_id is null and status <> 'cancelled') as total,
    count(*) filter (where parent_id is null and status = 'completed') as done,
    count(*) filter (where status not in ('completed','cancelled')) as open,
    count(*) filter (where status = 'blocked') as blocked,
    count(*) filter (where status = 'waiting') as waiting,
    count(*) filter (where status = 'blocked' and priority in ('critical','high')) as blocked_hi,
    count(*) filter (where status not in ('completed','cancelled') and due_at < now() and priority in ('critical','high')) as overdue_hi,
    count(*) filter (where status not in ('completed','cancelled') and due_at < now()) as overdue,
    count(*) filter (where status in ('in_progress','waiting','blocked','completed')) as started,
    max(updated_at) as last_task_activity
  from public.tasks where deleted_at is null and project_id is not null group by project_id
), m as (
  select project_id, count(*) as total, count(*) filter (where actual_date is not null) as done,
    sum(weight) as w_total, coalesce(sum(weight) filter (where actual_date is not null), 0) as w_done,
    count(*) filter (where actual_date is null and planned_date < (now() at time zone 'Asia/Qatar')::date) as overdue,
    count(*) filter (where actual_date is null and planned_date < (now() at time zone 'Asia/Qatar')::date and is_critical) as overdue_critical
  from public.milestones group by project_id
), nm as (
  select distinct on (project_id) project_id, id as next_milestone_id, title as next_milestone_title, planned_date as next_milestone_date
  from public.milestones where actual_date is null order by project_id, planned_date nulls last, sort
)
select p.id as project_id, p.workspace_id,
  coalesce(t.total, 0) as task_total, coalesce(t.done, 0) as task_done, coalesce(t.open, 0) as task_open,
  coalesce(t.blocked, 0) as task_blocked, coalesce(t.waiting, 0) as task_waiting, coalesce(t.overdue, 0) as task_overdue,
  coalesce(m.total, 0) as milestone_total, coalesce(m.done, 0) as milestone_done, coalesce(m.overdue, 0) as milestone_overdue,
  case when coalesce(m.total, 0) > 0 then round(100.0 * m.w_done / nullif(m.w_total, 0))
       when coalesce(t.total, 0) > 0 then round(100.0 * t.done / t.total) end::int as progress,
  case when coalesce(m.total, 0) > 0 then 'milestones' when coalesce(t.total, 0) > 0 then 'tasks' else 'none' end as progress_basis,
  t.last_task_activity,
  nm.next_milestone_id, nm.next_milestone_title, nm.next_milestone_date,
  calc.status as calculated_status,
  coalesce(p.manual_status, calc.status) as effective_status,
  calc.reasons
from public.projects p
left join t on t.project_id = p.id
left join m on m.project_id = p.id
left join nm on nm.project_id = p.id
cross join lateral (
  select case
    when (coalesce(t.total, 0) + coalesce(m.total, 0)) > 0 and coalesce(t.open, 0) = 0 and coalesce(m.total, 0) = coalesce(m.done, 0) then 'completed'
    when coalesce(m.overdue_critical, 0) > 0 or coalesce(t.blocked_hi, 0) > 0 then 'blocked'
    when coalesce(m.overdue, 0) > 0 or coalesce(t.overdue_hi, 0) > 0
      or (p.target_date < (now() at time zone 'Asia/Qatar')::date and coalesce(t.open, 0) > 0)
      or (coalesce(t.open, 0) > 0 and t.last_task_activity < now() - interval '14 days') then 'at_risk'
    when p.start_date > (now() at time zone 'Asia/Qatar')::date and coalesce(t.started, 0) = 0 then 'planned'
    else 'on_track' end as status,
  array_remove(array[
    case when coalesce(m.overdue_critical, 0) > 0 then m.overdue_critical || ' critical milestone(s) overdue' end,
    case when coalesce(t.blocked_hi, 0) > 0 then t.blocked_hi || ' high-priority task(s) blocked' end,
    case when coalesce(m.overdue, 0) > 0 then m.overdue || ' milestone(s) overdue' end,
    case when coalesce(t.overdue_hi, 0) > 0 then t.overdue_hi || ' high-priority task(s) overdue' end,
    case when p.target_date < (now() at time zone 'Asia/Qatar')::date and coalesce(t.open, 0) > 0 then 'target date passed' end,
    case when coalesce(t.open, 0) > 0 and t.last_task_activity < now() - interval '14 days' then 'no activity for 14+ days' end
  ], null) as reasons
) calc;

-- ---------- 16. universal search (RLS applies: security invoker) ----------
create or replace function public.search_all(q text)
returns table (kind text, id uuid, title text, subtitle text, workspace_id uuid)
language sql stable security invoker set search_path = '' as $$
  with s as (select '%' || replace(replace(trim(q), '%', ''), '_', '') || '%' as p)
  (select 'task'::text, t.id, t.title, coalesce(t.reference, t.client_name, t.next_action, ''), t.workspace_id from public.tasks t, s
    where t.deleted_at is null and (t.title ilike s.p or t.description ilike s.p or t.reference ilike s.p or t.client_name ilike s.p or t.next_action ilike s.p) limit 40)
  union all
  (select 'project'::text, p.id, p.name, coalesce(p.description, ''), p.workspace_id from public.projects p, s where p.name ilike s.p or p.description ilike s.p limit 15)
  union all
  (select 'follow_up'::text, f.id, f.subject, coalesce(f.counterpart, ''), f.workspace_id from public.follow_ups f, s where f.subject ilike s.p or f.counterpart ilike s.p or f.notes ilike s.p limit 15)
  union all
  (select 'contact'::text, c.id, c.name, coalesce(c.organisation, ''), c.workspace_id from public.contacts c, s where c.name ilike s.p or c.organisation ilike s.p or c.email ilike s.p limit 15)
  union all
  (select 'comment'::text, c.task_id, t.title, left(c.body, 120), t.workspace_id from public.task_comments c join public.tasks t on t.id = c.task_id, s
    where c.kind = 'note' and c.body ilike s.p and t.deleted_at is null limit 15);
$$;

-- ---------- 17. reminders: one scheduled job, idempotent per due value ----------
create or replace function public.run_reminders()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r record; n_over int := 0; n_soon int := 0; n_tfu int := 0; n_fu int := 0; n_esc int := 0;
begin
  -- overdue tasks: when the deadline passes, then once every 24h while still open
  for r in select t.id, t.title, t.workspace_id, coalesce(t.owner_id, t.created_by) as uid, w.name as ws
           from public.tasks t join public.workspaces w on w.id = t.workspace_id
           where t.deleted_at is null and t.status not in ('completed','cancelled') and t.due_at < now() and not w.archived
             and (t.overdue_notified_at is null or t.overdue_notified_at < now() - interval '24 hours')
           for update of t skip locked loop
    insert into public.notifications (user_id, kind, title, body, url, task_id, workspace_id)
    values (r.uid, 'overdue', 'Overdue: ' || left(r.title, 80), r.ws || ' — "' || left(r.title, 80) || '" is overdue. Please complete it.', '/#/t/' || r.id, r.id, r.workspace_id);
    update public.tasks set overdue_notified_at = now() where id = r.id;
    n_over := n_over + 1;
  end loop;

  -- due within 24 hours: once per due value
  for r in select t.id, t.title, t.workspace_id, t.due_at, coalesce(t.owner_id, t.created_by) as uid, w.name as ws
           from public.tasks t join public.workspaces w on w.id = t.workspace_id
           where t.deleted_at is null and t.status not in ('completed','cancelled') and not w.archived
             and t.due_at > now() and t.due_at <= now() + interval '24 hours' and t.due_soon_for is distinct from t.due_at
           for update of t skip locked loop
    insert into public.notifications (user_id, kind, title, body, url, task_id, workspace_id)
    values (r.uid, 'due_soon', 'Due soon: ' || left(r.title, 80), r.ws || ' — due ' || to_char(r.due_at at time zone 'Asia/Qatar', 'Dy DD Mon HH24:MI'), '/#/t/' || r.id, r.id, r.workspace_id);
    update public.tasks set due_soon_for = r.due_at where id = r.id;
    n_soon := n_soon + 1;
  end loop;

  -- task follow-up date reached: once per follow-up value
  for r in select t.id, t.title, t.workspace_id, t.follow_up_at, t.waiting_on, coalesce(t.owner_id, t.created_by) as uid, w.name as ws
           from public.tasks t join public.workspaces w on w.id = t.workspace_id
           where t.deleted_at is null and t.status not in ('completed','cancelled') and t.follow_up_at <= now()
             and t.followup_reminded_for is distinct from t.follow_up_at
           for update of t skip locked loop
    insert into public.notifications (user_id, kind, title, body, url, task_id, workspace_id)
    values (r.uid, 'follow_up', 'Follow up: ' || left(r.title, 80), r.ws || coalesce(' — waiting on ' || r.waiting_on, '') || '. Time to chase.', '/#/t/' || r.id, r.id, r.workspace_id);
    update public.tasks set followup_reminded_for = r.follow_up_at where id = r.id;
    n_tfu := n_tfu + 1;
  end loop;

  -- follow-up tracker items due: once per next_follow_up_at value
  for r in select f.id, f.subject, f.workspace_id, f.next_follow_up_at, coalesce(c.name, f.counterpart) as party, coalesce(f.owner_id, f.created_by) as uid, w.name as ws
           from public.follow_ups f join public.workspaces w on w.id = f.workspace_id left join public.contacts c on c.id = f.contact_id
           where f.status in ('open','escalated') and f.next_follow_up_at <= now() and f.reminded_for is distinct from f.next_follow_up_at
           for update of f skip locked loop
    insert into public.notifications (user_id, kind, title, body, url, follow_up_id, workspace_id)
    values (r.uid, 'follow_up', 'Follow up with ' || left(coalesce(r.party, 'contact'), 60), r.ws || ' — ' || left(r.subject, 120), '/#/f/' || r.id, r.id, r.workspace_id);
    update public.follow_ups set reminded_for = r.next_follow_up_at where id = r.id;
    n_fu := n_fu + 1;
  end loop;

  -- escalation date passed: status change itself prevents repeats
  for r in select f.id, f.subject, f.workspace_id, coalesce(c.name, f.counterpart) as party, coalesce(f.owner_id, f.created_by) as uid, w.name as ws
           from public.follow_ups f join public.workspaces w on w.id = f.workspace_id left join public.contacts c on c.id = f.contact_id
           where f.status = 'open' and f.escalate_at <= (now() at time zone 'Asia/Qatar')::date
           for update of f skip locked loop
    update public.follow_ups set status = 'escalated' where id = r.id;
    insert into public.notifications (user_id, kind, title, body, url, follow_up_id, workspace_id)
    values (r.uid, 'escalation', 'Escalate: ' || left(coalesce(r.party, 'no response'), 60), r.ws || ' — no response on "' || left(r.subject, 100) || '". Escalate or change approach.', '/#/f/' || r.id, r.id, r.workspace_id);
    n_esc := n_esc + 1;
  end loop;

  return jsonb_build_object('overdue', n_over, 'due_soon', n_soon, 'task_follow_ups', n_tfu, 'follow_ups', n_fu, 'escalations', n_esc);
end $$;
select cron.schedule('jobdesk-reminders', '*/5 * * * *', $$select public.run_reminders()$$);

-- ---------- 18. RLS policies ----------
alter table public.contacts enable row level security;
alter table public.projects enable row level security;
alter table public.milestones enable row level security;
alter table public.task_dependencies enable row level security;
alter table public.task_contacts enable row level security;
alter table public.follow_ups enable row level security;
alter table public.follow_up_logs enable row level security;
alter table public.activity enable row level security;

create policy "profiles: self and co-members" on public.profiles for select to authenticated using (id = (select auth.uid()) or public.shares_workspace(id));
create policy "profiles: edit own" on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()) and is_admin = false);

create policy "workspaces: members read" on public.workspaces for select to authenticated using (owner_id = (select auth.uid()) or public.is_ws_member(id));
create policy "workspaces: create own" on public.workspaces for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "workspaces: owner edits" on public.workspaces for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "workspaces: owner deletes" on public.workspaces for delete to authenticated using (owner_id = (select auth.uid()));

create policy "members: read" on public.workspace_members for select to authenticated using (public.is_ws_member(workspace_id));
create policy "members: owner removes or self leaves" on public.workspace_members for delete to authenticated
  using (role <> 'owner' and (public.is_ws_owner(workspace_id) or user_id = (select auth.uid())));

create policy "tasks: members read" on public.tasks for select to authenticated using (public.is_ws_member(workspace_id));
create policy "tasks: writers add" on public.tasks for insert to authenticated with check (created_by = (select auth.uid()) and public.can_write_ws(workspace_id));
create policy "tasks: writers edit" on public.tasks for update to authenticated using (public.can_write_ws(workspace_id)) with check (public.can_write_ws(workspace_id));
create policy "tasks: creator or owner hard-deletes" on public.tasks for delete to authenticated using (created_by = (select auth.uid()) or public.is_ws_owner(workspace_id));

create policy "comments: members read" on public.task_comments for select to authenticated using (public.can_see_task(task_id));
create policy "comments: writers add" on public.task_comments for insert to authenticated with check (author_id = (select auth.uid()) and public.can_write_task(task_id));
create policy "comments: author deletes" on public.task_comments for delete to authenticated using (author_id = (select auth.uid()));

create policy "deps: members read" on public.task_dependencies for select to authenticated using (public.can_see_task(task_id));
create policy "deps: writers add" on public.task_dependencies for insert to authenticated with check (public.can_write_task(task_id) and public.can_see_task(depends_on_id));
create policy "deps: writers remove" on public.task_dependencies for delete to authenticated using (public.can_write_task(task_id));

create policy "task contacts: members read" on public.task_contacts for select to authenticated using (public.can_see_task(task_id));
create policy "task contacts: writers add" on public.task_contacts for insert to authenticated with check (public.can_write_task(task_id));
create policy "task contacts: writers remove" on public.task_contacts for delete to authenticated using (public.can_write_task(task_id));

create policy "contacts: members read" on public.contacts for select to authenticated using (public.is_ws_member(workspace_id));
create policy "contacts: writers add" on public.contacts for insert to authenticated with check (public.can_write_ws(workspace_id));
create policy "contacts: writers edit" on public.contacts for update to authenticated using (public.can_write_ws(workspace_id)) with check (public.can_write_ws(workspace_id));
create policy "contacts: writers delete" on public.contacts for delete to authenticated using (public.can_write_ws(workspace_id));

create policy "projects: members read" on public.projects for select to authenticated using (public.is_ws_member(workspace_id));
create policy "projects: writers add" on public.projects for insert to authenticated with check (public.can_write_ws(workspace_id));
create policy "projects: writers edit" on public.projects for update to authenticated using (public.can_write_ws(workspace_id)) with check (public.can_write_ws(workspace_id));
create policy "projects: owner or creator deletes" on public.projects for delete to authenticated using (public.is_ws_owner(workspace_id) or created_by = (select auth.uid()));

create policy "milestones: members read" on public.milestones for select to authenticated
  using (exists (select 1 from public.projects p where p.id = project_id and public.is_ws_member(p.workspace_id)));
create policy "milestones: writers write" on public.milestones for all to authenticated
  using (exists (select 1 from public.projects p where p.id = project_id and public.can_write_ws(p.workspace_id)))
  with check (exists (select 1 from public.projects p where p.id = project_id and public.can_write_ws(p.workspace_id)));

create policy "follow-ups: members read" on public.follow_ups for select to authenticated using (public.is_ws_member(workspace_id));
create policy "follow-ups: writers add" on public.follow_ups for insert to authenticated with check (created_by = (select auth.uid()) and public.can_write_ws(workspace_id));
create policy "follow-ups: writers edit" on public.follow_ups for update to authenticated using (public.can_write_ws(workspace_id)) with check (public.can_write_ws(workspace_id));
create policy "follow-ups: creator or owner deletes" on public.follow_ups for delete to authenticated using (created_by = (select auth.uid()) or public.is_ws_owner(workspace_id));

create policy "fu logs: members read" on public.follow_up_logs for select to authenticated
  using (exists (select 1 from public.follow_ups f where f.id = follow_up_id and public.is_ws_member(f.workspace_id)));
create policy "fu logs: writers add" on public.follow_up_logs for insert to authenticated
  with check (author_id = (select auth.uid()) and exists (select 1 from public.follow_ups f where f.id = follow_up_id and public.can_write_ws(f.workspace_id)));

create policy "activity: members read" on public.activity for select to authenticated using (workspace_id is not null and public.is_ws_member(workspace_id));

create policy "notifications: own read" on public.notifications for select to authenticated using (user_id = (select auth.uid()));
create policy "notifications: own mark read" on public.notifications for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "notifications: own delete" on public.notifications for delete to authenticated using (user_id = (select auth.uid()));

revoke update, delete, insert on public.activity from anon, authenticated;

-- ---------- 19. grants on functions ----------
revoke execute on function public.ws_role(uuid), public.is_ws_member(uuid), public.can_write_ws(uuid), public.is_ws_owner(uuid),
  public.shares_workspace(uuid), public.can_see_task(uuid), public.can_write_task(uuid) from public, anon;
grant execute on function public.ws_role(uuid), public.is_ws_member(uuid), public.can_write_ws(uuid), public.is_ws_owner(uuid),
  public.shares_workspace(uuid), public.can_see_task(uuid), public.can_write_task(uuid) to authenticated;
revoke execute on function public.add_workspace_member(uuid, text, text), public.set_workspace_member_role(uuid, uuid, text),
  public.reopen_task(uuid, text, text), public.search_all(text) from public, anon;
grant execute on function public.add_workspace_member(uuid, text, text), public.set_workspace_member_role(uuid, uuid, text),
  public.reopen_task(uuid, text, text), public.search_all(text) to authenticated;
revoke execute on function public.tasks_before_write(), public.tasks_after_write(), public.task_dependencies_check(), public.task_comments_notify(),
  public.workspace_add_owner(), public.workspace_member_removed(), public.workspace_member_added(), public.generic_audit(),
  public.run_reminders(), public.actor_name(), public.follow_ups_before_write() from public, anon, authenticated;

-- ---------- 20. realtime ----------
alter publication supabase_realtime add table public.follow_ups, public.follow_up_logs, public.projects, public.milestones, public.task_dependencies, public.contacts;

-- ---------- 21. data: Personal & Family workspace for existing users, workspace kinds ----------
update public.workspaces set kind = 'professional' where name ilike 'qcloud%';
insert into public.workspaces (owner_id, name, color, kind, sort)
select id, 'Personal & Family', '#5f6b78', 'personal', 10 from auth.users
where not exists (select 1 from public.workspaces w where w.owner_id = auth.users.id and w.kind = 'personal');
