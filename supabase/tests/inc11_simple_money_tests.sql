-- Simple money layer tests. ONE transaction, ROLLED BACK: no data persists. Throwaway users and isolated test books only.
-- A = owner of personal + business test books (and partner); B = viewer on the personal books; C = outsider.
begin;
create temp table r (n serial, name text, ok boolean, detail text);
create temp table ids (k text primary key, v uuid);
grant all on r, ids to authenticated, anon;
grant usage, select on sequence r_n_seq to authenticated, anon;
create or replace function pg_temp.expect_error(p_name text, p_sql text, p_code text) returns void language plpgsql as $$
begin
  execute p_sql;
  insert into r(name, ok, detail) values (p_name, false, 'no error raised');
exception when others then
  insert into r(name, ok, detail) values (p_name, sqlerrm like p_code || '%', sqlerrm);
end $$;
grant execute on function pg_temp.expect_error(text, text, text) to authenticated, anon;
create or replace function pg_temp.id(k text) returns uuid language sql stable as $$ select v from ids where ids.k = $1 $$;
grant execute on function pg_temp.id(text) to authenticated, anon;
create or replace function pg_temp.acc(e text, c text) returns uuid language sql stable as $$ select id from public.fin_accounts where entity_id = pg_temp.id(e) and code = c $$;
grant execute on function pg_temp.acc(text, text) to authenticated, anon;
create or replace function pg_temp.bal(e text, c text) returns numeric language sql stable as $$
  select coalesce(sum(l.debit - l.credit), 0) from public.fin_lines l join public.fin_journals j on j.id = l.journal_id
  where j.status = 'posted' and l.account_id = pg_temp.acc(e, c) $$;
grant execute on function pg_temp.bal(text, text) to authenticated;
create or replace function pg_temp.tb(e text) returns numeric language sql stable as $$
  select coalesce(sum(l.debit - l.credit), 0) from public.fin_lines l join public.fin_journals j on j.id = l.journal_id where j.status = 'posted' and l.entity_id = pg_temp.id(e) $$;
grant execute on function pg_temp.tb(text) to authenticated;
create or replace function pg_temp.post(k text, p jsonb) returns jsonb language plpgsql as $$
declare v jsonb; begin v := public.fin_money_post(p || jsonb_build_object('entity_id', pg_temp.id('pers'))); insert into ids values (k, (v->>'journal_id')::uuid) on conflict do nothing; return v; end $$;
grant execute on function pg_temp.post(text, jsonb) to authenticated;

insert into auth.users (id, email, aud, role, instance_id) values
  ('aaaaaaaa-0000-4000-8000-0000000000a9', 'ma@example.invalid', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('bbbbbbbb-0000-4000-8000-0000000000b9', 'mb@example.invalid', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('cccccccc-0000-4000-8000-0000000000c9', 'mc@example.invalid', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000a9","role":"authenticated"}', true);
with e as (insert into public.fin_entities (name, kind, base_currency) values ('MTest Bespoke', 'business', 'QAR') returning id) insert into ids select 'biz', id from e;
with e as (insert into public.fin_entities (name, kind, base_currency) values ('MTest Personal', 'personal', 'QAR') returning id) insert into ids select 'pers', id from e;
select public.fin_add_member(pg_temp.id('pers'), 'mb@example.invalid', 'viewer');
insert into ids select 'link', public.fin_partner_link_create(pg_temp.id('biz'), 'Me', pg_temp.id('pers'));
insert into ids select 'bizparty', mirror_party_id from public.fin_partner_links where id = pg_temp.id('link');
with p as (insert into public.fin_parties (entity_id, name, kind) values (pg_temp.id('pers'), 'Friend F', 'other') returning id) insert into ids select 'friend', id from p;
with p as (insert into public.fin_parties (entity_id, name, kind) values (pg_temp.id('pers'), 'Bank Q', 'supplier') returning id) insert into ids select 'bankq', id from p;

insert into r(name, ok) select 'new personal books get the friends-loans and interest accounts', pg_temp.acc('pers','2250') is not null and pg_temp.acc('pers','6850') is not null;
insert into r(name, ok) select 'business books do not get them', pg_temp.acc('biz','2250') is null;

-- opening position: 10,000 in bank, card owes 500, bank loan 20,000 (posted by the test harness)
reset role;
select public.fin_system_journal(pg_temp.id('pers'), '2026-10-31', 'Opening', null, 'opening', null, jsonb_build_array(
  jsonb_build_object('account_id', pg_temp.acc('pers','1010'), 'debit', 10000, 'credit', 0),
  jsonb_build_object('account_id', pg_temp.acc('pers','3900'), 'debit', 10500, 'credit', 0),
  jsonb_build_object('account_id', pg_temp.acc('pers','2100'), 'debit', 0, 'credit', 500),
  jsonb_build_object('account_id', pg_temp.acc('pers','2200'), 'party_id', pg_temp.id('bankq'), 'debit', 0, 'credit', 20000)));
set local role authenticated;

-- salary, spending, transfers
select pg_temp.post('sal', jsonb_build_object('kind','income','txn_date','2026-11-01','amount',15000,'account_id',pg_temp.acc('pers','1010'),'category_account_id',pg_temp.acc('pers','4000'),'description','November salary'));
select pg_temp.post('gro', jsonb_build_object('kind','spend','txn_date','2026-11-02','amount',320.5,'account_id',pg_temp.acc('pers','1010'),'category_account_id',pg_temp.acc('pers','6100'),'description','Weekly shop','merchant','Lulu'));
insert into r(name, ok, detail) select 'salary and spending move the bank correctly', pg_temp.bal('pers','1010') = 10000 + 15000 - 320.5, pg_temp.bal('pers','1010')::text;
insert into r(name, ok) select 'salary is income, shop is spending', pg_temp.bal('pers','4000') = -15000 and pg_temp.bal('pers','6100') = 320.5;
insert into r(name, ok) select 'entries are normal posted manual entries (reversible the usual way)', (select status = 'posted' and source = 'manual' and memo = 'Weekly shop' from public.fin_journals where id = pg_temp.id('gro'));
insert into r(name, ok) select 'merchant kept on the lines', (select bool_and(description like 'Lulu · %') from public.fin_lines where journal_id = pg_temp.id('gro'));
select pg_temp.post('sav', jsonb_build_object('kind','transfer','txn_date','2026-11-02','amount',2000,'account_id',pg_temp.acc('pers','1010'),'category_account_id',pg_temp.acc('pers','1020'),'description','To savings'));
insert into r(name, ok) select 'own-account transfer is neither income nor spending', not exists (select 1 from public.fin_lines l join public.fin_accounts a on a.id = l.account_id where l.journal_id = pg_temp.id('sav') and a.type in ('income','expense'));
select pg_temp.post('card', jsonb_build_object('kind','transfer','txn_date','2026-11-02','amount',500,'account_id',pg_temp.acc('pers','1010'),'category_account_id',pg_temp.acc('pers','2100'),'description','Card payment'));
insert into r(name, ok) select 'card payment clears the card, not counted as spending', pg_temp.bal('pers','2100') = 0 and not exists (select 1 from public.fin_lines l join public.fin_accounts a on a.id = l.account_id where l.journal_id = pg_temp.id('card') and a.type = 'expense');
select pg_temp.expect_error('paying the card beyond what it shows owed is refused (no double count)', format('select pg_temp.post($q$x$q$, %L)', jsonb_build_object('kind','transfer','txn_date','2026-11-02','amount',100,'account_id',pg_temp.acc('pers','1010'),'category_account_id',pg_temp.acc('pers','2100'),'description','Card again')), 'exceeds_outstanding');

-- loans and money owed
select pg_temp.post('emi', jsonb_build_object('kind','debt_payment','txn_date','2026-11-02','amount',1500,'interest',200,'account_id',pg_temp.acc('pers','1010'),'category_account_id',pg_temp.acc('pers','2200'),'party_id',pg_temp.id('bankq'),'description','Loan EMI'));
insert into r(name, ok, detail) select 'loan instalment splits principal and interest', pg_temp.bal('pers','2200') = -18700 and pg_temp.bal('pers','6850') = 200, pg_temp.bal('pers','2200') || ' / ' || pg_temp.bal('pers','6850');
select pg_temp.expect_error('interest equal to the payment is refused', format('select pg_temp.post($q$x$q$, %L)', jsonb_build_object('kind','debt_payment','txn_date','2026-11-02','amount',100,'interest',100,'account_id',pg_temp.acc('pers','1010'),'category_account_id',pg_temp.acc('pers','2200'),'party_id',pg_temp.id('bankq'),'description','x')), 'bad_interest');
select pg_temp.post('bor', jsonb_build_object('kind','borrowed','txn_date','2026-11-02','amount',2000,'account_id',pg_temp.acc('pers','1000'),'category_account_id',pg_temp.acc('pers','2250'),'party_id',pg_temp.id('friend'),'description','Borrowed from F'));
select pg_temp.post('lent', jsonb_build_object('kind','lent','txn_date','2026-11-02','amount',300,'account_id',pg_temp.acc('pers','1000'),'category_account_id',pg_temp.acc('pers','1100'),'party_id',pg_temp.id('friend'),'description','Lent to F'));
select pg_temp.expect_error('repayment above what they owe is refused', format('select pg_temp.post($q$x$q$, %L)', jsonb_build_object('kind','repayment_in','txn_date','2026-11-02','amount',301,'account_id',pg_temp.acc('pers','1000'),'category_account_id',pg_temp.acc('pers','1100'),'party_id',pg_temp.id('friend'),'description','x')), 'exceeds_outstanding');
select pg_temp.post('rep', jsonb_build_object('kind','repayment_in','txn_date','2026-11-02','amount',100,'account_id',pg_temp.acc('pers','1000'),'category_account_id',pg_temp.acc('pers','1100'),'party_id',pg_temp.id('friend'),'description','F paid back'));
insert into r(name, ok, detail) select 'lending and repayment track who owes what', (select sum(debit-credit) from public.fin_lines where account_id = pg_temp.acc('pers','1100') and party_id = pg_temp.id('friend')) = 200, null;
insert into r(name, ok) select 'repayment is not income', not exists (select 1 from public.fin_lines l join public.fin_accounts a on a.id = l.account_id where l.journal_id = pg_temp.id('rep') and a.type = 'income');
select pg_temp.expect_error('lending needs a person', format('select pg_temp.post($q$x$q$, %L)', jsonb_build_object('kind','lent','txn_date','2026-11-02','amount',1,'account_id',pg_temp.acc('pers','1000'),'category_account_id',pg_temp.acc('pers','1100'),'description','x')), 'party_required');

-- paid for the business from my salary account; business pays me back
select pg_temp.post('dl1', jsonb_build_object('kind','paid_for_business','txn_date','2026-11-02','amount',500,'account_id',pg_temp.acc('pers','1010'),'for_entity_id',pg_temp.id('biz'),'business_account_id',pg_temp.acc('biz','1200'),'description','Fabric','merchant','Topaz','reference','INV-77'));
insert into r(name, ok, detail) select 'personal: bank down 500, receivable from business up 500', pg_temp.bal('pers','1010') = 10000 + 15000 - 320.5 - 2000 - 500 - 1500 - 500 and (select sum(debit-credit) from public.fin_lines where account_id = pg_temp.acc('pers','1100') and party_id = pg_temp.id('bizparty')) = 500, pg_temp.bal('pers','1010')::text;
insert into r(name, ok) select 'business: fabric stock up 500, payable to owner up 500', pg_temp.bal('biz','1200') = 500 and pg_temp.bal('biz','2300') = -500;
insert into r(name, ok) select 'paid-for-business is not personal spending', not exists (select 1 from public.fin_lines l join public.fin_accounts a on a.id = l.account_id where l.journal_id = pg_temp.id('dl1') and a.type = 'expense');
insert into r(name, ok) select 'it is a partner transaction with both entries and the bank recorded as the source', (select paid_from = 'personal_bank' and journal_id is not null and mirror_journal_id = pg_temp.id('dl1') and beneficiary = 'Topaz' from public.fin_partner_txns where link_id = pg_temp.id('link'));
select pg_temp.expect_error('paid-for-business needs the business account', format('select pg_temp.post($q$x$q$, %L)', jsonb_build_object('kind','paid_for_business','txn_date','2026-11-02','amount',1,'account_id',pg_temp.acc('pers','1010'),'for_entity_id',pg_temp.id('biz'),'description','x')), 'business_account_required');
select pg_temp.expect_error('business account cannot be its bank (personal money)', format('select pg_temp.post($q$x$q$, %L)', jsonb_build_object('kind','paid_for_business','txn_date','2026-11-02','amount',1,'account_id',pg_temp.acc('pers','1010'),'for_entity_id',pg_temp.id('biz'),'business_account_id',pg_temp.acc('biz','1010'),'description','x')), 'mixed_funds');
select pg_temp.post('dl2', jsonb_build_object('kind','business_repaid','txn_date','2026-11-03','amount',500,'account_id',pg_temp.acc('pers','1010'),'for_entity_id',pg_temp.id('biz'),'business_account_id',pg_temp.acc('biz','1010'),'description','Reimbursed fabric'));
insert into r(name, ok) select 'reimbursement clears both sides and is not income', (select sum(debit-credit) from public.fin_lines where account_id = pg_temp.acc('pers','1100') and party_id = pg_temp.id('bizparty')) = 0 and pg_temp.bal('biz','2300') = 0
  and not exists (select 1 from public.fin_lines l join public.fin_accounts a on a.id = l.account_id where l.journal_id = pg_temp.id('dl2') and a.type = 'income');
select pg_temp.expect_error('business cannot repay more than it owes', format('select pg_temp.post($q$x$q$, %L)', jsonb_build_object('kind','business_repaid','txn_date','2026-11-03','amount',1,'account_id',pg_temp.acc('pers','1010'),'for_entity_id',pg_temp.id('biz'),'business_account_id',pg_temp.acc('biz','1010'),'description','x')), 'exceeds_outstanding');

-- validation
select pg_temp.expect_error('money must move through a bank, cash or card account', format('select pg_temp.post($q$x$q$, %L)', jsonb_build_object('kind','spend','txn_date','2026-11-02','amount',1,'account_id',pg_temp.acc('pers','6100'),'category_account_id',pg_temp.acc('pers','6100'),'description','x')), 'bad_account');
select pg_temp.expect_error('income cannot land on a card', format('select pg_temp.post($q$x$q$, %L)', jsonb_build_object('kind','income','txn_date','2026-11-02','amount',1,'account_id',pg_temp.acc('pers','2100'),'category_account_id',pg_temp.acc('pers','4000'),'description','x')), 'bad_account');
select pg_temp.expect_error('spending to an income account is refused', format('select pg_temp.post($q$x$q$, %L)', jsonb_build_object('kind','spend','txn_date','2026-11-02','amount',1,'account_id',pg_temp.acc('pers','1010'),'category_account_id',pg_temp.acc('pers','4000'),'description','x')), 'bad_category');
select pg_temp.expect_error('another currency is refused', format('select pg_temp.post($q$x$q$, %L)', jsonb_build_object('kind','spend','txn_date','2026-11-02','amount',1,'currency','INR','account_id',pg_temp.acc('pers','1010'),'category_account_id',pg_temp.acc('pers','6100'),'description','x')), 'currency');
select pg_temp.expect_error('accounts from other books are refused', format('select pg_temp.post($q$x$q$, %L)', jsonb_build_object('kind','spend','txn_date','2026-11-02','amount',1,'account_id',pg_temp.acc('pers','1010'),'category_account_id',pg_temp.acc('biz','6900'),'description','x')), 'category_required');
select pg_temp.expect_error('a description is needed', format('select pg_temp.post($q$x$q$, %L)', jsonb_build_object('kind','spend','txn_date','2026-11-02','amount',1,'account_id',pg_temp.acc('pers','1010'),'category_account_id',pg_temp.acc('pers','6100'))), 'description_required');
update public.fin_entities set lock_date = '2026-10-31' where id = pg_temp.id('pers');
select pg_temp.expect_error('locked period is respected', format('select pg_temp.post($q$x$q$, %L)', jsonb_build_object('kind','spend','txn_date','2026-10-30','amount',1,'account_id',pg_temp.acc('pers','1010'),'category_account_id',pg_temp.acc('pers','6100'),'description','x')), '');
insert into r(name, ok) select 'locked-period refusal mentions the lock', (select detail ilike '%lock%' from r where name = 'locked period is respected');
insert into r(name, ok, detail) select 'personal trial balance balances', pg_temp.tb('pers') = 0, pg_temp.tb('pers')::text;
insert into r(name, ok, detail) select 'business trial balance balances', pg_temp.tb('biz') = 0, pg_temp.tb('biz')::text;

-- imports: store, flag duplicates, review, post once
insert into ids select 'imp1', public.fin_import_add(pg_temp.id('pers'), 'sms', 'Bank SMS', 'Debited QAR 320.50 at LULU', pg_temp.acc('pers','1010'), 'rules', jsonb_build_array(
  jsonb_build_object('txn_date','2026-11-02','amount',320.5,'direction','out','description','LULU HYPERMARKET','merchant','Lulu','kind','spend','category_account_id',pg_temp.acc('pers','6100'),'confidence','high'),
  jsonb_build_object('txn_date','2026-11-04','amount',45,'direction','out','description','WOQOD FUEL','merchant','Woqod','kind','spend','category_account_id',pg_temp.acc('pers','6300'),'confidence','high'),
  jsonb_build_object('txn_date','2026-11-05','amount',0,'direction','out','description','zero line skipped'),
  jsonb_build_object('txn_date','2026-11-05','amount',80,'direction','out','description','Unknown merchant','review_reason','Not sure what this is')));
insert into r(name, ok, detail) select 'import keeps the original text unchanged', raw_text = 'Debited QAR 320.50 at LULU', raw_text from public.fin_imports where id = pg_temp.id('imp1');
insert into r(name, ok, detail) select 'zero-amount lines are not imported', (select count(*) from public.fin_import_rows where import_id = pg_temp.id('imp1')) = 3, null;
insert into r(name, ok, detail) select 'line already in the books is flagged, not dropped', duplicate = 'in_books' and duplicate_line_id is not null, coalesce(duplicate, 'none') from public.fin_import_rows where import_id = pg_temp.id('imp1') and row_no = 1;
insert into r(name, ok) select 'new line is not flagged', duplicate is null from public.fin_import_rows where import_id = pg_temp.id('imp1') and row_no = 2;
insert into r(name, ok) select 'uncertain line keeps its review reason', review_reason = 'Not sure what this is' from public.fin_import_rows where import_id = pg_temp.id('imp1') and row_no = 4;
-- review edits
update public.fin_import_rows set category_account_id = pg_temp.acc('pers','6900'), kind = 'spend' where import_id = pg_temp.id('imp1') and row_no = 4;
insert into r(name, ok) select 'review can change the category', category_account_id = pg_temp.acc('pers','6900') from public.fin_import_rows where import_id = pg_temp.id('imp1') and row_no = 4;
select pg_temp.expect_error('a line can''t be posted by editing it', format('update public.fin_import_rows set status = $q$posted$q$ where import_id = %L and row_no = 2', pg_temp.id('imp1')), 'post_through_review');
select pg_temp.expect_error('the source of a line can''t be changed', format('update public.fin_import_rows set raw = $q${"x":1}$q$ where import_id = %L and row_no = 2', pg_temp.id('imp1')), 'fixed');
-- post
insert into ids select 'row2', id from public.fin_import_rows where import_id = pg_temp.id('imp1') and row_no = 2;
select pg_temp.post('fuel', jsonb_build_object('kind','spend','txn_date','2026-11-04','amount',45,'account_id',pg_temp.acc('pers','1010'),'category_account_id',pg_temp.acc('pers','6300'),'description','WOQOD FUEL','merchant','Woqod','import_row_id',pg_temp.id('row2')));
insert into r(name, ok) select 'posted line is linked to its entry', status = 'posted' and journal_id = pg_temp.id('fuel') and posted_by is not null from public.fin_import_rows where id = pg_temp.id('row2');
select pg_temp.expect_error('the same line can''t be posted twice', format('select pg_temp.post($q$x$q$, %L)', jsonb_build_object('kind','spend','txn_date','2026-11-04','amount',45,'account_id',pg_temp.acc('pers','1010'),'category_account_id',pg_temp.acc('pers','6300'),'description','WOQOD FUEL','import_row_id',pg_temp.id('row2'))), 'already_posted');
select pg_temp.expect_error('a posted line can''t be edited', format('update public.fin_import_rows set description = $q$x$q$ where id = %L', pg_temp.id('row2')), 'posted');
-- the same statement uploaded again
insert into ids select 'imp2', public.fin_import_add(pg_temp.id('pers'), 'statement', 'Statement again', null, pg_temp.acc('pers','1010'), 'csv', jsonb_build_array(
  jsonb_build_object('txn_date','2026-11-04','amount',45,'direction','out','description','WOQOD FUEL')));
insert into r(name, ok) select 'second upload of the same line is flagged as already imported', duplicate = 'imported' from public.fin_import_rows where import_id = pg_temp.id('imp2');
insert into ids select 'row2b', id from public.fin_import_rows where import_id = pg_temp.id('imp2');
select pg_temp.expect_error('and can''t be posted again', format('select pg_temp.post($q$x$q$, %L)', jsonb_build_object('kind','spend','txn_date','2026-11-04','amount',45,'account_id',pg_temp.acc('pers','1010'),'category_account_id',pg_temp.acc('pers','6300'),'description','WOQOD FUEL','import_row_id',pg_temp.id('row2b'))), 'duplicate_import');
update public.fin_import_rows set status = 'skipped' where id = pg_temp.id('row2b');
insert into r(name, ok) select 'a duplicate can be skipped', status = 'skipped' from public.fin_import_rows where id = pg_temp.id('row2b');
-- import a business payment from the statement
insert into ids select 'imp3', public.fin_import_add(pg_temp.id('pers'), 'statement', 'Dlusso line', null, pg_temp.acc('pers','1010'), 'csv', jsonb_build_array(
  jsonb_build_object('txn_date','2026-11-05','amount',150,'direction','out','description','DHL EXPRESS','kind','paid_for_business','for_entity_id',pg_temp.id('biz'))));
insert into ids select 'row3', id from public.fin_import_rows where import_id = pg_temp.id('imp3');
select pg_temp.post('dl3', jsonb_build_object('kind','paid_for_business','txn_date','2026-11-05','amount',150,'account_id',pg_temp.acc('pers','1010'),'for_entity_id',pg_temp.id('biz'),'business_account_id',pg_temp.acc('biz','6400'),'description','DHL EXPRESS','import_row_id',pg_temp.id('row3')));
insert into r(name, ok) select 'imported business payment posts in both books and links the partner line', (select status = 'posted' and partner_txn_id is not null and journal_id = pg_temp.id('dl3') from public.fin_import_rows where id = pg_temp.id('row3'))
  and pg_temp.bal('biz','6400') = 150 and (select import_key like 'imp:%' from public.fin_partner_txns where id = (select partner_txn_id from public.fin_import_rows where id = pg_temp.id('row3')));
delete from public.fin_imports where id = pg_temp.id($$imp3$$);
insert into r(name, ok) select 'import with posted lines is still there after a delete attempt', exists (select 1 from public.fin_imports where id = pg_temp.id('imp3'));
select pg_temp.expect_error('empty import refused', format('select public.fin_import_add(%L, $q$text$q$, $q$x$q$, null, null, null, $q$[]$q$)', pg_temp.id('pers')), 'nothing_found');

-- obligations and balance checks
insert into public.fin_obligations (entity_id, side, kind, name, account_id, party_id, original_amount, installment, due_day)
  values (pg_temp.id('pers'), 'i_owe', 'bank_loan', 'Car loan', pg_temp.acc('pers','2200'), pg_temp.id('bankq'), 30000, 1500, 25);
insert into r(name, ok) select 'loan details stored beside the ledger', exists (select 1 from public.fin_obligations where name = 'Car loan' and installment = 1500);
select pg_temp.expect_error('money owed to me can''t sit on a liability account', format('insert into public.fin_obligations (entity_id, side, name, account_id) values (%L, $q$owed_to_me$q$, $q$x$q$, %L)', pg_temp.id('pers'), pg_temp.acc('pers','2200')), 'bad_account');
select pg_temp.expect_error('one detail record per balance', format('insert into public.fin_obligations (entity_id, side, name, account_id, party_id) values (%L, $q$i_owe$q$, $q$x$q$, %L, %L)', pg_temp.id('pers'), pg_temp.acc('pers','2200'), pg_temp.id('bankq')), 'duplicate key');
select pg_temp.expect_error('obligation account can''t be switched', format('update public.fin_obligations set account_id = %L where name = $q$Car loan$q$', pg_temp.acc('pers','2250')), 'fixed');
insert into public.fin_balance_checks (entity_id, account_id, as_of, balance) values (pg_temp.id('pers'), pg_temp.acc('pers','1010'), '2026-11-05', 19900);
insert into r(name, ok) select 'actual bank balance stored separately from the ledger', exists (select 1 from public.fin_balance_checks where balance = 19900);
select pg_temp.expect_error('balance checks only for bank, cash or card', format('insert into public.fin_balance_checks (entity_id, account_id, as_of, balance) values (%L, %L, $q$2026-11-05$q$, 1)', pg_temp.id('pers'), pg_temp.acc('pers','6100')), 'bad_account');

-- permissions
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-0000000000b9","role":"authenticated"}', true);
select pg_temp.expect_error('a viewer can''t post', format('select public.fin_money_post(%L)', jsonb_build_object('entity_id', pg_temp.id('pers'), 'kind','spend','txn_date','2026-11-02','amount',1,'account_id',pg_temp.acc('pers','1010'),'category_account_id',pg_temp.acc('pers','6100'),'description','x')), 'forbidden');
select pg_temp.expect_error('a viewer can''t import', format('select public.fin_import_add(%L, $q$text$q$, $q$x$q$, null, null, null, %L)', pg_temp.id('pers'), jsonb_build_array(jsonb_build_object('amount',1,'direction','out','description','x'))), 'forbidden');
insert into r(name, ok) select 'a viewer can read imports and obligations', (select count(*) from public.fin_imports where entity_id = pg_temp.id('pers')) >= 3 and (select count(*) from public.fin_obligations where entity_id = pg_temp.id('pers')) = 1;
update public.fin_import_rows set description = 'viewer edit' where import_id = pg_temp.id('imp1') and row_no = 4;
insert into r(name, ok) select 'a viewer''s review edit changes nothing', (select description from public.fin_import_rows where import_id = pg_temp.id('imp1') and row_no = 4) <> 'viewer edit' or (select count(*) from public.fin_import_rows where import_id = pg_temp.id('imp1') and row_no = 4) = 0;
select set_config('request.jwt.claims', '{"sub":"cccccccc-0000-4000-8000-0000000000c9","role":"authenticated"}', true);
insert into r(name, ok) select 'an outsider sees no imports, rows, obligations or balance checks', not exists (select 1 from public.fin_imports where entity_id = pg_temp.id('pers'))
  and not exists (select 1 from public.fin_import_rows where entity_id = pg_temp.id('pers')) and not exists (select 1 from public.fin_obligations where entity_id = pg_temp.id('pers')) and not exists (select 1 from public.fin_balance_checks where entity_id = pg_temp.id('pers'));
select pg_temp.expect_error('an outsider can''t post', format('select public.fin_money_post(%L)', jsonb_build_object('entity_id', pg_temp.id('pers'), 'kind','spend','txn_date','2026-11-02','amount',1,'account_id',pg_temp.acc('pers','1010'),'category_account_id',pg_temp.acc('pers','6100'),'description','x')), 'forbidden');

reset role;
select count(*) filter (where ok) || '/' || count(*) || coalesce(' FAILED: ' || string_agg(name || ' [' || coalesce(detail, '') || ']', '; ') filter (where not ok), '') from r;
rollback;
