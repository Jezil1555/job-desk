-- Phase 1 database tests. Runs in ONE transaction and ROLLS BACK: no data persists.
-- Two throwaway users (A = owner, B = outsider/viewer/member) exercise rules and row-level security.
-- Run with:  psql "$DATABASE_URL" -f supabase/tests/phase1_tests.sql   (or paste into the SQL editor)
begin;
create temp table r (n serial, name text, ok boolean, detail text);
create temp table ids (k text primary key, v uuid);
grant all on r, ids to authenticated, anon;
grant usage, select on sequence r_n_seq to authenticated, anon;

insert into auth.users (id, email, aud, role, instance_id, raw_user_meta_data) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'test-a@example.invalid', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{"display_name":"Tester A"}'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'test-b@example.invalid', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{"display_name":"Tester B"}');
insert into r(name, ok) select 'profiles auto-created for new users', count(*) = 2 from public.profiles where email like 'test-_@example.invalid';

-- ===== as A =====
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-00000000000a","role":"authenticated"}', true);
with w as (insert into public.workspaces (name, owner_id) values ('T workspace', 'aaaaaaaa-0000-4000-8000-00000000000a') returning id) insert into ids select 'ws', id from w;
insert into r(name, ok) select 'owner membership created automatically', exists (select 1 from public.workspace_members where workspace_id = (select v from ids where k='ws') and role = 'owner');

with t as (insert into public.tasks (workspace_id, title) values ((select v from ids where k='ws'), 'Captured, no deadline') returning id, due_at, status, priority, owner_id)
insert into ids select 'plain', id from t;
insert into r(name, ok, detail) select 'task saved without a deadline, defaults applied', due_at is null and status = 'not_started' and priority = 'medium' and owner_id = 'aaaaaaaa-0000-4000-8000-00000000000a', status from public.tasks where id = (select v from ids where k='plain');

-- completion criteria
with t as (insert into public.tasks (workspace_id, title, completion_criteria) values ((select v from ids where k='ws'), 'Has criteria', '[{"text":"Supplier response recorded","done":false}]') returning id) insert into ids select 'crit', id from t;
do $$ begin update public.tasks set status = 'completed' where id = (select v from ids where k='crit'); insert into r(name, ok) values ('unticked criteria block completion', false);
exception when others then insert into r(name, ok, detail) values ('unticked criteria block completion', sqlerrm like 'criteria_incomplete%', sqlerrm); end $$;
update public.tasks set completion_criteria = '[{"text":"Supplier response recorded","done":true}]', status = 'completed' where id = (select v from ids where k='crit');
insert into r(name, ok) select 'ticked criteria allow completion and set completed_at', status = 'completed' and completed_at is not null and progress = 100 from public.tasks where id = (select v from ids where k='crit');

-- subtasks
with t as (insert into public.tasks (workspace_id, title) values ((select v from ids where k='ws'), 'Parent') returning id) insert into ids select 'parent', id from t;
insert into public.tasks (workspace_id, title, parent_id) values ((select v from ids where k='ws'), 'Child', (select v from ids where k='parent'));
do $$ begin update public.tasks set status = 'completed' where id = (select v from ids where k='parent'); insert into r(name, ok) values ('open subtask blocks parent completion', false);
exception when others then insert into r(name, ok, detail) values ('open subtask blocks parent completion', sqlerrm like 'subtasks_incomplete%', sqlerrm); end $$;

-- dependencies
with t as (insert into public.tasks (workspace_id, title) values ((select v from ids where k='ws'), 'Prerequisite') returning id) insert into ids select 'pre', id from t;
with t as (insert into public.tasks (workspace_id, title) values ((select v from ids where k='ws'), 'Dependent') returning id) insert into ids select 'dep', id from t;
insert into public.task_dependencies (task_id, depends_on_id) values ((select v from ids where k='dep'), (select v from ids where k='pre'));
do $$ begin update public.tasks set status = 'completed' where id = (select v from ids where k='dep'); insert into r(name, ok) values ('open prerequisite blocks completion', false);
exception when others then insert into r(name, ok, detail) values ('open prerequisite blocks completion', sqlerrm like 'dependencies_incomplete%', sqlerrm); end $$;
do $$ begin insert into public.task_dependencies (task_id, depends_on_id) values ((select v from ids where k='pre'), (select v from ids where k='dep')); insert into r(name, ok) values ('circular dependency rejected', false);
exception when others then insert into r(name, ok, detail) values ('circular dependency rejected', sqlerrm like 'dependency_cycle%', sqlerrm); end $$;

-- waiting / blocked / cancelled need details
do $$ begin update public.tasks set status = 'waiting' where id = (select v from ids where k='plain'); insert into r(name, ok) values ('waiting requires who', false);
exception when others then insert into r(name, ok, detail) values ('waiting requires who', sqlerrm like 'waiting_needs_person%', sqlerrm); end $$;
do $$ begin update public.tasks set status = 'blocked' where id = (select v from ids where k='plain'); insert into r(name, ok) values ('blocked requires a blocker', false);
exception when others then insert into r(name, ok, detail) values ('blocked requires a blocker', sqlerrm like 'blocked_needs_reason%', sqlerrm); end $$;
do $$ begin update public.tasks set status = 'cancelled' where id = (select v from ids where k='plain'); insert into r(name, ok) values ('cancelling requires a reason', false);
exception when others then insert into r(name, ok, detail) values ('cancelling requires a reason', sqlerrm like 'cancel_reason_required%', sqlerrm); end $$;
update public.tasks set status = 'waiting', waiting_on = 'Supplier', follow_up_at = now() + interval '2 days' where id = (select v from ids where k='plain');
insert into r(name, ok) select 'waiting with a person and follow-up date is accepted', status = 'waiting' from public.tasks where id = (select v from ids where k='plain');

-- reopen needs a reason; history preserved
do $$ begin update public.tasks set status = 'in_progress' where id = (select v from ids where k='crit'); insert into r(name, ok) values ('reopen without reason rejected', false);
exception when others then insert into r(name, ok, detail) values ('reopen without reason rejected', sqlerrm like 'reopen_reason_required%', sqlerrm); end $$;
select public.reopen_task((select v from ids where k='crit'), 'Customer rejected delivery', 'in_progress');
insert into r(name, ok) select 'reopen_task with reason reopens and clears completed_at', status = 'in_progress' and completed_at is null from public.tasks where id = (select v from ids where k='crit');
insert into r(name, ok, detail) select 'reopen reason kept in activity history', count(*) = 1, max(note) from public.activity where entity_id = (select v from ids where k='crit') and action = 'reopened' and note = 'Customer rejected delivery';
insert into r(name, ok) select 'completion also kept in history', exists (select 1 from public.activity where entity_id = (select v from ids where k='crit') and action = 'completed');

-- soft delete is audited
update public.tasks set deleted_at = now() where id = (select v from ids where k='dep');
insert into r(name, ok) select 'soft delete recorded as "deleted" in audit log', exists (select 1 from public.activity where entity_id = (select v from ids where k='dep') and action = 'deleted');

-- activity log is append-only for users
do $$ begin delete from public.activity where entity_id = (select v from ids where k='crit'); insert into r(name, ok) values ('users cannot delete audit history', false);
exception when others then insert into r(name, ok, detail) values ('users cannot delete audit history', true, sqlerrm); end $$;

-- project health: critical milestone overdue -> blocked; weighted progress
with p as (insert into public.projects (workspace_id, name, start_date, target_date) values ((select v from ids where k='ws'), 'T project', current_date - 30, current_date + 30) returning id) insert into ids select 'proj', id from p;
insert into public.milestones (project_id, title, planned_date, actual_date, weight) values ((select v from ids where k='proj'), 'Done one', current_date - 10, current_date - 9, 1);
insert into public.milestones (project_id, title, planned_date, weight, is_critical) values ((select v from ids where k='proj'), 'Customs', current_date - 2, 3, true);
insert into r(name, ok, detail) select 'critical overdue milestone makes project Blocked', calculated_status = 'blocked', calculated_status || ' / ' || array_to_string(reasons, '; ') from public.project_health where project_id = (select v from ids where k='proj');
insert into r(name, ok, detail) select 'progress weighted by completed milestones (1 of 4 = 25%)', progress = 25 and progress_basis = 'milestones', progress::text from public.project_health where project_id = (select v from ids where k='proj');
do $$ begin update public.projects set manual_status = 'on_track' where id = (select v from ids where k='proj'); insert into r(name, ok) values ('manual project status requires a reason', false);
exception when others then insert into r(name, ok, detail) values ('manual project status requires a reason', true, sqlerrm); end $$;
update public.projects set manual_status = 'on_track', manual_status_reason = 'Customs cleared verbally, paperwork pending' where id = (select v from ids where k='proj');
insert into r(name, ok) select 'manual override shown, calculated status kept separately', effective_status = 'on_track' and calculated_status = 'blocked' from public.project_health where project_id = (select v from ids where k='proj');

-- recurrence creates exactly one next occurrence
with t as (insert into public.tasks (workspace_id, title, recurrence, due_at) values ((select v from ids where k='ws'), 'Weekly report', 'weekly', now() - interval '1 hour') returning id) insert into ids select 'rec', id from t;
update public.tasks set status = 'completed' where id = (select v from ids where k='rec');
insert into r(name, ok, detail) select 'completing a weekly task creates one next occurrence 7 days later', count(*) = 1 and bool_and(due_at > now() + interval '6 days'), count(*)::text from public.tasks where recurrence_parent_id = (select v from ids where k='rec');

-- owner must be a workspace member
do $$ begin update public.tasks set owner_id = 'bbbbbbbb-0000-4000-8000-00000000000b' where id = (select v from ids where k='plain'); insert into r(name, ok) values ('owner must be a workspace member', false);
exception when others then insert into r(name, ok, detail) values ('owner must be a workspace member', sqlerrm like 'owner_not_member%', sqlerrm); end $$;

-- follow-up for reminder tests
with f as (insert into public.follow_ups (workspace_id, subject, counterpart, next_follow_up_at, escalate_at) values ((select v from ids where k='ws'), 'Dispatch date', 'Al Muthawa', now() - interval '1 hour', current_date - 1) returning id) insert into ids select 'fu', id from f;
do $$ begin insert into public.follow_ups (workspace_id, subject) values ((select v from ids where k='ws'), 'No party'); insert into r(name, ok) values ('follow-up needs a contact or counterpart', false);
exception when others then insert into r(name, ok, detail) values ('follow-up needs a contact or counterpart', true, sqlerrm); end $$;
with t as (insert into public.tasks (workspace_id, title, due_at) values ((select v from ids where k='ws'), 'Overdue one', now() - interval '3 hours') returning id) insert into ids select 'over', id from t;
with t as (insert into public.tasks (workspace_id, title, due_at) values ((select v from ids where k='ws'), 'Due soon', now() + interval '5 hours') returning id) insert into ids select 'soon', id from t;

-- ===== as B (outsider) =====
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-00000000000b","role":"authenticated"}', true);
insert into r(name, ok) select 'outsider sees no tasks in the workspace', count(*) = 0 from public.tasks where workspace_id = (select v from ids where k='ws');
insert into r(name, ok) select 'outsider sees no workspace, projects, follow-ups or activity', (select count(*) from public.workspaces where id = (select v from ids where k='ws')) + (select count(*) from public.projects where workspace_id = (select v from ids where k='ws')) + (select count(*) from public.follow_ups where workspace_id = (select v from ids where k='ws')) + (select count(*) from public.activity where workspace_id = (select v from ids where k='ws')) = 0;
insert into r(name, ok) select 'outsider sees no project health', count(*) = 0 from public.project_health where workspace_id = (select v from ids where k='ws');
insert into r(name, ok) select 'outsider search finds nothing', count(*) = 0 from public.search_all('Captured');
with u as (update public.tasks set title = 'hacked' where id = (select v from ids where k='plain') returning 1) insert into r(name, ok) select 'outsider update changes nothing', count(*) = 0 from u;
do $$ begin insert into public.tasks (workspace_id, title) values ((select v from ids where k='ws'), 'intruder'); insert into r(name, ok) values ('outsider cannot insert into the workspace', false);
exception when others then insert into r(name, ok, detail) values ('outsider cannot insert into the workspace', true, sqlerrm); end $$;
do $$ begin perform public.add_workspace_member((select v from ids where k='ws'), 'test-b@example.invalid', 'member'); insert into r(name, ok) values ('outsider cannot add themselves', false);
exception when others then insert into r(name, ok, detail) values ('outsider cannot add themselves', sqlerrm like 'not_owner%', sqlerrm); end $$;
insert into r(name, ok) select 'outsider cannot read the owner''s notifications', count(*) = 0 from public.notifications where user_id = 'aaaaaaaa-0000-4000-8000-00000000000a';

-- ===== A adds B as viewer =====
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select public.add_workspace_member((select v from ids where k='ws'), 'TEST-B@example.invalid', 'viewer');
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-00000000000b","role":"authenticated"}', true);
insert into r(name, ok) select 'viewer can read tasks', count(*) > 0 from public.tasks where workspace_id = (select v from ids where k='ws');
with u as (update public.tasks set title = 'viewer edit' where id = (select v from ids where k='plain') returning 1) insert into r(name, ok) select 'viewer cannot edit tasks', count(*) = 0 from u;
do $$ begin insert into public.task_comments (task_id, body) values ((select v from ids where k='plain'), 'viewer comment'); insert into r(name, ok) values ('viewer cannot comment', false);
exception when others then insert into r(name, ok, detail) values ('viewer cannot comment', true, sqlerrm); end $$;
insert into r(name, ok) select 'viewer was notified when added', count(*) = 1 from public.notifications where user_id = 'bbbbbbbb-0000-4000-8000-00000000000b' and kind = 'added';

-- ===== A promotes B to member =====
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select public.set_workspace_member_role((select v from ids where k='ws'), 'bbbbbbbb-0000-4000-8000-00000000000b', 'member');
insert into r(name, ok) select 'role change recorded in audit log', exists (select 1 from public.activity where workspace_id = (select v from ids where k='ws') and action = 'role_changed');
update public.tasks set owner_id = 'bbbbbbbb-0000-4000-8000-00000000000b' where id = (select v from ids where k='plain');
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-00000000000b","role":"authenticated"}', true);
insert into r(name, ok) select 'assignee notified of assignment', count(*) = 1 from public.notifications where user_id = 'bbbbbbbb-0000-4000-8000-00000000000b' and kind = 'assigned';
insert into public.task_comments (task_id, body) values ((select v from ids where k='plain'), 'Called supplier, reply Sunday');
insert into r(name, ok) select 'member can log updates', count(*) = 1 from public.task_comments where body = 'Called supplier, reply Sunday';
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-00000000000a","role":"authenticated"}', true);
insert into r(name, ok) select 'creator notified when someone else logs an update', count(*) = 1 from public.notifications where user_id = 'aaaaaaaa-0000-4000-8000-00000000000a' and kind = 'update';

-- ===== anonymous =====
reset role;
set local role anon;
insert into r(name, ok) select 'signed-out visitor sees nothing', (select count(*) from public.tasks) + (select count(*) from public.workspaces) + (select count(*) from public.profiles) = 0;

-- ===== reminders (scheduled job runs as the database owner) =====
reset role;
select set_config('request.jwt.claims', null, true);
create temp table run1 as select public.run_reminders() as res;
create temp table run2 as select public.run_reminders() as res;
insert into r(name, ok, detail) select 'overdue reminder sent once (not duplicated on re-run)', count(*) = 1, count(*)::text from public.notifications where task_id = (select v from ids where k='over') and kind = 'overdue';
insert into r(name, ok, detail) select 'due-soon reminder sent once', count(*) = 1, count(*)::text from public.notifications where task_id = (select v from ids where k='soon') and kind = 'due_soon';
insert into r(name, ok, detail) select 'follow-up reminder sent once', count(*) = 1, count(*)::text from public.notifications where follow_up_id = (select v from ids where k='fu') and kind = 'follow_up';
insert into r(name, ok, detail) select 'escalation fires once and marks Escalated', (select count(*) from public.notifications where follow_up_id = (select v from ids where k='fu') and kind = 'escalation') = 1 and (select status from public.follow_ups where id = (select v from ids where k='fu')) = 'escalated', (select res::text from run2);
update public.tasks set due_at = now() + interval '3 hours' where id = (select v from ids where k='soon');
select public.run_reminders();
insert into r(name, ok) select 'moving a deadline re-arms its reminder', count(*) = 2 from public.notifications where task_id = (select v from ids where k='soon') and kind = 'due_soon';

select n, ok, name, detail from r order by n;
rollback;
