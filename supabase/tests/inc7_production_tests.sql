-- Increment 7 tests (production costing). Run inside begin … rollback. Throwaway users and books only.
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
create or replace function pg_temp.bal(k text) returns numeric language sql stable as $$
  select coalesce(sum(l.debit - l.credit), 0) from public.fin_lines l join public.fin_journals j on j.id = l.journal_id join public.fin_accounts a on a.id = l.account_id
  where j.status = 'posted' and l.entity_id = pg_temp.id('e') and (a.system_key = k or a.code = k) $$;
grant execute on function pg_temp.acc(text), pg_temp.bal(text) to authenticated;
insert into auth.users (id, email, aud, role, instance_id) values ('aaaaaaaa-0000-4000-8000-0000000007a7','i7a@example.invalid','authenticated','authenticated','00000000-0000-0000-0000-000000000000'),
 ('bbbbbbbb-0000-4000-8000-0000000007b7','i7b@example.invalid','authenticated','authenticated','00000000-0000-0000-0000-000000000000'),
 ('cccccccc-0000-4000-8000-0000000007c7','i7c@example.invalid','authenticated','authenticated','00000000-0000-0000-0000-000000000000');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000007a7","role":"authenticated"}', true);
with e as (insert into public.fin_entities (name, kind, base_currency) values ('PC Bespoke', 'business', 'QAR') returning id) insert into ids select 'e', id from e;
select public.fin_add_member(pg_temp.id('e'), 'i7b@example.invalid', 'bookkeeper');
with i as (insert into public.fin_items (entity_id, name, unit, inventory_account_id) values (pg_temp.id('e'), 'Wool suiting', 'm', pg_temp.acc('1200')) returning id) insert into ids select 'wool', id from i;
with p as (insert into public.fin_parties (entity_id, name, kind) values (pg_temp.id('e'), 'Al Balai Textiles', 'supplier') returning id) insert into ids select 'supp', id from p;
with p as (insert into public.fin_parties (entity_id, name, kind) values (pg_temp.id('e'), 'Mr Khalid', 'customer') returning id) insert into ids select 'cust', id from p;
-- 1. fabric received before the bill
insert into ids select 'grn', public.fin_goods_receipt(jsonb_build_object('item_id', pg_temp.id('wool'), 'qty', 10, 'unit_cost', 40, 'party_id', pg_temp.id('supp'), 'receipt_date', '2026-10-02', 'reference', 'DN-118'));
insert into r select 'receipt: stock in at cost, owed as goods received not yet billed', pg_temp.bal('inventory') = 400 and pg_temp.bal('grni') = -400
  and (select on_hand from public.fin_item_avg_cost(pg_temp.id('wool'))) = 10, pg_temp.bal('inventory') || ' / ' || pg_temp.bal('grni');
-- 2. the supplier's bill arrives: clears the received-not-billed account (no second stock move)
with b as (insert into public.fin_invoices (entity_id, kind, party_id, issue_date) values (pg_temp.id('e'), 'purchase', pg_temp.id('supp'), '2026-10-04') returning id) insert into ids select 'bill', id from b;
insert into public.fin_invoice_lines (invoice_id, entity_id, description, qty, unit_price, account_id) values (pg_temp.id('bill'), pg_temp.id('e'), 'Wool suiting 10 m (GRN-0001)', 1, 400, pg_temp.acc('2050'));
select public.fin_post_invoice(pg_temp.id('bill'));
insert into r select 'bill clears goods-received and creates the payable; stock not doubled', pg_temp.bal('grni') = 0 and pg_temp.bal('ap') = -400 and pg_temp.bal('inventory') = 400
  and (select on_hand from public.fin_item_avg_cost(pg_temp.id('wool'))) = 10, null;
-- 3. job: issue 3.5 m of fabric, add stitching cost, complete
insert into ids select 'job', public.fin_production_open(pg_temp.id('e'), 'Navy two-piece suit', pg_temp.id('cust'), 'K-2210', '2026-10-05');
insert into r select 'orders are numbered automatically', order_no = 'JOB-0001' and status = 'open', order_no from public.fin_production_orders where id = pg_temp.id('job');
insert into ids select 'c1', public.fin_production_issue(pg_temp.id('job'), pg_temp.id('wool'), 3.5, '2026-10-06', 'Cutting');
insert into r select 'issue: fabric moves from inventory to work in progress at average cost', pg_temp.bal('wip') = 140 and pg_temp.bal('inventory') = 260
  and (select on_hand from public.fin_item_avg_cost(pg_temp.id('wool'))) = 6.5, pg_temp.bal('wip') || ' / ' || pg_temp.bal('inventory');
select pg_temp.err('job costs need a description', format('select public.fin_production_add_cost(%L, 150, %L)', pg_temp.id('job'), pg_temp.acc('1010')), 'note_required');
select pg_temp.err('job costs can''t come from income', format('select public.fin_production_add_cost(%L, 150, %L, null, $q$Stitching$q$)', pg_temp.id('job'), pg_temp.acc('4000')), 'bad_account');
insert into ids select 'c2', public.fin_production_add_cost(pg_temp.id('job'), 150, pg_temp.acc('1010'), '2026-10-08', 'Stitching — Topaz tailoring');
insert into r select 'stitching paid from the bank goes into the job', pg_temp.bal('wip') = 290, pg_temp.bal('wip')::text;
-- 4. not enough fabric
select pg_temp.err('using more fabric than in stock is refused', format('select public.fin_production_issue(%L, %L, 8)', pg_temp.id('job'), pg_temp.id('wool')), 'insufficient_stock');
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-0000000007b7","role":"authenticated"}', true);
select pg_temp.err('a bookkeeper can''t authorise negative stock', format('select public.fin_production_issue(%L, %L, 8, null, null, $q$urgent$q$)', pg_temp.id('job'), pg_temp.id('wool')), 'forbidden');
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000007a7","role":"authenticated"}', true);
insert into ids select 'c3', public.fin_production_issue(pg_temp.id('job'), pg_temp.id('wool'), 8, '2026-10-09', 'Second suit', 'Fabric delivered today, receipt not yet entered');
insert into r select 'owner-authorised exception is recorded with reason', (select count(*) from public.fin_stock_exceptions where entity_id = pg_temp.id('e') and qty_short = 1.5 and reason like 'Fabric delivered%') = 1
  and (select on_hand from public.fin_item_avg_cost(pg_temp.id('wool'))) = -1.5, null;
-- 5. reversal puts fabric back
select pg_temp.err('reversing a cost needs a reason', format('select public.fin_production_reverse_cost(%L, $q$$q$)', pg_temp.id('c3')), 'reason_required');
select public.fin_production_reverse_cost(pg_temp.id('c3'), 'Second suit cancelled');
insert into r select 'reversal returns fabric to stock and removes it from the job', (select on_hand from public.fin_item_avg_cost(pg_temp.id('wool'))) = 6.5 and pg_temp.bal('wip') = 290, pg_temp.bal('wip')::text;
select pg_temp.err('production entries can''t be reversed directly', format('select public.fin_reverse_journal(%L, $q$x$q$)', (select journal_id from public.fin_production_costs where id = pg_temp.id('c1'))), 'use_document');
select pg_temp.err('order status can''t be edited directly', format('update public.fin_production_orders set status = $q$completed$q$ where id = %L', pg_temp.id('job')), 'use_function');
-- 6. complete and cost
select public.fin_production_complete(pg_temp.id('job'), '2026-10-12');
insert into r select 'completion moves the job cost to cost of goods sold', pg_temp.bal('wip') = 0 and pg_temp.bal('cogs') = 290
  and (select total_cost from public.fin_production_orders where id = pg_temp.id('job')) = 290, pg_temp.bal('cogs')::text;
insert into r select 'order costing: 140 material + 150 other = 290', (select material_cost = 140 and other_cost = 150 and total_cost = 290 from public.fin_production_summary where order_id = pg_temp.id('job')), null;
select pg_temp.err('completed orders take no more costs', format('select public.fin_production_add_cost(%L, 10, %L, null, $q$Late trim$q$)', pg_temp.id('job'), pg_temp.acc('1010')), 'order_closed');
-- 7. receipt reversal guard, cancellation guard
select pg_temp.err('a delivery already used can''t be reversed', format('select public.fin_goods_receipt_reverse(%L, $q$wrong qty$q$)', pg_temp.id('grn')), 'insufficient_stock');
insert into ids select 'job2', public.fin_production_open(pg_temp.id('e'), 'Kandura', null, null, '2026-10-13');
insert into ids select 'c4', public.fin_production_issue(pg_temp.id('job2'), pg_temp.id('wool'), 1, '2026-10-13');
select pg_temp.err('orders with costs can''t be cancelled', format('select public.fin_production_cancel(%L, $q$client cancelled$q$)', pg_temp.id('job2')), 'has_costs');
select public.fin_production_reverse_cost(pg_temp.id('c4'), 'client cancelled');
select public.fin_production_cancel(pg_temp.id('job2'), 'client cancelled');
insert into r select 'empty order cancels with reason', status = 'cancelled' and cancel_reason = 'client cancelled', status from public.fin_production_orders where id = pg_temp.id('job2');
insert into r select 'trial balance balances', (select sum(debit) = sum(credit) from public.fin_lines l join public.fin_journals j on j.id = l.journal_id where j.status = 'posted' and l.entity_id = pg_temp.id('e')), null;
insert into r select 'stock ledger keeps every movement', (select count(*) from public.fin_stock_moves where item_id = pg_temp.id('wool')) = 6, (select count(*) from public.fin_stock_moves where item_id = pg_temp.id('wool'))::text;
select set_config('request.jwt.claims', '{"sub":"cccccccc-0000-4000-8000-0000000007c7","role":"authenticated"}', true);
insert into r select 'outsiders see no orders, costs or receipts', (select count(*) from public.fin_production_orders) + (select count(*) from public.fin_production_costs) + (select count(*) from public.fin_goods_receipts) = 0, null;
select pg_temp.err('outsiders can''t open orders', format('select public.fin_production_open(%L, $q$x$q$)', pg_temp.id('e')), 'forbidden');
reset role;
select count(*) filter (where ok) passed, count(*) total, json_agg(json_build_object('n', name, 'd', detail)) filter (where not ok) failures from r;
