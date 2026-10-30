-- Phase 4 tests (calendar feed, AI usage log). ONE transaction, ROLLED BACK. Throwaway users A and B.
begin;
create temp table r (n serial, name text, ok boolean, detail text);
create temp table ids (k text primary key, v uuid);
create temp table tok (k text primary key, v text);
grant all on r, ids, tok to authenticated, anon; grant usage, select on sequence r_n_seq to authenticated, anon;
insert into auth.users (id, email, aud, role, instance_id) values
  ('aaaaaaaa-0000-4000-8000-0000000000ca', 'cal-a@example.invalid', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('bbbbbbbb-0000-4000-8000-0000000000cb', 'cal-b@example.invalid', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');

-- data for A (as A) and B (as B)
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000ca","role":"authenticated"}', true);
with w as (insert into public.workspaces (name, owner_id) values ('Cal WS A', 'aaaaaaaa-0000-4000-8000-0000000000ca') returning id) insert into ids select 'wsa', id from w;
insert into public.tasks (workspace_id, title, due_at) values ((select v from ids where k='wsa'), 'Book container; urgent', now() + interval '2 days');
insert into public.tasks (workspace_id, title, status, waiting_on, follow_up_at) values ((select v from ids where k='wsa'), 'Customs BOE', 'waiting', 'Clearing agent', now() + interval '1 day');
insert into public.tasks (workspace_id, title, due_at) values ((select v from ids where k='wsa'), 'Already done task', now() + interval '3 days');
update public.tasks set status = 'completed' where title = 'Already done task';
insert into public.tasks (workspace_id, title) values ((select v from ids where k='wsa'), 'No date task');
insert into public.follow_ups (workspace_id, subject, counterpart, next_follow_up_at) values ((select v from ids where k='wsa'), 'Revised dispatch date', 'Al Muthawa', now() + interval '4 hours');
with p as (insert into public.projects (workspace_id, name) values ((select v from ids where k='wsa'), 'Kite BOM') returning id) insert into ids select 'proj', id from p;
insert into public.milestones (project_id, title, planned_date) values ((select v from ids where k='proj'), 'Customs clearance', current_date + 5);
with e as (insert into public.fin_entities (name, base_currency) values ('Cal books', 'QAR') returning id) insert into ids select 'ent', id from e;
with p as (insert into public.fin_parties (entity_id, name, kind) values ((select v from ids where k='ent'), 'Fabric House', 'supplier') returning id) insert into ids select 'supp', id from p;
with b as (insert into public.fin_invoices (entity_id, kind, party_id, issue_date, due_date) values ((select v from ids where k='ent'), 'purchase', (select v from ids where k='supp'), current_date, current_date + 3) returning id) insert into ids select 'bill', id from b;
insert into public.fin_invoice_lines (invoice_id, description, qty, unit_price, account_id) select (select v from ids where k='bill'), 'Fabric', 1, 400, id from public.fin_accounts where entity_id = (select v from ids where k='ent') and code = '6900';
select public.fin_post_invoice((select v from ids where k='bill'));
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-0000000000cb","role":"authenticated"}', true);
with w as (insert into public.workspaces (name, owner_id) values ('Cal WS B', 'bbbbbbbb-0000-4000-8000-0000000000cb') returning id) insert into ids select 'wsb', id from w;
insert into public.tasks (workspace_id, title, due_at) values ((select v from ids where k='wsb'), 'B private deadline', now() + interval '1 day');
insert into tok select 'b', public.create_calendar_feed(false);

-- A creates a feed
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000ca","role":"authenticated"}', true);
insert into tok select 'a', public.create_calendar_feed(false);
insert into r(name, ok, detail) select 'feed token is 64 hex characters', v ~ '^[a-f0-9]{64}$', length(v)::text from tok where k = 'a';
insert into r(name, ok) select 'only a hash of the token is stored', (select token_hash from public.calendar_feeds where user_id = 'aaaaaaaa-0000-4000-8000-0000000000ca') <> (select v from tok where k='a');
insert into r(name, ok) select 'a person sees only their own feed row', count(*) = 1 from public.calendar_feeds;
do $$ begin insert into public.calendar_feeds (user_id, token_hash) values ('aaaaaaaa-0000-4000-8000-0000000000ca', 'x'); insert into r(name, ok) values ('feed rows cannot be written directly', false);
exception when others then insert into r(name, ok, detail) values ('feed rows cannot be written directly', true, sqlerrm); end $$;
do $$ begin perform public.calendar_feed_events((select v from tok where k='a')); insert into r(name, ok) values ('signed-in users cannot read feeds by token', false);
exception when others then insert into r(name, ok, detail) values ('signed-in users cannot read feeds by token', sqlerrm like 'permission denied%', sqlerrm); end $$;
do $$ begin insert into public.ai_usage (user_id, action) values ('aaaaaaaa-0000-4000-8000-0000000000ca', 'x'); insert into r(name, ok) values ('usage log cannot be written by users', false);
exception when others then insert into r(name, ok, detail) values ('usage log cannot be written by users', true, sqlerrm); end $$;

-- the edge function (service role) reads the feed
reset role;
select set_config('request.jwt.claims', null, true);
create temp table feed as select public.calendar_feed_events((select v from tok where k='a')) as j;
insert into r(name, ok, detail) select 'feed contains my open deadline, follow-up, chase and milestone',
  (select count(*) from feed, jsonb_array_elements(j->'events') e where e->>'title' in ('Due: Book container; urgent', 'Follow up: Customs BOE', 'Milestone: Customs clearance — Kite BOM')) = 3
  and (select count(*) from feed, jsonb_array_elements(j->'events') e where e->>'title' like 'Chase: Revised dispatch date%') = 1,
  (select string_agg(e->>'title', ' | ') from feed, jsonb_array_elements(j->'events') e);
insert into r(name, ok) select 'feed excludes completed and undated tasks', not exists (select 1 from feed, jsonb_array_elements(j->'events') e where e->>'title' like '%Already done%' or e->>'title' like '%No date%');
insert into r(name, ok) select 'feed never includes another person''s tasks', not exists (select 1 from feed, jsonb_array_elements(j->'events') e where e->>'title' like '%B private%');
insert into r(name, ok) select 'bills are left out unless chosen', not exists (select 1 from feed, jsonb_array_elements(j->'events') e where e->>'title' like 'Bill due%');
insert into r(name, ok) select 'feed records when it was last fetched', last_used_at is not null from public.calendar_feeds where user_id = 'aaaaaaaa-0000-4000-8000-0000000000ca';
insert into r(name, ok) select 'wrong or empty token returns nothing', public.calendar_feed_events('0000000000000000000000000000000000000000000000000000000000000000') is null and public.calendar_feed_events(null) is null;
insert into r(name, ok) select 'B''s token shows only B''s items', (select count(*) from jsonb_array_elements(public.calendar_feed_events((select v from tok where k='b'))->'events') e where e->>'title' = 'Due: B private deadline') = 1
  and not exists (select 1 from jsonb_array_elements(public.calendar_feed_events((select v from tok where k='b'))->'events') e where e->>'title' like '%Book container%');

-- include bills; new link revokes the old one; turning off removes access
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000ca","role":"authenticated"}', true);
insert into tok select 'a2', public.create_calendar_feed(true);
reset role;
insert into r(name, ok) select 'making a new link stops the old one', public.calendar_feed_events((select v from tok where k='a')) is null;
insert into r(name, ok, detail) select 'with bills chosen, posted unpaid bills appear with the amount due', count(*) = 1, string_agg(e->>'description', ' | ')
  from jsonb_array_elements(public.calendar_feed_events((select v from tok where k='a2'))->'events') e where e->>'title' like 'Bill due: Fabric House BILL-0001' and e->>'description' like '%QAR 400.00 outstanding%';
set local role authenticated;
select public.revoke_calendar_feed();
reset role;
insert into r(name, ok) select 'turning the link off revokes it', public.calendar_feed_events((select v from tok where k='a2')) is null;
set local role anon;
do $$ begin perform public.create_calendar_feed(false); insert into r(name, ok) values ('signed-out visitors cannot create links', false);
exception when others then insert into r(name, ok, detail) values ('signed-out visitors cannot create links', true, sqlerrm); end $$;
reset role;
select count(*) filter (where ok) as passed, count(*) as total, json_agg(json_build_object('name', name, 'detail', detail)) filter (where not ok) as failures from r;
rollback;
