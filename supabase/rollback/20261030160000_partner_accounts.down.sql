-- Undo 20261030160000_partner_accounts. Refuses once any partner account, transaction or partner-sourced journal exists:
-- posted partner entries are part of both sets of books and are reversed through the module, never dropped.
do $$ begin
  if exists (select 1 from public.fin_partner_links) or exists (select 1 from public.fin_journals where source = 'partner') then
    raise exception 'partner accounts or entries exist — rolling back would orphan posted entries';
  end if;
end $$;
drop function if exists public.fin_partner_reverse(uuid, text);
drop function if exists public.fin_partner_update(uuid, jsonb, text);
drop function if exists public.fin_partner_sync_mirror(uuid);
drop function if exists public.fin_partner_record(jsonb);
drop function if exists public.fin_partner_post_mirror(uuid);
drop function if exists public.fin_partner_link_create(uuid, text, uuid);
drop function if exists public.fin_partner_mirror_balance(uuid);
drop function if exists public.fin_partner_balance(uuid);
drop table if exists public.fin_partner_docs;
drop function if exists public.fin_partner_docs_guard();
drop table if exists public.fin_partner_txns;
drop table if exists public.fin_partner_links;
create or replace function public.fin_reverse_journal(p_journal uuid, p_reason text, p_date date default null) returns uuid language plpgsql security definer set search_path = '' as $$
declare j public.fin_journals; v_new uuid; v_lines jsonb;
begin
  select * into j from public.fin_journals where id = p_journal for update;
  if not found then raise exception 'not_found: entry not found'; end if;
  if not public.can_write_fin(j.entity_id) then raise exception 'forbidden: only owners and bookkeepers can reverse'; end if;
  if j.status <> 'posted' then raise exception 'not_posted: only posted entries can be reversed — delete the draft instead'; end if;
  if j.reversed_by is not null then raise exception 'already_reversed: this entry was already reversed'; end if;
  if j.reversal_of is not null then raise exception 'is_reversal: a reversal can''t itself be reversed — post a new entry'; end if;
  if j.source in ('invoice','bill','payment','stock') and coalesce(current_setting('app.fin_doc_void', true), '') <> 'on' then
    raise exception 'use_document: void the invoice, bill or payment instead of reversing its entry';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required: give a reason for the reversal'; end if;
  select jsonb_agg(jsonb_build_object('account_id', account_id, 'party_id', party_id, 'description', description, 'debit', credit, 'credit', debit) order by sort) into v_lines
    from public.fin_lines where journal_id = p_journal;
  v_new := public.fin_system_journal(j.entity_id, coalesce(p_date, j.entry_date), 'Reversal of #' || j.number || ': ' || p_reason, j.reference, 'reversal', j.id, v_lines, j.id);
  perform set_config('app.fin_posting', 'on', true);
  update public.fin_journals set reversed_by = v_new, reversal_reason = p_reason where id = p_journal;
  perform set_config('app.fin_posting', 'off', true);
  return v_new;
end $$;
alter table public.fin_journals drop constraint fin_journals_source_check;
alter table public.fin_journals add constraint fin_journals_source_check check (source in ('manual','opening','invoice','bill','payment','reversal','stock'));
