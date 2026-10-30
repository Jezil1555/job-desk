-- Increment 4 tests: run inside begin … rollback after the migration.
create temp table r (name text, ok boolean, detail text);
grant all on r to authenticated;
create or replace function pg_temp.err(p_name text, p_sql text, p_code text) returns void language plpgsql as $$
begin execute p_sql; insert into r values (p_name, false, 'no error');
exception when others then insert into r values (p_name, sqlerrm like p_code || '%', sqlerrm); end $$;
grant execute on function pg_temp.err(text, text, text) to authenticated;
insert into auth.users (id, email, aud, role, instance_id) values ('aaaaaaaa-0000-4000-8000-0000000004a4','i4a@example.invalid','authenticated','authenticated','00000000-0000-0000-0000-000000000000'),
 ('bbbbbbbb-0000-4000-8000-0000000004b4','i4b@example.invalid','authenticated','authenticated','00000000-0000-0000-0000-000000000000');
insert into public.ai_proposals (id, user_id, action, target_type, proposal) values
 ('0a000000-0000-4000-8000-0000000004a1','aaaaaaaa-0000-4000-8000-0000000004a4','draft_message','follow_up','{"text":"Hi, following up…"}'),
 ('0a000000-0000-4000-8000-0000000004a2','aaaaaaaa-0000-4000-8000-0000000004a4','action_items','note','{"items":[{"title":"Send PO"}]}'),
 ('0a000000-0000-4000-8000-0000000004a3','aaaaaaaa-0000-4000-8000-0000000004a4','categorize',null,'{"suggestions":[]}');
insert into public.ai_proposals (user_id, action, proposal, created_at) values ('aaaaaaaa-0000-4000-8000-0000000004a4','weekly_narrative','{"text":"old"}', now() - interval '20 days');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000004a4","role":"authenticated"}', true);
select pg_temp.err('users can''t create proposals themselves', $q$insert into public.ai_proposals (user_id, action, proposal) values ('aaaaaaaa-0000-4000-8000-0000000004a4','draft_message','{}')$q$, 'new row violates');
update public.ai_proposals set status = 'accepted' where id = '0a000000-0000-4000-8000-0000000004a1'; -- silently ignored by RLS
insert into r select 'direct edits change nothing', status = 'proposed', status from public.ai_proposals where id = '0a000000-0000-4000-8000-0000000004a1';
select public.record_ai_decision('0a000000-0000-4000-8000-0000000004a1', 'edited', '{"changed_chars":42}');
select public.record_ai_decision('0a000000-0000-4000-8000-0000000004a2', 'rejected');
select public.record_ai_decision('0a000000-0000-4000-8000-0000000004a3', 'accepted', '{"line":"x"}');
select public.record_ai_decision('0a000000-0000-4000-8000-0000000004a3', 'edited', '{"line":"y"}');
insert into r select 'decisions recorded with time and detail', (select status from public.ai_proposals where id = '0a000000-0000-4000-8000-0000000004a1') = 'edited'
  and (select status from public.ai_proposals where id = '0a000000-0000-4000-8000-0000000004a2') = 'rejected'
  and (select jsonb_array_length(decisions) from public.ai_proposals where id = '0a000000-0000-4000-8000-0000000004a3') = 2, null;
select pg_temp.err('unknown decision refused', $q$select public.record_ai_decision('0a000000-0000-4000-8000-0000000004a1', 'approved_by_ai')$q$, 'bad_decision');
select pg_temp.err('users can''t run expiry', $q$select public.expire_ai_proposals()$q$, 'permission denied');
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-0000000004b4","role":"authenticated"}', true);
insert into r select 'others can''t see someone''s AI history', count(*) = 0, null from public.ai_proposals;
select pg_temp.err('others can''t decide someone''s proposal', $q$select public.record_ai_decision('0a000000-0000-4000-8000-0000000004a1', 'accepted')$q$, 'not_found');
reset role;
select public.expire_ai_proposals();
insert into r select 'stale suggestions expire after 14 days', status = 'expired', status from public.ai_proposals where action = 'weekly_narrative' and user_id = 'aaaaaaaa-0000-4000-8000-0000000004a4';
insert into r select 'recent undecided suggestions stay open', count(*) = 0, null from public.ai_proposals where user_id = 'aaaaaaaa-0000-4000-8000-0000000004a4' and created_at > now() - interval '1 day' and status = 'expired';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000004a4","role":"authenticated"}', true);
select pg_temp.err('expired suggestions can''t be accepted later', format('select public.record_ai_decision(%L, $q$accepted$q$)', (select id from public.ai_proposals where action = 'weekly_narrative')), 'expired');
reset role;
select count(*) filter (where ok) passed, count(*) total, json_agg(json_build_object('n', name, 'd', detail)) filter (where not ok) failures from r;
