-- Undo 20261031010000_production_costing. Refuses once any receipt or production entry is posted (reverse them and keep the module instead).
do $$ begin
  if exists (select 1 from public.fin_journals where source in ('receipt','production')) or exists (select 1 from public.fin_stock_moves where source in ('receipt','production')) then
    raise exception 'production or receipt entries exist — rolling back would orphan posted entries';
  end if;
end $$;
drop view if exists public.fin_production_summary;
drop function if exists public.fin_production_cancel(uuid, text);
drop function if exists public.fin_production_complete(uuid, date);
drop function if exists public.fin_production_reverse_cost(uuid, text);
drop function if exists public.fin_production_add_cost(uuid, numeric, uuid, date, text);
drop function if exists public.fin_production_issue(uuid, uuid, numeric, date, text, text);
drop function if exists public.fin_production_open(uuid, text, uuid, text, date);
drop function if exists public.fin_goods_receipt_reverse(uuid, text);
drop function if exists public.fin_goods_receipt(jsonb);
drop function if exists public.fin_issue_cost(uuid);
alter table public.fin_stock_moves drop column if exists production_order_id, drop column if exists exception_id;
drop table if exists public.fin_production_costs;
drop table if exists public.fin_goods_receipts;
drop table if exists public.fin_stock_exceptions;
drop table if exists public.fin_production_orders;
drop function if exists public.fin_production_orders_guard();
delete from public.fin_accounts a where a.system_key in ('wip','grni') and not exists (select 1 from public.fin_lines l where l.account_id = a.id);
drop function if exists public.fin_sys_account_ensure(uuid, text);
do $$ declare d text; begin
  for d in select definition from private.migration_snapshots where migration = '20261031010000' loop execute d; end loop;
end $$;
alter table public.fin_stock_moves drop constraint fin_stock_moves_source_check;
alter table public.fin_stock_moves add constraint fin_stock_moves_source_check check (source in ('purchase','sale','void','adjustment','opening'));
alter table public.fin_accounts drop constraint fin_accounts_system_key_check;
alter table public.fin_accounts add constraint fin_accounts_system_key_check check (system_key in ('cash','bank','ar','ap','inventory','cogs','sales','capital','drawings','retained','opening','intercompany'));
alter table public.fin_journals drop constraint fin_journals_source_check;
alter table public.fin_journals add constraint fin_journals_source_check check (source in ('manual','opening','invoice','bill','payment','reversal','stock','partner','intercompany'));
delete from private.migration_snapshots where migration = '20261031010000';
