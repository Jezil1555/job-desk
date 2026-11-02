-- Undo 20261102090000_simple_money. Refuses once anything was posted through the import review or details were recorded,
-- because the rule is: reverse entries through the app, never drop posted history. Entries posted by fin_money_post are ordinary
-- posted journals (manual / partner) and stay in the books after this runs.
do $$ begin
  if exists (select 1 from public.fin_import_rows where status = 'posted') then raise exception 'refused: imported lines have been posted'; end if;
  if exists (select 1 from public.fin_files where obligation_id is not null or import_id is not null) then raise exception 'refused: files are attached to obligations or imports'; end if;
end $$;
drop function if exists public.fin_money_post(jsonb);
drop function if exists public.fin_import_add(uuid, text, text, text, uuid, text, jsonb);
drop function if exists public.fin_money_key(uuid, date, numeric, text, text);
drop function if exists public.fin_balance_of(uuid, uuid);
alter table public.fin_files drop constraint fin_file_target;
alter table public.fin_files add constraint fin_file_target check (num_nonnulls(journal_id, invoice_id, payment_id) = 1);
alter table public.fin_files drop column if exists import_id;
alter table public.fin_files drop column if exists obligation_id;
drop table if exists public.fin_balance_checks;
drop policy if exists "imports: writers remove" on public.fin_imports;
drop table if exists public.fin_import_rows;
drop table if exists public.fin_imports;
drop table if exists public.fin_obligations;
drop function if exists public.fin_balance_checks_guard();
drop function if exists public.fin_import_rows_guard();
drop function if exists public.fin_obligations_guard();
drop trigger if exists fin_entities_money_accounts on public.fin_entities;
drop function if exists public.fin_entities_money_accounts();
do $$ begin
  if to_regclass('public.ai_proposals') is not null then
    if exists (select 1 from public.ai_proposals where action = 'extract_money' or target_type = 'fin_import') then
      raise notice 'ai_proposals has statement-reading rows; leaving the widened checks in place';
    else
      alter table public.ai_proposals drop constraint if exists ai_proposals_action_check;
      alter table public.ai_proposals add constraint ai_proposals_action_check check (action in ('draft_message','action_items','weekly_narrative','categorize'));
      alter table public.ai_proposals drop constraint if exists ai_proposals_target_type_check;
      alter table public.ai_proposals add constraint ai_proposals_target_type_check check (target_type in ('task','follow_up','note','weekly_review','fin_account'));
    end if;
  end if;
end $$;
-- the two accounts (2250, 6850) are kept if any entry uses them; otherwise removed
delete from public.fin_accounts a where a.code in ('2250','6850') and a.name in ('Personal loans (friends & family)','Interest on loans & cards')
  and exists (select 1 from public.fin_entities e where e.id = a.entity_id and e.kind = 'personal')
  and not exists (select 1 from public.fin_lines l where l.account_id = a.id);
