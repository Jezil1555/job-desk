-- Rollback support (used by every migration from here on): before a function is replaced, its current definition is
-- saved here so the matching script in supabase/rollback/ can restore it exactly.
create table if not exists private.migration_snapshots (
  migration text not null, object text not null, definition text not null, saved_at timestamptz not null default now(),
  primary key (migration, object)
);
revoke all on private.migration_snapshots from public, anon, authenticated;
insert into private.migration_snapshots (migration, object, definition) values
  ('20261030200000', 'public.tasks_before_write()', pg_get_functiondef('public.tasks_before_write()'::regprocedure)),
  ('20261030200000', 'public.tasks_after_write()', pg_get_functiondef('public.tasks_after_write()'::regprocedure))
  on conflict do nothing;

-- Increment 1: task accountability. Optional assignee (who does the work) and reviewer (who signs it off), alongside the
-- responsible owner. A task with a reviewer can only be completed after the reviewer approves. All changes are logged in
-- activity (old → new), which is the task's delegation and status history. Changing project never changes people.

alter table public.tasks
  add column assignee_id uuid references auth.users(id) on delete set null,
  add column reviewer_id uuid references auth.users(id) on delete set null,
  add column review_status text check (review_status in ('requested','approved','changes_requested')),
  add column review_note text,
  add column reviewed_by uuid references auth.users(id) on delete set null,
  add column reviewed_at timestamptz;
create index tasks_assignee_open_idx on public.tasks(assignee_id) where status not in ('completed','cancelled') and deleted_at is null;
create index tasks_reviewer_idx on public.tasks(reviewer_id) where review_status = 'requested';

create or replace function public.tasks_before_write()
 returns trigger language plpgsql security definer set search_path to ''
as $function$
declare v_open int; v_reason text; v_flag text := coalesce(current_setting('app.task_review', true), '');
begin
  new.updated_at := now();
  new.title := trim(new.title);
  if new.owner_id is not null and not exists (select 1 from public.workspace_members where workspace_id = new.workspace_id and user_id = new.owner_id) then
    raise exception 'owner_not_member: the owner must be a member of this workspace';
  end if;
  if new.assignee_id is not null and not exists (select 1 from public.workspace_members where workspace_id = new.workspace_id and user_id = new.assignee_id) then
    raise exception 'assignee_not_member: the assignee must be a member of this workspace';
  end if;
  if new.reviewer_id is not null and not exists (select 1 from public.workspace_members where workspace_id = new.workspace_id and user_id = new.reviewer_id) then
    raise exception 'reviewer_not_member: the reviewer must be a member of this workspace';
  end if;
  if new.reviewer_id is not null and new.reviewer_id = coalesce(new.assignee_id, new.owner_id) then
    raise exception 'self_review: the reviewer must be someone other than the person doing the work';
  end if;
  -- review state changes only through request_task_review / review_task
  if tg_op = 'UPDATE' and v_flag <> 'on' and (new.review_status is distinct from old.review_status or new.reviewed_by is distinct from old.reviewed_by
       or new.reviewed_at is distinct from old.reviewed_at or new.review_note is distinct from old.review_note) then
    raise exception 'review_via_function: use Request review / Approve / Request changes';
  end if;
  if tg_op = 'INSERT' and v_flag <> 'on' then new.review_status := null; new.reviewed_by := null; new.reviewed_at := null; new.review_note := null; end if;
  if tg_op = 'UPDATE' and new.reviewer_id is distinct from old.reviewer_id and v_flag <> 'on' then
    new.review_status := null; new.reviewed_by := null; new.reviewed_at := null; new.review_note := null;
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
  if new.status = 'waiting' and char_length(coalesce(trim(new.waiting_on), '')) = 0 and new.waiting_on_contact_id is null then
    raise exception 'waiting_needs_person: say who you are waiting on';
  end if;
  if new.status = 'blocked' and char_length(coalesce(trim(new.blocker), '')) = 0 then
    raise exception 'blocked_needs_reason: describe what is blocking this task';
  end if;
  if new.status = 'completed' and (tg_op = 'INSERT' or old.status <> 'completed') then
    if exists (select 1 from jsonb_array_elements(new.completion_criteria) e where coalesce((e->>'done')::boolean, false) = false) then
      raise exception 'criteria_incomplete: tick every completion criterion before completing';
    end if;
    if new.reviewer_id is not null and new.review_status is distinct from 'approved' then
      raise exception 'review_required: this task needs the reviewer''s approval before it can be completed';
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
    if new.reviewer_id is not null then new.review_status := null; new.reviewed_by := null; new.reviewed_at := null; new.review_note := null; end if;
  end if;
  if new.status <> 'completed' and new.completed_at is not null and tg_op = 'INSERT' then new.completed_at := null; end if;
  if new.status = 'cancelled' and (tg_op = 'INSERT' or old.status <> 'cancelled') and char_length(coalesce(trim(new.cancelled_reason), '')) = 0 then
    raise exception 'cancel_reason_required: give a reason for cancelling';
  end if;
  if tg_op = 'UPDATE' then
    if new.due_at is distinct from old.due_at then new.overdue_notified_at := null; new.due_soon_for := null; end if;
    if new.follow_up_at is distinct from old.follow_up_at then new.followup_reminded_for := null; end if;
  end if;
  return new;
end $function$;

create or replace function public.tasks_after_write()
 returns trigger language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := (select auth.uid());
  v_changes jsonb := '{}'::jsonb;
  v_ws text; f text;
  v_fields text[] := array['title','status','priority','owner_id','assignee_id','reviewer_id','review_status','due_at','start_date','follow_up_at','project_id','workspace_id',
                           'parent_id','progress','next_action','waiting_on','blocker','category','recurrence','deleted_at','cancelled_reason'];
  o jsonb; nw jsonb;
begin
  select name into v_ws from public.workspaces where id = new.workspace_id;
  if tg_op = 'INSERT' then
    insert into public.activity (workspace_id, entity_type, entity_id, actor_id, action, changes)
    values (new.workspace_id, 'task', new.id, v_actor, 'created', jsonb_strip_nulls(jsonb_build_object('title', new.title, 'status', new.status, 'priority', new.priority,
      'owner_id', new.owner_id, 'assignee_id', new.assignee_id, 'reviewer_id', new.reviewer_id)));
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
                   when new.review_status is distinct from old.review_status and new.review_status = 'requested' then 'review_requested'
                   when new.review_status is distinct from old.review_status and new.review_status = 'changes_requested' then 'changes_requested'
                   when new.owner_id is distinct from old.owner_id or new.assignee_id is distinct from old.assignee_id or new.reviewer_id is distinct from old.reviewer_id then 'delegated'
                   else 'updated' end,
              v_changes,
              case when old.status = 'completed' and new.status <> 'completed' then nullif(current_setting('app.reopen_reason', true), '')
                   when new.review_note is distinct from old.review_note then new.review_note end);
    end if;
  end if;
  if new.recurrence is not null and new.status = 'completed' and (tg_op = 'INSERT' or old.status <> 'completed')
     and not exists (select 1 from public.tasks where recurrence_parent_id = new.id) then
    insert into public.tasks (workspace_id, project_id, parent_id, title, description, category, priority, owner_id, assignee_id, reviewer_id, created_by,
                              start_date, due_at, due_all_day, next_action, completion_criteria, recurrence, recurrence_parent_id, status, client_name, reference)
    values (new.workspace_id, new.project_id, new.parent_id, new.title, new.description, new.category, new.priority, new.owner_id, new.assignee_id, new.reviewer_id, new.created_by,
            (public.next_occurrence(new.start_date::timestamptz, new.recurrence))::date,
            public.next_occurrence(coalesce(new.due_at, now()), new.recurrence), new.due_all_day, new.next_action,
            coalesce((select jsonb_agg(e || '{"done": false}'::jsonb) from jsonb_array_elements(new.completion_criteria) e), '[]'::jsonb),
            new.recurrence, new.id, 'not_started', new.client_name, new.reference);
  end if;
  if new.deleted_at is null and new.owner_id is not null and new.owner_id is distinct from v_actor
     and (tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id) then
    insert into public.notifications (user_id, kind, title, body, url, task_id, workspace_id, actor_id)
    values (new.owner_id, 'assigned', public.actor_name() || ' made you responsible for a task', v_ws || ': ' || new.title, '/#/t/' || new.id, new.id, new.workspace_id, v_actor);
  end if;
  if new.deleted_at is null and new.assignee_id is not null and new.assignee_id is distinct from v_actor and new.assignee_id is distinct from new.owner_id
     and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id) then
    insert into public.notifications (user_id, kind, title, body, url, task_id, workspace_id, actor_id)
    values (new.assignee_id, 'assigned', public.actor_name() || ' assigned you a task', v_ws || ': ' || new.title, '/#/t/' || new.id, new.id, new.workspace_id, v_actor);
  end if;
  if tg_op = 'UPDATE' and new.review_status = 'requested' and old.review_status is distinct from 'requested' and new.reviewer_id is distinct from v_actor then
    insert into public.notifications (user_id, kind, title, body, url, task_id, workspace_id, actor_id)
    values (new.reviewer_id, 'review', public.actor_name() || ' asked you to review a task', v_ws || ': ' || new.title, '/#/t/' || new.id, new.id, new.workspace_id, v_actor);
  end if;
  if tg_op = 'UPDATE' and new.review_status = 'changes_requested' and old.review_status is distinct from 'changes_requested' then
    insert into public.notifications (user_id, kind, title, body, url, task_id, workspace_id, actor_id)
    select u, 'review', public.actor_name() || ' asked for changes', v_ws || ': ' || new.title || coalesce(' — ' || left(new.review_note, 120), ''), '/#/t/' || new.id, new.id, new.workspace_id, v_actor
    from (select distinct unnest(array[coalesce(new.assignee_id, new.owner_id), new.owner_id]) u) x where u is not null and u is distinct from v_actor;
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
end $function$;

-- Ask the reviewer to sign off (owner, assignee or any editor can ask).
create or replace function public.request_task_review(p_task uuid, p_note text default null) returns void language plpgsql security invoker set search_path = '' as $$
declare t public.tasks;
begin
  select * into t from public.tasks where id = p_task;
  if not found then raise exception 'not_found: task not found'; end if;
  if t.reviewer_id is null then raise exception 'no_reviewer: choose a reviewer first'; end if;
  if t.status in ('completed','cancelled') then raise exception 'closed: the task is already closed'; end if;
  perform set_config('app.task_review', 'on', true);
  update public.tasks set review_status = 'requested', review_note = nullif(trim(p_note), ''), reviewed_by = null, reviewed_at = null where id = p_task;
  if not found then raise exception 'forbidden: you can''t edit this task'; end if;
  perform set_config('app.task_review', 'off', true);
  insert into public.task_comments (task_id, body, kind) values (p_task, 'Review requested' || coalesce(': ' || nullif(trim(p_note), ''), ''), 'status');
end $$;

-- Reviewer's decision. Approving completes the task (all other completion rules still apply).
create or replace function public.review_task(p_task uuid, p_decision text, p_note text default null) returns void language plpgsql security invoker set search_path = '' as $$
declare t public.tasks;
begin
  select * into t from public.tasks where id = p_task;
  if not found then raise exception 'not_found: task not found'; end if;
  if t.reviewer_id is distinct from (select auth.uid()) then raise exception 'not_reviewer: only the reviewer can approve or ask for changes'; end if;
  if p_decision not in ('approve','changes') then raise exception 'bad_decision'; end if;
  if p_decision = 'changes' and char_length(coalesce(trim(p_note), '')) < 3 then raise exception 'note_required: say what needs to change'; end if;
  perform set_config('app.task_review', 'on', true);
  if p_decision = 'approve' then
    update public.tasks set review_status = 'approved', reviewed_by = (select auth.uid()), reviewed_at = now(), review_note = nullif(trim(p_note), ''), status = 'completed' where id = p_task;
  else
    update public.tasks set review_status = 'changes_requested', reviewed_by = (select auth.uid()), reviewed_at = now(), review_note = trim(p_note),
      status = case when status in ('completed','cancelled') then status else 'in_progress' end where id = p_task;
  end if;
  if not found then raise exception 'forbidden: you can''t edit this task'; end if;
  perform set_config('app.task_review', 'off', true);
  insert into public.task_comments (task_id, body, kind) values (p_task, case when p_decision = 'approve' then 'Approved' else 'Changes requested' end || coalesce(': ' || nullif(trim(p_note), ''), ''), 'status');
end $$;
revoke execute on function public.request_task_review(uuid, text), public.review_task(uuid, text, text) from public, anon;
grant execute on function public.request_task_review(uuid, text), public.review_task(uuid, text, text) to authenticated;
