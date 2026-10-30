-- Partner accounts tests. ONE transaction, ROLLED BACK: no data persists. Uses throwaway users and isolated test books only.
-- A = partner and owner of both test books; B = bookkeeper on the business only; C = viewer on the business.
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
-- record helper: returns txn id and stores it under key k
create or replace function pg_temp.rec(k text, p jsonb) returns uuid language plpgsql as $$
declare v uuid; begin v := public.fin_partner_record(p || jsonb_build_object('link_id', pg_temp.id('link'))); insert into ids values (k, v); return v; end $$;
grant execute on function pg_temp.rec(text, jsonb) to authenticated;
-- balances straight from the ledgers
create or replace function pg_temp.biz_owed() returns numeric language sql stable as $$
  select coalesce(sum(l.credit - l.debit), 0) from public.fin_lines l join public.fin_journals j on j.id = l.journal_id
  where j.status = 'posted' and l.account_id = pg_temp.acc('biz', '2300') and l.party_id = (select partner_party_id from public.fin_partner_links where id = pg_temp.id('link')) $$;
create or replace function pg_temp.pers_owed() returns numeric language sql stable as $$
  select coalesce(sum(l.debit - l.credit), 0) from public.fin_lines l join public.fin_journals j on j.id = l.journal_id
  where j.status = 'posted' and l.account_id = pg_temp.acc('pers', '1100') $$;
grant execute on function pg_temp.biz_owed(), pg_temp.pers_owed() to authenticated;

insert into auth.users (id, email, aud, role, instance_id) values
  ('aaaaaaaa-0000-4000-8000-0000000000a5', 'pa@example.invalid', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('bbbbbbbb-0000-4000-8000-0000000000b5', 'pb@example.invalid', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('cccccccc-0000-4000-8000-0000000000c5', 'pc@example.invalid', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000a5","role":"authenticated"}', true);
with e as (insert into public.fin_entities (name, kind, base_currency) values ('PTest Bespoke', 'business', 'QAR') returning id) insert into ids select 'biz', id from e;
with e as (insert into public.fin_entities (name, kind, base_currency) values ('PTest Personal', 'personal', 'QAR') returning id) insert into ids select 'pers', id from e;
select public.fin_add_member(pg_temp.id('biz'), 'pb@example.invalid', 'bookkeeper');
select public.fin_add_member(pg_temp.id('biz'), 'pc@example.invalid', 'viewer');

-- set-up
insert into ids select 'link', public.fin_partner_link_create(pg_temp.id('biz'), 'Jezz', pg_temp.id('pers'));
insert into r(name, ok) select 'link uses the existing partner current account (no new account)', partner_account_id = pg_temp.acc('biz', '2300') from public.fin_partner_links where id = pg_temp.id('link');
insert into r(name, ok) select 'link mirrors into personal "money owed to me"', mirror_receivable_account_id = pg_temp.acc('pers', '1100') and mirror_default_account_id = pg_temp.acc('pers', '3900') from public.fin_partner_links where id = pg_temp.id('link');
insert into r(name, ok) select 'business has no extra accounts after set-up', count(*) = 26 from public.fin_accounts where entity_id = pg_temp.id('biz');
insert into r(name, ok) select 'partner and business appear as parties', (select count(*) from public.fin_parties where entity_id = pg_temp.id('biz') and name = 'Jezz' and kind = 'partner') = 1
  and (select count(*) from public.fin_parties where entity_id = pg_temp.id('pers') and name = 'PTest Bespoke') = 1;
select pg_temp.expect_error('a second link for the same partner is refused', format('select public.fin_partner_link_create(%L, $q$jezz$q$, null)', pg_temp.id('biz')), 'exists');
insert into r(name, ok) select 'no overdue terms invented', terms_days is null from public.fin_partner_links where id = pg_temp.id('link');

-- funding
select pg_temp.rec('t1', jsonb_build_object('txn_type','salary_funding','txn_date','2026-09-30','date_precision','month','description','August payroll','amount',5186,'account_id',pg_temp.acc('biz','6100'),'flags',jsonb_build_array('legacy_7066','payroll_source_check'),'import_key','t1'));
select pg_temp.rec('t2', jsonb_build_object('txn_type','expense_funding','txn_date','2026-10-07','payment_date','2026-10-07','description','Fabric','beneficiary','Blossom Trading','reference','39896','invoice_amount',70,'amount',68,'account_id',pg_temp.acc('biz','1200'),'paid_from','personal_bank'));
select pg_temp.rec('t3', jsonb_build_object('txn_type','salary_funding','txn_date','2026-10-25','description','September salary','amount',8500,'account_id',pg_temp.acc('biz','6100')));
insert into r(name, ok, detail) select 'transaction numbers are automatic', string_agg(txn_no, ',' order by txn_no) = 'PR-0001,PR-0002,PR-0003', string_agg(txn_no, ',') from public.fin_partner_txns where link_id = pg_temp.id('link');
insert into r(name, ok, detail) select 'business owes the partner 13,754', pg_temp.biz_owed() = 13754, pg_temp.biz_owed()::text;
insert into r(name, ok, detail) select 'personal books show the same amount receivable', pg_temp.pers_owed() = 13754, pg_temp.pers_owed()::text;
insert into r(name, ok) select 'balance functions agree with the ledgers', public.fin_partner_balance(pg_temp.id('link')) = 13754 and public.fin_partner_mirror_balance(pg_temp.id('link')) = 13754;
insert into r(name, ok) select 'funding debits the expense, never the business bank', (select sum(debit) from public.fin_lines where journal_id = (select journal_id from public.fin_partner_txns where id = pg_temp.id('t1')) and account_id = pg_temp.acc('biz','6100')) = 5186
  and not exists (select 1 from public.fin_lines l join public.fin_accounts a on a.id = l.account_id where l.entity_id = pg_temp.id('biz') and a.subtype in ('bank','cash'));
insert into r(name, ok) select 'month-only date kept, payment date left blank', date_precision = 'month' and payment_date is null and txn_date = '2026-09-30' from public.fin_partner_txns where id = pg_temp.id('t1');
insert into r(name, ok) select 'journals are tagged as partner entries', count(*) = 6 from public.fin_journals where source = 'partner' and entity_id in (pg_temp.id('biz'), pg_temp.id('pers'));
insert into r(name, ok) select 'nothing posted to income', not exists (select 1 from public.fin_lines l join public.fin_accounts a on a.id = l.account_id where l.entity_id in (pg_temp.id('biz'), pg_temp.id('pers')) and a.type = 'income');

-- validation
select pg_temp.expect_error('personal funding against business bank is refused', format('select pg_temp.rec($q$x1$q$, %L)', jsonb_build_object('txn_type','expense_funding','txn_date','2026-10-01','description','x','amount',10,'account_id',pg_temp.acc('biz','1010'))), 'mixed_funds');
select pg_temp.expect_error('funding to income is refused', format('select pg_temp.rec($q$x2$q$, %L)', jsonb_build_object('txn_type','expense_funding','txn_date','2026-10-01','description','x','amount',10,'account_id',pg_temp.acc('biz','4000'))), 'bad_account');
select pg_temp.expect_error('reimbursement must come from bank or cash', format('select pg_temp.rec($q$x3$q$, %L)', jsonb_build_object('txn_type','reimbursement','txn_date','2026-10-29','description','x','amount',10,'account_id',pg_temp.acc('biz','6900'))), 'bad_account');
select pg_temp.expect_error('same supplier invoice twice is refused', format('select pg_temp.rec($q$x4$q$, %L)', jsonb_build_object('txn_type','expense_funding','txn_date','2026-10-08','description','again','beneficiary','blossom trading','reference','39896','amount',68,'account_id',pg_temp.acc('biz','1200'))), 'duplicate key');
select pg_temp.expect_error('same import line twice is refused', format('select pg_temp.rec($q$x5$q$, %L)', jsonb_build_object('txn_type','expense_funding','txn_date','2026-10-08','description','x','amount',1,'account_id',pg_temp.acc('biz','6900'),'import_key','t1')), 'duplicate_import');
select pg_temp.expect_error('other currencies are refused for now', format('select pg_temp.rec($q$x6$q$, %L)', jsonb_build_object('txn_type','expense_funding','txn_date','2026-10-08','description','x','amount',1,'currency','INR','account_id',pg_temp.acc('biz','6900'))), 'currency');
select pg_temp.expect_error('reimbursement above the outstanding balance is refused', format('select pg_temp.rec($q$x7$q$, %L)', jsonb_build_object('txn_type','reimbursement','txn_date','2026-10-29','description','x','amount',20000,'account_id',pg_temp.acc('biz','1010'))), 'exceeds_outstanding');
select pg_temp.expect_error('adjustment needs a direction', format('select pg_temp.rec($q$x8$q$, %L)', jsonb_build_object('txn_type','adjustment','txn_date','2026-10-08','description','x','amount',1,'account_id',pg_temp.acc('biz','6900'))), 'direction_required');
select pg_temp.expect_error('counter account from other books is refused', format('select pg_temp.rec($q$x9$q$, %L)', jsonb_build_object('txn_type','expense_funding','txn_date','2026-10-08','description','x','amount',1,'account_id',pg_temp.acc('pers','6900'))), 'bad_account');

-- reimbursement
select pg_temp.rec('t4', jsonb_build_object('txn_type','reimbursement','txn_date','2026-10-29','description','Reimbursement from business','amount',8000,'account_id',pg_temp.acc('biz','1010')));
insert into r(name, ok, detail) select 'reimbursement reduces both sides to 5,754', pg_temp.biz_owed() = 5754 and pg_temp.pers_owed() = 5754, pg_temp.biz_owed() || ' / ' || pg_temp.pers_owed();
insert into r(name, ok) select 'reimbursement credits the business bank and debits the partner account', (select credit from public.fin_lines where journal_id = (select journal_id from public.fin_partner_txns where id = pg_temp.id('t4')) and account_id = pg_temp.acc('biz','1010')) = 8000
  and (select debit from public.fin_lines where journal_id = (select journal_id from public.fin_partner_txns where id = pg_temp.id('t4')) and account_id = pg_temp.acc('biz','2300')) = 8000;
insert into r(name, ok) select 'reimbursement is not an expense or income in either book', not exists (select 1 from public.fin_lines l join public.fin_accounts a on a.id = l.account_id
  where l.journal_id in (select journal_id from public.fin_partner_txns where id = pg_temp.id('t4') union select mirror_journal_id from public.fin_partner_txns where id = pg_temp.id('t4')) and a.type in ('expense','income'));

-- settles link
select pg_temp.expect_error('funding cannot settle another line', format('select public.fin_partner_update(%L, %L, $q$x$q$)', pg_temp.id('t2'), jsonb_build_object('settles_txn_id', pg_temp.id('t3'))), 'bad_settles');
select public.fin_partner_update(pg_temp.id('t4'), jsonb_build_object('settles_txn_id', pg_temp.id('t3')), 'Reimbursement was for September salary');
insert into r(name, ok) select 'reimbursement linked to the salary line it settles, balances unchanged', settles_txn_id = pg_temp.id('t3') and pg_temp.biz_owed() = 5754 from public.fin_partner_txns where id = pg_temp.id('t4');

-- editing and audit
select pg_temp.expect_error('editing without a reason is refused', format('select public.fin_partner_update(%L, $q${"notes":"x"}$q$, $q$$q$)', pg_temp.id('t2')), 'reason_required');
select pg_temp.expect_error('amount cannot be edited', format('select public.fin_partner_update(%L, $q${"amount":1}$q$, $q$typo$q$)', pg_temp.id('t2')), 'locked_field');
select pg_temp.expect_error('account cannot be edited', format('select public.fin_partner_update(%L, %L, $q$typo$q$)', pg_temp.id('t2'), jsonb_build_object('account_id', pg_temp.acc('biz','6900'))), 'locked_field');
select public.fin_partner_update(pg_temp.id('t2'), '{"recon_status":"verified","notes":"Matched to bank statement"}', 'Checked against bank statement');
insert into r(name, ok, detail) select 'edit is audited with old value, new value, user and reason', count(*) = 1, max(changes::text) from public.fin_audit
  where record_type = 'fin_partner_txns' and record_id = pg_temp.id('t2') and action = 'update' and actor_id = 'aaaaaaaa-0000-4000-8000-0000000000a5'
    and changes->'recon_status' = '["unverified","verified"]' and changes->'last_change_reason'->>1 = 'Checked against bank statement';
do $$ begin update public.fin_partner_txns set amount = 1 where id = pg_temp.id('t2'); insert into r(name, ok) values ('transactions cannot be changed directly', not found);
exception when others then insert into r(name, ok, detail) values ('transactions cannot be changed directly', true, sqlerrm); end $$;
insert into r(name, ok) select 'amount unchanged after direct-update attempt', amount = 68 from public.fin_partner_txns where id = pg_temp.id('t2');
do $$ begin delete from public.fin_partner_txns where id = pg_temp.id('t2'); insert into r(name, ok) values ('transactions cannot be deleted', not found);
exception when others then insert into r(name, ok, detail) values ('transactions cannot be deleted', true, sqlerrm); end $$;
insert into r(name, ok) select 'transaction still present', count(*) = 1 from public.fin_partner_txns where id = pg_temp.id('t2');
select pg_temp.expect_error('partner journals cannot be reversed directly', format('select public.fin_reverse_journal(%L, $q$x$q$)', (select journal_id from public.fin_partner_txns where id = pg_temp.id('t2'))), 'use_document');

-- reversal
select pg_temp.expect_error('reversing funding that would leave reimbursements uncovered is refused', format('select public.fin_partner_reverse(%L, $q$wrong$q$)', pg_temp.id('t3')), 'would_go_negative');
select public.fin_partner_reverse(pg_temp.id('t1'), 'Wrong account, re-recording');
insert into r(name, ok, detail) select 'reversal removes it from both books', pg_temp.biz_owed() = 568 and pg_temp.pers_owed() = 568, pg_temp.biz_owed() || ' / ' || pg_temp.pers_owed();
insert into r(name, ok) select 'original kept, marked reversed with links to both reversal entries', status = 'reversed' and reversal_journal_id is not null and mirror_reversal_journal_id is not null and reversal_reason like 'Wrong account%'
  from public.fin_partner_txns where id = pg_temp.id('t1');
insert into r(name, ok) select 'reversal entry references the original', (select reversal_of from public.fin_journals where id = (select reversal_journal_id from public.fin_partner_txns where id = pg_temp.id('t1'))) = (select journal_id from public.fin_partner_txns where id = pg_temp.id('t1'));
select pg_temp.expect_error('cannot reverse twice', format('select public.fin_partner_reverse(%L, $q$again$q$)', pg_temp.id('t1')), 'already_reversed');
select pg_temp.rec('t1b', jsonb_build_object('txn_type','salary_funding','txn_date','2026-09-30','date_precision','month','description','August payroll (re-recorded)','amount',5186,'account_id',pg_temp.acc('biz','2100'),'import_key','t1b'));
insert into r(name, ok) select 'funding against a payroll liability is allowed', pg_temp.biz_owed() = 5754;

-- bookkeeper B: records in business books, personal side waits for the partner
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-0000000000b5","role":"authenticated"}', true);
select pg_temp.rec('t5', jsonb_build_object('txn_type','expense_funding','txn_date','2026-10-28','description','Freight','amount',75,'account_id',pg_temp.acc('biz','6400')));
insert into r(name, ok) select 'bookkeeper cannot see the partner''s personal books', count(*) = 0 from public.fin_lines where entity_id = pg_temp.id('pers');
insert into r(name, ok) select 'bookkeeper entry has no personal mirror yet', mirror_journal_id is null from public.fin_partner_txns where id = pg_temp.id('t5');
select pg_temp.expect_error('bookkeeper cannot reverse a line that is also in personal books', format('select public.fin_partner_reverse(%L, $q$x$q$)', pg_temp.id('t2')), 'partner_required');
select pg_temp.expect_error('bookkeeper cannot post to personal books', format('select public.fin_partner_sync_mirror(%L)', pg_temp.id('link')), 'forbidden');
select pg_temp.expect_error('bookkeeper cannot create partner links', format('select public.fin_partner_link_create(%L, $q$Other$q$, null)', pg_temp.id('biz')), 'forbidden');
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000a5","role":"authenticated"}', true);
insert into r(name, ok) select 'the two books differ until the partner syncs', public.fin_partner_balance(pg_temp.id('link')) = 5829 and public.fin_partner_mirror_balance(pg_temp.id('link')) = 5754;
insert into r(name, ok) select 'partner syncs one pending line', public.fin_partner_sync_mirror(pg_temp.id('link')) = 1;
insert into r(name, ok, detail) select 'books agree again after sync', pg_temp.biz_owed() = 5829 and pg_temp.pers_owed() = 5829, pg_temp.biz_owed() || ' / ' || pg_temp.pers_owed();

-- viewer C
select set_config('request.jwt.claims', '{"sub":"cccccccc-0000-4000-8000-0000000000c5","role":"authenticated"}', true);
insert into r(name, ok, detail) select 'viewer can read partner transactions', count(*) = 6, count(*)::text from public.fin_partner_txns where link_id = pg_temp.id('link');
select pg_temp.expect_error('viewer cannot record', format('select pg_temp.rec($q$x10$q$, %L)', jsonb_build_object('txn_type','expense_funding','txn_date','2026-10-08','description','x','amount',1,'account_id',pg_temp.acc('biz','6900'))), 'forbidden');
select pg_temp.expect_error('viewer cannot edit', format('select public.fin_partner_update(%L, $q${"notes":"x"}$q$, $q$x$q$)', pg_temp.id('t2')), 'forbidden');
select pg_temp.expect_error('viewer cannot attach documents', format('insert into public.fin_partner_docs (txn_id, entity_id, kind, title, url) values (%L, %L, $q$supplier_invoice$q$, $q$x$q$, $q$https://example.invalid/x$q$)', pg_temp.id('t2'), pg_temp.id('biz')), 'new row violates');

-- documents
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000a5","role":"authenticated"}', true);
insert into public.fin_partner_docs (txn_id, entity_id, kind, title, storage_path, mime_type, size_bytes) values (pg_temp.id('t2'), pg_temp.id('biz'), 'supplier_invoice', 'Blossom 39896', pg_temp.id('biz') || '/partner/inv.pdf', 'application/pdf', 1000);
insert into r(name, ok) select 'document attached to its transaction', count(*) = 1 from public.fin_partner_docs where txn_id = pg_temp.id('t2');
select pg_temp.expect_error('document from another books folder is refused', format('insert into public.fin_partner_docs (txn_id, entity_id, kind, title, storage_path, mime_type) values (%L, %L, $q$supplier_invoice$q$, $q$x$q$, %L, $q$application/pdf$q$)', pg_temp.id('t2'), pg_temp.id('biz'), pg_temp.id('pers') || '/x.pdf'), 'new row for relation');
select pg_temp.expect_error('unsupported file type is refused', format('insert into public.fin_partner_docs (txn_id, entity_id, kind, title, storage_path, mime_type) values (%L, %L, $q$supplier_invoice$q$, $q$x$q$, %L, $q$application/zip$q$)', pg_temp.id('t2'), pg_temp.id('biz'), pg_temp.id('biz') || '/x.zip'), 'new row for relation');
select pg_temp.expect_error('non-web links are refused', format('insert into public.fin_partner_docs (txn_id, entity_id, kind, title, url) values (%L, %L, $q$other$q$, $q$x$q$, $q$javascript:alert(1)$q$)', pg_temp.id('t2'), pg_temp.id('biz')), 'new row for relation');
select pg_temp.expect_error('document cannot point at a transaction in other books', format('insert into public.fin_partner_docs (txn_id, entity_id, kind, title, url) values (%L, %L, $q$other$q$, $q$x$q$, $q$https://example.invalid$q$)', pg_temp.id('t2'), pg_temp.id('pers')), 'wrong_entity');

-- signed out
reset role; set local role anon;
select pg_temp.expect_error('signed-out visitors cannot record', 'select public.fin_partner_record($q${}$q$)', 'permission denied');
reset role;
select count(*) filter (where ok) as passed, count(*) as total, json_agg(json_build_object('name', name, 'detail', detail)) filter (where not ok) as failures from r;
rollback;
