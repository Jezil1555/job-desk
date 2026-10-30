-- Increment 6: transactions between two sets of books (e.g. Dlusso ↔ Fitness Hub). Each book has one "Inter-entity current
-- accounts" account; each counterparty is a party linked to its books. Every transaction posts matching entries in BOTH books
-- in one step (you must keep both), with the same IC number as reference. Transfers are balance-sheet only — never income or expense.
insert into private.migration_snapshots (migration, object, definition) values
  ('20261031000000', 'public.fin_reverse_journal(uuid,text,date)', pg_get_functiondef('public.fin_reverse_journal(uuid,text,date)'::regprocedure)) on conflict do nothing;

alter table public.fin_journals drop constraint fin_journals_source_check;
alter table public.fin_journals add constraint fin_journals_source_check check (source in ('manual','opening','invoice','bill','payment','reversal','stock','partner','intercompany'));
alter table public.fin_accounts drop constraint fin_accounts_system_key_check;
alter table public.fin_accounts add constraint fin_accounts_system_key_check check (system_key in ('cash','bank','ar','ap','inventory','cogs','sales','capital','drawings','retained','opening','intercompany'));
alter table public.fin_parties add column related_entity_id uuid references public.fin_entities(id) on delete set null;
create unique index fin_parties_related_unique on public.fin_parties (entity_id, related_entity_id) where related_entity_id is not null;

create or replace function public.fin_reverse_journal(p_journal uuid, p_reason text, p_date date default null) returns uuid language plpgsql security definer set search_path = '' as $$
declare j public.fin_journals; v_new uuid; v_lines jsonb;
begin
  select * into j from public.fin_journals where id = p_journal for update;
  if not found then raise exception 'not_found: entry not found'; end if;
  if not public.can_write_fin(j.entity_id) then raise exception 'forbidden: only owners and bookkeepers can reverse'; end if;
  if j.status <> 'posted' then raise exception 'not_posted: only posted entries can be reversed — delete the draft instead'; end if;
  if j.reversed_by is not null then raise exception 'already_reversed: this entry was already reversed'; end if;
  if j.reversal_of is not null then raise exception 'is_reversal: a reversal can''t itself be reversed — post a new entry'; end if;
  if j.source in ('invoice','bill','payment','stock','partner','intercompany') and coalesce(current_setting('app.fin_doc_void', true), '') <> 'on' then
    raise exception 'use_document: void the invoice, bill, payment, partner or inter-entity transaction instead of reversing its entry';
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

create sequence public.fin_ic_no_seq;
create table public.fin_ic_txns (
  id uuid primary key default gen_random_uuid(),
  ic_no text not null unique,
  from_entity_id uuid not null references public.fin_entities(id) on delete cascade,
  to_entity_id uuid not null references public.fin_entities(id) on delete cascade,
  kind text not null check (kind in ('transfer','paid_on_behalf','recharge')),
  txn_date date not null,
  description text not null check (char_length(description) between 1 and 300),
  reference text,
  amount numeric(16,2) not null check (amount > 0),        -- in the sender's currency
  amount_to numeric(16,2) not null check (amount_to > 0),  -- in the receiver's currency (same as amount when currencies match)
  from_account_id uuid not null references public.fin_accounts(id),  -- sender: bank/cash (transfer, paid on behalf) or income (recharge)
  to_account_id uuid not null references public.fin_accounts(id),    -- receiver: bank/cash (transfer) or expense/asset (paid on behalf, recharge)
  from_journal_id uuid references public.fin_journals(id),
  to_journal_id uuid references public.fin_journals(id),
  status text not null default 'posted' check (status in ('posted','reversed')),
  from_reversal_id uuid references public.fin_journals(id), to_reversal_id uuid references public.fin_journals(id),
  reversal_reason text,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  constraint ic_two_books check (from_entity_id <> to_entity_id)
);
create index on public.fin_ic_txns (from_entity_id, txn_date);
create index on public.fin_ic_txns (to_entity_id, txn_date);
alter table public.fin_ic_txns enable row level security;
create policy "ic txns: members of either book read" on public.fin_ic_txns for select to authenticated using (public.is_fin_member(from_entity_id) or public.is_fin_member(to_entity_id));
create trigger fin_ic_txns_audit after insert or update on public.fin_ic_txns for each row execute function public.fin_audit_trg();

-- the inter-entity account in a set of books (created on first use) and the party standing for the other books
create or replace function public.fin_ic_account(p_entity uuid) returns uuid language plpgsql security definer set search_path = '' as $$
declare v uuid; v_code text := '1190';
begin
  select id into v from public.fin_accounts where entity_id = p_entity and system_key = 'intercompany';
  if v is not null then return v; end if;
  if exists (select 1 from public.fin_accounts where entity_id = p_entity and code = v_code) then v_code := '1191'; end if;
  insert into public.fin_accounts (entity_id, code, name, type, subtype, system_key, description)
    values (p_entity, v_code, 'Inter-entity current accounts', 'asset', 'other', 'intercompany', 'Balances with your other sets of books, by counterparty (debit = they owe these books, credit = these books owe them)')
    returning id into v;
  return v;
end $$;
create or replace function public.fin_ic_party(p_entity uuid, p_other uuid) returns uuid language plpgsql security definer set search_path = '' as $$
declare v uuid; v_name text;
begin
  select id into v from public.fin_parties where entity_id = p_entity and related_entity_id = p_other;
  if v is not null then return v; end if;
  select name into v_name from public.fin_entities where id = p_other;
  insert into public.fin_parties (entity_id, name, kind, related_entity_id, notes) values (p_entity, left(v_name, 160), 'other', p_other, 'Your other set of books') returning id into v;
  return v;
end $$;

create or replace function public.fin_ic_record(p jsonb) returns uuid language plpgsql security definer set search_path = '' as $$
declare a public.fin_entities; b public.fin_entities; fa public.fin_accounts; ta public.fin_accounts; v_kind text := p->>'kind';
  v_amt numeric := (p->>'amount')::numeric; v_amt_to numeric := coalesce(nullif(p->>'amount_to','')::numeric, (p->>'amount')::numeric); v_date date := (p->>'txn_date')::date;
  v_id uuid := gen_random_uuid(); v_no text; ic_a uuid; ic_b uuid; party_a uuid; party_b uuid; j_a uuid; j_b uuid; v_desc text; v_ref text;
begin
  select * into a from public.fin_entities where id = (p->>'from_entity_id')::uuid;
  select * into b from public.fin_entities where id = (p->>'to_entity_id')::uuid;
  if a.id is null or b.id is null then raise exception 'not_found: books not found'; end if;
  if a.id = b.id then raise exception 'same_books: choose two different sets of books'; end if;
  if not public.can_write_fin(a.id) or not public.can_write_fin(b.id) then raise exception 'forbidden: you need to keep both sets of books to record an inter-entity transaction'; end if;
  if v_kind not in ('transfer','paid_on_behalf','recharge') then raise exception 'bad_kind'; end if;
  if v_amt is null or v_amt <= 0 or v_amt_to <= 0 then raise exception 'amount_required: enter an amount above zero'; end if;
  if a.base_currency = b.base_currency and v_amt_to <> v_amt then raise exception 'amount_mismatch: both books use % — the amounts must be equal', a.base_currency; end if;
  if a.base_currency <> b.base_currency and nullif(p->>'amount_to','') is null then raise exception 'amount_to_required: enter the amount in % as received by %', b.base_currency, b.name; end if;
  if v_date is null then raise exception 'date_required'; end if;
  if coalesce(trim(p->>'description'), '') = '' then raise exception 'description_required'; end if;
  select * into fa from public.fin_accounts where id = (p->>'from_account_id')::uuid;
  select * into ta from public.fin_accounts where id = (p->>'to_account_id')::uuid;
  if fa.entity_id is distinct from a.id or not fa.is_active then raise exception 'bad_account: choose an account from %', a.name; end if;
  if ta.entity_id is distinct from b.id or not ta.is_active then raise exception 'bad_account: choose an account from %', b.name; end if;
  if fa.system_key = 'intercompany' or ta.system_key = 'intercompany' then raise exception 'bad_account: choose the bank, income or expense account, not the inter-entity account'; end if;
  if v_kind in ('transfer','paid_on_behalf') and fa.subtype not in ('cash','bank') then raise exception 'bad_account: % pays from a bank or cash account', a.name; end if;
  if v_kind = 'transfer' and ta.subtype not in ('cash','bank') then raise exception 'bad_account: % receives into a bank or cash account', b.name; end if;
  if v_kind in ('paid_on_behalf','recharge') and (ta.subtype in ('cash','bank') or ta.type in ('income','equity')) then raise exception 'bad_account: % books it as an expense or asset', b.name; end if;
  if v_kind = 'recharge' and fa.type <> 'income' then raise exception 'bad_account: a recharge is income in %', a.name; end if;
  ic_a := public.fin_ic_account(a.id); ic_b := public.fin_ic_account(b.id);
  party_a := public.fin_ic_party(a.id, b.id); party_b := public.fin_ic_party(b.id, a.id);
  v_no := 'IC-' || lpad(nextval('public.fin_ic_no_seq')::text, 5, '0');
  v_desc := v_no || ' · ' || trim(p->>'description'); v_ref := coalesce(nullif(trim(p->>'reference'), ''), v_no);
  -- sender: Dr inter-entity (receiver owes) / Cr bank or income
  j_a := public.fin_system_journal(a.id, v_date, left(v_desc || ' → ' || b.name, 300), v_ref, 'intercompany', v_id,
    jsonb_build_array(jsonb_build_object('account_id', ic_a, 'party_id', party_a, 'description', v_desc, 'debit', v_amt, 'credit', 0),
                      jsonb_build_object('account_id', fa.id, 'description', v_desc, 'debit', 0, 'credit', v_amt)));
  -- receiver: Dr bank or expense / Cr inter-entity (owes the sender)
  j_b := public.fin_system_journal(b.id, v_date, left(v_desc || ' ← ' || a.name, 300), v_ref, 'intercompany', v_id,
    jsonb_build_array(jsonb_build_object('account_id', ta.id, 'description', v_desc, 'debit', v_amt_to, 'credit', 0),
                      jsonb_build_object('account_id', ic_b, 'party_id', party_b, 'description', v_desc, 'debit', 0, 'credit', v_amt_to)));
  insert into public.fin_ic_txns (id, ic_no, from_entity_id, to_entity_id, kind, txn_date, description, reference, amount, amount_to, from_account_id, to_account_id, from_journal_id, to_journal_id)
    values (v_id, v_no, a.id, b.id, v_kind, v_date, trim(p->>'description'), nullif(trim(p->>'reference'), ''), v_amt, v_amt_to, fa.id, ta.id, j_a, j_b);
  return v_id;
end $$;

create or replace function public.fin_ic_reverse(p_txn uuid, p_reason text) returns void language plpgsql security definer set search_path = '' as $$
declare t public.fin_ic_txns; r1 uuid; r2 uuid;
begin
  select * into t from public.fin_ic_txns where id = p_txn for update;
  if not found then raise exception 'not_found'; end if;
  if not public.can_write_fin(t.from_entity_id) or not public.can_write_fin(t.to_entity_id) then raise exception 'forbidden: you need to keep both sets of books'; end if;
  if t.status <> 'posted' then raise exception 'already_reversed'; end if;
  if char_length(coalesce(trim(p_reason), '')) < 3 then raise exception 'reason_required: give a reason for the reversal'; end if;
  perform set_config('app.fin_doc_void', 'on', true);
  r1 := public.fin_reverse_journal(t.from_journal_id, t.ic_no || ': ' || trim(p_reason), null);
  r2 := public.fin_reverse_journal(t.to_journal_id, t.ic_no || ': ' || trim(p_reason), null);
  perform set_config('app.fin_doc_void', 'off', true);
  update public.fin_ic_txns set status = 'reversed', from_reversal_id = r1, to_reversal_id = r2, reversal_reason = trim(p_reason) where id = p_txn;
end $$;

-- Matching check for one set of books: per counterparty, the balance in these books, the mirror balance in theirs (if you can see it),
-- and the balances implied by the recorded inter-entity transactions. Any gap means an entry outside this module or a mismatch.
create or replace function public.fin_ic_position(p_entity uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  if not public.is_fin_member(p_entity) then raise exception 'forbidden'; end if;
  with others as (
    select distinct case when from_entity_id = p_entity then to_entity_id else from_entity_id end as other_id from public.fin_ic_txns where p_entity in (from_entity_id, to_entity_id)
    union select related_entity_id from public.fin_parties where entity_id = p_entity and related_entity_id is not null
  ), bal as (
    select o.other_id,
      (select coalesce(sum(l.debit - l.credit), 0) from public.fin_lines l join public.fin_journals j on j.id = l.journal_id join public.fin_parties pa on pa.id = l.party_id
         join public.fin_accounts ac on ac.id = l.account_id
         where j.status = 'posted' and l.entity_id = p_entity and ac.system_key = 'intercompany' and pa.related_entity_id = o.other_id) as mine,
      case when public.is_fin_member(o.other_id) then
        (select coalesce(sum(l.credit - l.debit), 0) from public.fin_lines l join public.fin_journals j on j.id = l.journal_id join public.fin_parties pa on pa.id = l.party_id
          join public.fin_accounts ac on ac.id = l.account_id
          where j.status = 'posted' and l.entity_id = o.other_id and ac.system_key = 'intercompany' and pa.related_entity_id = p_entity) end as theirs,
      (select coalesce(sum(case when from_entity_id = p_entity then amount else -amount_to end), 0) from public.fin_ic_txns where status = 'posted' and from_entity_id in (p_entity, o.other_id) and to_entity_id in (p_entity, o.other_id)) as recorded_mine,
      (select coalesce(sum(case when from_entity_id = p_entity then amount_to else -amount end), 0) from public.fin_ic_txns where status = 'posted' and from_entity_id in (p_entity, o.other_id) and to_entity_id in (p_entity, o.other_id)) as recorded_theirs
    from others o where o.other_id is not null
  )
  select coalesce(jsonb_agg(jsonb_build_object('entity_id', b.other_id, 'name', e.name, 'currency', e.base_currency, 'mine', b.mine, 'theirs', b.theirs,
      'recorded_mine', b.recorded_mine, 'recorded_theirs', b.recorded_theirs,
      'matched', b.mine = b.recorded_mine and (b.theirs is null or b.theirs = b.recorded_theirs)) order by e.name), '[]'::jsonb) into v
  from bal b join public.fin_entities e on e.id = b.other_id;
  return v;
end $$;

revoke execute on function public.fin_ic_account(uuid), public.fin_ic_party(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.fin_ic_record(jsonb), public.fin_ic_reverse(uuid, text), public.fin_ic_position(uuid) from public, anon;
grant execute on function public.fin_ic_record(jsonb), public.fin_ic_reverse(uuid, text), public.fin_ic_position(uuid) to authenticated;
