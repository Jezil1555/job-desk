-- Increment 1 tests (run after the migration, inside a transaction that is rolled back).
create temp table r (name text, ok boolean, detail text);
create temp table ids (k text primary key, v uuid);
grant all on r, ids to authenticated;
create or replace function pg_temp.err(p_name text, p_sql text, p_code text) returns void language plpgsql as $$
begin execute p_sql; insert into r values (p_name, false, 'no error');
exception when others then insert into r values (p_name, sqlerrm like p_code || '%', sqlerrm); end $$;
grant execute on function pg_temp.err(text, text, text) to authenticated;
create or replace function pg_temp.id(k text) returns uuid language sql stable as $$ select v from ids where ids.k = $1 $$;
grant execute on function pg_temp.id(text) to authenticated;
create or replace function pg_temp.as_user(u text) returns void language sql as $$ select set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true) $$;
grant execute on function pg_temp.as_user(text) to authenticated;
insert into auth.users (id, email, aud, role, instance_id) values
 ('aaaaaaaa-0000-4000-8000-0000000001a1','i1a@example.invalid','authenticated','authenticated','00000000-0000-0000-0000-000000000000'),
 ('bbbbbbbb-0000-4000-8000-0000000001b1','i1b@example.invalid','authenticated','authenticated','00000000-0000-0000-0000-000000000000'),
 ('cccccccc-0000-4000-8000-0000000001c1','i1c@example.invalid','authenticated','authenticated','00000000-0000-0000-0000-000000000000'),
 ('dddddddd-0000-4000-8000-0000000001d1','i1d@example.invalid','authenticated','authenticated','00000000-0000-0000-0000-000000000000');
with w as (insert into public.workspaces (name, owner_id) values ('I1 WS', 'aaaaaaaa-0000-4000-8000-0000000001a1') returning id) insert into ids select 'ws', id from w;
insert into public.workspace_members (workspace_id, user_id, role) values (pg_temp.id('ws'), 'aaaaaaaa-0000-4000-8000-0000000001a1', 'owner'),
  (pg_temp.id('ws'), 'bbbbbbbb-0000-4000-8000-0000000001b1', 'member'), (pg_temp.id('ws'), 'cccccccc-0000-4000-8000-0000000001c1', 'member') on conflict do nothing;
with p as (insert into public.projects (workspace_id, name) values (pg_temp.id('ws'), 'P1') returning id) insert into ids select 'p1', id from p;
with p as (insert into public.projects (workspace_id, name) values (pg_temp.id('ws'), 'P2') returning id) insert into ids select 'p2', id from p;

set local role authenticated;
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-0000000001a1');
select pg_temp.err('assignee must be a workspace member', format('insert into public.tasks (workspace_id, title, assignee_id) values (%L, $q$x$q$, $q$dddddddd-0000-4000-8000-0000000001d1$q$)', pg_temp.id('ws')), 'assignee_not_member');
select pg_temp.err('reviewer can''t be the person doing the work', format('insert into public.tasks (workspace_id, title, assignee_id, reviewer_id) values (%L, $q$x$q$, $q$bbbbbbbb-0000-4000-8000-0000000001b1$q$, $q$bbbbbbbb-0000-4000-8000-0000000001b1$q$)', pg_temp.id('ws')), 'self_review');
select pg_temp.err('owner can''t review own unassigned task', format('insert into public.tasks (workspace_id, title, reviewer_id) values (%L, $q$x$q$, $q$aaaaaaaa-0000-4000-8000-0000000001a1$q$)', pg_temp.id('ws')), 'self_review');
with t as (insert into public.tasks (workspace_id, project_id, title, assignee_id, reviewer_id, review_status) values (pg_temp.id('ws'), pg_temp.id('p1'), 'Customs docs pack',
  'bbbbbbbb-0000-4000-8000-0000000001b1', 'cccccccc-0000-4000-8000-0000000001c1', 'approved') returning id) insert into ids select 't', id from t;
insert into r select 'review state can''t be set when creating a task', review_status is null, review_status from public.tasks where id = pg_temp.id('t');
update public.tasks set project_id = pg_temp.id('p2') where id = pg_temp.id('t');
insert into r select 'changing project keeps owner, assignee and reviewer', owner_id = 'aaaaaaaa-0000-4000-8000-0000000001a1' and assignee_id = 'bbbbbbbb-0000-4000-8000-0000000001b1' and reviewer_id = 'cccccccc-0000-4000-8000-0000000001c1', null from public.tasks where id = pg_temp.id('t');
select pg_temp.err('task with a reviewer can''t be completed without approval', format('update public.tasks set status = $q$completed$q$ where id = %L', pg_temp.id('t')), 'review_required');
select pg_temp.err('review state can''t be edited directly', format('update public.tasks set review_status = $q$approved$q$ where id = %L', pg_temp.id('t')), 'review_via_function');
select pg_temp.as_user('bbbbbbbb-0000-4000-8000-0000000001b1');
select public.request_task_review(pg_temp.id('t'), 'All 6 documents attached');
select pg_temp.err('only the reviewer can approve', format('select public.review_task(%L, $q$approve$q$)', pg_temp.id('t')), 'not_reviewer');
select pg_temp.as_user('cccccccc-0000-4000-8000-0000000001c1');
select pg_temp.err('asking for changes needs a note', format('select public.review_task(%L, $q$changes$q$, $q$$q$)', pg_temp.id('t')), 'note_required');
select public.review_task(pg_temp.id('t'), 'changes', 'COO certificate missing');
insert into r select 'changes requested: back in progress', t.status = 'in_progress' and t.review_status = 'changes_requested', t.status from public.tasks t where id = pg_temp.id('t');
select pg_temp.as_user('bbbbbbbb-0000-4000-8000-0000000001b1');
select public.request_task_review(pg_temp.id('t'), 'COO added');
select pg_temp.as_user('cccccccc-0000-4000-8000-0000000001c1');
select public.review_task(pg_temp.id('t'), 'approve', null);
insert into r select 'approval completes the task and records who approved', status = 'completed' and review_status = 'approved' and reviewed_by = 'cccccccc-0000-4000-8000-0000000001c1' and completed_at is not null, status from public.tasks where id = pg_temp.id('t');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-0000000001a1');
select public.reopen_task(pg_temp.id('t'), 'Customer asked for amended invoice');
insert into r select 'reopening clears the approval', review_status is null and status = 'in_progress', review_status from public.tasks where id = pg_temp.id('t');
update public.tasks set assignee_id = 'cccccccc-0000-4000-8000-0000000001c1', reviewer_id = 'bbbbbbbb-0000-4000-8000-0000000001b1' where id = pg_temp.id('t');
insert into r select 'history records delegation with old and new people', exists (select 1 from public.activity where entity_id = pg_temp.id('t') and action = 'delegated'
  and changes->'assignee_id' = '["bbbbbbbb-0000-4000-8000-0000000001b1","cccccccc-0000-4000-8000-0000000001c1"]'), null;
insert into r select 'history records review requested, changes and approval', (select count(*) from public.activity where entity_id = pg_temp.id('t') and action in ('review_requested','changes_requested','completed')) >= 4, null;
with t as (insert into public.tasks (workspace_id, title) values (pg_temp.id('ws'), 'No reviewer') returning id) insert into ids select 't2', id from t;
update public.tasks set status = 'completed' where id = pg_temp.id('t2');
insert into r select 'tasks without a reviewer complete as before', status = 'completed', status from public.tasks where id = pg_temp.id('t2');
select pg_temp.as_user('dddddddd-0000-4000-8000-0000000001d1');
select pg_temp.err('outsiders can''t request review', format('select public.request_task_review(%L)', pg_temp.id('t')), 'not_found');
reset role;
-- notifications are private to each person, so check them as admin
insert into r select 'assignee is notified', count(*) >= 1, null from public.notifications where task_id = pg_temp.id('t') and user_id = 'bbbbbbbb-0000-4000-8000-0000000001b1' and kind = 'assigned';
insert into r select 'reviewer is notified when review is requested', count(*) = 2, count(*)::text from public.notifications where task_id = pg_temp.id('t') and user_id = 'cccccccc-0000-4000-8000-0000000001c1' and kind = 'review';
insert into r select 'assignee is told when changes are requested', count(*) = 1, count(*)::text from public.notifications where task_id = pg_temp.id('t') and user_id = 'bbbbbbbb-0000-4000-8000-0000000001b1' and kind = 'review';
