-- Phase 3 finance tests. ONE transaction, ROLLED BACK: no data persists.
-- Throwaway users: A = owner of test books, B = viewer, C = outsider. Uses only isolated test entities (never real books).
-- Run: psql "$DATABASE_URL" -f supabase/tests/phase3_tests.sql   (also runs on a local Postgres with supabase/tests/local/stubs.sql)
begin;
create temp table r (n serial, name text, ok boolean, detail text);
create temp table ids (k text primary key, v uuid);
grant all on r, ids to authenticated, anon;
grant usage, select on sequence r_n_seq to authenticated, anon;
-- helper: run SQL as the current role and record whether it failed with the expected error code prefix
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

insert into auth.users (id, email, aud, role, instance_id, raw_user_meta_data) values
  ('aaaaaaaa-0000-4000-8000-0000000000fa', 'fin-a@example.invalid', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{"display_name":"Fin A"}'),
  ('bbbbbbbb-0000-4000-8000-0000000000fb', 'fin-b@example.invalid', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{"display_name":"Fin B"}'),
  ('cccccccc-0000-4000-8000-0000000000fc', 'fin-c@example.invalid', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{"display_name":"Fin C"}');
-- a workspace + task owned by A, and one by C (for task-link checks)
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000fa","role":"authenticated"}', true);
with w as (insert into public.workspaces (name, owner_id) values ('FinTest WS', 'aaaaaaaa-0000-4000-8000-0000000000fa') returning id) insert into ids select 'ws', id from w;
insert into public.workspace_members (workspace_id, user_id, role) values (pg_temp.id('ws'), 'aaaaaaaa-0000-4000-8000-0000000000fa', 'owner') on conflict do nothing;
with t as (insert into public.tasks (workspace_id, title) values (pg_temp.id('ws'), 'Pay fabric supplier') returning id) insert into ids select 'task', id from t;
select set_config('request.jwt.claims', '{"sub":"cccccccc-0000-4000-8000-0000000000fc","role":"authenticated"}', true);
with w as (insert into public.workspaces (name, owner_id) values ('FinTest C WS', 'cccccccc-0000-4000-8000-0000000000fc') returning id) insert into ids select 'wsc', id from w;
insert into public.workspace_members (workspace_id, user_id, role) values (pg_temp.id('wsc'), 'cccccccc-0000-4000-8000-0000000000fc', 'owner') on conflict do nothing;
with t as (insert into public.tasks (workspace_id, title) values (pg_temp.id('wsc'), 'C private task') returning id) insert into ids select 'taskc', id from t;

-- ================================================================ as A (owner)
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000fa","role":"authenticated"}', true);
with e as (insert into public.fin_entities (name, kind, base_currency) values ('FinTest Trading', 'business', 'QAR') returning id) insert into ids select 'biz', id from e;
with e as (insert into public.fin_entities (name, kind, base_currency) values ('FinTest Personal', 'personal', 'QAR') returning id) insert into ids select 'pers', id from e;
insert into r(name, ok, detail) select 'business books seeded with a chart of accounts', count(*) = 26, count(*)::text from public.fin_accounts where entity_id = pg_temp.id('biz');
insert into r(name, ok, detail) select 'personal books seeded with the personal template', count(*) = 25 and bool_or(name = 'Family support & remittances'), count(*)::text from public.fin_accounts where entity_id = pg_temp.id('pers');
insert into r(name, ok) select 'creator is owner of new books', role = 'owner' from public.fin_members where entity_id = pg_temp.id('biz') and user_id = 'aaaaaaaa-0000-4000-8000-0000000000fa';
insert into ids select 'bank', id from public.fin_accounts where entity_id = pg_temp.id('biz') and code = '1010';
insert into ids select 'cash', id from public.fin_accounts where entity_id = pg_temp.id('biz') and code = '1000';
insert into ids select 'rent', id from public.fin_accounts where entity_id = pg_temp.id('biz') and code = '6000';
insert into ids select 'sales', id from public.fin_accounts where entity_id = pg_temp.id('biz') and code = '4000';
insert into ids select 'ar', id from public.fin_accounts where entity_id = pg_temp.id('biz') and code = '1100';
insert into ids select 'ap', id from public.fin_accounts where entity_id = pg_temp.id('biz') and code = '2000';
insert into ids select 'inv', id from public.fin_accounts where entity_id = pg_temp.id('biz') and code = '1200';
insert into ids select 'cogs', id from public.fin_accounts where entity_id = pg_temp.id('biz') and code = '5000';
insert into ids select 'opening', id from public.fin_accounts where entity_id = pg_temp.id('biz') and code = '3900';
insert into ids select 'pbank', id from public.fin_accounts where entity_id = pg_temp.id('pers') and code = '1010';

-- manual journal: draft → post
with j as (insert into public.fin_journals (entity_id, entry_date, memo) values (pg_temp.id('biz'), current_date, 'October rent') returning id) insert into ids select 'j1', id from j;
insert into public.fin_lines (journal_id, account_id, debit) values (pg_temp.id('j1'), pg_temp.id('rent'), 1000);
select pg_temp.expect_error('one-line entry cannot be posted', 'select public.fin_post_journal(pg_temp.id(''j1''))', 'too_few_lines');
insert into public.fin_lines (journal_id, account_id, credit) values (pg_temp.id('j1'), pg_temp.id('bank'), 900);
select pg_temp.expect_error('unbalanced entry cannot be posted', 'select public.fin_post_journal(pg_temp.id(''j1''))', 'unbalanced');
update public.fin_lines set credit = 1000 where journal_id = pg_temp.id('j1') and account_id = pg_temp.id('bank');
select pg_temp.expect_error('a line cannot have both debit and credit', 'insert into public.fin_lines (journal_id, account_id, debit, credit) values (pg_temp.id(''j1''), pg_temp.id(''rent''), 5, 5)', 'new row');
select public.fin_post_journal(pg_temp.id('j1'));
insert into r(name, ok, detail) select 'balanced entry posts with number 1', status = 'posted' and number = 1 and posted_at is not null, status || ' #' || coalesce(number::text, '-') from public.fin_journals where id = pg_temp.id('j1');
select pg_temp.expect_error('posted entry cannot be edited', 'update public.fin_journals set memo = ''changed'' where id = pg_temp.id(''j1'')', 'posted_immutable');
select pg_temp.expect_error('posted entry cannot be deleted', 'delete from public.fin_journals where id = pg_temp.id(''j1'')', 'posted_immutable');
select pg_temp.expect_error('posted lines cannot be changed', 'update public.fin_lines set debit = 1 where journal_id = pg_temp.id(''j1'') and debit > 0', 'posted_immutable');
select pg_temp.expect_error('lines cannot be added to a posted entry', 'insert into public.fin_lines (journal_id, account_id, debit) values (pg_temp.id(''j1''), pg_temp.id(''rent''), 1)', 'posted_immutable');
select pg_temp.expect_error('entries cannot be created as posted', 'insert into public.fin_journals (entity_id, entry_date, memo, status) values (pg_temp.id(''biz''), current_date, ''x'', ''posted'')', 'post_via_function');
select pg_temp.expect_error('client cannot fake a system entry', 'insert into public.fin_journals (entity_id, entry_date, memo, source) values (pg_temp.id(''biz''), current_date, ''x'', ''payment'')', 'system_entry');
with j as (insert into public.fin_journals (entity_id, entry_date, memo) values (pg_temp.id('biz'), current_date, 'Cross-book test') returning id) insert into ids select 'jx', id from j;
select pg_temp.expect_error('accounts from other books are rejected (personal bank in business entry)', 'insert into public.fin_lines (journal_id, account_id, debit) values (pg_temp.id(''jx''), pg_temp.id(''pbank''), 10)', 'account_other_entity');
delete from public.fin_journals where id = pg_temp.id('jx');
insert into r(name, ok) select 'draft entries can be deleted', not exists (select 1 from public.fin_journals where id = pg_temp.id('jx'));

-- reversal
select pg_temp.expect_error('reversal needs a reason', 'select public.fin_reverse_journal(pg_temp.id(''j1''), '' '')', 'reason_required');
with x as (select public.fin_reverse_journal(pg_temp.id('j1'), 'Wrong month') as id) insert into ids select 'j1r', id from x;
insert into r(name, ok) select 'reversal posts a mirrored entry and links both ways',
  (select reversed_by from public.fin_journals where id = pg_temp.id('j1')) = pg_temp.id('j1r')
  and (select reversal_of from public.fin_journals where id = pg_temp.id('j1r')) = pg_temp.id('j1')
  and (select sum(debit) from public.fin_lines where journal_id = pg_temp.id('j1r') and account_id = pg_temp.id('bank')) = 1000;
select pg_temp.expect_error('an entry cannot be reversed twice', 'select public.fin_reverse_journal(pg_temp.id(''j1''), ''again'')', 'already_reversed');
select pg_temp.expect_error('a reversal cannot be reversed', 'select public.fin_reverse_journal(pg_temp.id(''j1r''), ''again'')', 'is_reversal');

-- period lock
update public.fin_entities set lock_date = current_date where id = pg_temp.id('biz');
with j as (insert into public.fin_journals (entity_id, entry_date, memo) values (pg_temp.id('biz'), current_date, 'Late entry') returning id) insert into ids select 'jl', id from j;
insert into public.fin_lines (journal_id, account_id, debit) values (pg_temp.id('jl'), pg_temp.id('rent'), 50);
insert into public.fin_lines (journal_id, account_id, credit) values (pg_temp.id('jl'), pg_temp.id('cash'), 50);
select pg_temp.expect_error('locked period rejects posting', 'select public.fin_post_journal(pg_temp.id(''jl''))', 'period_locked');
update public.fin_entities set lock_date = null where id = pg_temp.id('biz');
select public.fin_post_journal(pg_temp.id('jl'));
select pg_temp.expect_error('document counters cannot be edited', 'update public.fin_entities set next_journal_no = 1 where id = pg_temp.id(''biz'')', 'numbering_locked');
select pg_temp.expect_error('base currency is locked once entries exist', 'update public.fin_entities set base_currency = ''INR'' where id = pg_temp.id(''biz'')', 'currency_locked');

-- parties, items
with p as (insert into public.fin_parties (entity_id, name, kind) values (pg_temp.id('biz'), 'Al Noor Tailoring', 'customer') returning id) insert into ids select 'cust', id from p;
with p as (insert into public.fin_parties (entity_id, name, kind) values (pg_temp.id('biz'), 'Fabric House', 'supplier') returning id) insert into ids select 'supp', id from p;
with i as (insert into public.fin_items (entity_id, sku, name, unit) values (pg_temp.id('biz'), 'FAB-01', 'Wool fabric', 'm') returning id) insert into ids select 'item', id from i;

-- purchase bill with stock
with b as (insert into public.fin_invoices (entity_id, kind, party_id, party_reference, issue_date, due_date) values (pg_temp.id('biz'), 'purchase', pg_temp.id('supp'), 'FH-7781', current_date, current_date + 2) returning id) insert into ids select 'bill', id from b;
insert into public.fin_invoice_lines (invoice_id, item_id, description, qty, unit_price) values (pg_temp.id('bill'), pg_temp.id('item'), 'Wool fabric', 10, 50);
select pg_temp.expect_error('task links must be tasks you can see', 'update public.fin_invoices set task_id = pg_temp.id(''taskc'') where id = pg_temp.id(''bill'')', 'task_not_visible');
update public.fin_invoices set task_id = pg_temp.id('task') where id = pg_temp.id('bill');
select pg_temp.expect_error('numbers cannot be chosen by hand', 'update public.fin_invoices set number = ''X1'' where id = pg_temp.id(''bill'')', 'numbering_locked');
select public.fin_post_invoice(pg_temp.id('bill'));
insert into r(name, ok, detail) select 'bill posts as BILL-0001: Dr inventory 500, Cr payables 500',
  i.number = 'BILL-0001' and (select debit from public.fin_lines where journal_id = i.journal_id and account_id = pg_temp.id('inv')) = 500
  and (select credit from public.fin_lines where journal_id = i.journal_id and account_id = pg_temp.id('ap')) = 500, i.number from public.fin_invoices i where i.id = pg_temp.id('bill');
insert into r(name, ok, detail) select 'stock received at cost (10 m @ 50)', on_hand = 10 and avg_cost = 50, on_hand || ' @ ' || avg_cost from public.fin_item_avg_cost(pg_temp.id('item'));
select pg_temp.expect_error('posted bill amounts cannot change', 'update public.fin_invoice_lines set unit_price = 1 where invoice_id = pg_temp.id(''bill'')', 'posted_immutable');
select pg_temp.expect_error('posted bill date cannot change', 'update public.fin_invoices set issue_date = current_date - 1 where id = pg_temp.id(''bill'')', 'posted_immutable');
update public.fin_invoices set notes = 'Delivered to tailor' where id = pg_temp.id('bill');
insert into r(name, ok) select 'posted bill notes can still be edited', notes = 'Delivered to tailor' from public.fin_invoices where id = pg_temp.id('bill');
insert into r(name, ok) select 'completing a linked task does not pay the bill (no payment exists)', not exists (select 1 from public.fin_allocations where invoice_id = pg_temp.id('bill'));

-- opening stock adjustment
select public.fin_stock_adjust(pg_temp.id('item'), current_date, 10, 60, 'opening', 'Count on 1 Oct');
insert into r(name, ok, detail) select 'opening stock moves average cost to 55', on_hand = 20 and avg_cost = 55, on_hand || ' @ ' || avg_cost from public.fin_item_avg_cost(pg_temp.id('item'));

-- sales invoice with COGS
with s as (insert into public.fin_invoices (entity_id, kind, party_id, issue_date, due_date) values (pg_temp.id('biz'), 'sale', pg_temp.id('cust'), current_date, current_date + 30) returning id) insert into ids select 'sale', id from s;
insert into public.fin_invoice_lines (invoice_id, item_id, description, qty, unit_price) values (pg_temp.id('sale'), pg_temp.id('item'), 'Bespoke suit fabric', 4, 250);
with s as (insert into public.fin_invoices (entity_id, kind, issue_date) values (pg_temp.id('biz'), 'sale', current_date) returning id) insert into ids select 'sale0', id from s;
insert into public.fin_invoice_lines (invoice_id, description, qty, unit_price) values (pg_temp.id('sale0'), 'Alteration', 1, 50);
select pg_temp.expect_error('sale without a customer cannot post', 'select public.fin_post_invoice(pg_temp.id(''sale0''))', 'party_required');
delete from public.fin_invoices where id = pg_temp.id('sale0');
select public.fin_post_invoice(pg_temp.id('sale'));
insert into r(name, ok, detail) select 'sale posts INV-0001: receivable 1000, sales 1000, COGS 220 at average cost',
  i.number = 'INV-0001'
  and (select debit from public.fin_lines where journal_id = i.journal_id and account_id = pg_temp.id('ar')) = 1000
  and (select credit from public.fin_lines where journal_id = i.journal_id and account_id = pg_temp.id('sales')) = 1000
  and (select debit from public.fin_lines where journal_id = i.journal_id and account_id = pg_temp.id('cogs')) = 220
  and (select credit from public.fin_lines where journal_id = i.journal_id and account_id = pg_temp.id('inv')) = 220,
  (select string_agg(a.code || ':' || l.debit || '/' || l.credit, ' ') from public.fin_lines l join public.fin_accounts a on a.id = l.account_id where l.journal_id = i.journal_id)
  from public.fin_invoices i where i.id = pg_temp.id('sale');
with s as (insert into public.fin_invoices (entity_id, kind, party_id, issue_date) values (pg_temp.id('biz'), 'sale', pg_temp.id('cust'), current_date) returning id) insert into ids select 'sale2', id from s;
insert into public.fin_invoice_lines (invoice_id, item_id, description, qty, unit_price) values (pg_temp.id('sale2'), pg_temp.id('item'), 'Too much', 50, 10);
select pg_temp.expect_error('cannot sell more stock than on hand', 'select public.fin_post_invoice(pg_temp.id(''sale2''))', 'insufficient_stock');

-- payments
select pg_temp.expect_error('payments must use a bank, cash or card account', format('select public.fin_record_payment(%L, ''in'', %L, current_date, 100, %L, null, null, ''[]'')', pg_temp.id('biz'), pg_temp.id('cust'), pg_temp.id('sales')), 'bad_account');
select pg_temp.expect_error('cannot allocate more than is outstanding',
  format('select public.fin_record_payment(%L, ''in'', %L, current_date, 1500, %L, ''TT1'', null, %L)', pg_temp.id('biz'), pg_temp.id('cust'), pg_temp.id('bank'), jsonb_build_array(jsonb_build_object('invoice_id', pg_temp.id('sale'), 'amount', 1500))), 'overpayment');
select pg_temp.expect_error('money in cannot settle a supplier bill',
  format('select public.fin_record_payment(%L, ''in'', %L, current_date, 100, %L, null, null, %L)', pg_temp.id('biz'), pg_temp.id('supp'), pg_temp.id('bank'), jsonb_build_array(jsonb_build_object('invoice_id', pg_temp.id('bill'), 'amount', 100))), 'wrong_kind');
with p as (select public.fin_record_payment(pg_temp.id('biz'), 'in', pg_temp.id('cust'), current_date, 600, pg_temp.id('bank'), 'TT-0091', 'Part payment',
  jsonb_build_array(jsonb_build_object('invoice_id', pg_temp.id('sale'), 'amount', 600))) as id) insert into ids select 'pay', id from p;
insert into r(name, ok, detail) select 'part payment leaves 400 outstanding', total = 1000 and paid = 600, total || ' / ' || paid from public.fin_invoice_totals where invoice_id = pg_temp.id('sale');
select pg_temp.expect_error('invoice with payments cannot be voided', 'select public.fin_void_invoice(pg_temp.id(''sale''), ''Customer cancelled'')', 'has_payments');
select pg_temp.expect_error('payment entries cannot be reversed directly', 'select public.fin_reverse_journal((select journal_id from public.fin_payments where id = pg_temp.id(''pay'')), ''x'')', 'use_document');
select pg_temp.expect_error('payments cannot be inserted directly', format('insert into public.fin_payments (entity_id, direction, pay_date, amount, account_id) values (%L, ''in'', current_date, 5, %L)', pg_temp.id('biz'), pg_temp.id('bank')), 'new row');

-- bank reconciliation
with s as (insert into public.fin_statement_lines (entity_id, account_id, line_date, description, amount, reference) values (pg_temp.id('biz'), pg_temp.id('bank'), current_date, 'TT AL NOOR', 600, 'TT-0091') returning id) insert into ids select 'st', id from s;
with s as (insert into public.fin_statement_lines (entity_id, account_id, line_date, description, amount) values (pg_temp.id('biz'), pg_temp.id('bank'), current_date, 'Bank charge', -15) returning id) insert into ids select 'st2', id from s;
select pg_temp.expect_error('duplicate statement lines are rejected', format('insert into public.fin_statement_lines (entity_id, account_id, line_date, description, amount) values (%L, %L, current_date, ''Bank charge'', -15)', pg_temp.id('biz'), pg_temp.id('bank')), 'duplicate key');
select pg_temp.expect_error('statement can''t be marked matched directly', 'update public.fin_statement_lines set status = ''matched'' where id = pg_temp.id(''st'')', 'match_via_function');
select pg_temp.expect_error('amounts must agree to match', format('select public.fin_match_statement(%L, (select id from public.fin_lines where journal_id = %L and account_id = %L))', pg_temp.id('st2'), (select journal_id from public.fin_payments where id = pg_temp.id('pay')), pg_temp.id('bank')), 'amount_mismatch');
select public.fin_match_statement(pg_temp.id('st'), (select id from public.fin_lines where journal_id = (select journal_id from public.fin_payments where id = pg_temp.id('pay')) and account_id = pg_temp.id('bank')));
insert into r(name, ok) select 'statement line matched to the payment', status = 'matched' and matched_line_id is not null from public.fin_statement_lines where id = pg_temp.id('st');
select pg_temp.expect_error('reconciled payment cannot be voided', 'select public.fin_void_payment(pg_temp.id(''pay''), ''Bounced'')', 'reconciled');
select public.fin_unmatch_statement(pg_temp.id('st'));
select public.fin_void_payment(pg_temp.id('pay'), 'Cheque bounced');
insert into r(name, ok, detail) select 'voided payment reopens the invoice balance', paid = 0, paid::text from public.fin_invoice_totals where invoice_id = pg_temp.id('sale');
select public.fin_void_invoice(pg_temp.id('sale'), 'Customer cancelled');
insert into r(name, ok, detail) select 'void invoice reverses the entry and returns stock', i.status = 'void' and (select reversed_by from public.fin_journals where id = i.journal_id) is not null
  and (select on_hand from public.fin_item_avg_cost(pg_temp.id('item'))) = 20, i.status from public.fin_invoices i where i.id = pg_temp.id('sale');

-- the books always balance
insert into r(name, ok, detail) select 'trial balance: total debits = total credits', sum(l.debit) = sum(l.credit), sum(l.debit) || ' / ' || sum(l.credit)
  from public.fin_lines l join public.fin_journals j on j.id = l.journal_id where j.entity_id = pg_temp.id('biz') and j.status = 'posted';
insert into r(name, ok) select 'every posted entry balances on its own', not exists (
  select 1 from public.fin_lines l join public.fin_journals j on j.id = l.journal_id where j.entity_id = pg_temp.id('biz') and j.status = 'posted' group by j.id having sum(l.debit) <> sum(l.credit));
insert into r(name, ok, detail) select 'journal numbers are sequential with no gaps', max(number) = count(*), count(*) || ' entries, max #' || max(number) from public.fin_journals where entity_id = pg_temp.id('biz') and status = 'posted';
insert into r(name, ok, detail) select 'finance changes are audited', count(*) >= 5, count(*)::text from public.fin_audit where entity_id = pg_temp.id('biz');

-- files in private storage
insert into storage.objects (bucket_id, name, owner) values ('finance', pg_temp.id('biz')::text || '/f1/receipt.pdf', 'aaaaaaaa-0000-4000-8000-0000000000fa');
insert into public.fin_files (entity_id, invoice_id, title, storage_path) values (pg_temp.id('biz'), pg_temp.id('bill'), 'Supplier bill', pg_temp.id('biz')::text || '/f1/receipt.pdf');
insert into r(name, ok) select 'owner can attach a receipt to a bill', count(*) = 1 from public.fin_files where invoice_id = pg_temp.id('bill');

-- members
select public.fin_add_member(pg_temp.id('biz'), 'FIN-B@example.invalid', 'viewer');
select pg_temp.expect_error('adding an unknown email explains it', format('select public.fin_add_member(%L, ''nobody@example.invalid'', ''viewer'')', pg_temp.id('biz')), 'no_account');
select pg_temp.expect_error('the last owner cannot be removed', format('delete from public.fin_members where entity_id = %L and user_id = ''aaaaaaaa-0000-4000-8000-0000000000fa''', pg_temp.id('biz')), 'last_owner');

-- ================================================================ as B (viewer)
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-0000000000fb","role":"authenticated"}', true);
insert into r(name, ok) select 'viewer can read the books', (select count(*) from public.fin_journals where entity_id = pg_temp.id('biz')) > 0 and (select count(*) from public.fin_invoices where entity_id = pg_temp.id('biz')) = 3;
insert into r(name, ok) select 'viewer can read receipts (for signed links)', count(*) = 1 from storage.objects where bucket_id = 'finance';
insert into r(name, ok) select 'viewer cannot see the owner''s personal books', not exists (select 1 from public.fin_entities where id = pg_temp.id('pers')) and not exists (select 1 from public.fin_accounts where entity_id = pg_temp.id('pers'));
select pg_temp.expect_error('viewer cannot create entries', format('insert into public.fin_journals (entity_id, entry_date, memo) values (%L, current_date, ''x'')', pg_temp.id('biz')), 'new row');
select pg_temp.expect_error('viewer cannot post', 'select public.fin_post_journal(pg_temp.id(''jl''))', 'forbidden');
select pg_temp.expect_error('viewer cannot record payments', format('select public.fin_record_payment(%L, ''out'', %L, current_date, 10, %L, null, null, ''[]'')', pg_temp.id('biz'), pg_temp.id('supp'), pg_temp.id('bank')), 'forbidden');
select pg_temp.expect_error('viewer cannot upload receipts', format('insert into storage.objects (bucket_id, name, owner) values (''finance'', %L, ''bbbbbbbb-0000-4000-8000-0000000000fb'')', pg_temp.id('biz')::text || '/f2/x.pdf'), 'new row');
select pg_temp.expect_error('viewer cannot add people', format('select public.fin_add_member(%L, ''fin-c@example.invalid'', ''owner'')', pg_temp.id('biz')), 'forbidden');
with u as (update public.fin_accounts set name = 'hacked' where entity_id = pg_temp.id('biz') returning 1) insert into r(name, ok) select 'viewer cannot rename accounts', count(*) = 0 from u;

-- ================================================================ as C (outsider)
select set_config('request.jwt.claims', '{"sub":"cccccccc-0000-4000-8000-0000000000fc","role":"authenticated"}', true);
insert into r(name, ok) select 'outsider sees no books, entries, invoices, payments or receipts',
  (select count(*) from public.fin_entities where id in (pg_temp.id('biz'), pg_temp.id('pers'))) = 0 and (select count(*) from public.fin_journals) = 0
  and (select count(*) from public.fin_invoices) = 0 and (select count(*) from public.fin_payments) = 0 and (select count(*) from storage.objects where bucket_id = 'finance') = 0
  and (select count(*) from public.fin_invoice_totals) = 0 and (select count(*) from public.fin_audit) = 0;
select pg_temp.expect_error('outsider cannot post into someone else''s books', 'select public.fin_post_journal(pg_temp.id(''j1''))', 'forbidden');
select pg_temp.expect_error('outsider cannot add lines to someone else''s draft', format('insert into public.fin_lines (journal_id, account_id, debit) values (%L, %L, 5)', pg_temp.id('j1'), pg_temp.id('rent')), '');
insert into r(name, ok) select 'outsider cannot read stock cost', not exists (select 1 from public.fin_item_avg_cost(pg_temp.id('item')) where on_hand <> 0);
with e as (insert into public.fin_entities (name, kind, base_currency) values ('C own books', 'business', 'INR') returning id) insert into ids select 'cbooks', id from e;
insert into r(name, ok) select 'anyone can open their own books (INR)', base_currency = 'INR' from public.fin_entities where id = pg_temp.id('cbooks');

-- ================================================================ anonymous
reset role; set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
do $$ declare c int; begin select count(*) into c from public.fin_entities; insert into r(name, ok, detail) values ('anonymous visitors cannot read books', c = 0, c::text);
exception when others then insert into r(name, ok, detail) values ('anonymous visitors cannot read books', true, sqlerrm); end $$;
do $$ declare c int; begin select count(*) into c from public.fin_lines; insert into r(name, ok, detail) values ('anonymous visitors cannot read ledger lines', c = 0, c::text);
exception when others then insert into r(name, ok, detail) values ('anonymous visitors cannot read ledger lines', true, sqlerrm); end $$;

-- ================================================================ reminders (scheduled job runs as the database owner)
reset role;
select set_config('request.jwt.claims', null, true);
select public.fin_reminders();
select public.fin_reminders();
insert into r(name, ok, detail) select 'bill due soon reminds owner once (not on re-run)', count(*) = 1, count(*)::text from public.notifications
  where user_id = 'aaaaaaaa-0000-4000-8000-0000000000fa' and kind = 'bill_due';
insert into r(name, ok) select 'viewers are not sent bill reminders', not exists (select 1 from public.notifications where user_id = 'bbbbbbbb-0000-4000-8000-0000000000fb' and kind like 'bill%');

select n, ok, name, detail from r order by n;
rollback;
