-- Phase 2 database tests (notes, documents, links, private storage, goals/habits/health, weekly reviews).
-- Runs in ONE transaction and ROLLS BACK: no data persists. Three throwaway users:
--   A = workspace owner, B = viewer in A's workspace, C = outsider.
-- Run with:  psql "$DATABASE_URL" -f supabase/tests/phase2_tests.sql   (or paste into the SQL editor)
begin;
create temp table r (n serial, name text, ok boolean, detail text);
create temp table ids (k text primary key, v uuid);
grant all on r, ids to authenticated, anon;
grant usage, select on sequence r_n_seq to authenticated, anon;

insert into auth.users (id, email, aud, role, instance_id, raw_user_meta_data) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'test2-a@example.invalid', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{"display_name":"Tester A"}'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'test2-b@example.invalid', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{"display_name":"Tester B"}'),
  ('cccccccc-0000-4000-8000-00000000000c', 'test2-c@example.invalid', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{"display_name":"Tester C"}');

-- ===== as A (owner) =====
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-00000000000a","role":"authenticated"}', true);
with w as (insert into public.workspaces (name, owner_id) values ('T2 workspace', 'aaaaaaaa-0000-4000-8000-00000000000a') returning id) insert into ids select 'ws', id from w;
with w as (insert into public.workspaces (name, owner_id) values ('T2 other', 'aaaaaaaa-0000-4000-8000-00000000000a') returning id) insert into ids select 'ws2', id from w;
select public.add_workspace_member((select v from ids where k='ws'), 'test2-b@example.invalid', 'viewer');
with t as (insert into public.tasks (workspace_id, title) values ((select v from ids where k='ws'), 'Book container') returning id) insert into ids select 'task', id from t;
with t as (insert into public.tasks (workspace_id, title) values ((select v from ids where k='ws2'), 'Other workspace task') returning id) insert into ids select 'task2', id from t;

with n as (insert into public.notes (workspace_id, kind, title, body, meeting_date, tags) values ((select v from ids where k='ws'), 'meeting', 'Logistics review', '- [ ] Send PO @B', current_date, '{customs,ksa}') returning id) insert into ids select 'note', id from n;
insert into r(name, ok) select 'meeting note saved, author recorded', created_by = 'aaaaaaaa-0000-4000-8000-00000000000a' from public.notes where id = (select v from ids where k='note');
insert into r(name, ok) select 'note searchable by body and tags (full-text)', exists (select 1 from public.search_all('customs') where kind = 'note') and exists (select 1 from public.search_all('Logistics') where kind = 'note');
do $$ begin insert into public.notes (workspace_id, kind, title) values ((select v from ids where k='ws'), 'decision', 'No decision text'); insert into r(name, ok) values ('decision record requires the decision', false);
exception when others then insert into r(name, ok, detail) values ('decision record requires the decision', true, sqlerrm); end $$;
insert into public.notes (workspace_id, kind, title, decision, decision_status, decided_on) values ((select v from ids where k='ws'), 'decision', 'Use sea freight', 'Move KSA lane to sea', 'decided', current_date);
insert into r(name, ok) select 'decision with text accepted', count(*) = 1 from public.notes where title = 'Use sea freight';

-- documents + storage
with d as (insert into public.documents (workspace_id, title, kind, storage_path, mime_type, size_bytes, category)
  values ((select v from ids where k='ws'), 'BOL', 'file', (select v from ids where k='ws')::text || '/x1/bol.pdf', 'application/pdf', 1000, 'delivery') returning id) insert into ids select 'doc', id from d;
insert into r(name, ok) select 'document recorded', count(*) = 1 from public.documents where id = (select v from ids where k='doc');
do $$ begin insert into public.documents (workspace_id, title, kind, storage_path) values ((select v from ids where k='ws'), 'Wrong folder', 'file', (select v from ids where k='ws2')::text || '/x/a.pdf'); insert into r(name, ok) values ('file path must sit in its own workspace folder', false);
exception when others then insert into r(name, ok, detail) values ('file path must sit in its own workspace folder', true, sqlerrm); end $$;
do $$ begin insert into public.documents (workspace_id, title, kind, url) values ((select v from ids where k='ws'), 'Bad link', 'link', 'javascript:alert(1)'); insert into r(name, ok) values ('only http(s) links accepted', false);
exception when others then insert into r(name, ok, detail) values ('only http(s) links accepted', true, sqlerrm); end $$;
insert into storage.objects (bucket_id, name, owner) values ('documents', (select v from ids where k='ws')::text || '/x1/bol.pdf', 'aaaaaaaa-0000-4000-8000-00000000000a');
insert into r(name, ok) select 'owner can upload into own workspace folder', count(*) = 1 from storage.objects where bucket_id = 'documents' and name like (select v from ids where k='ws')::text || '/%';
insert into r(name, ok) select 'documents bucket is private', not public from storage.buckets where id = 'documents';

-- links
insert into public.record_links (workspace_id, from_type, from_id, to_type, to_id) values ((select v from ids where k='ws'), 'note', (select v from ids where k='note'), 'task', (select v from ids where k='task'));
insert into public.record_links (workspace_id, from_type, from_id, to_type, to_id) values ((select v from ids where k='ws'), 'document', (select v from ids where k='doc'), 'task', (select v from ids where k='task'));
insert into r(name, ok) select 'note and document linked to a task', count(*) = 2 from public.record_links where to_id = (select v from ids where k='task');
do $$ begin insert into public.record_links (workspace_id, from_type, from_id, to_type, to_id) values ((select v from ids where k='ws'), 'note', (select v from ids where k='note'), 'task', (select v from ids where k='task2')); insert into r(name, ok) values ('cross-workspace link rejected', false);
exception when others then insert into r(name, ok, detail) values ('cross-workspace link rejected', true, sqlerrm); end $$;
do $$ begin insert into public.record_links (workspace_id, from_type, from_id, to_type, to_id) values ((select v from ids where k='ws'), 'note', (select v from ids where k='note'), 'task', gen_random_uuid()); insert into r(name, ok) values ('link to a missing record rejected', false);
exception when others then insert into r(name, ok, detail) values ('link to a missing record rejected', true, sqlerrm); end $$;

-- private personal data
with g as (insert into public.goals (title, horizon, target_value, current_value, unit) values ('Lose 8 kg', 'yearly', 8, 2, 'kg') returning id) insert into ids select 'goal', id from g;
with h as (insert into public.habits (title) values ('Gym') returning id) insert into ids select 'habit', id from h;
insert into public.habit_logs (habit_id, log_date) values ((select v from ids where k='habit'), current_date);
insert into public.health_logs (log_date, kind, value, unit) values (current_date, 'weight', 82.4, 'kg');
insert into public.weekly_reviews (week_start, wins, snapshot) values (current_date, 'Shipped', '{"completed":3}');
insert into r(name, ok) select 'owner sees own goal, habit, check-in, health log and review',
  (select count(*) from public.goals) = 1 and (select count(*) from public.habits) = 1 and (select count(*) from public.habit_logs) = 1 and (select count(*) from public.health_logs) = 1 and (select count(*) from public.weekly_reviews) = 1;
do $$ begin insert into public.habit_logs (habit_id, log_date) values ((select v from ids where k='habit'), current_date + 5); insert into r(name, ok) values ('habit cannot be ticked days in the future', false);
exception when others then insert into r(name, ok, detail) values ('habit cannot be ticked days in the future', true, sqlerrm); end $$;
do $$ begin insert into public.weekly_reviews (week_start, wins) values (current_date, 'dup'); insert into r(name, ok) values ('one review per week', false);
exception when others then insert into r(name, ok, detail) values ('one review per week', true, sqlerrm); end $$;
insert into r(name, ok) select 'note and document changes are audited', count(*) >= 2 from public.activity where entity_type in ('note', 'document') and workspace_id = (select v from ids where k='ws');

-- ===== as B (viewer in the same workspace) =====
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-00000000000b","role":"authenticated"}', true);
insert into r(name, ok) select 'viewer can read workspace notes, documents and links',
  (select count(*) from public.notes where workspace_id = (select v from ids where k='ws')) = 2 and (select count(*) from public.documents) = 1 and (select count(*) from public.record_links) = 2;
insert into r(name, ok) select 'viewer can read the stored file (for a signed link)', count(*) = 1 from storage.objects where bucket_id = 'documents' and name like (select v from ids where k='ws')::text || '/%';
do $$ begin insert into public.notes (workspace_id, title) values ((select v from ids where k='ws'), 'Viewer note'); insert into r(name, ok) values ('viewer cannot add notes', false);
exception when others then insert into r(name, ok, detail) values ('viewer cannot add notes', sqlerrm like '%row-level security%', sqlerrm); end $$;
do $$ begin insert into storage.objects (bucket_id, name, owner) values ('documents', (select v from ids where k='ws')::text || '/x2/v.pdf', 'bbbbbbbb-0000-4000-8000-00000000000b'); insert into r(name, ok) values ('viewer cannot upload files', false);
exception when others then insert into r(name, ok, detail) values ('viewer cannot upload files', sqlerrm like '%row-level security%', sqlerrm); end $$;
-- storage rows can't be deleted with SQL (Supabase guard), so test the check the delete policy uses
insert into r(name, ok) select 'viewer fails the write check used by the file-delete policy', not public.can_write_ws((select v from ids where k='ws'));
with d as (delete from public.record_links returning 1) insert into r(name, ok) select 'viewer cannot remove links', count(*) = 0 from d;
insert into r(name, ok) select 'co-member cannot see another person''s goals, habits, check-ins, health logs or reviews',
  (select count(*) from public.goals) = 0 and (select count(*) from public.habits) = 0 and (select count(*) from public.habit_logs) = 0 and (select count(*) from public.health_logs) = 0 and (select count(*) from public.weekly_reviews) = 0;
do $$ begin insert into public.habit_logs (habit_id, log_date) values ((select v from ids where k='habit'), current_date - 1); insert into r(name, ok) values ('cannot tick someone else''s habit', false);
exception when others then insert into r(name, ok, detail) values ('cannot tick someone else''s habit', true, sqlerrm); end $$;
with u as (update public.goals set current_value = 8 returning 1) insert into r(name, ok) select 'cannot edit someone else''s goal', count(*) = 0 from u;

-- ===== as C (outsider) =====
select set_config('request.jwt.claims', '{"sub":"cccccccc-0000-4000-8000-00000000000c","role":"authenticated"}', true);
insert into r(name, ok) select 'outsider sees no notes, documents, links or files',
  (select count(*) from public.notes where workspace_id = (select v from ids where k='ws')) = 0 and (select count(*) from public.documents where workspace_id = (select v from ids where k='ws')) = 0
  and (select count(*) from public.record_links where workspace_id = (select v from ids where k='ws')) = 0 and (select count(*) from storage.objects where bucket_id = 'documents' and name like (select v from ids where k='ws')::text || '/%') = 0;
insert into r(name, ok) select 'outsider search returns nothing from the workspace', not exists (select 1 from public.search_all('Logistics'));
do $$ begin insert into storage.objects (bucket_id, name, owner) values ('documents', (select v from ids where k='ws')::text || '/x3/c.pdf', 'cccccccc-0000-4000-8000-00000000000c'); insert into r(name, ok) values ('outsider cannot upload into the workspace folder', false);
exception when others then insert into r(name, ok, detail) values ('outsider cannot upload into the workspace folder', sqlerrm like '%row-level security%', sqlerrm); end $$;

-- ===== anonymous =====
reset role; set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
do $$ declare c int; begin select count(*) into c from public.notes; insert into r(name, ok, detail) values ('anonymous visitors cannot read notes', c = 0, c::text);
exception when others then insert into r(name, ok, detail) values ('anonymous visitors cannot read notes', true, sqlerrm); end $$;
do $$ declare c int; begin select count(*) into c from storage.objects where bucket_id = 'documents'; insert into r(name, ok, detail) values ('anonymous visitors cannot list files', c = 0, c::text);
exception when others then insert into r(name, ok, detail) values ('anonymous visitors cannot list files', true, sqlerrm); end $$;
do $$ declare c int; begin select count(*) into c from public.goals; insert into r(name, ok, detail) values ('anonymous visitors cannot read goals', c = 0, c::text);
exception when others then insert into r(name, ok, detail) values ('anonymous visitors cannot read goals', true, sqlerrm); end $$;

-- ===== cleanup trigger: deleting a task removes its links =====
reset role; set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-00000000000a","role":"authenticated"}', true);
delete from public.tasks where id = (select v from ids where k='task');
insert into r(name, ok) select 'deleting a task removes its links', count(*) = 0 from public.record_links where to_id = (select v from ids where k='task');

reset role;
select n, ok, name, detail from r order by n;
rollback;
