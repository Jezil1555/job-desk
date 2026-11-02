-- Undo 20261102150000_multi_currency. Refuses once anything depends on it: foreign-currency accounts with entries, entries recorded with a
-- foreign amount, cross-currency partner lines, or budgets set in another currency. Reverse those through the app first.
do $$ begin
  if exists (select 1 from public.fin_lines l join public.fin_accounts a on a.id = l.account_id where a.currency is not null) then raise exception 'refused: foreign-currency accounts have entries'; end if;
  if exists (select 1 from public.fin_money_fx) then raise exception 'refused: entries were recorded with foreign amounts'; end if;
  if exists (select 1 from public.fin_partner_txns where mirror_amount is not null or mirror_fx_amount is not null) then raise exception 'refused: cross-currency partner lines exist'; end if;
  if exists (select 1 from public.fin_budgets where native_currency is not null) then raise exception 'refused: budgets are set in another currency'; end if;
end $$;
do $$ declare d text; begin
  for d in select definition from private.migration_snapshots where migration = '20261102150000' loop execute d; end loop;
end $$;
delete from private.migration_snapshots where migration = '20261102150000';
drop function if exists public.fin_money_link_business(uuid, uuid, text);
drop function if exists public.fin_fx_line(uuid, uuid, text, numeric, numeric, jsonb);
drop trigger if exists fin_lines_fx_guard on public.fin_lines;
drop function if exists public.fin_lines_fx_guard();
drop trigger if exists fin_accounts_currency_guard on public.fin_accounts;
drop function if exists public.fin_accounts_currency_guard();
drop table if exists public.fin_money_fx;
alter table public.fin_partner_txns drop column if exists mirror_fx_amount;
alter table public.fin_partner_txns drop column if exists mirror_amount;
alter table public.fin_budgets drop column if exists native_amount;
alter table public.fin_budgets drop column if exists native_currency;
alter table public.fin_import_rows drop column if exists rate_source;
alter table public.fin_import_rows drop column if exists base_amount;
alter table public.fin_accounts drop column if exists currency;
delete from public.fin_accounts a where a.code = '6870' and a.name = 'Exchange differences' and not exists (select 1 from public.fin_lines l where l.account_id = a.id);
