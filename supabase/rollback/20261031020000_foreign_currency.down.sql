-- Undo 20261031020000_foreign_currency. Refuses once any foreign-currency document or revaluation exists (keep the module and void them instead).
do $$ begin
  if exists (select 1 from public.fin_invoices where currency is not null) or exists (select 1 from public.fin_payments where currency is not null)
     or exists (select 1 from public.fin_journals where source = 'revaluation') or exists (select 1 from public.fin_lines where fx_currency is not null) then
    raise exception 'foreign-currency documents exist — rolling back would orphan posted entries';
  end if;
end $$;
drop function if exists public.fin_fx_revaluation_cancel(uuid, text);
drop function if exists public.fin_fx_revalue(uuid, date, jsonb);
drop function if exists public.fin_fx_open_items(uuid, date);
drop table if exists public.fin_fx_revaluations;
drop function if exists public.fin_record_fx_payment(jsonb);
drop trigger if exists fin_allocations_fx_guard on public.fin_allocations;
drop function if exists public.fin_allocations_fx_guard();
drop trigger if exists fin_invoices_fx_guard on public.fin_invoices;
drop function if exists public.fin_invoices_fx_guard();
delete from public.fin_accounts a where a.system_key = 'fx' and not exists (select 1 from public.fin_lines l where l.account_id = a.id);
drop function if exists public.fin_fx_account(uuid);
alter table public.fin_payments drop column if exists currency, drop column if exists fx_rate, drop column if exists base_amount, drop column if exists fx_gain;
alter table public.fin_invoices drop column if exists currency, drop column if exists fx_rate;
do $$ declare d text; begin
  for d in select definition from private.migration_snapshots where migration = '20261031020000' loop execute d; end loop;
end $$;
revoke execute on function public.fin_system_journal(uuid, date, text, text, text, uuid, jsonb, uuid) from public, anon, authenticated;
revoke execute on function public.fin_reminders() from public, anon, authenticated;
alter table public.fin_accounts drop constraint fin_accounts_system_key_check;
alter table public.fin_accounts add constraint fin_accounts_system_key_check check (system_key in ('cash','bank','ar','ap','inventory','cogs','sales','capital','drawings','retained','opening','intercompany','wip','grni'));
alter table public.fin_journals drop constraint fin_journals_source_check;
alter table public.fin_journals add constraint fin_journals_source_check check (source in ('manual','opening','invoice','bill','payment','reversal','stock','partner','intercompany','receipt','production'));
delete from private.migration_snapshots where migration = '20261031020000';
