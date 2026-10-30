-- Undo 20261031000000_intercompany. Only safe before any inter-entity transaction is posted: posted journals with source
-- 'intercompany' would violate the restored source check, so this script stops if any exist (reverse them first and keep the books).
do $$ begin
  if exists (select 1 from public.fin_journals where source = 'intercompany') then
    raise exception 'inter-entity entries exist — rolling back would orphan posted entries; reverse and keep them instead';
  end if;
end $$;
drop function if exists public.fin_ic_position(uuid);
drop function if exists public.fin_ic_reverse(uuid, text);
drop function if exists public.fin_ic_record(jsonb);
drop function if exists public.fin_ic_party(uuid, uuid);
drop function if exists public.fin_ic_account(uuid);
drop table if exists public.fin_ic_txns;
drop sequence if exists public.fin_ic_no_seq;
do $$ declare d text; begin
  for d in select definition from private.migration_snapshots where migration = '20261031000000' loop execute d; end loop;
end $$;
drop index if exists public.fin_parties_related_unique;
delete from public.fin_accounts a where a.system_key = 'intercompany' and not exists (select 1 from public.fin_lines l where l.account_id = a.id);
alter table public.fin_parties drop column if exists related_entity_id;
alter table public.fin_accounts drop constraint fin_accounts_system_key_check;
alter table public.fin_accounts add constraint fin_accounts_system_key_check check (system_key in ('cash','bank','ar','ap','inventory','cogs','sales','capital','drawings','retained','opening'));
alter table public.fin_journals drop constraint fin_journals_source_check;
alter table public.fin_journals add constraint fin_journals_source_check check (source in ('manual','opening','invoice','bill','payment','reversal','stock','partner'));
delete from private.migration_snapshots where migration = '20261031000000';
