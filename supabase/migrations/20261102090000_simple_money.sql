-- Simple money layer (2 Nov 2026): the Personal Finance redesign.
-- The person records what happened in plain words ("I spent", "I paid for Dlusso", "Dlusso paid me back", "I paid the loan");
-- one database function turns that into a balanced, posted double entry. Nothing here bypasses the ledger rules:
-- every entry goes through fin_system_journal (lock date, balance check, numbering) or fin_partner_record (both books).
--
-- Adds:
--   fin_obligations      details the ledger can't hold for money owed to me / money I owe (kind, original amount, instalment, due day, expected date)
--   fin_imports          one upload or paste (statement, SMS, email, receipt) with its original text kept unchanged
--   fin_import_rows      the transactions read from it, waiting for review; posted rows keep a link to their entry; duplicates refused
--   fin_balance_checks   the balance the bank actually shows, kept apart from the ledger balance so differences are flagged, never hidden
--   fin_money_post()     the one posting function behind Capture and the import review
--   fin_import_add()     stores an import and flags likely duplicates (already imported, or already in the books)
-- Extends fin_files so receipts can hang off an obligation or an import, and the AI log so statement reading is recorded.

-- ===================================================================== accounts personal books need for this
insert into public.fin_accounts (entity_id, code, name, type, subtype, description)
select e.id, x.code, x.name, x.type, x.subtype, x.descr from public.fin_entities e
cross join (values ('2250', 'Personal loans (friends & family)', 'liability', 'loan', 'Money borrowed from friends or family'),
                   ('6850', 'Interest on loans & cards', 'expense', 'other', 'Interest and finance charges on loans and credit cards')) as x(code, name, type, subtype, descr)
where e.kind = 'personal' and not exists (select 1 from public.fin_accounts a where a.entity_id = e.id and a.code = x.code);
-- new personal books get them too (runs after the standard chart is seeded: triggers fire in name order)
create or replace function public.fin_entities_money_accounts() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'personal' then
    insert into public.fin_accounts (entity_id, code, name, type, subtype, description)
    select new.id, x.code, x.name, x.type, x.subtype, x.descr
    from (values ('2250', 'Personal loans (friends & family)', 'liability', 'loan', 'Money borrowed from friends or family'),
                 ('6850', 'Interest on loans & cards', 'expense', 'other', 'Interest and finance charges on loans and credit cards')) as x(code, name, type, subtype, descr)
    where not exists (select 1 from public.fin_accounts a where a.entity_id = new.id and a.code = x.code);
  end if;
  return new;
end $$;
create trigger fin_entities_money_accounts after insert on public.fin_entities for each row execute function public.fin_entities_money_accounts();

-- ===================================================================== obligations (details beside the ledger)
create table public.fin_obligations (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.fin_entities(id) on delete cascade,
  side text not null check (side in ('owed_to_me','i_owe')),
  kind text not null default 'other' check (kind in ('bank_loan','credit_card','friend_family','business','partner','other')),
  name text not null check (char_length(name) between 1 and 120),
  account_id uuid not null references public.fin_accounts(id),
  party_id uuid references public.fin_parties(id),
  original_amount numeric(14,2) check (original_amount is null or original_amount >= 0),
  installment numeric(14,2) check (installment is null or installment > 0),
  due_day int check (due_day is null or due_day between 1 and 31),
  due_date date,
  expected_date date,
  interest_rate numeric(6,3) check (interest_rate is null or interest_rate >= 0),
  notes text check (notes is null or char_length(notes) <= 2000),
  archived boolean not null default false,
  created_by uuid default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index fin_obligations_one_per_balance on public.fin_obligations (entity_id, account_id, coalesce(party_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index fin_obligations_entity on public.fin_obligations (entity_id);

create or replace function public.fin_obligations_guard() returns trigger language plpgsql security definer set search_path = '' as $$
declare a public.fin_accounts; p public.fin_parties;
begin
  if tg_op = 'UPDATE' and (new.entity_id <> old.entity_id or new.account_id <> old.account_id or new.party_id is distinct from old.party_id) then
    raise exception 'fixed: the account and person of an obligation can''t be changed; archive it and add a new one';
  end if;
  select * into a from public.fin_accounts where id = new.account_id;
  if a.entity_id is distinct from new.entity_id then raise exception 'bad_account: choose an account from these books'; end if;
  if new.side = 'owed_to_me' and a.type <> 'asset' then raise exception 'bad_account: money owed to you sits on an asset account'; end if;
  if new.side = 'i_owe' and a.type <> 'liability' then raise exception 'bad_account: money you owe sits on a liability account'; end if;
  if new.party_id is not null then
    select * into p from public.fin_parties where id = new.party_id;
    if p.entity_id is distinct from new.entity_id then raise exception 'bad_party: choose a person from these books'; end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger fin_obligations_guard before insert or update on public.fin_obligations for each row execute function public.fin_obligations_guard();
create trigger fin_obligations_audit after insert or update or delete on public.fin_obligations for each row execute function public.fin_audit_trg();

alter table public.fin_obligations enable row level security;
create policy "obligations: members read" on public.fin_obligations for select to authenticated using (public.is_fin_member(entity_id));
create policy "obligations: writers add" on public.fin_obligations for insert to authenticated with check (public.can_write_fin(entity_id));
create policy "obligations: writers edit" on public.fin_obligations for update to authenticated using (public.can_write_fin(entity_id)) with check (public.can_write_fin(entity_id));
create policy "obligations: writers remove" on public.fin_obligations for delete to authenticated using (public.can_write_fin(entity_id));

-- ===================================================================== imports (original kept) and their rows
create table public.fin_imports (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.fin_entities(id) on delete cascade,
  source text not null check (source in ('statement','sms','email','receipt','text')),
  title text not null check (char_length(title) between 1 and 200),
  raw_text text check (raw_text is null or char_length(raw_text) <= 200000),
  account_id uuid references public.fin_accounts(id),
  reader text not null default 'rules' check (reader in ('rules','csv','ai')),
  created_by uuid default auth.uid() references auth.users(id),
  created_at timestamptz not null default now()
);
create index fin_imports_entity on public.fin_imports (entity_id, created_at desc);

create table public.fin_import_rows (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.fin_imports(id) on delete cascade,
  entity_id uuid not null references public.fin_entities(id) on delete cascade,
  row_no int not null,
  txn_date date,
  amount numeric(14,2) not null check (amount > 0),
  direction text not null check (direction in ('in','out')),
  currency text not null default 'QAR' check (currency ~ '^[A-Z]{3}$'),
  description text not null check (char_length(description) between 1 and 300),
  merchant text check (merchant is null or char_length(merchant) <= 120),
  account_id uuid references public.fin_accounts(id),            -- the bank, cash or card account the money moved through
  kind text check (kind is null or kind in ('spend','income','transfer','lent','repayment_in','borrowed','debt_payment','paid_for_business','business_repaid')),
  category_account_id uuid references public.fin_accounts(id),   -- expense / income / counter account (receivable, liability, transfer target)
  party_id uuid references public.fin_parties(id),
  for_entity_id uuid references public.fin_entities(id),         -- the business this was paid for, or that paid me back
  business_account_id uuid references public.fin_accounts(id),   -- account in that business's books
  interest numeric(14,2) check (interest is null or interest >= 0),
  confidence text not null default 'low' check (confidence in ('high','medium','low')),
  review_reason text check (review_reason is null or char_length(review_reason) <= 300),
  dedupe_key text not null,
  duplicate text check (duplicate is null or duplicate in ('imported','in_books')),
  duplicate_line_id uuid references public.fin_lines(id) on delete set null,
  status text not null default 'pending' check (status in ('pending','posted','skipped')),
  journal_id uuid references public.fin_journals(id),
  partner_txn_id uuid references public.fin_partner_txns(id),
  raw jsonb,
  created_at timestamptz not null default now(),
  posted_at timestamptz,
  posted_by uuid references auth.users(id),
  unique (import_id, row_no)
);
create unique index fin_import_rows_no_double_post on public.fin_import_rows (entity_id, dedupe_key) where status = 'posted';
create index fin_import_rows_entity on public.fin_import_rows (entity_id, status);

-- review edits only: never touch a posted row, never post by editing, never move rows between books or imports
create or replace function public.fin_import_rows_guard() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('app.fin_money_posting', true), '') = 'on' then return new; end if;
  if tg_op = 'UPDATE' then
    if old.status = 'posted' then raise exception 'posted: this line is already in your books; reverse the entry to change it'; end if;
    if new.status = 'posted' then raise exception 'post_through_review: use Post to put a line into your books'; end if;
    if new.import_id <> old.import_id or new.entity_id <> old.entity_id or new.row_no <> old.row_no or new.dedupe_key <> old.dedupe_key
       or new.raw is distinct from old.raw or new.journal_id is distinct from old.journal_id or new.partner_txn_id is distinct from old.partner_txn_id then
      raise exception 'fixed: the source of an imported line can''t be changed';
    end if;
  end if;
  return new;
end $$;
create trigger fin_import_rows_guard before update on public.fin_import_rows for each row execute function public.fin_import_rows_guard();
create trigger fin_imports_audit after insert or delete on public.fin_imports for each row execute function public.fin_audit_trg();
create trigger fin_import_rows_audit after update of status on public.fin_import_rows for each row execute function public.fin_audit_trg();

alter table public.fin_imports enable row level security;
alter table public.fin_import_rows enable row level security;
create policy "imports: members read" on public.fin_imports for select to authenticated using (public.is_fin_member(entity_id));
create policy "imports: writers remove" on public.fin_imports for delete to authenticated
  using (public.can_write_fin(entity_id) and not exists (select 1 from public.fin_import_rows r where r.import_id = fin_imports.id and r.status = 'posted'));
create policy "import rows: members read" on public.fin_import_rows for select to authenticated using (public.is_fin_member(entity_id));
create policy "import rows: writers review" on public.fin_import_rows for update to authenticated using (public.can_write_fin(entity_id)) with check (public.can_write_fin(entity_id));

-- ===================================================================== actual bank balances (kept apart from the ledger)
create table public.fin_balance_checks (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.fin_entities(id) on delete cascade,
  account_id uuid not null references public.fin_accounts(id),
  as_of date not null,
  balance numeric(14,2) not null,
  note text check (note is null or char_length(note) <= 300),
  created_by uuid default auth.uid() references auth.users(id),
  created_at timestamptz not null default now()
);
create index fin_balance_checks_acc on public.fin_balance_checks (account_id, as_of desc, created_at desc);
create or replace function public.fin_balance_checks_guard() returns trigger language plpgsql security definer set search_path = '' as $$
declare a public.fin_accounts;
begin
  select * into a from public.fin_accounts where id = new.account_id;
  if a.entity_id is distinct from new.entity_id or a.subtype not in ('cash','bank','card') then raise exception 'bad_account: choose a bank, cash or card account from these books'; end if;
  return new;
end $$;
create trigger fin_balance_checks_guard before insert on public.fin_balance_checks for each row execute function public.fin_balance_checks_guard();
create trigger fin_balance_checks_audit after insert or delete on public.fin_balance_checks for each row execute function public.fin_audit_trg();
alter table public.fin_balance_checks enable row level security;
create policy "balance checks: members read" on public.fin_balance_checks for select to authenticated using (public.is_fin_member(entity_id));
create policy "balance checks: writers add" on public.fin_balance_checks for insert to authenticated with check (public.can_write_fin(entity_id) and created_by = (select auth.uid()));
create policy "balance checks: writers remove" on public.fin_balance_checks for delete to authenticated using (public.can_write_fin(entity_id));

-- ===================================================================== receipts can hang off obligations and imports
alter table public.fin_files add column obligation_id uuid references public.fin_obligations(id) on delete cascade;
alter table public.fin_files add column import_id uuid references public.fin_imports(id) on delete cascade;
alter table public.fin_files drop constraint fin_file_target;
alter table public.fin_files add constraint fin_file_target check (num_nonnulls(journal_id, invoice_id, payment_id, obligation_id, import_id) = 1);

-- ===================================================================== AI log knows about statement reading
do $$ begin
  if to_regclass('public.ai_proposals') is not null then
    alter table public.ai_proposals drop constraint if exists ai_proposals_action_check;
    alter table public.ai_proposals add constraint ai_proposals_action_check check (action in ('draft_message','action_items','weekly_narrative','categorize','extract_money'));
    alter table public.ai_proposals drop constraint if exists ai_proposals_target_type_check;
    alter table public.ai_proposals add constraint ai_proposals_target_type_check check (target_type in ('task','follow_up','note','weekly_review','fin_account','fin_import'));
  end if;
end $$;

-- ===================================================================== helpers
create or replace function public.fin_balance_of(p_account uuid, p_party uuid) returns numeric language sql stable security definer set search_path = '' as $$
  select coalesce(sum(l.debit - l.credit), 0) from public.fin_lines l join public.fin_journals j on j.id = l.journal_id
  where j.status = 'posted' and l.account_id = p_account and (p_party is null or l.party_id = p_party) $$;

create or replace function public.fin_money_key(p_account uuid, p_date date, p_amount numeric, p_dir text, p_desc text) returns text language sql immutable set search_path = '' as $$
  select md5(coalesce(p_account::text, '-') || '|' || coalesce(p_date::text, '-') || '|' || round(p_amount, 2)::text || '|' || p_dir || '|' ||
             regexp_replace(lower(coalesce(p_desc, '')), '[^a-z0-9]+', '', 'g')) $$;

-- ===================================================================== store an import and flag likely duplicates
-- p_rows: [{txn_date, amount, direction, currency, description, merchant, account_id, kind, category_account_id, party_id, for_entity_id,
--           business_account_id, interest, confidence, review_reason, raw}]
create or replace function public.fin_import_add(p_entity uuid, p_source text, p_title text, p_raw text, p_account uuid, p_reader text, p_rows jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid(); r jsonb; i int := 0; e public.fin_entities; v_acc uuid; v_date date; v_amt numeric; v_dir text; v_desc text; v_key text; v_dup text; v_line uuid;
  v_n int; v_reason text;
begin
  if not public.can_write_fin(p_entity) then raise exception 'forbidden: only owners and bookkeepers can import'; end if;
  select * into e from public.fin_entities where id = p_entity;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'nothing_found: no transactions were found to import'; end if;
  if jsonb_array_length(p_rows) > 1000 then raise exception 'too_many: import up to 1,000 lines at a time'; end if;
  if p_account is not null and (select entity_id from public.fin_accounts where id = p_account) is distinct from p_entity then raise exception 'bad_account'; end if;
  insert into public.fin_imports (id, entity_id, source, title, raw_text, account_id, reader) values (v_id, p_entity, p_source, left(coalesce(nullif(trim(p_title), ''), 'Import'), 200), p_raw, p_account, coalesce(p_reader, 'rules'));
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    v_acc := coalesce(nullif(r->>'account_id', '')::uuid, p_account);
    if v_acc is not null and not exists (select 1 from public.fin_accounts where id = v_acc and entity_id = p_entity and subtype in ('cash','bank','card')) then v_acc := null; end if;
    v_date := nullif(r->>'txn_date', '')::date; v_amt := abs(round((r->>'amount')::numeric, 2)); v_dir := r->>'direction';
    v_desc := left(coalesce(nullif(trim(r->>'description'), ''), nullif(trim(r->>'merchant'), ''), 'Transaction'), 300);
    if v_amt is null or v_amt = 0 or v_dir not in ('in','out') then continue; end if;
    v_key := public.fin_money_key(v_acc, v_date, v_amt, v_dir, v_desc);
    v_dup := null; v_line := null; v_reason := nullif(trim(r->>'review_reason'), '');
    if exists (select 1 from public.fin_import_rows x where x.entity_id = p_entity and x.dedupe_key = v_key and x.status in ('posted','pending') and x.import_id <> v_id) then
      v_dup := 'imported';
    elsif v_acc is not null and v_date is not null then
      -- same account, same amount, same direction, within 3 days, not already tied to another import line
      select l.id into v_line from public.fin_lines l join public.fin_journals j on j.id = l.journal_id
       where j.status = 'posted' and l.account_id = v_acc and j.entry_date between v_date - 3 and v_date + 3
         and (case when v_dir = 'in' then l.debit else l.credit end) = v_amt
         and not exists (select 1 from public.fin_import_rows x where x.journal_id = j.id)
       order by abs(j.entry_date - v_date) limit 1;
      if v_line is not null then v_dup := 'in_books'; end if;
    end if;
    -- the same line twice inside one upload is two real transactions only if the person says so; flag it
    select count(*) into v_n from public.fin_import_rows x where x.import_id = v_id and x.dedupe_key = v_key;
    if v_n > 0 then v_reason := coalesce(v_reason || ' · ', '') || 'Appears twice in this upload'; end if;
    insert into public.fin_import_rows (import_id, entity_id, row_no, txn_date, amount, direction, currency, description, merchant, account_id, kind, category_account_id, party_id,
        for_entity_id, business_account_id, interest, confidence, review_reason, dedupe_key, duplicate, duplicate_line_id, raw)
      values (v_id, p_entity, i, v_date, v_amt, v_dir, coalesce(nullif(upper(r->>'currency'), ''), e.base_currency), v_desc, left(nullif(trim(r->>'merchant'), ''), 120), v_acc,
        nullif(r->>'kind', ''),
        (select id from public.fin_accounts where id = nullif(r->>'category_account_id', '')::uuid and entity_id = p_entity),
        (select id from public.fin_parties where id = nullif(r->>'party_id', '')::uuid and entity_id = p_entity),
        (select id from public.fin_entities where id = nullif(r->>'for_entity_id', '')::uuid),
        nullif(r->>'business_account_id', '')::uuid,
        nullif(r->>'interest', '')::numeric,
        case when r->>'confidence' in ('high','medium','low') then r->>'confidence' else 'low' end,
        left(v_reason, 300), v_key, v_dup, v_line, r->'raw');
  end loop;
  if not exists (select 1 from public.fin_import_rows where import_id = v_id) then raise exception 'nothing_found: no transactions with an amount were found'; end if;
  return v_id;
end $$;

-- ===================================================================== the one posting function
-- p: {entity_id, kind, txn_date, amount, account_id (bank/cash/card), category_account_id, party_id, for_entity_id, business_account_id,
--     interest, interest_account_id, description, merchant, reference, import_row_id}
create or replace function public.fin_money_post(p jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare e public.fin_entities; v_kind text := p->>'kind'; v_amt numeric := round((p->>'amount')::numeric, 2); v_date date := nullif(p->>'txn_date', '')::date;
  m public.fin_accounts; c public.fin_accounts; v_party uuid := nullif(p->>'party_id', '')::uuid; v_desc text := trim(coalesce(p->>'description', ''));
  v_merchant text := nullif(trim(p->>'merchant'), ''); v_ref text := nullif(trim(p->>'reference'), ''); v_lines jsonb; v_jid uuid; v_ptx uuid;
  k public.fin_partner_links; ba public.fin_accounts; v_int numeric := coalesce(nullif(p->>'interest', '')::numeric, 0); ia public.fin_accounts;
  v_row public.fin_import_rows; v_bal numeric; v_ldesc text;
begin
  select * into e from public.fin_entities where id = nullif(p->>'entity_id', '')::uuid;
  if not found then raise exception 'not_found: books not found'; end if;
  if not public.can_write_fin(e.id) then raise exception 'forbidden: only owners and bookkeepers can record money'; end if;
  if v_kind not in ('spend','income','transfer','lent','repayment_in','borrowed','debt_payment','paid_for_business','business_repaid') then raise exception 'bad_kind: say what happened'; end if;
  if v_amt is null or v_amt <= 0 then raise exception 'amount_required: enter an amount above zero'; end if;
  if v_date is null then raise exception 'date_required: enter the date'; end if;
  if v_desc = '' then v_desc := coalesce(v_merchant, ''); end if;
  if v_desc = '' then raise exception 'description_required: say what it was for'; end if;
  if nullif(p->>'currency', '') is not null and p->>'currency' <> e.base_currency then
    raise exception 'currency: these books are in %; enter the % amount that left or reached your account', e.base_currency, e.base_currency;
  end if;

  select * into m from public.fin_accounts where id = nullif(p->>'account_id', '')::uuid;
  if not found or m.entity_id <> e.id or not m.is_active or m.subtype not in ('cash','bank','card') then raise exception 'bad_account: choose the bank, cash or card account the money moved through'; end if;
  if v_kind in ('income','repayment_in','borrowed','business_repaid') and m.subtype = 'card' then
    raise exception 'bad_account: money received goes into a bank or cash account';
  end if;
  if v_party is not null and not exists (select 1 from public.fin_parties where id = v_party and entity_id = e.id) then raise exception 'bad_party: choose a person from these books'; end if;

  -- the import row being posted, locked so it can't be posted twice
  if nullif(p->>'import_row_id', '') is not null then
    select * into v_row from public.fin_import_rows where id = (p->>'import_row_id')::uuid for update;
    if not found or v_row.entity_id <> e.id then raise exception 'not_found: imported line not found'; end if;
    if v_row.status <> 'pending' then raise exception 'already_posted: this imported line was already posted or skipped'; end if;
    if exists (select 1 from public.fin_import_rows x where x.entity_id = e.id and x.dedupe_key = v_row.dedupe_key and x.status = 'posted') then
      raise exception 'duplicate_import: the same transaction was already posted from an earlier import';
    end if;
  end if;

  v_ldesc := left(coalesce(v_merchant || ' · ', '') || v_desc, 300);

  if v_kind in ('paid_for_business','business_repaid') then
    select * into k from public.fin_partner_links where entity_id = nullif(p->>'for_entity_id', '')::uuid and mirror_entity_id = e.id;
    if not found then raise exception 'no_link: these books aren''t linked to that business yet (set up the partner account in the business''s books first)'; end if;
    select * into ba from public.fin_accounts where id = nullif(p->>'business_account_id', '')::uuid;
    if not found or ba.entity_id <> k.entity_id then
      raise exception 'business_account_required: %', case when v_kind = 'paid_for_business' then 'say what it was for in the business''s books (e.g. fabric stock, rent, freight)' else 'choose the business account the money came from' end;
    end if;
    if v_kind = 'business_repaid' and m.subtype = 'card' then raise exception 'bad_account: money received goes into a bank or cash account'; end if;
    v_ptx := public.fin_partner_record(jsonb_build_object(
      'link_id', k.id, 'txn_type', case when v_kind = 'paid_for_business' then 'expense_funding' else 'reimbursement' end,
      'txn_date', v_date, 'payment_date', v_date, 'description', v_desc, 'beneficiary', v_merchant, 'reference', v_ref, 'amount', v_amt, 'account_id', ba.id,
      'paid_from', case when v_kind = 'business_repaid' then (case when ba.subtype = 'cash' then 'business_cash' else 'business_bank' end)
                        else (case m.subtype when 'bank' then 'personal_bank' when 'cash' then 'personal_cash' else 'personal_card' end) end,
      'mirror_account_id', m.id,
      'import_key', case when v_row.id is not null then 'imp:' || v_row.dedupe_key end));
    select mirror_journal_id into v_jid from public.fin_partner_txns where id = v_ptx;
    if v_jid is null then raise exception 'mirror_missing: the business side was recorded but your books were not updated — check you can write to both books'; end if;
  else
    if v_kind <> 'transfer' or nullif(p->>'category_account_id', '') is not null then
      select * into c from public.fin_accounts where id = nullif(p->>'category_account_id', '')::uuid;
      if not found or c.entity_id <> e.id or not c.is_active then raise exception 'category_required: choose what it was for'; end if;
    end if;
    case v_kind
      when 'spend' then
        if not (c.type = 'expense' or c.subtype in ('fixed_asset','investment','earmarked','inventory')) then raise exception 'bad_category: spending goes to a spending category or something you bought (asset)'; end if;
        v_lines := jsonb_build_array(jsonb_build_object('account_id', c.id, 'party_id', v_party, 'description', v_ldesc, 'debit', v_amt, 'credit', 0),
                                     jsonb_build_object('account_id', m.id, 'description', v_ldesc, 'debit', 0, 'credit', v_amt));
      when 'income' then
        if c.type <> 'income' then raise exception 'bad_category: choose an income type (salary, business income, other)'; end if;
        v_lines := jsonb_build_array(jsonb_build_object('account_id', m.id, 'description', v_ldesc, 'debit', v_amt, 'credit', 0),
                                     jsonb_build_object('account_id', c.id, 'party_id', v_party, 'description', v_ldesc, 'debit', 0, 'credit', v_amt));
      when 'transfer' then
        if c.id is null or c.subtype not in ('cash','bank','card','earmarked','investment') then raise exception 'bad_category: choose the account the money moved to'; end if;
        if c.id = m.id then raise exception 'same_account: choose two different accounts'; end if;
        if c.subtype = 'card' then -- paying the card: can't pay off more than the card shows owed, or purchases would be counted twice
          v_bal := -public.fin_balance_of(c.id, null);
          if v_amt > v_bal then raise exception 'exceeds_outstanding: the card shows % owed in your books; record the card spending first, or enter the difference as spending', greatest(v_bal, 0); end if;
        end if;
        v_lines := jsonb_build_array(jsonb_build_object('account_id', c.id, 'description', v_ldesc, 'debit', v_amt, 'credit', 0),
                                     jsonb_build_object('account_id', m.id, 'description', v_ldesc, 'debit', 0, 'credit', v_amt));
      when 'lent' then
        if c.subtype <> 'receivable' then raise exception 'bad_category: money you lend or pay for someone sits on a "money owed to me" account'; end if;
        if v_party is null then raise exception 'party_required: say who owes you this'; end if;
        v_lines := jsonb_build_array(jsonb_build_object('account_id', c.id, 'party_id', v_party, 'description', v_ldesc, 'debit', v_amt, 'credit', 0),
                                     jsonb_build_object('account_id', m.id, 'description', v_ldesc, 'debit', 0, 'credit', v_amt));
      when 'repayment_in' then
        if c.subtype <> 'receivable' then raise exception 'bad_category: choose the "money owed to me" account being paid back'; end if;
        if v_party is null then raise exception 'party_required: say who paid you back'; end if;
        v_bal := public.fin_balance_of(c.id, v_party);
        if v_amt > v_bal then raise exception 'exceeds_outstanding: % is more than the % they owe you', v_amt, greatest(v_bal, 0); end if;
        v_lines := jsonb_build_array(jsonb_build_object('account_id', m.id, 'description', v_ldesc, 'debit', v_amt, 'credit', 0),
                                     jsonb_build_object('account_id', c.id, 'party_id', v_party, 'description', v_ldesc, 'debit', 0, 'credit', v_amt));
      when 'borrowed' then
        if c.type <> 'liability' then raise exception 'bad_category: borrowed money sits on a loan or payable account'; end if;
        v_lines := jsonb_build_array(jsonb_build_object('account_id', m.id, 'description', v_ldesc, 'debit', v_amt, 'credit', 0),
                                     jsonb_build_object('account_id', c.id, 'party_id', v_party, 'description', v_ldesc, 'debit', 0, 'credit', v_amt));
      when 'debt_payment' then
        if c.type <> 'liability' then raise exception 'bad_category: choose the loan, card or amount you owe'; end if;
        if v_int < 0 or v_int >= v_amt then raise exception 'bad_interest: interest must be less than the amount paid'; end if;
        v_bal := -public.fin_balance_of(c.id, v_party);
        if v_amt - v_int > v_bal then raise exception 'exceeds_outstanding: the principal % is more than the % you owe on this', v_amt - v_int, greatest(v_bal, 0); end if;
        if v_int > 0 then
          select * into ia from public.fin_accounts where id = coalesce(nullif(p->>'interest_account_id', '')::uuid,
            (select id from public.fin_accounts where entity_id = e.id and code = '6850'), (select id from public.fin_accounts where entity_id = e.id and code = '6800'));
          if not found or ia.entity_id <> e.id or ia.type <> 'expense' then raise exception 'bad_interest_account: choose an expense account for the interest'; end if;
        end if;
        v_lines := jsonb_build_array(jsonb_build_object('account_id', c.id, 'party_id', v_party, 'description', v_ldesc || case when v_int > 0 then ' (principal)' else '' end, 'debit', v_amt - v_int, 'credit', 0))
          || case when v_int > 0 then jsonb_build_array(jsonb_build_object('account_id', ia.id, 'description', v_ldesc || ' (interest)', 'debit', v_int, 'credit', 0)) else '[]'::jsonb end
          || jsonb_build_array(jsonb_build_object('account_id', m.id, 'description', v_ldesc, 'debit', 0, 'credit', v_amt));
    end case;
    v_jid := public.fin_system_journal(e.id, v_date, left(v_desc, 300), v_ref, 'manual', null, v_lines);
  end if;

  if v_row.id is not null then
    perform set_config('app.fin_money_posting', 'on', true);
    update public.fin_import_rows set status = 'posted', journal_id = v_jid, partner_txn_id = v_ptx, posted_at = now(), posted_by = (select auth.uid()),
      kind = v_kind, account_id = m.id, category_account_id = c.id, party_id = v_party, for_entity_id = nullif(p->>'for_entity_id', '')::uuid,
      business_account_id = ba.id, interest = nullif(v_int, 0), txn_date = v_date, amount = v_amt, description = left(v_desc, 300), merchant = left(v_merchant, 120)
     where id = v_row.id;
    perform set_config('app.fin_money_posting', 'off', true);
  end if;
  return jsonb_build_object('journal_id', v_jid, 'partner_txn_id', v_ptx);
end $$;

-- ===================================================================== grants
revoke execute on function public.fin_obligations_guard(), public.fin_import_rows_guard(), public.fin_balance_checks_guard(), public.fin_entities_money_accounts() from public, anon, authenticated;
revoke execute on function public.fin_money_key(uuid, date, numeric, text, text) from public, anon;
revoke execute on function public.fin_balance_of(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.fin_import_add(uuid, text, text, text, uuid, text, jsonb), public.fin_money_post(jsonb) from public, anon;
grant execute on function public.fin_import_add(uuid, text, text, text, uuid, text, jsonb), public.fin_money_post(jsonb), public.fin_money_key(uuid, date, numeric, text, text) to authenticated;
grant select, insert, update, delete on public.fin_obligations, public.fin_balance_checks to authenticated;
grant select, delete on public.fin_imports to authenticated;
grant select, update on public.fin_import_rows to authenticated;
