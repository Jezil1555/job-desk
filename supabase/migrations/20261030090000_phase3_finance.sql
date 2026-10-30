-- Phase 3: Finance & CFO — separate double-entry books per entity.
-- Additive only: no existing table is changed except a nullable link from tasks shown via invoices.
-- Rules:
--   * Every entity (Personal, a business) has its own members, chart of accounts, journals and reports.
--   * Journals are drafts until posted. Posting requires >= 2 lines, debits = credits > 0, a date after the lock date.
--   * Posted journals and their lines can't be edited or deleted — they are reversed instead (a mirrored posted journal).
--   * Invoices/bills post their own journals; payments exist only when a person records them (never automatically).
--   * Finance data is visible only to that entity's members (owner / bookkeeper / viewer), independent of workspaces.

-- ===================================================================== entities & members
create table public.fin_entities (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  kind text not null default 'business' check (kind in ('personal','business')),
  base_currency text not null check (base_currency ~ '^[A-Z]{3}$'),
  workspace_id uuid references public.workspaces(id) on delete set null,
  fiscal_year_start int not null default 1 check (fiscal_year_start between 1 and 12),
  lock_date date,
  next_journal_no int not null default 1,
  next_invoice_no int not null default 1,
  next_bill_no int not null default 1,
  archived boolean not null default false,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.fin_members (
  entity_id uuid not null references public.fin_entities(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','bookkeeper','viewer')),
  created_at timestamptz not null default now(),
  primary key (entity_id, user_id)
);
create index on public.fin_members (user_id);

create or replace function public.fin_role(e uuid) returns text language sql stable security definer set search_path = '' as $$
  select role from public.fin_members where entity_id = e and user_id = (select auth.uid());
$$;
create or replace function public.is_fin_member(e uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.fin_members where entity_id = e and user_id = (select auth.uid()));
$$;
create or replace function public.can_write_fin(e uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.fin_members where entity_id = e and user_id = (select auth.uid()) and role in ('owner','bookkeeper'));
$$;
create or replace function public.is_fin_owner(e uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.fin_members where entity_id = e and user_id = (select auth.uid()) and role = 'owner');
$$;
-- posting functions set this flag; triggers refuse direct changes to posted records without it
create or replace function public.fin_posting() returns boolean language sql stable set search_path = '' as $$
  select coalesce(current_setting('app.fin_posting', true), '') = 'on';
$$;

-- ===================================================================== chart of accounts, parties
create table public.fin_accounts (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.fin_entities(id) on delete cascade,
  code text not null check (code ~ '^[0-9A-Za-z.\-]{1,12}$'),
  name text not null check (char_length(name) between 1 and 120),
  type text not null check (type in ('asset','liability','equity','income','expense')),
  subtype text not null default 'other' check (subtype in ('cash','bank','card','receivable','payable','inventory','fixed_asset','investment','earmarked','loan','partner','cogs','other')),
  system_key text check (system_key in ('cash','bank','ar','ap','inventory','cogs','sales','capital','drawings','retained','opening')),
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (entity_id, code),
  unique (entity_id, system_key)
);
create table public.fin_parties (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.fin_entities(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 160),
  kind text not null default 'customer' check (kind in ('customer','supplier','partner','employee','other')),
  email text, phone text, notes text,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);
create index on public.fin_parties (entity_id);

-- ===================================================================== journals
create table public.fin_journals (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.fin_entities(id) on delete cascade,
  number int,
  entry_date date not null,
  memo text not null check (char_length(memo) between 1 and 300),
  reference text,
  source text not null default 'manual' check (source in ('manual','opening','invoice','bill','payment','reversal','stock')),
  source_id uuid,
  status text not null default 'draft' check (status in ('draft','posted')),
  reversal_of uuid references public.fin_journals(id),
  reversed_by uuid references public.fin_journals(id),
  reversal_reason text,
  posted_at timestamptz,
  posted_by uuid references auth.users(id),
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entity_id, number)
);
create index on public.fin_journals (entity_id, entry_date);
create table public.fin_lines (
  id uuid primary key default gen_random_uuid(),
  journal_id uuid not null references public.fin_journals(id) on delete cascade,
  entity_id uuid not null references public.fin_entities(id) on delete cascade,
  account_id uuid not null references public.fin_accounts(id),
  party_id uuid references public.fin_parties(id),
  description text,
  debit numeric(16,2) not null default 0 check (debit >= 0),
  credit numeric(16,2) not null default 0 check (credit >= 0),
  fx_currency text check (fx_currency is null or fx_currency ~ '^[A-Z]{3}$'),
  fx_amount numeric(16,2),
  statement_line_id uuid unique,
  sort int not null default 0,
  constraint one_side check ((debit > 0 and credit = 0) or (credit > 0 and debit = 0))
);
create index on public.fin_lines (journal_id);
create index on public.fin_lines (entity_id, account_id);

-- ===================================================================== invoices & bills
create table public.fin_items (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.fin_entities(id) on delete cascade,
  sku text, name text not null check (char_length(name) between 1 and 160), unit text not null default 'pc',
  sale_price numeric(16,2),
  inventory_account_id uuid references public.fin_accounts(id),
  cogs_account_id uuid references public.fin_accounts(id),
  income_account_id uuid references public.fin_accounts(id),
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  unique (entity_id, sku)
);
create table public.fin_invoices (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.fin_entities(id) on delete cascade,
  kind text not null check (kind in ('sale','purchase')),
  party_id uuid references public.fin_parties(id),
  number text,
  party_reference text,               -- the supplier's own bill number
  issue_date date not null,
  due_date date,                      -- optional: never invented
  status text not null default 'draft' check (status in ('draft','posted','void')),
  notes text,
  task_id uuid references public.tasks(id) on delete set null,
  journal_id uuid references public.fin_journals(id),
  void_reason text,
  posted_at timestamptz,
  due_reminded_for date, overdue_reminded_for date,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint due_after_issue check (due_date is null or due_date >= issue_date),
  unique (entity_id, kind, number)
);
create index on public.fin_invoices (entity_id, kind, status);
create index on public.fin_invoices (task_id) where task_id is not null;
create table public.fin_invoice_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.fin_invoices(id) on delete cascade,
  entity_id uuid not null references public.fin_entities(id) on delete cascade,
  item_id uuid references public.fin_items(id),
  description text not null check (char_length(description) between 1 and 300),
  qty numeric(14,3) not null default 1 check (qty > 0),
  unit_price numeric(16,2) not null check (unit_price >= 0),
  amount numeric(16,2) generated always as (round(qty * unit_price, 2)) stored,
  account_id uuid references public.fin_accounts(id),
  sort int not null default 0
);
create index on public.fin_invoice_lines (invoice_id);

create table public.fin_stock_moves (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.fin_entities(id) on delete cascade,
  item_id uuid not null references public.fin_items(id),
  move_date date not null,
  qty numeric(14,3) not null check (qty <> 0),
  unit_cost numeric(16,4) not null check (unit_cost >= 0),
  source text not null check (source in ('purchase','sale','void','adjustment','opening')),
  invoice_id uuid references public.fin_invoices(id),
  journal_id uuid references public.fin_journals(id),
  note text,
  created_at timestamptz not null default now()
);
create index on public.fin_stock_moves (item_id);

-- ===================================================================== payments
create table public.fin_payments (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.fin_entities(id) on delete cascade,
  direction text not null check (direction in ('in','out')),
  party_id uuid references public.fin_parties(id),
  pay_date date not null,
  amount numeric(16,2) not null check (amount > 0),
  account_id uuid not null references public.fin_accounts(id),
  reference text, memo text,
  status text not null default 'posted' check (status in ('posted','void')),
  journal_id uuid references public.fin_journals(id),
  void_reason text,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now()
);
create table public.fin_allocations (
  payment_id uuid not null references public.fin_payments(id) on delete cascade,
  invoice_id uuid not null references public.fin_invoices(id),
  entity_id uuid not null references public.fin_entities(id) on delete cascade,
  amount numeric(16,2) not null check (amount > 0),
  primary key (payment_id, invoice_id)
);
create index on public.fin_allocations (invoice_id);

-- ===================================================================== bank statements, budgets, files, audit
create table public.fin_statement_lines (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.fin_entities(id) on delete cascade,
  account_id uuid not null references public.fin_accounts(id),
  line_date date not null,
  description text not null,
  amount numeric(16,2) not null check (amount <> 0),   -- + money in, - money out
  reference text,
  status text not null default 'unmatched' check (status in ('unmatched','matched','ignored')),
  matched_line_id uuid references public.fin_lines(id) on delete set null,
  import_batch uuid,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  unique nulls not distinct (account_id, line_date, amount, description, reference)
);
create index on public.fin_statement_lines (entity_id, account_id, status);
alter table public.fin_lines add constraint fin_lines_statement_fk foreign key (statement_line_id) references public.fin_statement_lines(id) on delete set null;

create table public.fin_budgets (
  entity_id uuid not null references public.fin_entities(id) on delete cascade,
  account_id uuid not null references public.fin_accounts(id) on delete cascade,
  month date not null check (extract(day from month) = 1),
  amount numeric(16,2) not null,
  primary key (account_id, month)
);
create index on public.fin_budgets (entity_id, month);

create table public.fin_files (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.fin_entities(id) on delete cascade,
  journal_id uuid references public.fin_journals(id) on delete cascade,
  invoice_id uuid references public.fin_invoices(id) on delete cascade,
  payment_id uuid references public.fin_payments(id) on delete cascade,
  title text not null,
  storage_path text not null unique,
  mime_type text, size_bytes bigint,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  constraint fin_file_path check (storage_path like entity_id::text || '/%'),
  constraint fin_file_target check (num_nonnulls(journal_id, invoice_id, payment_id) = 1)
);

create table public.fin_audit (
  id bigint generated always as identity primary key,
  entity_id uuid,
  record_type text not null,
  record_id uuid,
  actor_id uuid,
  action text not null,
  changes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index on public.fin_audit (entity_id, created_at desc);

-- ===================================================================== totals view (respects RLS of the caller)
create view public.fin_invoice_totals with (security_invoker = true) as
select i.id as invoice_id, i.entity_id,
  coalesce((select sum(l.amount) from public.fin_invoice_lines l where l.invoice_id = i.id), 0)::numeric(16,2) as total,
  coalesce((select sum(a.amount) from public.fin_allocations a join public.fin_payments p on p.id = a.payment_id where a.invoice_id = i.id and p.status = 'posted'), 0)::numeric(16,2) as paid
from public.fin_invoices i;

-- ===================================================================== helpers
create or replace function public.fin_check_open(e uuid, d date) returns void language plpgsql stable security definer set search_path = '' as $$
declare v_lock date;
begin
  select lock_date into v_lock from public.fin_entities where id = e;
  if v_lock is not null and d <= v_lock then
    raise exception 'period_locked: the books are locked up to %; choose a later date or ask the owner to move the lock date', to_char(v_lock, 'DD Mon YYYY');
  end if;
end $$;
create or replace function public.fin_sys_account(e uuid, k text) returns uuid language sql stable security definer set search_path = '' as $$
  select id from public.fin_accounts where entity_id = e and system_key = k;
$$;

-- ===================================================================== chart-of-accounts templates
create or replace function public.fin_seed_accounts(e uuid, k text) returns void language plpgsql security definer set search_path = '' as $$
begin
  if k = 'personal' then
    insert into public.fin_accounts (entity_id, code, name, type, subtype, system_key) values
      (e,'1000','Cash in hand','asset','cash','cash'), (e,'1010','Bank — current account','asset','bank','bank'), (e,'1020','Savings account','asset','bank',null),
      (e,'1100','Money owed to me (reimbursements, loans given)','asset','receivable','ar'), (e,'1300','Investments','asset','investment',null),
      (e,'1400','Earmarked funds','asset','earmarked',null), (e,'1500','Property & vehicles','asset','fixed_asset',null),
      (e,'2000','Bills to pay','liability','payable','ap'), (e,'2100','Credit card','liability','card',null), (e,'2200','Loans & EMIs','liability','loan',null),
      (e,'3200','Net worth brought forward','equity','other','retained'), (e,'3900','Opening balances','equity','other','opening'),
      (e,'4000','Salary','income','other','sales'), (e,'4100','Investment & business income','income','other',null), (e,'4200','Other income','income','other',null),
      (e,'6000','Housing & rent','expense','other',null), (e,'6100','Groceries & household','expense','other',null), (e,'6200','Utilities & telecom','expense','other',null),
      (e,'6300','Transport & fuel','expense','other',null), (e,'6400','Education & childcare','expense','other',null), (e,'6500','Medical & insurance','expense','other',null),
      (e,'6600','Family support & remittances','expense','other',null), (e,'6700','Leisure & travel','expense','other',null), (e,'6800','Bank & card charges','expense','other',null),
      (e,'6900','Other expenses','expense','other',null);
  else
    insert into public.fin_accounts (entity_id, code, name, type, subtype, system_key) values
      (e,'1000','Cash on hand','asset','cash','cash'), (e,'1010','Bank account','asset','bank','bank'), (e,'1100','Accounts receivable','asset','receivable','ar'),
      (e,'1200','Inventory','asset','inventory','inventory'), (e,'1300','Deposits & prepayments','asset','other',null), (e,'1500','Equipment & fit-out','asset','fixed_asset',null),
      (e,'2000','Accounts payable','liability','payable','ap'), (e,'2100','Accrued expenses','liability','other',null), (e,'2200','Loans','liability','loan',null),
      (e,'2300','Partner current accounts','liability','partner',null),
      (e,'3000','Partner capital','equity','partner','capital'), (e,'3100','Partner drawings','equity','partner','drawings'), (e,'3200','Retained earnings','equity','other','retained'),
      (e,'3900','Opening balance equity','equity','other','opening'),
      (e,'4000','Sales','income','other','sales'), (e,'4100','Other income','income','other',null),
      (e,'5000','Cost of goods sold','expense','cogs','cogs'),
      (e,'6000','Rent','expense','other',null), (e,'6100','Salaries & wages','expense','other',null), (e,'6200','Utilities','expense','other',null),
      (e,'6300','Marketing','expense','other',null), (e,'6400','Transport & delivery','expense','other',null), (e,'6500','Bank charges','expense','other',null),
      (e,'6600','Licences & government fees','expense','other',null), (e,'6700','Repairs & maintenance','expense','other',null), (e,'6900','Other expenses','expense','other',null);
  end if;
end $$;
revoke execute on function public.fin_seed_accounts(uuid, text) from public, anon, authenticated;

create or replace function public.fin_entities_after_insert() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.fin_members (entity_id, user_id, role) values (new.id, new.created_by, 'owner') on conflict do nothing;
  perform public.fin_seed_accounts(new.id, new.kind);
  return new;
end $$;
create trigger fin_entities_after_insert after insert on public.fin_entities for each row execute function public.fin_entities_after_insert();
create trigger fin_entities_touch before update on public.fin_entities for each row execute function public.touch_updated_at();

create or replace function public.fin_entities_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.base_currency <> old.base_currency and exists (select 1 from public.fin_journals where entity_id = old.id and status = 'posted') then
    raise exception 'currency_locked: the base currency can''t change once entries are posted';
  end if;
  if new.kind <> old.kind then raise exception 'kind_locked: an entity''s type can''t change'; end if;
  if not public.fin_posting() and (new.next_journal_no <> old.next_journal_no or new.next_invoice_no <> old.next_invoice_no or new.next_bill_no <> old.next_bill_no) then
    raise exception 'numbering_locked: document numbers are assigned automatically';
  end if;
  return new;
end $$;
create trigger fin_entities_guard before update on public.fin_entities for each row execute function public.fin_entities_guard();

-- ===================================================================== journal & line guards
create or replace function public.fin_journals_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' and not public.fin_posting() then raise exception 'post_via_function: save as draft, then post'; end if;
    if new.number is not null and not public.fin_posting() then raise exception 'numbering_locked: journal numbers are assigned when posting'; end if;
    if not public.fin_posting() and (new.source not in ('manual','opening') or new.source_id is not null or new.reversal_of is not null or new.reversed_by is not null) then
      raise exception 'system_entry: only manual or opening-balance entries can be created directly';
    end if;
    return new;
  elsif tg_op = 'UPDATE' then
    if old.status = 'posted' and not public.fin_posting() then raise exception 'posted_immutable: posted entries can''t be edited — reverse it instead'; end if;
    if new.status <> old.status and not public.fin_posting() then raise exception 'post_via_function: use Post or Reverse'; end if;
    if new.entity_id <> old.entity_id then raise exception 'entity_locked'; end if;
    if not public.fin_posting() and (new.source, new.source_id, new.reversal_of, new.reversed_by, new.number) is distinct from (old.source, old.source_id, old.reversal_of, old.reversed_by, old.number) then
      raise exception 'system_entry: these fields are set by the system';
    end if;
    new.updated_at := now();
    return new;
  else
    if old.status = 'posted' then raise exception 'posted_immutable: posted entries can''t be deleted — reverse it instead'; end if;
    if old.source <> 'manual' and old.source <> 'opening' and not public.fin_posting() then raise exception 'system_entry: this draft belongs to an invoice or payment'; end if;
    return old;
  end if;
end $$;
create trigger fin_journals_guard before insert or update or delete on public.fin_journals for each row execute function public.fin_journals_guard();

create or replace function public.fin_lines_guard() returns trigger language plpgsql set search_path = '' as $$
declare v_status text; v_entity uuid; v_acc_entity uuid; v_party_entity uuid;
begin
  if tg_op = 'DELETE' then
    select status into v_status from public.fin_journals where id = old.journal_id;
    if v_status = 'posted' then raise exception 'posted_immutable: lines of a posted entry can''t be removed'; end if;
    return old;
  end if;
  select status, entity_id into v_status, v_entity from public.fin_journals where id = new.journal_id;
  if v_status = 'posted' and not public.fin_posting() then raise exception 'posted_immutable: lines of a posted entry can''t be changed'; end if;
  new.entity_id := v_entity;
  select entity_id into v_acc_entity from public.fin_accounts where id = new.account_id;
  if v_acc_entity is distinct from v_entity then raise exception 'account_other_entity: that account belongs to different books'; end if;
  if new.party_id is not null then
    select entity_id into v_party_entity from public.fin_parties where id = new.party_id;
    if v_party_entity is distinct from v_entity then raise exception 'party_other_entity: that customer/supplier belongs to different books'; end if;
  end if;
  return new;
end $$;
create trigger fin_lines_guard before insert or update or delete on public.fin_lines for each row execute function public.fin_lines_guard();

-- ===================================================================== posting & reversal
create or replace function public.fin_post_journal(p_journal uuid) returns int language plpgsql security definer set search_path = '' as $$
declare j public.fin_journals; v_dr numeric; v_cr numeric; v_n int; v_inactive int; v_no int;
begin
  select * into j from public.fin_journals where id = p_journal for update;
  if not found then raise exception 'not_found: entry not found'; end if;
  if not public.can_write_fin(j.entity_id) then raise exception 'forbidden: only owners and bookkeepers can post'; end if;
  if j.status = 'posted' then raise exception 'already_posted: this entry is already posted'; end if;
  perform public.fin_check_open(j.entity_id, j.entry_date);
  select count(*), coalesce(sum(debit),0), coalesce(sum(credit),0) into v_n, v_dr, v_cr from public.fin_lines where journal_id = p_journal;
  if v_n < 2 then raise exception 'too_few_lines: an entry needs at least two lines'; end if;
  if v_dr <> v_cr then raise exception 'unbalanced: debits (%) and credits (%) must be equal', v_dr, v_cr; end if;
  if v_dr = 0 then raise exception 'zero_entry: the entry has no amount'; end if;
  select count(*) into v_inactive from public.fin_lines l join public.fin_accounts a on a.id = l.account_id where l.journal_id = p_journal and not a.is_active;
  if v_inactive > 0 then raise exception 'inactive_account: one of the accounts is inactive'; end if;
  perform set_config('app.fin_posting', 'on', true);
  update public.fin_entities set next_journal_no = next_journal_no + 1 where id = j.entity_id returning next_journal_no - 1 into v_no;
  update public.fin_journals set status = 'posted', number = v_no, posted_at = now(), posted_by = (select auth.uid()) where id = p_journal;
  perform set_config('app.fin_posting', 'off', true);
  return v_no;
end $$;

-- internal: post a journal built by the system (invoice, payment, reversal). Returns journal id.
create or replace function public.fin_system_journal(e uuid, d date, p_memo text, p_ref text, p_source text, p_source_id uuid, p_lines jsonb, p_reversal_of uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_dr numeric; v_cr numeric; v_no int; l jsonb; i int := 0;
begin
  perform public.fin_check_open(e, d);
  select coalesce(sum((x->>'debit')::numeric),0), coalesce(sum((x->>'credit')::numeric),0) into v_dr, v_cr from jsonb_array_elements(p_lines) x;
  if v_dr <> v_cr or v_dr = 0 then raise exception 'unbalanced: system entry does not balance (% / %)', v_dr, v_cr; end if;
  perform set_config('app.fin_posting', 'on', true);
  update public.fin_entities set next_journal_no = next_journal_no + 1 where id = e returning next_journal_no - 1 into v_no;
  insert into public.fin_journals (entity_id, number, entry_date, memo, reference, source, source_id, status, reversal_of, posted_at, posted_by, created_by)
    values (e, v_no, d, left(p_memo, 300), p_ref, p_source, p_source_id, 'posted', p_reversal_of, now(), (select auth.uid()), coalesce((select auth.uid()), (select created_by from public.fin_entities where id = e)))
    returning id into v_id;
  for l in select * from jsonb_array_elements(p_lines) loop
    if coalesce((l->>'debit')::numeric, 0) = 0 and coalesce((l->>'credit')::numeric, 0) = 0 then continue; end if;
    insert into public.fin_lines (journal_id, entity_id, account_id, party_id, description, debit, credit, sort)
      values (v_id, e, (l->>'account_id')::uuid, nullif(l->>'party_id','')::uuid, l->>'description', coalesce((l->>'debit')::numeric,0), coalesce((l->>'credit')::numeric,0), i);
    i := i + 1;
  end loop;
  perform set_config('app.fin_posting', 'off', true);
  return v_id;
end $$;
revoke execute on function public.fin_system_journal(uuid, date, text, text, text, uuid, jsonb, uuid) from public, anon, authenticated;

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

-- ===================================================================== invoices & bills
create or replace function public.fin_invoices_guard() returns trigger language plpgsql set search_path = '' as $$
declare v_pe uuid;
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then raise exception 'posted_immutable: posted invoices can''t be deleted — void them instead'; end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and old.status <> 'draft' and not public.fin_posting() then
    -- after posting only the task link, notes and due date may change (not money, party or dates that hit the books)
    if (new.party_id, new.issue_date, new.kind, new.entity_id, new.number, new.status, new.journal_id) is distinct from (old.party_id, old.issue_date, old.kind, old.entity_id, old.number, old.status, old.journal_id) then
      raise exception 'posted_immutable: a posted invoice can only have its due date, notes or task link changed';
    end if;
  end if;
  if tg_op = 'INSERT' and (new.status <> 'draft' or new.journal_id is not null) and not public.fin_posting() then raise exception 'post_via_function: save as draft, then post'; end if;
  if tg_op = 'INSERT' and new.number is not null and not public.fin_posting() then raise exception 'numbering_locked: numbers are assigned when posting (put the supplier''s number in Supplier ref)'; end if;
  if tg_op = 'UPDATE' and old.status = 'draft' and new.number is distinct from old.number and not public.fin_posting() then raise exception 'numbering_locked'; end if;
  if new.party_id is not null then
    select entity_id into v_pe from public.fin_parties where id = new.party_id;
    if v_pe is distinct from new.entity_id then raise exception 'party_other_entity: that customer/supplier belongs to different books'; end if;
  end if;
  if new.task_id is not null and (tg_op = 'INSERT' or new.task_id is distinct from old.task_id) and not public.can_see_task(new.task_id) then
    raise exception 'task_not_visible: you can only link tasks you can see';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger fin_invoices_guard before insert or update or delete on public.fin_invoices for each row execute function public.fin_invoices_guard();

create or replace function public.fin_invoice_lines_guard() returns trigger language plpgsql set search_path = '' as $$
declare v_status text; v_entity uuid; v_x uuid;
begin
  select status, entity_id into v_status, v_entity from public.fin_invoices where id = coalesce(new.invoice_id, old.invoice_id);
  if v_status <> 'draft' and not public.fin_posting() then raise exception 'posted_immutable: lines of a posted invoice can''t be changed'; end if;
  if tg_op = 'DELETE' then return old; end if;
  new.entity_id := v_entity;
  if new.account_id is not null then select entity_id into v_x from public.fin_accounts where id = new.account_id; if v_x is distinct from v_entity then raise exception 'account_other_entity'; end if; end if;
  if new.item_id is not null then select entity_id into v_x from public.fin_items where id = new.item_id; if v_x is distinct from v_entity then raise exception 'item_other_entity'; end if; end if;
  return new;
end $$;
create trigger fin_invoice_lines_guard before insert or update or delete on public.fin_invoice_lines for each row execute function public.fin_invoice_lines_guard();

create or replace function public.fin_item_avg_cost(p_item uuid) returns table (on_hand numeric, avg_cost numeric) language sql stable security definer set search_path = '' as $$
  select coalesce(sum(qty), 0), case when coalesce(sum(qty), 0) > 0 then round(sum(qty * unit_cost) / sum(qty), 4) else 0 end
  from public.fin_stock_moves where item_id = p_item and public.is_fin_member(entity_id);
$$;

create or replace function public.fin_post_invoice(p_invoice uuid) returns text language plpgsql security definer set search_path = '' as $$
declare inv public.fin_invoices; l record; it public.fin_items; v_lines jsonb := '[]'::jsonb; v_total numeric := 0; v_ctrl uuid; v_acc uuid;
  v_no text; v_jid uuid; v_cost numeric; v_onhand numeric; v_cogs numeric; v_inv_acc uuid; v_cogs_acc uuid; v_moves jsonb := '[]'::jsonb; m jsonb;
begin
  select * into inv from public.fin_invoices where id = p_invoice for update;
  if not found then raise exception 'not_found: invoice not found'; end if;
  if not public.can_write_fin(inv.entity_id) then raise exception 'forbidden: only owners and bookkeepers can post'; end if;
  if inv.status <> 'draft' then raise exception 'already_posted: this invoice is already posted'; end if;
  if inv.party_id is null then raise exception 'party_required: choose the %', case inv.kind when 'sale' then 'customer' else 'supplier' end; end if;
  perform public.fin_check_open(inv.entity_id, inv.issue_date);
  v_ctrl := public.fin_sys_account(inv.entity_id, case inv.kind when 'sale' then 'ar' else 'ap' end);
  if v_ctrl is null then raise exception 'missing_account: no % control account in these books', case inv.kind when 'sale' then 'receivable' else 'payable' end; end if;
  for l in select * from public.fin_invoice_lines where invoice_id = p_invoice order by sort loop
    it := null; v_inv_acc := null; v_cogs_acc := null;
    v_total := v_total + l.amount;
    if l.item_id is not null then
      select * into it from public.fin_items where id = l.item_id;
      v_inv_acc := coalesce(it.inventory_account_id, public.fin_sys_account(inv.entity_id, 'inventory'));
      v_cogs_acc := coalesce(it.cogs_account_id, public.fin_sys_account(inv.entity_id, 'cogs'));
      if v_inv_acc is null then raise exception 'missing_account: no inventory account in these books'; end if;
    end if;
    if inv.kind = 'sale' then
      v_acc := coalesce(l.account_id, it.income_account_id, public.fin_sys_account(inv.entity_id, 'sales'));
      if v_acc is null then raise exception 'missing_account: choose an income account for "%"', l.description; end if;
      v_lines := v_lines || jsonb_build_object('account_id', v_acc, 'description', l.description, 'debit', 0, 'credit', l.amount);
      if l.item_id is not null then
        select on_hand, avg_cost into v_onhand, v_cost from public.fin_item_avg_cost(l.item_id);
        if v_onhand < l.qty then raise exception 'insufficient_stock: only % % of "%" in stock', v_onhand, it.unit, it.name; end if;
        v_cogs := round(l.qty * v_cost, 2);
        if v_cogs > 0 then
          v_lines := v_lines || jsonb_build_object('account_id', v_cogs_acc, 'description', 'Cost of ' || it.name, 'debit', v_cogs, 'credit', 0)
                             || jsonb_build_object('account_id', v_inv_acc, 'description', 'Stock out: ' || it.name, 'debit', 0, 'credit', v_cogs);
        end if;
        v_moves := v_moves || jsonb_build_object('item_id', l.item_id, 'qty', -l.qty, 'unit_cost', v_cost, 'source', 'sale');
      end if;
    else
      v_acc := case when l.item_id is not null then v_inv_acc else l.account_id end;
      if v_acc is null then raise exception 'missing_account: choose an expense or asset account for "%"', l.description; end if;
      v_lines := v_lines || jsonb_build_object('account_id', v_acc, 'description', l.description, 'debit', l.amount, 'credit', 0);
      if l.item_id is not null then
        v_moves := v_moves || jsonb_build_object('item_id', l.item_id, 'qty', l.qty, 'unit_cost', l.unit_price, 'source', 'purchase');
      end if;
    end if;
  end loop;
  if v_total <= 0 then raise exception 'zero_invoice: add at least one line with an amount'; end if;
  v_lines := v_lines || jsonb_build_object('account_id', v_ctrl, 'party_id', inv.party_id, 'description', case inv.kind when 'sale' then 'Invoice total' else 'Bill total' end,
    'debit', case inv.kind when 'sale' then v_total else 0 end, 'credit', case inv.kind when 'sale' then 0 else v_total end);
  perform set_config('app.fin_posting', 'on', true);
  if inv.number is null then
    if inv.kind = 'sale' then update public.fin_entities set next_invoice_no = next_invoice_no + 1 where id = inv.entity_id returning 'INV-' || lpad((next_invoice_no - 1)::text, 4, '0') into v_no;
    else update public.fin_entities set next_bill_no = next_bill_no + 1 where id = inv.entity_id returning 'BILL-' || lpad((next_bill_no - 1)::text, 4, '0') into v_no; end if;
  else v_no := inv.number; end if;
  v_jid := public.fin_system_journal(inv.entity_id, inv.issue_date, case inv.kind when 'sale' then 'Invoice ' else 'Bill ' end || v_no, coalesce(inv.party_reference, v_no),
    case inv.kind when 'sale' then 'invoice' else 'bill' end, inv.id, v_lines);
  perform set_config('app.fin_posting', 'on', true);
  for m in select * from jsonb_array_elements(v_moves) loop
    insert into public.fin_stock_moves (entity_id, item_id, move_date, qty, unit_cost, source, invoice_id, journal_id)
      values (inv.entity_id, (m->>'item_id')::uuid, inv.issue_date, (m->>'qty')::numeric, (m->>'unit_cost')::numeric, m->>'source', inv.id, v_jid);
  end loop;
  update public.fin_invoices set status = 'posted', number = v_no, journal_id = v_jid, posted_at = now() where id = p_invoice;
  perform set_config('app.fin_posting', 'off', true);
  return v_no;
end $$;

create or replace function public.fin_void_invoice(p_invoice uuid, p_reason text, p_date date default null) returns void language plpgsql security definer set search_path = '' as $$
declare inv public.fin_invoices; v_rev uuid; m record;
begin
  select * into inv from public.fin_invoices where id = p_invoice for update;
  if not found then raise exception 'not_found: invoice not found'; end if;
  if not public.can_write_fin(inv.entity_id) then raise exception 'forbidden: only owners and bookkeepers can void'; end if;
  if inv.status <> 'posted' then raise exception 'not_posted: only posted invoices can be voided — delete the draft instead'; end if;
  if exists (select 1 from public.fin_allocations a join public.fin_payments p on p.id = a.payment_id where a.invoice_id = p_invoice and p.status = 'posted') then
    raise exception 'has_payments: void the payments against this invoice first';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required: give a reason for voiding'; end if;
  perform set_config('app.fin_doc_void', 'on', true);
  v_rev := public.fin_reverse_journal(inv.journal_id, 'Void ' || inv.number || ': ' || p_reason, p_date);
  perform set_config('app.fin_doc_void', 'off', true);
  for m in select * from public.fin_stock_moves where invoice_id = p_invoice and source in ('purchase','sale') loop
    insert into public.fin_stock_moves (entity_id, item_id, move_date, qty, unit_cost, source, invoice_id, journal_id, note)
      values (m.entity_id, m.item_id, coalesce(p_date, inv.issue_date), -m.qty, m.unit_cost, 'void', p_invoice, v_rev, 'Void ' || inv.number);
  end loop;
  perform set_config('app.fin_posting', 'on', true);
  update public.fin_invoices set status = 'void', void_reason = p_reason where id = p_invoice;
  perform set_config('app.fin_posting', 'off', true);
end $$;

-- stock adjustments: opening stock (in, against opening equity) or a count correction (in/out, against cost of goods sold)
create or replace function public.fin_stock_adjust(p_item uuid, p_date date, p_qty numeric, p_unit_cost numeric, p_kind text, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare it public.fin_items; v_inv uuid; v_other uuid; v_cost numeric; v_onhand numeric; v_val numeric; v_jid uuid;
begin
  select * into it from public.fin_items where id = p_item;
  if not found then raise exception 'not_found: item not found'; end if;
  if not public.can_write_fin(it.entity_id) then raise exception 'forbidden'; end if;
  if p_qty is null or p_qty = 0 then raise exception 'qty_required: enter a quantity'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required: give a reason'; end if;
  if p_kind not in ('opening','adjustment') then raise exception 'bad_kind'; end if;
  v_inv := coalesce(it.inventory_account_id, public.fin_sys_account(it.entity_id, 'inventory'));
  v_other := case p_kind when 'opening' then public.fin_sys_account(it.entity_id, 'opening') else coalesce(it.cogs_account_id, public.fin_sys_account(it.entity_id, 'cogs')) end;
  if v_inv is null or v_other is null then raise exception 'missing_account: these books have no inventory accounts'; end if;
  select on_hand, avg_cost into v_onhand, v_cost from public.fin_item_avg_cost(p_item);
  if p_qty > 0 then
    if p_unit_cost is null or p_unit_cost < 0 then raise exception 'cost_required: enter the unit cost'; end if;
    v_cost := p_unit_cost;
  else
    if p_kind = 'opening' then raise exception 'bad_qty: opening stock must be positive'; end if;
    if v_onhand < -p_qty then raise exception 'insufficient_stock: only % in stock', v_onhand; end if;
  end if;
  v_val := round(abs(p_qty) * v_cost, 2);
  if v_val > 0 then
    v_jid := public.fin_system_journal(it.entity_id, p_date, case p_kind when 'opening' then 'Opening stock: ' else 'Stock adjustment: ' end || it.name || ' — ' || p_reason, null, 'stock', p_item,
      jsonb_build_array(
        jsonb_build_object('account_id', v_inv, 'description', it.name, 'debit', case when p_qty > 0 then v_val else 0 end, 'credit', case when p_qty > 0 then 0 else v_val end),
        jsonb_build_object('account_id', v_other, 'description', p_reason, 'debit', case when p_qty > 0 then 0 else v_val end, 'credit', case when p_qty > 0 then v_val else 0 end)));
  else
    perform public.fin_check_open(it.entity_id, p_date);
  end if;
  insert into public.fin_stock_moves (entity_id, item_id, move_date, qty, unit_cost, source, journal_id, note)
    values (it.entity_id, p_item, p_date, p_qty, v_cost, p_kind, v_jid, p_reason);
  return v_jid;
end $$;

-- ===================================================================== payments (recorded by a person, never automatically)
create or replace function public.fin_record_payment(p_entity uuid, p_direction text, p_party uuid, p_date date, p_amount numeric, p_account uuid,
  p_reference text, p_memo text, p_allocations jsonb default '[]'::jsonb) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_pid uuid; v_jid uuid; v_ctrl uuid; v_acc public.fin_accounts; a jsonb; inv public.fin_invoices; v_out numeric; v_sum numeric := 0; v_pe uuid;
begin
  if not public.can_write_fin(p_entity) then raise exception 'forbidden: only owners and bookkeepers can record payments'; end if;
  if p_direction not in ('in','out') then raise exception 'bad_direction'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'amount_required: enter an amount above zero'; end if;
  select * into v_acc from public.fin_accounts where id = p_account;
  if v_acc.entity_id is distinct from p_entity or v_acc.subtype not in ('cash','bank','card') then raise exception 'bad_account: pay from or into a cash, bank or card account'; end if;
  if p_party is not null then select entity_id into v_pe from public.fin_parties where id = p_party; if v_pe is distinct from p_entity then raise exception 'party_other_entity'; end if; end if;
  v_ctrl := public.fin_sys_account(p_entity, case p_direction when 'in' then 'ar' else 'ap' end);
  for a in select * from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb)) loop
    select * into inv from public.fin_invoices where id = (a->>'invoice_id')::uuid for update;
    if inv.entity_id is distinct from p_entity or inv.status <> 'posted' then raise exception 'bad_invoice: only posted invoices in these books can be paid'; end if;
    if inv.kind <> (case p_direction when 'in' then 'sale' else 'purchase' end) then raise exception 'wrong_kind: money in settles invoices; money out settles bills'; end if;
    if inv.party_id is distinct from p_party then raise exception 'wrong_party: the invoice belongs to a different customer/supplier'; end if;
    select total - paid into v_out from public.fin_invoice_totals where invoice_id = inv.id;
    if (a->>'amount')::numeric > v_out then raise exception 'overpayment: % is more than the % outstanding on %', (a->>'amount'), v_out, inv.number; end if;
    v_sum := v_sum + (a->>'amount')::numeric;
  end loop;
  if v_sum > p_amount then raise exception 'allocation_exceeds_payment: allocations add up to more than the payment'; end if;
  if v_sum < p_amount and p_party is null then raise exception 'party_required: an unallocated payment needs a customer or supplier'; end if;
  insert into public.fin_payments (entity_id, direction, party_id, pay_date, amount, account_id, reference, memo)
    values (p_entity, p_direction, p_party, p_date, p_amount, p_account, p_reference, p_memo) returning id into v_pid;
  v_jid := public.fin_system_journal(p_entity, p_date, case p_direction when 'in' then 'Payment received' else 'Payment made' end || coalesce(' — ' || p_reference, ''), p_reference, 'payment', v_pid,
    jsonb_build_array(
      jsonb_build_object('account_id', p_account, 'description', coalesce(p_memo, 'Payment'), 'debit', case p_direction when 'in' then p_amount else 0 end, 'credit', case p_direction when 'in' then 0 else p_amount end),
      jsonb_build_object('account_id', v_ctrl, 'party_id', p_party, 'description', coalesce(p_memo, 'Payment'), 'debit', case p_direction when 'in' then 0 else p_amount end, 'credit', case p_direction when 'in' then p_amount else 0 end)));
  update public.fin_payments set journal_id = v_jid where id = v_pid;
  for a in select * from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb)) loop
    if (a->>'amount')::numeric > 0 then insert into public.fin_allocations (payment_id, invoice_id, entity_id, amount) values (v_pid, (a->>'invoice_id')::uuid, p_entity, (a->>'amount')::numeric); end if;
  end loop;
  return v_pid;
end $$;

create or replace function public.fin_void_payment(p_payment uuid, p_reason text) returns void language plpgsql security definer set search_path = '' as $$
declare p public.fin_payments;
begin
  select * into p from public.fin_payments where id = p_payment for update;
  if not found then raise exception 'not_found: payment not found'; end if;
  if not public.can_write_fin(p.entity_id) then raise exception 'forbidden: only owners and bookkeepers can void'; end if;
  if p.status = 'void' then raise exception 'already_void: this payment is already void'; end if;
  if exists (select 1 from public.fin_lines where journal_id = p.journal_id and statement_line_id is not null) then raise exception 'reconciled: unmatch it from the bank statement first'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required: give a reason for voiding'; end if;
  perform set_config('app.fin_doc_void', 'on', true);
  perform public.fin_reverse_journal(p.journal_id, 'Void payment: ' || p_reason, null);
  perform set_config('app.fin_doc_void', 'off', true);
  update public.fin_payments set status = 'void', void_reason = p_reason where id = p_payment;
end $$;

-- ===================================================================== bank reconciliation
create or replace function public.fin_match_statement(p_statement uuid, p_line uuid) returns void language plpgsql security definer set search_path = '' as $$
declare s public.fin_statement_lines; l public.fin_lines; v_status text;
begin
  select * into s from public.fin_statement_lines where id = p_statement for update;
  if not found then raise exception 'not_found: statement line not found'; end if;
  if not public.can_write_fin(s.entity_id) then raise exception 'forbidden'; end if;
  if s.status <> 'unmatched' then raise exception 'already_matched: this statement line is already matched or ignored'; end if;
  select * into l from public.fin_lines where id = p_line for update;
  select status into v_status from public.fin_journals where id = l.journal_id;
  if v_status <> 'posted' then raise exception 'not_posted: match to a posted entry'; end if;
  if l.account_id <> s.account_id then raise exception 'wrong_account: the entry is on a different account'; end if;
  if l.statement_line_id is not null then raise exception 'already_matched: that entry is already matched'; end if;
  if (l.debit - l.credit) <> s.amount then raise exception 'amount_mismatch: statement % vs entry %', s.amount, l.debit - l.credit; end if;
  perform set_config('app.fin_posting', 'on', true);
  update public.fin_lines set statement_line_id = s.id where id = l.id;
  update public.fin_statement_lines set status = 'matched', matched_line_id = l.id where id = s.id;
  perform set_config('app.fin_posting', 'off', true);
end $$;
create or replace function public.fin_unmatch_statement(p_statement uuid) returns void language plpgsql security definer set search_path = '' as $$
declare s public.fin_statement_lines;
begin
  select * into s from public.fin_statement_lines where id = p_statement for update;
  if not found or not public.can_write_fin(s.entity_id) then raise exception 'forbidden'; end if;
  perform set_config('app.fin_posting', 'on', true);
  update public.fin_lines set statement_line_id = null where statement_line_id = s.id;
  update public.fin_statement_lines set status = 'unmatched', matched_line_id = null where id = s.id;
  perform set_config('app.fin_posting', 'off', true);
end $$;
create or replace function public.fin_statement_guard() returns trigger language plpgsql set search_path = '' as $$
declare v_e uuid; v_sub text;
begin
  if tg_op = 'DELETE' then
    if old.status = 'matched' then raise exception 'matched_line: unmatch it before deleting'; end if; return old;
  end if;
  select entity_id, subtype into v_e, v_sub from public.fin_accounts where id = new.account_id;
  if v_e is distinct from new.entity_id or v_sub not in ('bank','cash','card') then raise exception 'bad_account: statements belong to a bank, cash or card account'; end if;
  if tg_op = 'INSERT' and (new.status = 'matched' or new.matched_line_id is not null) then raise exception 'match_via_function: import as unmatched, then match'; end if;
  if tg_op = 'UPDATE' and not public.fin_posting() then
    if (new.status = 'matched' or old.status = 'matched') and new.status is distinct from old.status then raise exception 'match_via_function: use Match / Unmatch'; end if;
    if new.matched_line_id is distinct from old.matched_line_id then raise exception 'match_via_function: use Match / Unmatch'; end if;
    if old.status = 'matched' and (new.amount, new.line_date, new.account_id) is distinct from (old.amount, old.line_date, old.account_id) then raise exception 'matched_line: unmatch it before editing'; end if;
  end if;
  return new;
end $$;
create trigger fin_statement_guard before insert or update or delete on public.fin_statement_lines for each row execute function public.fin_statement_guard();

-- ===================================================================== members (owner adds by email)
create or replace function public.fin_add_member(p_entity uuid, p_email text, p_role text) returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid;
begin
  if not public.is_fin_owner(p_entity) then raise exception 'forbidden: only the owner can add people to these books'; end if;
  if p_role not in ('owner','bookkeeper','viewer') then raise exception 'bad_role'; end if;
  select id into v_uid from auth.users where lower(email) = lower(trim(p_email));
  if v_uid is null then raise exception 'no_account: % has no Job Desk account yet — send them your invite link first', p_email; end if;
  insert into public.fin_members (entity_id, user_id, role) values (p_entity, v_uid, p_role) on conflict (entity_id, user_id) do update set role = excluded.role;
end $$;
create or replace function public.fin_members_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if (tg_op = 'DELETE' and old.role = 'owner') or (tg_op = 'UPDATE' and old.role = 'owner' and new.role <> 'owner') then
    if (select count(*) from public.fin_members where entity_id = old.entity_id and role = 'owner') <= 1 then raise exception 'last_owner: the books need at least one owner'; end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger fin_members_guard before update or delete on public.fin_members for each row execute function public.fin_members_guard();

-- ===================================================================== audit (append-only, entity members can read)
create or replace function public.fin_audit_trg() returns trigger language plpgsql security definer set search_path = '' as $$
declare o jsonb; nw jsonb; v_changes jsonb := '{}'::jsonb; k text; v_e uuid; v_id uuid;
begin
  if tg_op = 'DELETE' then o := to_jsonb(old); nw := '{}'::jsonb; else nw := to_jsonb(new); o := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end; end if;
  v_e := coalesce((nw->>'entity_id')::uuid, (o->>'entity_id')::uuid);
  if tg_table_name = 'fin_entities' then v_e := coalesce((nw->>'id')::uuid, (o->>'id')::uuid); end if;
  v_id := coalesce((nw->>'id')::uuid, (o->>'id')::uuid, (nw->>'payment_id')::uuid, (o->>'payment_id')::uuid);
  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(nw) loop
      if k not in ('updated_at','due_reminded_for','overdue_reminded_for') and o->k is distinct from nw->k then v_changes := v_changes || jsonb_build_object(k, jsonb_build_array(o->k, nw->k)); end if;
    end loop;
    if v_changes = '{}'::jsonb then return new; end if;
  elsif tg_op = 'DELETE' then v_changes := o;
  else v_changes := nw;
  end if;
  if tg_op = 'DELETE' and tg_table_name <> 'fin_entities' and not exists (select 1 from public.fin_entities where id = v_e) then return old; end if;
  insert into public.fin_audit (entity_id, record_type, record_id, actor_id, action, changes) values (v_e, tg_table_name, v_id, (select auth.uid()), lower(tg_op), v_changes);
  return coalesce(new, old);
end $$;
create trigger fin_entities_audit after insert or update on public.fin_entities for each row execute function public.fin_audit_trg();
create trigger fin_members_audit after insert or update or delete on public.fin_members for each row execute function public.fin_audit_trg();
create trigger fin_accounts_audit after insert or update or delete on public.fin_accounts for each row execute function public.fin_audit_trg();
create trigger fin_journals_audit after insert or update or delete on public.fin_journals for each row execute function public.fin_audit_trg();
create trigger fin_invoices_audit after insert or update or delete on public.fin_invoices for each row execute function public.fin_audit_trg();
create trigger fin_payments_audit after insert or update on public.fin_payments for each row execute function public.fin_audit_trg();
create trigger fin_statement_audit after update or delete on public.fin_statement_lines for each row execute function public.fin_audit_trg();
create trigger fin_budgets_audit after insert or update or delete on public.fin_budgets for each row execute function public.fin_audit_trg();

-- ===================================================================== row-level security
alter table public.fin_entities enable row level security;
alter table public.fin_members enable row level security;
alter table public.fin_accounts enable row level security;
alter table public.fin_parties enable row level security;
alter table public.fin_journals enable row level security;
alter table public.fin_lines enable row level security;
alter table public.fin_items enable row level security;
alter table public.fin_invoices enable row level security;
alter table public.fin_invoice_lines enable row level security;
alter table public.fin_stock_moves enable row level security;
alter table public.fin_payments enable row level security;
alter table public.fin_allocations enable row level security;
alter table public.fin_statement_lines enable row level security;
alter table public.fin_budgets enable row level security;
alter table public.fin_files enable row level security;
alter table public.fin_audit enable row level security;

create policy "fin entities: members read" on public.fin_entities for select to authenticated using (public.is_fin_member(id) or created_by = (select auth.uid()));
create policy "fin entities: anyone creates own" on public.fin_entities for insert to authenticated with check (created_by = (select auth.uid()));
create policy "fin entities: owner edits" on public.fin_entities for update to authenticated using (public.is_fin_owner(id)) with check (public.is_fin_owner(id));
create policy "fin members: members read" on public.fin_members for select to authenticated using (public.is_fin_member(entity_id));
create policy "fin members: owner changes roles" on public.fin_members for update to authenticated using (public.is_fin_owner(entity_id)) with check (public.is_fin_owner(entity_id));
create policy "fin members: owner removes, or leave" on public.fin_members for delete to authenticated using (public.is_fin_owner(entity_id) or user_id = (select auth.uid()));

do $$ declare t text; begin
  foreach t in array array['fin_accounts','fin_parties','fin_items','fin_budgets'] loop
    execute format('create policy "%1$s: members read" on public.%1$I for select to authenticated using (public.is_fin_member(entity_id))', t);
    execute format('create policy "%1$s: writers add" on public.%1$I for insert to authenticated with check (public.can_write_fin(entity_id))', t);
    execute format('create policy "%1$s: writers edit" on public.%1$I for update to authenticated using (public.can_write_fin(entity_id)) with check (public.can_write_fin(entity_id))', t);
    execute format('create policy "%1$s: writers delete" on public.%1$I for delete to authenticated using (public.can_write_fin(entity_id))', t);
  end loop;
  foreach t in array array['fin_journals','fin_invoices'] loop
    execute format('create policy "%1$s: members read" on public.%1$I for select to authenticated using (public.is_fin_member(entity_id))', t);
    execute format('create policy "%1$s: writers add" on public.%1$I for insert to authenticated with check (public.can_write_fin(entity_id) and created_by = (select auth.uid()))', t);
    execute format('create policy "%1$s: writers edit" on public.%1$I for update to authenticated using (public.can_write_fin(entity_id)) with check (public.can_write_fin(entity_id))', t);
    execute format('create policy "%1$s: writers delete" on public.%1$I for delete to authenticated using (public.can_write_fin(entity_id))', t);
  end loop;
  foreach t in array array['fin_lines','fin_invoice_lines'] loop
    execute format('create policy "%1$s: members read" on public.%1$I for select to authenticated using (public.is_fin_member(entity_id))', t);
    execute format('create policy "%1$s: writers add" on public.%1$I for insert to authenticated with check (public.can_write_fin(entity_id))', t);
    execute format('create policy "%1$s: writers edit" on public.%1$I for update to authenticated using (public.can_write_fin(entity_id)) with check (public.can_write_fin(entity_id))', t);
    execute format('create policy "%1$s: writers delete" on public.%1$I for delete to authenticated using (public.can_write_fin(entity_id))', t);
  end loop;
  -- read-only from the client: these are written only by the posting functions
  foreach t in array array['fin_stock_moves','fin_payments','fin_allocations','fin_audit'] loop
    execute format('create policy "%1$s: members read" on public.%1$I for select to authenticated using (public.is_fin_member(entity_id))', t);
  end loop;
end $$;
-- lines: the entity_id is set by the trigger from the journal, so check the journal too on insert
create policy "fin statement: members read" on public.fin_statement_lines for select to authenticated using (public.is_fin_member(entity_id));
create policy "fin statement: writers import" on public.fin_statement_lines for insert to authenticated with check (public.can_write_fin(entity_id) and created_by = (select auth.uid()));
create policy "fin statement: writers edit" on public.fin_statement_lines for update to authenticated using (public.can_write_fin(entity_id)) with check (public.can_write_fin(entity_id));
create policy "fin statement: writers delete" on public.fin_statement_lines for delete to authenticated using (public.can_write_fin(entity_id));
create policy "fin files: members read" on public.fin_files for select to authenticated using (public.is_fin_member(entity_id));
create policy "fin files: writers add" on public.fin_files for insert to authenticated with check (public.can_write_fin(entity_id) and created_by = (select auth.uid()));
create policy "fin files: writers delete" on public.fin_files for delete to authenticated using (public.can_write_fin(entity_id));

-- private storage for receipts and invoices: path = <entity id>/<uuid>/<file name>
insert into storage.buckets (id, name, public, file_size_limit) values ('finance', 'finance', false, 26214400) on conflict (id) do nothing;
create policy "finance bucket: members read" on storage.objects for select to authenticated using (bucket_id = 'finance' and public.is_fin_member(public.storage_ws(name)));
create policy "finance bucket: writers upload" on storage.objects for insert to authenticated with check (bucket_id = 'finance' and public.can_write_fin(public.storage_ws(name)));
create policy "finance bucket: writers delete" on storage.objects for delete to authenticated using (bucket_id = 'finance' and public.can_write_fin(public.storage_ws(name)));

-- function grants: posting functions are callable by signed-in users (each checks the caller's role); internals are not
revoke execute on function public.fin_check_open(uuid, date) from public, anon;
revoke execute on function public.fin_entities_after_insert() from public, anon, authenticated;
revoke execute on function public.fin_audit_trg() from public, anon, authenticated;
grant execute on function public.fin_post_journal(uuid), public.fin_reverse_journal(uuid, text, date), public.fin_post_invoice(uuid), public.fin_void_invoice(uuid, text, date),
  public.fin_record_payment(uuid, text, uuid, date, numeric, uuid, text, text, jsonb), public.fin_void_payment(uuid, text),
  public.fin_match_statement(uuid, uuid), public.fin_unmatch_statement(uuid), public.fin_add_member(uuid, text, text), public.fin_item_avg_cost(uuid),
  public.fin_stock_adjust(uuid, date, numeric, numeric, text, text) to authenticated;

-- ===================================================================== reminders for bills and invoices
create or replace function public.fin_reminders() returns jsonb language plpgsql security definer set search_path = '' as $$
declare r record; v_today date; n_due int := 0; n_over int := 0;
begin
  for r in
    select i.*, e.name as ename, e.base_currency, t.total - t.paid as outstanding, (now() at time zone 'Asia/Qatar')::date as today
    from public.fin_invoices i join public.fin_entities e on e.id = i.entity_id join public.fin_invoice_totals t on t.invoice_id = i.id
    where i.status = 'posted' and i.due_date is not null and t.total - t.paid > 0 and not e.archived
    for update of i skip locked
  loop
    v_today := r.today;
    if r.kind = 'purchase' and r.due_date between v_today and v_today + 3 and r.due_reminded_for is distinct from r.due_date then
      insert into public.notifications (user_id, kind, title, body, url)
        select m.user_id, 'bill_due', 'Bill due ' || case when r.due_date = v_today then 'today' else to_char(r.due_date, 'Dy DD Mon') end || ': ' || coalesce(r.number, ''),
               r.ename || ' · ' || r.base_currency || ' ' || to_char(r.outstanding, 'FM999,999,990.00') || ' outstanding', '/#/finance/' || r.entity_id || '/bills'
        from public.fin_members m where m.entity_id = r.entity_id and m.role in ('owner','bookkeeper');
      update public.fin_invoices set due_reminded_for = r.due_date where id = r.id; n_due := n_due + 1;
    elsif r.due_date < v_today and r.overdue_reminded_for is distinct from r.due_date then
      insert into public.notifications (user_id, kind, title, body, url)
        select m.user_id, case r.kind when 'purchase' then 'bill_overdue' else 'invoice_overdue' end,
               case r.kind when 'purchase' then 'Overdue bill: ' else 'Customer invoice overdue: ' end || coalesce(r.number, ''),
               r.ename || ' · ' || r.base_currency || ' ' || to_char(r.outstanding, 'FM999,999,990.00') || ' · due ' || to_char(r.due_date, 'DD Mon'),
               '/#/finance/' || r.entity_id || case r.kind when 'purchase' then '/bills' else '/invoices' end
        from public.fin_members m where m.entity_id = r.entity_id and m.role in ('owner','bookkeeper');
      update public.fin_invoices set overdue_reminded_for = r.due_date where id = r.id; n_over := n_over + 1;
    end if;
  end loop;
  return jsonb_build_object('due', n_due, 'overdue', n_over);
end $$;
revoke execute on function public.fin_reminders() from public, anon, authenticated;
select cron.schedule('jobdesk-fin-reminders', '17 * * * *', $$select public.fin_reminders()$$);

-- realtime for collaborative books
alter publication supabase_realtime add table public.fin_journals, public.fin_invoices, public.fin_payments;
