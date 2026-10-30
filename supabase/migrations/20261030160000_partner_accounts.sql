-- Partner accounts: money a partner pays personally on a business's behalf, reimbursements, and the balance between them.
-- Each transaction posts a double entry in the business's books (Dr expense/inventory/etc, Cr partner current account)
-- and, when the partner keeps personal books here, a mirror entry there (Dr money owed to me, Cr source of funds).
-- Posted partner transactions are never edited in money terms or deleted; they are reversed with a reason.

alter table public.fin_journals drop constraint fin_journals_source_check;
alter table public.fin_journals add constraint fin_journals_source_check check (source in ('manual','opening','invoice','bill','payment','reversal','stock','partner'));

-- partner journals are reversed only through the partner module (same rule as invoices/payments)
create or replace function public.fin_reverse_journal(p_journal uuid, p_reason text, p_date date default null) returns uuid language plpgsql security definer set search_path = '' as $$
declare j public.fin_journals; v_new uuid; v_lines jsonb;
begin
  select * into j from public.fin_journals where id = p_journal for update;
  if not found then raise exception 'not_found: entry not found'; end if;
  if not public.can_write_fin(j.entity_id) then raise exception 'forbidden: only owners and bookkeepers can reverse'; end if;
  if j.status <> 'posted' then raise exception 'not_posted: only posted entries can be reversed — delete the draft instead'; end if;
  if j.reversed_by is not null then raise exception 'already_reversed: this entry was already reversed'; end if;
  if j.reversal_of is not null then raise exception 'is_reversal: a reversal can''t itself be reversed — post a new entry'; end if;
  if j.source in ('invoice','bill','payment','stock','partner') and coalesce(current_setting('app.fin_doc_void', true), '') <> 'on' then
    raise exception 'use_document: void the invoice, bill, payment or partner transaction instead of reversing its entry';
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

-- ===================================================================== partner links
create table public.fin_partner_links (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.fin_entities(id) on delete cascade,          -- the business (e.g. Dlusso Bespoke)
  partner_party_id uuid not null references public.fin_parties(id),                       -- the partner as a party in the business's books
  partner_account_id uuid not null references public.fin_accounts(id),                    -- liability: partner current account (Due to partner)
  partner_user_id uuid references auth.users(id),                                         -- the partner's Job Desk login, if any
  mirror_entity_id uuid references public.fin_entities(id) on delete set null,            -- the partner's personal books, if kept here
  mirror_party_id uuid references public.fin_parties(id),                                 -- the business as a party in the personal books
  mirror_receivable_account_id uuid references public.fin_accounts(id),                   -- asset: money owed to me
  mirror_default_account_id uuid references public.fin_accounts(id),                      -- where funds came from when not chosen (opening balances)
  terms_days int check (terms_days is null or terms_days between 0 and 3650),             -- agreed reimbursement period; null = none agreed
  next_no int not null default 1,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  unique (entity_id, partner_party_id)
);

-- ===================================================================== partner transactions
create table public.fin_partner_txns (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references public.fin_partner_links(id) on delete cascade,
  entity_id uuid not null references public.fin_entities(id) on delete cascade,
  txn_no text not null,
  txn_type text not null check (txn_type in ('expense_funding','salary_funding','reimbursement','adjustment')),
  direction text not null check (direction in ('increase','decrease')),                   -- effect on the amount owed to the partner
  txn_date date not null,                                                                  -- transaction / expense date (accounting date)
  date_precision text not null default 'day' check (date_precision in ('day','month')),   -- 'month' = exact day unknown; never fabricated
  payment_date date,                                                                       -- when the money actually moved; separate field, may be unknown
  description text not null check (char_length(description) between 1 and 300),
  beneficiary text,                                                                        -- supplier / beneficiary (or payer for reimbursements)
  reference text,                                                                          -- invoice or reference number
  invoice_amount numeric(16,2) check (invoice_amount is null or invoice_amount >= 0),
  amount numeric(16,2) not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  paid_from text not null default 'not_recorded' check (paid_from in ('personal_bank','personal_cash','personal_card','other','not_recorded','business_bank','business_cash')),
  account_id uuid not null references public.fin_accounts(id),                            -- business-side counter account (expense/inventory/… or bank for reimbursements)
  job_ref text,
  recon_status text not null default 'unverified' check (recon_status in ('unverified','verified','disputed')),
  flags text[] not null default '{}',
  legacy_ref text,
  notes text,
  import_key text,
  journal_id uuid references public.fin_journals(id),
  mirror_journal_id uuid references public.fin_journals(id),
  mirror_account_id uuid references public.fin_accounts(id),
  status text not null default 'posted' check (status in ('posted','reversed')),
  reversal_journal_id uuid references public.fin_journals(id),
  mirror_reversal_journal_id uuid references public.fin_journals(id),
  reversal_reason text,
  last_change_reason text,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  updated_at timestamptz,
  unique (entity_id, txn_no),
  unique (entity_id, import_key)
);
create index on public.fin_partner_txns (link_id, txn_date);
-- the same invoice from the same supplier can't be counted twice while posted
create unique index fin_partner_txns_no_double on public.fin_partner_txns (link_id, txn_type, lower(coalesce(beneficiary, '')), lower(reference)) where reference is not null and status = 'posted';

create table public.fin_partner_docs (
  id uuid primary key default gen_random_uuid(),
  txn_id uuid not null references public.fin_partner_txns(id) on delete cascade,
  entity_id uuid not null references public.fin_entities(id) on delete cascade,
  kind text not null check (kind in ('supplier_invoice','cash_receipt','bank_transfer','card_payment','salary_record','payment_proof','other')),
  title text not null check (char_length(title) between 1 and 200),
  storage_path text unique,
  url text,
  mime_type text, size_bytes bigint,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  constraint partner_doc_target check (num_nonnulls(storage_path, url) = 1),
  constraint partner_doc_path check (storage_path is null or storage_path like entity_id::text || '/%'),
  constraint partner_doc_url check (url is null or url ~* '^https?://'),
  constraint partner_doc_type check (storage_path is null or mime_type in ('application/pdf','image/jpeg','image/png',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.ms-excel','text/csv'))
);
create index on public.fin_partner_docs (txn_id);

create or replace function public.fin_partner_docs_guard() returns trigger language plpgsql set search_path = '' as $$
declare v_e uuid;
begin
  select entity_id into v_e from public.fin_partner_txns where id = new.txn_id;
  if v_e is distinct from new.entity_id then raise exception 'wrong_entity: document must belong to the same books as its transaction'; end if;
  return new;
end $$;
create trigger fin_partner_docs_guard before insert or update on public.fin_partner_docs for each row execute function public.fin_partner_docs_guard();

alter table public.fin_partner_links enable row level security;
alter table public.fin_partner_txns enable row level security;
alter table public.fin_partner_docs enable row level security;
create policy "partner links: members read" on public.fin_partner_links for select to authenticated using (public.is_fin_member(entity_id));
create policy "partner links: owner edits terms" on public.fin_partner_links for update to authenticated using (public.is_fin_owner(entity_id)) with check (public.is_fin_owner(entity_id));
create policy "partner txns: members read" on public.fin_partner_txns for select to authenticated using (public.is_fin_member(entity_id));
create policy "partner docs: members read" on public.fin_partner_docs for select to authenticated using (public.is_fin_member(entity_id));
create policy "partner docs: writers add" on public.fin_partner_docs for insert to authenticated with check (public.can_write_fin(entity_id) and created_by = (select auth.uid()));
create policy "partner docs: writers remove" on public.fin_partner_docs for delete to authenticated using (public.can_write_fin(entity_id));
-- links/txns are written only by the functions below (no insert/update/delete policies for transactions)

create trigger fin_partner_links_audit after insert or update of partner_account_id, partner_party_id, mirror_entity_id, mirror_receivable_account_id, mirror_default_account_id, terms_days on public.fin_partner_links for each row execute function public.fin_audit_trg();
create trigger fin_partner_txns_audit after insert or update on public.fin_partner_txns for each row execute function public.fin_audit_trg();
create trigger fin_partner_docs_audit after insert or delete on public.fin_partner_docs for each row execute function public.fin_audit_trg();

-- ===================================================================== helpers
-- Amount the business currently owes the partner, from the business's own ledger (credit balance of the partner account for that party).
create or replace function public.fin_partner_balance(p_link uuid) returns numeric language sql stable security definer set search_path = '' as $$
  select coalesce(sum(l.credit - l.debit), 0) from public.fin_lines l join public.fin_journals j on j.id = l.journal_id
    join public.fin_partner_links k on k.id = p_link
  where j.status = 'posted' and l.account_id = k.partner_account_id and l.party_id = k.partner_party_id and public.is_fin_member(k.entity_id);
$$;
-- Same balance as the partner sees it in personal books (debit balance of "money owed to me" for the business).
create or replace function public.fin_partner_mirror_balance(p_link uuid) returns numeric language sql stable security definer set search_path = '' as $$
  select coalesce(sum(l.debit - l.credit), 0) from public.fin_lines l join public.fin_journals j on j.id = l.journal_id
    join public.fin_partner_links k on k.id = p_link
  where j.status = 'posted' and l.account_id = k.mirror_receivable_account_id and l.party_id = k.mirror_party_id and public.is_fin_member(k.mirror_entity_id);
$$;

-- Set up a partner account (owner only). Reuses an existing partner party/account; never duplicates accounts.
create or replace function public.fin_partner_link_create(p_entity uuid, p_partner_name text, p_mirror_entity uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_party uuid; v_acc uuid; v_link uuid; v_mparty uuid; v_mrec uuid; v_mdef uuid; v_ename text;
begin
  if not public.is_fin_owner(p_entity) then raise exception 'forbidden: only the owner can set up partner accounts'; end if;
  if coalesce(trim(p_partner_name), '') = '' then raise exception 'name_required'; end if;
  select id into v_party from public.fin_parties where entity_id = p_entity and lower(name) = lower(trim(p_partner_name)) and not archived limit 1;
  if v_party is null then insert into public.fin_parties (entity_id, name, kind) values (p_entity, trim(p_partner_name), 'partner') returning id into v_party; end if;
  select id into v_acc from public.fin_accounts where entity_id = p_entity and type = 'liability' and subtype = 'partner' and is_active order by code limit 1;
  if v_acc is null then raise exception 'missing_account: add a liability account of kind Partner (e.g. 2300 Partner current accounts) first'; end if;
  if p_mirror_entity is not null then
    if not public.can_write_fin(p_mirror_entity) then raise exception 'forbidden: you can only link personal books you keep'; end if;
    select name into v_ename from public.fin_entities where id = p_entity;
    select id into v_mparty from public.fin_parties where entity_id = p_mirror_entity and lower(name) = lower(v_ename) and not archived limit 1;
    if v_mparty is null then insert into public.fin_parties (entity_id, name, kind) values (p_mirror_entity, v_ename, 'other') returning id into v_mparty; end if;
    v_mrec := public.fin_sys_account(p_mirror_entity, 'ar'); v_mdef := public.fin_sys_account(p_mirror_entity, 'opening');
    if v_mrec is null or v_mdef is null then raise exception 'missing_account: the personal books need a receivable and an opening-balances account'; end if;
  end if;
  insert into public.fin_partner_links (entity_id, partner_party_id, partner_account_id, partner_user_id, mirror_entity_id, mirror_party_id, mirror_receivable_account_id, mirror_default_account_id)
    values (p_entity, v_party, v_acc, case when p_mirror_entity is not null then (select auth.uid()) end, p_mirror_entity, v_mparty, v_mrec, v_mdef)
    on conflict (entity_id, partner_party_id) do nothing returning id into v_link;
  if v_link is null then raise exception 'exists: a partner account for % already exists', p_partner_name; end if;
  return v_link;
end $$;

-- internal: post the personal-books mirror of a transaction (caller must keep those books)
create or replace function public.fin_partner_post_mirror(p_txn uuid) returns uuid language plpgsql security definer set search_path = '' as $$
declare t public.fin_partner_txns; k public.fin_partner_links; v_acc uuid; v_jid uuid; v_lines jsonb; v_desc text;
begin
  select * into t from public.fin_partner_txns where id = p_txn for update;
  select * into k from public.fin_partner_links where id = t.link_id;
  if k.mirror_entity_id is null or t.mirror_journal_id is not null or t.status <> 'posted' then return t.mirror_journal_id; end if;
  if not public.can_write_fin(k.mirror_entity_id) then return null; end if; -- left pending for the partner to post
  v_acc := coalesce(t.mirror_account_id, k.mirror_default_account_id);
  if (select entity_id from public.fin_accounts where id = v_acc) is distinct from k.mirror_entity_id then raise exception 'mirror_account_other_entity'; end if;
  v_desc := t.txn_no || ' · ' || t.description;
  v_lines := case when t.direction = 'increase' then
      jsonb_build_array(jsonb_build_object('account_id', k.mirror_receivable_account_id, 'party_id', k.mirror_party_id, 'description', v_desc, 'debit', t.amount, 'credit', 0),
                        jsonb_build_object('account_id', v_acc, 'description', v_desc, 'debit', 0, 'credit', t.amount))
    else jsonb_build_array(jsonb_build_object('account_id', v_acc, 'description', v_desc, 'debit', t.amount, 'credit', 0),
                           jsonb_build_object('account_id', k.mirror_receivable_account_id, 'party_id', k.mirror_party_id, 'description', v_desc, 'debit', 0, 'credit', t.amount)) end;
  v_jid := public.fin_system_journal(k.mirror_entity_id, t.txn_date, left(t.txn_no || ' ' || t.description, 300), t.reference, 'partner', t.id, v_lines);
  update public.fin_partner_txns set mirror_journal_id = v_jid, mirror_account_id = v_acc where id = t.id;
  return v_jid;
end $$;

-- ===================================================================== record a transaction
create or replace function public.fin_partner_record(p jsonb) returns uuid language plpgsql security definer set search_path = '' as $$
declare k public.fin_partner_links; e public.fin_entities; a public.fin_accounts; v_type text := p->>'txn_type'; v_dir text; v_amt numeric := (p->>'amount')::numeric;
  v_id uuid := gen_random_uuid(); v_no text; v_jid uuid; v_lines jsonb; v_desc text; v_bal numeric; v_date date := (p->>'txn_date')::date; v_prec text := coalesce(p->>'date_precision', 'day');
begin
  select * into k from public.fin_partner_links where id = (p->>'link_id')::uuid for update;
  if not found then raise exception 'not_found: partner account not found'; end if;
  if not public.can_write_fin(k.entity_id) then raise exception 'forbidden: only owners and bookkeepers can record partner transactions'; end if;
  select * into e from public.fin_entities where id = k.entity_id;
  if v_type not in ('expense_funding','salary_funding','reimbursement','adjustment') then raise exception 'bad_type'; end if;
  v_dir := case v_type when 'reimbursement' then 'decrease' when 'adjustment' then coalesce(p->>'direction', '') else 'increase' end;
  if v_dir not in ('increase','decrease') then raise exception 'direction_required: say whether the adjustment increases or decreases the amount owed'; end if;
  if v_amt is null or v_amt <= 0 then raise exception 'amount_required: enter an amount above zero'; end if;
  if v_date is null then raise exception 'date_required: enter the transaction date (month-only is allowed)'; end if;
  if v_prec not in ('day','month') then raise exception 'bad_precision'; end if;
  if coalesce(trim(p->>'description'), '') = '' then raise exception 'description_required'; end if;
  if coalesce(p->>'currency', e.base_currency) <> e.base_currency then raise exception 'currency: record % amounts only for now (convert first and note the original in the description)', e.base_currency; end if;
  select * into a from public.fin_accounts where id = (p->>'account_id')::uuid;
  if a.entity_id is distinct from k.entity_id or not a.is_active then raise exception 'bad_account: choose an active account from these books'; end if;
  if a.id = k.partner_account_id then raise exception 'bad_account: the counter account can''t be the partner account itself'; end if;
  -- personal funding must never touch the business's own money accounts, and reimbursements must come from them
  if v_dir = 'increase' and a.subtype in ('cash','bank','card') then raise exception 'mixed_funds: money the partner paid personally can''t be booked against the business''s bank or cash'; end if;
  if v_type = 'reimbursement' and a.subtype not in ('cash','bank') then raise exception 'bad_account: a reimbursement is paid from the business''s bank or cash account'; end if;
  if v_type in ('expense_funding','salary_funding') and a.type in ('income','equity') then raise exception 'bad_account: funding is booked to an expense, inventory, asset or liability account — never to income'; end if;
  if v_dir = 'decrease' then
    v_bal := public.fin_partner_balance(k.id);
    if v_amt > v_bal then raise exception 'exceeds_outstanding: % is more than the % currently owed to the partner', v_amt, v_bal; end if;
  end if;
  if p->>'import_key' is not null and exists (select 1 from public.fin_partner_txns where entity_id = k.entity_id and import_key = p->>'import_key') then
    raise exception 'duplicate_import: this line was already imported';
  end if;
  update public.fin_partner_links set next_no = next_no + 1 where id = k.id returning 'PR-' || lpad((next_no - 1)::text, 4, '0') into v_no;
  insert into public.fin_partner_txns (id, link_id, entity_id, txn_no, txn_type, direction, txn_date, date_precision, payment_date, description, beneficiary, reference, invoice_amount, amount, currency,
      paid_from, account_id, job_ref, flags, legacy_ref, notes, import_key, mirror_account_id, recon_status)
    values (v_id, k.id, k.entity_id, v_no, v_type, v_dir, v_date, v_prec, nullif(p->>'payment_date', '')::date, trim(p->>'description'), nullif(trim(p->>'beneficiary'), ''), nullif(trim(p->>'reference'), ''),
      nullif(p->>'invoice_amount', '')::numeric, v_amt, e.base_currency, coalesce(nullif(p->>'paid_from', ''), case when v_type = 'reimbursement' then 'business_bank' else 'not_recorded' end), a.id,
      nullif(trim(p->>'job_ref'), ''), coalesce(array(select jsonb_array_elements_text(p->'flags')), '{}'), nullif(p->>'legacy_ref', ''), nullif(p->>'notes', ''), nullif(p->>'import_key', ''),
      nullif(p->>'mirror_account_id', '')::uuid, 'unverified');
  v_desc := v_no || ' · ' || trim(p->>'description');
  v_lines := case when v_dir = 'increase' then
      jsonb_build_array(jsonb_build_object('account_id', a.id, 'description', v_desc, 'debit', v_amt, 'credit', 0),
                        jsonb_build_object('account_id', k.partner_account_id, 'party_id', k.partner_party_id, 'description', v_desc, 'debit', 0, 'credit', v_amt))
    else jsonb_build_array(jsonb_build_object('account_id', k.partner_account_id, 'party_id', k.partner_party_id, 'description', v_desc, 'debit', v_amt, 'credit', 0),
                           jsonb_build_object('account_id', a.id, 'description', v_desc, 'debit', 0, 'credit', v_amt)) end;
  v_jid := public.fin_system_journal(k.entity_id, v_date, left(v_no || ' ' || trim(p->>'description'), 300), nullif(trim(p->>'reference'), ''), 'partner', v_id, v_lines);
  update public.fin_partner_txns set journal_id = v_jid where id = v_id;
  perform public.fin_partner_post_mirror(v_id);
  return v_id;
end $$;

-- partner posts the personal side of transactions a bookkeeper recorded
create or replace function public.fin_partner_sync_mirror(p_link uuid) returns int language plpgsql security definer set search_path = '' as $$
declare k public.fin_partner_links; t record; n int := 0;
begin
  select * into k from public.fin_partner_links where id = p_link;
  if k.mirror_entity_id is null or not public.can_write_fin(k.mirror_entity_id) then raise exception 'forbidden: only the partner can post to their personal books'; end if;
  for t in select id from public.fin_partner_txns where link_id = p_link and status = 'posted' and mirror_journal_id is null order by txn_no loop
    perform public.fin_partner_post_mirror(t.id); n := n + 1;
  end loop;
  return n;
end $$;

-- edit descriptive fields (never amounts, dates or accounts) — a reason is required and recorded in the audit trail
create or replace function public.fin_partner_update(p_txn uuid, p_patch jsonb, p_reason text) returns void language plpgsql security definer set search_path = '' as $$
declare t public.fin_partner_txns; k text;
begin
  select * into t from public.fin_partner_txns where id = p_txn for update;
  if not found then raise exception 'not_found'; end if;
  if not public.can_write_fin(t.entity_id) then raise exception 'forbidden'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required: say why you are changing this record'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('payment_date','beneficiary','reference','invoice_amount','paid_from','job_ref','notes','recon_status','flags','legacy_ref','description') then
      raise exception 'locked_field: % can''t be edited — reverse the transaction and record it again', k;
    end if;
  end loop;
  update public.fin_partner_txns set
    payment_date = case when p_patch ? 'payment_date' then nullif(p_patch->>'payment_date', '')::date else payment_date end,
    beneficiary = case when p_patch ? 'beneficiary' then nullif(trim(p_patch->>'beneficiary'), '') else beneficiary end,
    reference = case when p_patch ? 'reference' then nullif(trim(p_patch->>'reference'), '') else reference end,
    invoice_amount = case when p_patch ? 'invoice_amount' then nullif(p_patch->>'invoice_amount', '')::numeric else invoice_amount end,
    paid_from = case when p_patch ? 'paid_from' then p_patch->>'paid_from' else paid_from end,
    job_ref = case when p_patch ? 'job_ref' then nullif(trim(p_patch->>'job_ref'), '') else job_ref end,
    notes = case when p_patch ? 'notes' then nullif(p_patch->>'notes', '') else notes end,
    recon_status = case when p_patch ? 'recon_status' then p_patch->>'recon_status' else recon_status end,
    flags = case when p_patch ? 'flags' then coalesce(array(select jsonb_array_elements_text(p_patch->'flags')), '{}') else flags end,
    legacy_ref = case when p_patch ? 'legacy_ref' then nullif(p_patch->>'legacy_ref', '') else legacy_ref end,
    description = case when p_patch ? 'description' then trim(p_patch->>'description') else description end,
    last_change_reason = p_reason, updated_by = (select auth.uid()), updated_at = now()
  where id = p_txn;
end $$;

-- reverse a transaction in both books with a reason; the original stays on record and is linked to its reversal
create or replace function public.fin_partner_reverse(p_txn uuid, p_reason text) returns void language plpgsql security definer set search_path = '' as $$
declare t public.fin_partner_txns; k public.fin_partner_links; v_r uuid; v_mr uuid;
begin
  select * into t from public.fin_partner_txns where id = p_txn for update;
  if not found then raise exception 'not_found'; end if;
  if not public.can_write_fin(t.entity_id) then raise exception 'forbidden'; end if;
  if t.status <> 'posted' then raise exception 'already_reversed'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required: give a reason for the reversal'; end if;
  select * into k from public.fin_partner_links where id = t.link_id;
  if t.direction = 'increase' and public.fin_partner_balance(k.id) - t.amount < 0 then
    raise exception 'would_go_negative: reimbursements already exceed what would remain — reverse the reimbursement first';
  end if;
  if t.mirror_journal_id is not null and not public.can_write_fin(k.mirror_entity_id) then raise exception 'partner_required: the partner must reverse this (it is also in their personal books)'; end if;
  perform set_config('app.fin_doc_void', 'on', true);
  v_r := public.fin_reverse_journal(t.journal_id, t.txn_no || ': ' || p_reason, null);
  if t.mirror_journal_id is not null then v_mr := public.fin_reverse_journal(t.mirror_journal_id, t.txn_no || ': ' || p_reason, null); end if;
  perform set_config('app.fin_doc_void', 'off', true);
  update public.fin_partner_txns set status = 'reversed', reversal_journal_id = v_r, mirror_reversal_journal_id = v_mr, reversal_reason = p_reason,
    last_change_reason = 'Reversed: ' || p_reason, updated_by = (select auth.uid()), updated_at = now() where id = p_txn;
end $$;

revoke execute on function public.fin_partner_post_mirror(uuid) from public, anon, authenticated;
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'fin\_partner\_%' loop
    execute format('revoke execute on function %s from public, anon', f.sig);
  end loop;
end $$;
grant execute on function public.fin_partner_record(jsonb), public.fin_partner_update(uuid, jsonb, text), public.fin_partner_reverse(uuid, text),
  public.fin_partner_sync_mirror(uuid), public.fin_partner_link_create(uuid, text, uuid), public.fin_partner_balance(uuid), public.fin_partner_mirror_balance(uuid) to authenticated;
revoke execute on function public.fin_partner_docs_guard() from public, anon, authenticated;
