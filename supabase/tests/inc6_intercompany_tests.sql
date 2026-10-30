-- Increment 6 tests (inter-entity). Run inside begin … rollback (live) or on the local copy. Uses throwaway users and books only.
create temp table r (name text, ok boolean, detail text);
create temp table ids (k text primary key, v uuid);
grant all on r, ids to authenticated;
create or replace function pg_temp.err(p_name text, p_sql text, p_code text) returns void language plpgsql as $$
begin execute p_sql; insert into r values (p_name, false, 'no error');
exception when others then insert into r values (p_name, sqlerrm like p_code || '%', sqlerrm); end $$;
grant execute on function pg_temp.err(text, text, text) to authenticated;
create or replace function pg_temp.id(k text) returns uuid language sql stable as $$ select v from ids where ids.k = $1 $$;
grant execute on function pg_temp.id(text) to authenticated;
create or replace function pg_temp.acc(e text, c text) returns uuid language sql stable as $$ select id from public.fin_accounts where entity_id = pg_temp.id(e) and code = c $$;
grant execute on function pg_temp.acc(text, text) to authenticated;
create or replace function pg_temp.icbal(e text, other text) returns numeric language sql stable as $$
  select coalesce(sum(l.debit - l.credit), 0) from public.fin_lines l join public.fin_journals j on j.id = l.journal_id join public.fin_accounts a on a.id = l.account_id join public.fin_parties p on p.id = l.party_id
  where j.status = 'posted' and l.entity_id = pg_temp.id(e) and a.system_key = 'intercompany' and p.related_entity_id = pg_temp.id(other) $$;
grant execute on function pg_temp.icbal(text, text) to authenticated;
insert into auth.users (id, email, aud, role, instance_id) values ('aaaaaaaa-0000-4000-8000-0000000006a6','i6a@example.invalid','authenticated','authenticated','00000000-0000-0000-0000-000000000000'),
 ('bbbbbbbb-0000-4000-8000-0000000006b6','i6b@example.invalid','authenticated','authenticated','00000000-0000-0000-0000-000000000000');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000006a6","role":"authenticated"}', true);
with e as (insert into public.fin_entities (name, kind, base_currency) values ('IC Tailoring', 'business', 'QAR') returning id) insert into ids select 'a', id from e;
with e as (insert into public.fin_entities (name, kind, base_currency) values ('IC Gym', 'business', 'QAR') returning id) insert into ids select 'b', id from e;
with e as (insert into public.fin_entities (name, kind, base_currency) values ('IC Cafe India', 'business', 'INR') returning id) insert into ids select 'c', id from e;
-- 1. Tailoring lends Gym 5,000 (bank to bank)
insert into ids select 't1', public.fin_ic_record(jsonb_build_object('from_entity_id', pg_temp.id('a'), 'to_entity_id', pg_temp.id('b'), 'kind', 'transfer', 'txn_date', '2026-10-01',
  'description', 'Short-term loan', 'amount', 5000, 'from_account_id', pg_temp.acc('a','1010'), 'to_account_id', pg_temp.acc('b','1010')));
insert into r select 'transfer: lender shows 5,000 receivable from borrower', pg_temp.icbal('a','b') = 5000, pg_temp.icbal('a','b')::text;
insert into r select 'transfer: borrower shows 5,000 owed to lender', pg_temp.icbal('b','a') = -5000, pg_temp.icbal('b','a')::text;
insert into r select 'transfer is not income or expense in either book', not exists (select 1 from public.fin_lines l join public.fin_accounts ac on ac.id = l.account_id
  where l.journal_id in (select from_journal_id from public.fin_ic_txns where id = pg_temp.id('t1') union select to_journal_id from public.fin_ic_txns where id = pg_temp.id('t1')) and ac.type in ('income','expense')), null;
insert into r select 'both entries carry the same IC reference', (select count(distinct reference) from public.fin_journals where source_id = pg_temp.id('t1')) = 1
  and (select reference from public.fin_journals where id = (select from_journal_id from public.fin_ic_txns where id = pg_temp.id('t1'))) like 'IC-%', null;
-- 2. Tailoring pays Gym's 800 rent
insert into ids select 't2', public.fin_ic_record(jsonb_build_object('from_entity_id', pg_temp.id('a'), 'to_entity_id', pg_temp.id('b'), 'kind', 'paid_on_behalf', 'txn_date', '2026-10-05',
  'description', 'Gym October rent paid by Tailoring', 'amount', 800, 'from_account_id', pg_temp.acc('a','1010'), 'to_account_id', pg_temp.acc('b','6000')));
insert into r select 'paid on behalf: expense lands in the gym''s books, not the tailoring''s', (select debit from public.fin_lines where journal_id = (select to_journal_id from public.fin_ic_txns where id = pg_temp.id('t2')) and account_id = pg_temp.acc('b','6000')) = 800
  and not exists (select 1 from public.fin_lines l join public.fin_accounts ac on ac.id = l.account_id where l.journal_id = (select from_journal_id from public.fin_ic_txns where id = pg_temp.id('t2')) and ac.type = 'expense'), null;
-- 3. Gym repays 2,000
insert into ids select 't3', public.fin_ic_record(jsonb_build_object('from_entity_id', pg_temp.id('b'), 'to_entity_id', pg_temp.id('a'), 'kind', 'transfer', 'txn_date', '2026-10-20',
  'description', 'Part repayment', 'amount', 2000, 'from_account_id', pg_temp.acc('b','1010'), 'to_account_id', pg_temp.acc('a','1010')));
insert into r select 'repayment nets the balance to 3,800 on both sides', pg_temp.icbal('a','b') = 3800 and pg_temp.icbal('b','a') = -3800, pg_temp.icbal('a','b') || ' / ' || pg_temp.icbal('b','a');
insert into r select 'matching check: balances agree with recorded transactions', (select bool_and((x->>'matched')::boolean) from jsonb_array_elements(public.fin_ic_position(pg_temp.id('a'))) x)
  and (select (x->>'mine')::numeric from jsonb_array_elements(public.fin_ic_position(pg_temp.id('a'))) x where x->>'entity_id' = pg_temp.id('b')::text) = 3800, null;
-- 4. different currencies
select pg_temp.err('different currencies need the received amount', format('select public.fin_ic_record(%L)', jsonb_build_object('from_entity_id', pg_temp.id('a'), 'to_entity_id', pg_temp.id('c'), 'kind', 'transfer', 'txn_date', '2026-10-10',
  'description', 'Funding to India', 'amount', 1000, 'from_account_id', pg_temp.acc('a','1010'), 'to_account_id', pg_temp.acc('c','1010'))), 'amount_to_required');
insert into ids select 't4', public.fin_ic_record(jsonb_build_object('from_entity_id', pg_temp.id('a'), 'to_entity_id', pg_temp.id('c'), 'kind', 'transfer', 'txn_date', '2026-10-10',
  'description', 'Funding to India', 'amount', 1000, 'amount_to', 22850, 'from_account_id', pg_temp.acc('a','1010'), 'to_account_id', pg_temp.acc('c','1010')));
insert into r select 'cross-currency: each book in its own currency', pg_temp.icbal('a','c') = 1000 and pg_temp.icbal('c','a') = -22850, null;
select pg_temp.err('same currency, different amounts refused', format('select public.fin_ic_record(%L)', jsonb_build_object('from_entity_id', pg_temp.id('a'), 'to_entity_id', pg_temp.id('b'), 'kind', 'transfer', 'txn_date', '2026-10-10',
  'description', 'x', 'amount', 100, 'amount_to', 90, 'from_account_id', pg_temp.acc('a','1010'), 'to_account_id', pg_temp.acc('b','1010'))), 'amount_mismatch');
-- 5. validation
select pg_temp.err('transfer can''t land in an expense account', format('select public.fin_ic_record(%L)', jsonb_build_object('from_entity_id', pg_temp.id('a'), 'to_entity_id', pg_temp.id('b'), 'kind', 'transfer', 'txn_date', '2026-10-10',
  'description', 'x', 'amount', 100, 'from_account_id', pg_temp.acc('a','1010'), 'to_account_id', pg_temp.acc('b','6000'))), 'bad_account');
select pg_temp.err('accounts must belong to the right books', format('select public.fin_ic_record(%L)', jsonb_build_object('from_entity_id', pg_temp.id('a'), 'to_entity_id', pg_temp.id('b'), 'kind', 'transfer', 'txn_date', '2026-10-10',
  'description', 'x', 'amount', 100, 'from_account_id', pg_temp.acc('b','1010'), 'to_account_id', pg_temp.acc('a','1010'))), 'bad_account');
select pg_temp.err('same books refused', format('select public.fin_ic_record(%L)', jsonb_build_object('from_entity_id', pg_temp.id('a'), 'to_entity_id', pg_temp.id('a'), 'kind', 'transfer', 'txn_date', '2026-10-10',
  'description', 'x', 'amount', 100, 'from_account_id', pg_temp.acc('a','1010'), 'to_account_id', pg_temp.acc('a','1000'))), 'same_books');
select pg_temp.err('inter-entity entries can''t be reversed one side at a time', format('select public.fin_reverse_journal(%L, $q$x$q$)', (select from_journal_id from public.fin_ic_txns where id = pg_temp.id('t1'))), 'use_document');
-- 6. reversal (both books)
select pg_temp.err('reversal needs a reason', format('select public.fin_ic_reverse(%L, $q$$q$)', pg_temp.id('t2')), 'reason_required');
select public.fin_ic_reverse(pg_temp.id('t2'), 'Rent was paid twice');
insert into r select 'reversal removes it from both books and keeps the record', pg_temp.icbal('a','b') = 3000 and pg_temp.icbal('b','a') = -3000
  and (select status from public.fin_ic_txns where id = pg_temp.id('t2')) = 'reversed', pg_temp.icbal('a','b')::text;
insert into r select 'still matched after reversal', (select bool_and((x->>'matched')::boolean) from jsonb_array_elements(public.fin_ic_position(pg_temp.id('a'))) x), null;
insert into r select 'trial balance still balances in all three books', (select bool_and(d = c) from (select l.entity_id, sum(debit) d, sum(credit) c from public.fin_lines l join public.fin_journals j on j.id = l.journal_id
  where j.status = 'posted' and l.entity_id in (pg_temp.id('a'), pg_temp.id('b'), pg_temp.id('c')) group by 1) x), null;
-- 7. someone who keeps only one of the two books
reset role;
insert into public.fin_members (entity_id, user_id, role) values (pg_temp.id('a'), 'bbbbbbbb-0000-4000-8000-0000000006b6', 'bookkeeper');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-0000000006b6","role":"authenticated"}', true);
select pg_temp.err('you must keep both books to record', format('select public.fin_ic_record(%L)', jsonb_build_object('from_entity_id', pg_temp.id('a'), 'to_entity_id', pg_temp.id('b'), 'kind', 'transfer', 'txn_date', '2026-10-10',
  'description', 'x', 'amount', 100, 'from_account_id', pg_temp.acc('a','1010'), 'to_account_id', pg_temp.acc('b','1010'))), 'forbidden');
insert into r select 'one-book member sees their side but not the other book''s balance', (select (x->>'theirs') is null from jsonb_array_elements(public.fin_ic_position(pg_temp.id('a'))) x where x->>'entity_id' = pg_temp.id('b')::text), null;
select pg_temp.err('outsider can''t read a position', format('select public.fin_ic_position(%L)', pg_temp.id('b')), 'forbidden');
reset role;
select count(*) filter (where ok) passed, count(*) total, json_agg(json_build_object('n', name, 'd', detail)) filter (where not ok) failures from r;
