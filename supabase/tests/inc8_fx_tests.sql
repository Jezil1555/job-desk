-- Increment 8 tests (foreign currency). Run inside begin … rollback. Throwaway users and books only.
create temp table r (name text, ok boolean, detail text);
create temp table ids (k text primary key, v uuid);
grant all on r, ids to authenticated;
create or replace function pg_temp.err(p_name text, p_sql text, p_code text) returns void language plpgsql as $$
begin execute p_sql; insert into r values (p_name, false, 'no error');
exception when others then insert into r values (p_name, sqlerrm like p_code || '%', sqlerrm); end $$;
grant execute on function pg_temp.err(text, text, text) to authenticated;
create or replace function pg_temp.id(k text) returns uuid language sql stable as $$ select v from ids where ids.k = $1 $$;
grant execute on function pg_temp.id(text) to authenticated;
create or replace function pg_temp.acc(c text) returns uuid language sql stable as $$ select id from public.fin_accounts where entity_id = pg_temp.id('e') and code = c $$;
create or replace function pg_temp.bal(k text, d date default '2099-01-01') returns numeric language sql stable as $$
  select coalesce(sum(l.debit - l.credit), 0) from public.fin_lines l join public.fin_journals j on j.id = l.journal_id join public.fin_accounts a on a.id = l.account_id
  where j.status = 'posted' and l.entity_id = pg_temp.id('e') and (a.system_key = k or a.code = k) and j.entry_date <= d $$;
grant execute on function pg_temp.acc(text), pg_temp.bal(text, date) to authenticated;
insert into auth.users (id, email, aud, role, instance_id) values ('aaaaaaaa-0000-4000-8000-0000000008a8','i8a@example.invalid','authenticated','authenticated','00000000-0000-0000-0000-000000000000'),
 ('cccccccc-0000-4000-8000-0000000008c8','i8c@example.invalid','authenticated','authenticated','00000000-0000-0000-0000-000000000000');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000008a8","role":"authenticated"}', true);
with e as (insert into public.fin_entities (name, kind, base_currency) values ('FX Bespoke', 'business', 'QAR') returning id) insert into ids select 'e', id from e;
with p as (insert into public.fin_parties (entity_id, name, kind) values (pg_temp.id('e'), 'London client', 'customer') returning id) insert into ids select 'cust', id from p;
with p as (insert into public.fin_parties (entity_id, name, kind) values (pg_temp.id('e'), 'Biella mill', 'supplier') returning id) insert into ids select 'supp', id from p;
with i as (insert into public.fin_items (entity_id, name, unit, inventory_account_id) values (pg_temp.id('e'), 'Italian wool', 'm', pg_temp.acc('1200')) returning id) insert into ids select 'wool', id from i;
-- 1. USD sales invoice 1,000 @ 3.64
with i as (insert into public.fin_invoices (entity_id, kind, party_id, issue_date, currency, fx_rate) values (pg_temp.id('e'), 'sale', pg_temp.id('cust'), '2026-09-10', 'USD', 3.64) returning id) insert into ids select 'inv', id from i;
insert into public.fin_invoice_lines (invoice_id, entity_id, description, qty, unit_price, account_id) values (pg_temp.id('inv'), pg_temp.id('e'), 'Two suits', 2, 500, pg_temp.acc('4000'));
select public.fin_post_invoice(pg_temp.id('inv'));
insert into r select 'USD invoice posts in QAR at the invoice rate', pg_temp.bal('ar') = 3640 and pg_temp.bal('4000') = -3640, pg_temp.bal('ar')::text;
insert into r select 'receivable line keeps the USD amount', (select fx_currency = 'USD' and fx_amount = 1000 from public.fin_lines where journal_id = (select journal_id from public.fin_invoices where id = pg_temp.id('inv')) and account_id = pg_temp.acc('1100')), null;
insert into r select 'invoice totals stay in USD', (select total = 1000 from public.fin_invoice_totals where invoice_id = pg_temp.id('inv')), null;
select pg_temp.err('posted invoice currency can''t change', format('update public.fin_invoices set fx_rate = 3.7 where id = %L', pg_temp.id('inv')), 'posted_immutable');
-- 2. validation
with i as (insert into public.fin_invoices (entity_id, kind, party_id, issue_date, currency) values (pg_temp.id('e'), 'sale', pg_temp.id('cust'), '2026-09-11', 'EUR') returning id) insert into ids select 'norate', id from i;
insert into public.fin_invoice_lines (invoice_id, entity_id, description, qty, unit_price, account_id) values (pg_temp.id('norate'), pg_temp.id('e'), 'x', 1, 10, pg_temp.acc('4000'));
select pg_temp.err('foreign invoice without a rate is refused', format('select public.fin_post_invoice(%L)', pg_temp.id('norate')), 'rate_required');
with i as (insert into public.fin_invoices (entity_id, kind, party_id, issue_date, currency, fx_rate) values (pg_temp.id('e'), 'sale', pg_temp.id('cust'), '2026-09-11', 'QAR', 2) returning id) insert into ids select 'qinv', id from i;
insert into r select 'choosing the base currency stores a normal invoice', (select currency is null and fx_rate is null from public.fin_invoices where id = pg_temp.id('qinv')), null;
select pg_temp.err('base-currency payment can''t settle a USD invoice', format('select public.fin_record_payment(%L, $q$in$q$, %L, $q$2026-09-20$q$, 100, %L, null, null, %L::jsonb)',
  pg_temp.id('e'), pg_temp.id('cust'), pg_temp.acc('1010'), json_build_array(json_build_object('invoice_id', pg_temp.id('inv'), 'amount', 100))), 'currency_mismatch');
select pg_temp.err('foreign payment needs the bank amount', format('select public.fin_record_fx_payment(%L)', jsonb_build_object('entity_id', pg_temp.id('e'), 'direction', 'in', 'party_id', pg_temp.id('cust'),
  'pay_date', '2026-09-20', 'currency', 'USD', 'amount', 400, 'account_id', pg_temp.acc('1010'))), 'base_amount_required');
-- 3. part-payment USD 400 arrives as QAR 1,460 (3.65): realised gain 4
insert into ids select 'pay', public.fin_record_fx_payment(jsonb_build_object('entity_id', pg_temp.id('e'), 'direction', 'in', 'party_id', pg_temp.id('cust'), 'pay_date', '2026-09-20',
  'currency', 'USD', 'amount', 400, 'base_amount', 1460, 'account_id', pg_temp.acc('1010'), 'reference', 'SWIFT 8812', 'allocations', jsonb_build_array(jsonb_build_object('invoice_id', pg_temp.id('inv'), 'amount', 400))));
insert into r select 'bank shows what arrived; receivable cleared at the booked rate', pg_temp.bal('1010') = 1460 and pg_temp.bal('ar') = 2184, pg_temp.bal('1010') || ' / ' || pg_temp.bal('ar');
insert into r select 'realised gain of 4 posted to exchange gains', pg_temp.bal('fx') = -4 and (select fx_gain = 4 from public.fin_payments where id = pg_temp.id('pay')), pg_temp.bal('fx')::text;
insert into r select 'invoice shows USD 600 still owed', (select total - paid = 600 from public.fin_invoice_totals where invoice_id = pg_temp.id('inv')), null;
-- 4. month-end revaluation at 3.62
select pg_temp.err('revaluation needs a rate for every open currency', format('select public.fin_fx_revalue(%L, $q$2026-09-30$q$, $q${}$q$::jsonb)', pg_temp.id('e')), 'rate_required');
insert into ids select 'rv', public.fin_fx_revalue(pg_temp.id('e'), '2026-09-30', '{"USD": 3.62}');
insert into r select 'revaluation: USD 600 now worth 2,172 — unrealised loss 12 at month end', pg_temp.bal('ar', '2026-09-30') = 2172 and pg_temp.bal('fx', '2026-09-30') = 8
  and (select net = -12 from public.fin_fx_revaluations where id = pg_temp.id('rv')), pg_temp.bal('ar', '2026-09-30') || ' / ' || pg_temp.bal('fx', '2026-09-30');
insert into r select 'reversed automatically on 1 Oct', pg_temp.bal('ar', '2026-10-01') = 2184 and pg_temp.bal('fx', '2026-10-01') = -4
  and (select entry_date = '2026-10-01' from public.fin_journals where id = (select reversal_journal_id from public.fin_fx_revaluations where id = pg_temp.id('rv'))), null;
select pg_temp.err('one revaluation per date', format('select public.fin_fx_revalue(%L, $q$2026-09-30$q$, $q${"USD": 3.6}$q$::jsonb)', pg_temp.id('e')), 'already_revalued');
select pg_temp.err('the revaluation entry is already reversed and can''t be reversed again', format('select public.fin_reverse_journal(%L, $q$x$q$)', (select journal_id from public.fin_fx_revaluations where id = pg_temp.id('rv'))), 'already_reversed');
select pg_temp.err('cancelling needs a reason', format('select public.fin_fx_revaluation_cancel(%L, $q$$q$)', pg_temp.id('rv')), 'reason_required');
select public.fin_fx_revaluation_cancel(pg_temp.id('rv'), 'Used the wrong closing rate');
insert into r select 'cancel posts the opposite of both entries; originals kept', pg_temp.bal('ar', '2026-09-30') = 2184 and pg_temp.bal('fx') = -4
  and (select status = 'cancelled' and array_length(cancel_journal_ids, 1) = 2 from public.fin_fx_revaluations where id = pg_temp.id('rv')), null;
select pg_temp.err('revaluation entries can only be undone through the revaluation', format('select public.fin_reverse_journal(%L, $q$x$q$)', (select cancel_journal_ids[1] from public.fin_fx_revaluations where id = pg_temp.id('rv'))), 'use_document');
insert into ids select 'rv2', public.fin_fx_revalue(pg_temp.id('e'), '2026-09-30', '{"USD": 3.66}');
insert into r select 'after cancelling, the date can be revalued again (gain 12)', (select net = 12 from public.fin_fx_revaluations where id = pg_temp.id('rv2')), null;
-- 5. EUR bill for fabric: stock at the base cost; paid at a better rate
with i as (insert into public.fin_invoices (entity_id, kind, party_id, issue_date, currency, fx_rate, party_reference) values (pg_temp.id('e'), 'purchase', pg_temp.id('supp'), '2026-10-02', 'EUR', 4.0, 'BM-77') returning id) insert into ids select 'bill', id from i;
insert into public.fin_invoice_lines (invoice_id, entity_id, item_id, description, qty, unit_price) values (pg_temp.id('bill'), pg_temp.id('e'), pg_temp.id('wool'), 'Italian wool', 10, 20);
select public.fin_post_invoice(pg_temp.id('bill'));
insert into r select 'EUR bill: stock and payable in QAR at 4.0', pg_temp.bal('ap') = -800 and pg_temp.bal('1200') = 800
  and (select avg_cost from public.fin_item_avg_cost(pg_temp.id('wool'))) = 80, pg_temp.bal('ap')::text;
insert into ids select 'pay2', public.fin_record_fx_payment(jsonb_build_object('entity_id', pg_temp.id('e'), 'direction', 'out', 'party_id', pg_temp.id('supp'), 'pay_date', '2026-10-15',
  'currency', 'EUR', 'amount', 200, 'base_amount', 790, 'account_id', pg_temp.acc('1010'), 'allocations', jsonb_build_array(jsonb_build_object('invoice_id', pg_temp.id('bill'), 'amount', 200))));
insert into r select 'paying EUR 200 for QAR 790 clears 800 owed: gain 10', pg_temp.bal('ap') = 0 and (select fx_gain = 10 from public.fin_payments where id = pg_temp.id('pay2')) and pg_temp.bal('fx') = -14, pg_temp.bal('fx')::text;
select pg_temp.err('a EUR payment can''t settle the USD invoice', format('select public.fin_record_fx_payment(%L)', jsonb_build_object('entity_id', pg_temp.id('e'), 'direction', 'in', 'party_id', pg_temp.id('cust'),
  'pay_date', '2026-10-20', 'currency', 'EUR', 'amount', 10, 'base_amount', 40, 'account_id', pg_temp.acc('1010'), 'allocations', jsonb_build_array(jsonb_build_object('invoice_id', pg_temp.id('inv'), 'amount', 10)))), 'currency_mismatch');
-- 6. voiding a foreign payment undoes the gain too
select public.fin_void_payment(pg_temp.id('pay2'), 'Bank returned it');
insert into r select 'voiding the payment restores the payable and removes its gain', pg_temp.bal('ap') = -800 and pg_temp.bal('fx') = -4
  and (select paid = 0 from public.fin_invoice_totals where invoice_id = pg_temp.id('bill')), pg_temp.bal('fx')::text;
-- 7. base-currency invoices unchanged
with i as (insert into public.fin_invoices (entity_id, kind, party_id, issue_date) values (pg_temp.id('e'), 'sale', pg_temp.id('cust'), '2026-10-05') returning id) insert into ids select 'binv', id from i;
insert into public.fin_invoice_lines (invoice_id, entity_id, description, qty, unit_price, account_id) values (pg_temp.id('binv'), pg_temp.id('e'), 'Alteration', 1, 250, pg_temp.acc('4000'));
select public.fin_post_invoice(pg_temp.id('binv'));
insert into r select 'QAR invoice posts as before, with no foreign amount', (select count(*) = 0 from public.fin_lines where journal_id = (select journal_id from public.fin_invoices where id = pg_temp.id('binv')) and fx_currency is not null)
  and pg_temp.bal('4000') = -3890, pg_temp.bal('4000')::text;
insert into r select 'trial balance balances', (select sum(debit) = sum(credit) from public.fin_lines l join public.fin_journals j on j.id = l.journal_id where j.status = 'posted' and l.entity_id = pg_temp.id('e')), null;
-- 8. outsiders
select set_config('request.jwt.claims', '{"sub":"cccccccc-0000-4000-8000-0000000008c8","role":"authenticated"}', true);
insert into r select 'outsiders see no revaluations or open items', (select count(*) from public.fin_fx_revaluations) = 0 and (select count(*) from public.fin_fx_open_items(pg_temp.id('e'), '2026-12-31')) = 0, null;
select pg_temp.err('outsiders can''t revalue', format('select public.fin_fx_revalue(%L, $q$2026-10-31$q$, $q${"USD": 3.6}$q$::jsonb)', pg_temp.id('e')), 'forbidden');
select pg_temp.err('outsiders can''t record foreign payments', format('select public.fin_record_fx_payment(%L)', jsonb_build_object('entity_id', pg_temp.id('e'), 'direction', 'in')), 'forbidden');
reset role;
select count(*) filter (where ok) passed, count(*) total, json_agg(json_build_object('n', name, 'd', detail)) filter (where not ok) failures from r;
