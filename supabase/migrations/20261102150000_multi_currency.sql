-- Multi-currency money (2 Nov 2026). Books keep one base currency for reporting (Personal & Family: QAR), but:
--   * a bank, cash, card, savings, investment or loan account can be held in another currency (an INR bank account, BHD cash);
--     every line on it carries the amount in that currency (fx_currency / fx_amount, signed like debit − credit), so its own balance is exact;
--   * a payment in another currency records both the foreign amount and the base amount — the base amount is what actually left or reached
--     a base-currency account when known, otherwise a rate the person confirms (their planning rate is offered, and flagged as such);
--   * paying for a business kept in another currency (The Burgery, INR) records the business's amount in its books and the QAR amount in
--     personal books; when the business has repaid everything, any leftover exchange difference is cleared to "Exchange differences";
--   * budgets can be set in any currency (amount stays the base-currency equivalent, so the classic budget screen keeps working).
-- Never assumes a rate silently: a foreign amount without a base amount is refused.


-- rollback support: save the functions this migration replaces
create table if not exists private.migration_snapshots (
  migration text not null, object text not null, definition text not null, saved_at timestamptz not null default now(),
  primary key (migration, object)
);
revoke all on private.migration_snapshots from public, anon, authenticated;
insert into private.migration_snapshots (migration, object, definition) values
  ('20261102150000', 'public.fin_partner_record(jsonb)', pg_get_functiondef('public.fin_partner_record(jsonb)'::regprocedure)),
  ('20261102150000', 'public.fin_partner_post_mirror(uuid)', pg_get_functiondef('public.fin_partner_post_mirror(uuid)'::regprocedure)),
  ('20261102150000', 'public.fin_money_post(jsonb)', pg_get_functiondef('public.fin_money_post(jsonb)'::regprocedure)),
  ('20261102150000', 'public.fin_entities_money_accounts()', pg_get_functiondef('public.fin_entities_money_accounts()'::regprocedure))
  on conflict do nothing;

-- ===================================================================== account currency
alter table public.fin_accounts add column currency text check (currency is null or currency ~ '^[A-Z]{3}$');

create or replace function public.fin_accounts_currency_guard() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_base text;
begin
  select base_currency into v_base from public.fin_entities where id = new.entity_id;
  if new.currency = v_base then new.currency := null; end if;
  if new.currency is not null and new.subtype not in ('cash','bank','card','earmarked','investment','loan') then
    raise exception 'currency_account: only bank, cash, card, savings, investment and loan accounts can be held in another currency';
  end if;
  if tg_op = 'UPDATE' and new.currency is distinct from old.currency and exists (select 1 from public.fin_lines where account_id = old.id) then
    raise exception 'currency_locked: this account already has entries, so its currency can''t change — open a new account instead';
  end if;
  return new;
end $$;
create trigger fin_accounts_currency_guard before insert or update of currency, subtype on public.fin_accounts for each row execute function public.fin_accounts_currency_guard();

-- every line on a foreign-currency account must say how much it was in that currency (fires after fin_lines_guard: name order)
create or replace function public.fin_lines_fx_guard() returns trigger language plpgsql security definer set search_path = '' as $$
declare a public.fin_accounts;
begin
  select * into a from public.fin_accounts where id = new.account_id;
  if a.currency is not null then
    if new.fx_currency is distinct from a.currency or new.fx_amount is null then
      raise exception 'foreign_account: % is kept in % — record it with Capture and enter the % amount', a.name, a.currency, a.currency;
    end if;
    if (new.debit > 0 and new.fx_amount <= 0) or (new.credit > 0 and new.fx_amount >= 0) then
      raise exception 'fx_sign: the % amount must go the same way as the entry', a.currency;
    end if;
  end if;
  return new;
end $$;
create trigger fin_lines_fx_guard before insert or update on public.fin_lines for each row execute function public.fin_lines_fx_guard();

-- ===================================================================== the rate used, per entry (so planning-rate entries can be found and corrected)
create table public.fin_money_fx (
  journal_id uuid primary key references public.fin_journals(id) on delete cascade,
  entity_id uuid not null references public.fin_entities(id) on delete cascade,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  native_amount numeric(16,2) not null check (native_amount > 0),
  base_amount numeric(16,2) not null check (base_amount > 0),
  rate numeric(18,8) not null check (rate > 0),             -- units of currency per 1 base
  rate_source text not null check (rate_source in ('actual','planning','entered')),
  created_at timestamptz not null default now()
);
alter table public.fin_money_fx enable row level security;
create policy "money fx: members read" on public.fin_money_fx for select to authenticated using (public.is_fin_member(entity_id));

-- ===================================================================== import rows: base amount beside the foreign amount
alter table public.fin_import_rows add column base_amount numeric(14,2) check (base_amount is null or base_amount > 0);
alter table public.fin_import_rows add column rate_source text check (rate_source is null or rate_source in ('actual','planning','entered'));

-- ===================================================================== budgets in their own currency
alter table public.fin_budgets add column native_currency text check (native_currency is null or native_currency ~ '^[A-Z]{3}$');
alter table public.fin_budgets add column native_amount numeric(14,2);

-- ===================================================================== exchange differences account for personal books
insert into public.fin_accounts (entity_id, code, name, type, subtype, description)
select e.id, '6870', 'Exchange differences', 'expense', 'other', 'Gains (negative) and losses from exchange rates on money owed and repaid'
from public.fin_entities e where e.kind = 'personal' and not exists (select 1 from public.fin_accounts a where a.entity_id = e.id and a.code = '6870');
create or replace function public.fin_entities_money_accounts() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'personal' then
    insert into public.fin_accounts (entity_id, code, name, type, subtype, description)
    select new.id, x.code, x.name, x.type, x.subtype, x.descr
    from (values ('2250', 'Personal loans (friends & family)', 'liability', 'loan', 'Money borrowed from friends or family'),
                 ('6850', 'Interest on loans & cards', 'expense', 'other', 'Interest and finance charges on loans and credit cards'),
                 ('6870', 'Exchange differences', 'expense', 'other', 'Gains (negative) and losses from exchange rates on money owed and repaid')) as x(code, name, type, subtype, descr)
    where not exists (select 1 from public.fin_accounts a where a.entity_id = new.id and a.code = x.code);
  end if;
  return new;
end $$;

-- ===================================================================== partner funding across currencies
alter table public.fin_partner_txns add column mirror_amount numeric(14,2) check (mirror_amount is null or mirror_amount > 0);       -- in the personal books' currency
alter table public.fin_partner_txns add column mirror_fx_amount numeric(16,2) check (mirror_fx_amount is null or mirror_fx_amount > 0); -- in the personal money account's currency, when it isn't the base

-- same rules as before; also stores mirror_amount / mirror_fx_amount when given
create or replace function public.fin_partner_record(p jsonb) returns uuid language plpgsql security definer set search_path = '' as $function$
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
  if v_dir = 'increase' and a.subtype in ('cash','bank','card') then raise exception 'mixed_funds: money the partner paid personally can''t be booked against the business''s bank or cash'; end if;
  if v_type = 'reimbursement' and a.subtype not in ('cash','bank') then raise exception 'bad_account: a reimbursement is paid from the business''s bank or cash account'; end if;
  if v_type in ('expense_funding','salary_funding') and a.type in ('income','equity') then raise exception 'bad_account: funding is booked to an expense, inventory, asset or liability account — never to income'; end if;
  if a.currency is not null then raise exception 'foreign_account: choose a % account in the business''s books for partner transactions', e.base_currency; end if;
  if v_dir = 'decrease' then
    v_bal := public.fin_partner_balance(k.id);
    if v_amt > v_bal then raise exception 'exceeds_outstanding: % is more than the % currently owed to the partner', v_amt, v_bal; end if;
  end if;
  if p->>'import_key' is not null and exists (select 1 from public.fin_partner_txns where entity_id = k.entity_id and import_key = p->>'import_key') then
    raise exception 'duplicate_import: this line was already imported';
  end if;
  update public.fin_partner_links set next_no = next_no + 1 where id = k.id returning 'PR-' || lpad((next_no - 1)::text, 4, '0') into v_no;
  insert into public.fin_partner_txns (id, link_id, entity_id, txn_no, txn_type, direction, txn_date, date_precision, payment_date, description, beneficiary, reference, invoice_amount, amount, currency,
      paid_from, account_id, job_ref, flags, legacy_ref, notes, import_key, mirror_account_id, recon_status, mirror_amount, mirror_fx_amount)
    values (v_id, k.id, k.entity_id, v_no, v_type, v_dir, v_date, v_prec, nullif(p->>'payment_date', '')::date, trim(p->>'description'), nullif(trim(p->>'beneficiary'), ''), nullif(trim(p->>'reference'), ''),
      nullif(p->>'invoice_amount', '')::numeric, v_amt, e.base_currency, coalesce(nullif(p->>'paid_from', ''), case when v_type = 'reimbursement' then 'business_bank' else 'not_recorded' end), a.id,
      nullif(trim(p->>'job_ref'), ''), coalesce(array(select jsonb_array_elements_text(p->'flags')), '{}'), nullif(p->>'legacy_ref', ''), nullif(p->>'notes', ''), nullif(p->>'import_key', ''),
      nullif(p->>'mirror_account_id', '')::uuid, 'unverified', round(nullif(p->>'mirror_amount', '')::numeric, 2), round(nullif(p->>'mirror_fx_amount', '')::numeric, 2));
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
end $function$;

-- mirror in the personal books: in their own currency when the business keeps another one
create or replace function public.fin_partner_post_mirror(p_txn uuid) returns uuid language plpgsql security definer set search_path = '' as $function$
declare t public.fin_partner_txns; k public.fin_partner_links; v_acc uuid; acc public.fin_accounts; v_jid uuid; v_lines jsonb; v_desc text; v_bc text; v_mc text; v_amt numeric; v_fx numeric; v_sign int;
begin
  select * into t from public.fin_partner_txns where id = p_txn for update;
  select * into k from public.fin_partner_links where id = t.link_id;
  if k.mirror_entity_id is null or t.mirror_journal_id is not null or t.status <> 'posted' then return t.mirror_journal_id; end if;
  if not public.can_write_fin(k.mirror_entity_id) then return null; end if;
  v_acc := coalesce(t.mirror_account_id, k.mirror_default_account_id);
  select * into acc from public.fin_accounts where id = v_acc;
  if acc.entity_id is distinct from k.mirror_entity_id then raise exception 'mirror_account_other_entity'; end if;
  select base_currency into v_bc from public.fin_entities where id = k.entity_id;
  select base_currency into v_mc from public.fin_entities where id = k.mirror_entity_id;
  v_amt := coalesce(t.mirror_amount, case when v_bc = v_mc then t.amount end);
  if v_amt is null then raise exception 'mirror_amount_required: the business keeps % — enter what it was in % for your own books', v_bc, v_mc; end if;
  v_sign := case when t.direction = 'increase' then 1 else -1 end;
  if acc.currency is not null then
    v_fx := coalesce(t.mirror_fx_amount, case when acc.currency = v_bc then t.amount end);
    if v_fx is null then raise exception 'mirror_fx_required: % is kept in % — enter the % amount', acc.name, acc.currency, acc.currency; end if;
  end if;
  v_desc := t.txn_no || ' · ' || t.description;
  -- receivable line: in the personal currency, noting the business's own amount when it differs; money line: noting the account's currency if foreign
  v_lines := jsonb_build_array(
      jsonb_build_object('account_id', k.mirror_receivable_account_id, 'party_id', k.mirror_party_id, 'description', v_desc,
        'debit', case when v_sign = 1 then v_amt else 0 end, 'credit', case when v_sign = 1 then 0 else v_amt end,
        'fx_currency', case when v_bc <> v_mc then v_bc end, 'fx_amount', case when v_bc <> v_mc then v_sign * t.amount end),
      jsonb_build_object('account_id', v_acc, 'description', v_desc,
        'debit', case when v_sign = 1 then 0 else v_amt end, 'credit', case when v_sign = 1 then v_amt else 0 end,
        'fx_currency', acc.currency, 'fx_amount', case when acc.currency is not null then -v_sign * v_fx end));
  v_jid := public.fin_system_journal(k.mirror_entity_id, t.txn_date, left(t.txn_no || ' ' || t.description, 300), t.reference, 'partner', t.id, v_lines);
  update public.fin_partner_txns set mirror_journal_id = v_jid, mirror_account_id = v_acc where id = t.id;
  return v_jid;
end $function$;

-- ===================================================================== the posting function, now currency-aware
-- p: {entity_id, kind, txn_date, amount (base), currency, fx_amount (in currency), to_fx_amount (transfer destination in its own currency),
--     rate_source, account_id, category_account_id, party_id, for_entity_id, business_account_id, business_amount (in the business's currency),
--     interest (base), interest_account_id, description, merchant, reference, import_row_id}
-- kind 'opening': an existing balance on account_id (asset: what you have; liability: what you owe), against Opening balances.
create or replace function public.fin_money_post(p jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare e public.fin_entities; v_kind text := p->>'kind'; v_amt numeric := round((p->>'amount')::numeric, 2); v_date date := nullif(p->>'txn_date', '')::date;
  m public.fin_accounts; c public.fin_accounts; v_party uuid := nullif(p->>'party_id', '')::uuid; v_desc text := trim(coalesce(p->>'description', ''));
  v_merchant text := nullif(trim(p->>'merchant'), ''); v_ref text := nullif(trim(p->>'reference'), ''); v_lines jsonb; v_jid uuid; v_ptx uuid;
  k public.fin_partner_links; ba public.fin_accounts; v_int numeric := coalesce(nullif(p->>'interest', '')::numeric, 0); ia public.fin_accounts;
  v_row public.fin_import_rows; v_bal numeric; v_ldesc text;
  v_ccy text; v_fx numeric := round(nullif(p->>'fx_amount', '')::numeric, 2); v_tofx numeric := round(nullif(p->>'to_fx_amount', '')::numeric, 2);
  v_src text := coalesce(nullif(p->>'rate_source', ''), 'entered'); v_bc text; v_bamt numeric; v_mfx jsonb; v_cfx jsonb; v_fxa public.fin_accounts; v_open public.fin_accounts;
  v_intfx numeric; v_res numeric;
begin
  select * into e from public.fin_entities where id = nullif(p->>'entity_id', '')::uuid;
  if not found then raise exception 'not_found: books not found'; end if;
  if not public.can_write_fin(e.id) then raise exception 'forbidden: only owners and bookkeepers can record money'; end if;
  if v_kind not in ('spend','income','transfer','lent','repayment_in','borrowed','debt_payment','paid_for_business','business_repaid','opening') then raise exception 'bad_kind: say what happened'; end if;
  if v_amt is null or v_amt <= 0 then raise exception 'amount_required: enter an amount above zero'; end if;
  if v_date is null then raise exception 'date_required: enter the date'; end if;
  if v_desc = '' then v_desc := coalesce(v_merchant, case when v_kind = 'opening' then 'Opening balance' end, ''); end if;
  if v_desc = '' then raise exception 'description_required: say what it was for'; end if;
  if v_src not in ('actual','planning','entered') then v_src := 'entered'; end if;
  v_ccy := coalesce(nullif(upper(p->>'currency'), ''), e.base_currency);
  if v_ccy = e.base_currency then v_fx := null; v_ccy := e.base_currency;
  elsif v_fx is null or v_fx <= 0 then raise exception 'fx_amount_required: enter the % amount as well as the % amount', v_ccy, e.base_currency;
  end if;

  select * into m from public.fin_accounts where id = nullif(p->>'account_id', '')::uuid;
  if v_kind = 'opening' then
    if not found or m.entity_id <> e.id or not m.is_active or m.type not in ('asset','liability') then raise exception 'bad_account: choose the account the balance is on'; end if;
  elsif not found or m.entity_id <> e.id or not m.is_active or m.subtype not in ('cash','bank','card') then raise exception 'bad_account: choose the bank, cash or card account the money moved through'; end if;
  if v_kind in ('income','repayment_in','borrowed','business_repaid') and m.subtype = 'card' then
    raise exception 'bad_account: money received goes into a bank or cash account';
  end if;
  if m.currency is not null and v_ccy <> m.currency then raise exception 'currency_mismatch: % is kept in % — enter the amount in %', m.name, m.currency, m.currency; end if;
  if v_party is not null and not exists (select 1 from public.fin_parties where id = v_party and entity_id = e.id) then raise exception 'bad_party: choose a person from these books'; end if;
  -- the money line's own-currency amount (only when the money account is foreign); sign follows the line
  v_mfx := case when m.currency is not null then jsonb_build_object('fx_currency', m.currency, 'fx_amount', v_fx) end;

  if nullif(p->>'import_row_id', '') is not null then
    select * into v_row from public.fin_import_rows where id = (p->>'import_row_id')::uuid for update;
    if not found or v_row.entity_id <> e.id then raise exception 'not_found: imported line not found'; end if;
    if v_row.status <> 'pending' then raise exception 'already_posted: this imported line was already posted or skipped'; end if;
    if exists (select 1 from public.fin_import_rows x where x.entity_id = e.id and x.dedupe_key = v_row.dedupe_key and x.status = 'posted') then
      raise exception 'duplicate_import: the same transaction was already posted from an earlier import';
    end if;
  end if;

  v_ldesc := left(coalesce(v_merchant || ' · ', '') || v_desc, 300);

  if v_kind = 'opening' then
    select * into v_open from public.fin_accounts where entity_id = e.id and system_key = 'opening';
    if not found then raise exception 'missing_account: these books have no Opening balances account'; end if;
    v_lines := case when m.type = 'asset' then
        jsonb_build_array(jsonb_build_object('account_id', m.id, 'party_id', v_party, 'description', v_ldesc, 'debit', v_amt, 'credit', 0, 'fx_currency', m.currency, 'fx_amount', case when m.currency is not null then v_fx end),
                          jsonb_build_object('account_id', v_open.id, 'description', 'Opening balance', 'debit', 0, 'credit', v_amt))
      else jsonb_build_array(jsonb_build_object('account_id', v_open.id, 'description', 'Opening balance', 'debit', v_amt, 'credit', 0),
                          jsonb_build_object('account_id', m.id, 'party_id', v_party, 'description', v_ldesc, 'debit', 0, 'credit', v_amt, 'fx_currency', m.currency, 'fx_amount', case when m.currency is not null then -v_fx end)) end;
    v_jid := public.fin_system_journal(e.id, v_date, left(v_desc, 300), v_ref, 'opening', null, v_lines);

  elsif v_kind in ('paid_for_business','business_repaid') then
    select * into k from public.fin_partner_links where entity_id = nullif(p->>'for_entity_id', '')::uuid and mirror_entity_id = e.id;
    if not found then raise exception 'no_link: these books aren''t linked to that business yet (link it first)'; end if;
    select * into ba from public.fin_accounts where id = nullif(p->>'business_account_id', '')::uuid;
    if not found or ba.entity_id <> k.entity_id then
      raise exception 'business_account_required: %', case when v_kind = 'paid_for_business' then 'say what it was for in the business''s books (e.g. fabric stock, rent, freight)' else 'choose the business account the money came from' end;
    end if;
    select base_currency into v_bc from public.fin_entities where id = k.entity_id;
    -- the amount in the business's own currency: given, or the same as one we already have
    v_bamt := coalesce(round(nullif(p->>'business_amount', '')::numeric, 2), case when v_bc = e.base_currency then v_amt when v_bc = v_ccy then v_fx end);
    if v_bamt is null or v_bamt <= 0 then raise exception 'business_amount_required: the business keeps % — enter the % amount it records', v_bc, v_bc; end if;
    v_ptx := public.fin_partner_record(jsonb_build_object(
      'link_id', k.id, 'txn_type', case when v_kind = 'paid_for_business' then 'expense_funding' else 'reimbursement' end,
      'txn_date', v_date, 'payment_date', v_date, 'description', v_desc, 'beneficiary', v_merchant, 'reference', v_ref, 'amount', v_bamt, 'account_id', ba.id,
      'paid_from', case when v_kind = 'business_repaid' then (case when ba.subtype = 'cash' then 'business_cash' else 'business_bank' end)
                        else (case m.subtype when 'bank' then 'personal_bank' when 'cash' then 'personal_cash' else 'personal_card' end) end,
      'mirror_account_id', m.id, 'mirror_amount', v_amt, 'mirror_fx_amount', case when m.currency is not null then v_fx end,
      'import_key', case when v_row.id is not null then 'imp:' || v_row.dedupe_key end));
    select mirror_journal_id into v_jid from public.fin_partner_txns where id = v_ptx;
    if v_jid is null then raise exception 'mirror_missing: the business side was recorded but your books were not updated — check you can write to both books'; end if;
    -- business in another currency fully repaid: clear what's left in the personal receivable to exchange differences
    if v_kind = 'business_repaid' and v_bc <> e.base_currency and public.fin_partner_balance(k.id) = 0 then
      v_res := public.fin_balance_of(k.mirror_receivable_account_id, k.mirror_party_id);
      if v_res <> 0 then
        select * into v_fxa from public.fin_accounts where entity_id = e.id and code = '6870';
        if found then
          perform public.fin_system_journal(e.id, v_date, 'Exchange difference on ' || coalesce((select name from public.fin_entities where id = k.entity_id), 'business') || ' (fully repaid)', null, 'manual', null,
            case when v_res > 0 then jsonb_build_array(jsonb_build_object('account_id', v_fxa.id, 'description', 'Exchange loss', 'debit', v_res, 'credit', 0),
                                                       jsonb_build_object('account_id', k.mirror_receivable_account_id, 'party_id', k.mirror_party_id, 'description', 'Exchange difference', 'debit', 0, 'credit', v_res))
                 else jsonb_build_array(jsonb_build_object('account_id', k.mirror_receivable_account_id, 'party_id', k.mirror_party_id, 'description', 'Exchange difference', 'debit', -v_res, 'credit', 0),
                                        jsonb_build_object('account_id', v_fxa.id, 'description', 'Exchange gain', 'debit', 0, 'credit', -v_res)) end);
        end if;
      end if;
    end if;

  else
    if v_kind <> 'transfer' or nullif(p->>'category_account_id', '') is not null then
      select * into c from public.fin_accounts where id = nullif(p->>'category_account_id', '')::uuid;
      if not found or c.entity_id <> e.id or not c.is_active then raise exception 'category_required: choose what it was for'; end if;
    end if;
    -- the other side's own-currency amount: a foreign counter account needs one; otherwise note the foreign amount for reference
    if c.currency is not null then
      if v_kind = 'transfer' and c.currency is distinct from v_ccy then
        if v_tofx is null or v_tofx <= 0 then raise exception 'to_fx_amount_required: enter how much arrived in % (in %)', c.name, c.currency; end if;
        v_cfx := jsonb_build_object('fx_currency', c.currency, 'fx_amount', v_tofx);
      elsif c.currency = v_ccy then v_cfx := jsonb_build_object('fx_currency', c.currency, 'fx_amount', v_fx);
      else raise exception 'currency_mismatch: % is kept in % — enter the amount in %', c.name, c.currency, c.currency;
      end if;
    elsif v_fx is not null then v_cfx := jsonb_build_object('fx_currency', v_ccy, 'fx_amount', v_fx);
    end if;
    case v_kind
      when 'spend' then
        if not (c.type = 'expense' or c.subtype in ('fixed_asset','investment','earmarked','inventory')) then raise exception 'bad_category: spending goes to a spending category or something you bought (asset)'; end if;
        v_lines := jsonb_build_array(public.fin_fx_line(c.id, v_party, v_ldesc, v_amt, 0, v_cfx), public.fin_fx_line(m.id, null, v_ldesc, 0, v_amt, v_mfx));
      when 'income' then
        if c.type <> 'income' then raise exception 'bad_category: choose an income type (salary, business income, other)'; end if;
        v_lines := jsonb_build_array(public.fin_fx_line(m.id, null, v_ldesc, v_amt, 0, v_mfx), public.fin_fx_line(c.id, v_party, v_ldesc, 0, v_amt, v_cfx));
      when 'transfer' then
        if c.id is null or c.subtype not in ('cash','bank','card','earmarked','investment') then raise exception 'bad_category: choose the account the money moved to'; end if;
        if c.id = m.id then raise exception 'same_account: choose two different accounts'; end if;
        if c.subtype = 'card' then
          v_bal := -public.fin_balance_of(c.id, null);
          if v_amt > v_bal then raise exception 'exceeds_outstanding: the card shows % owed in your books; record the card spending first, or enter the difference as spending', greatest(v_bal, 0); end if;
        end if;
        v_lines := jsonb_build_array(public.fin_fx_line(c.id, null, v_ldesc, v_amt, 0, v_cfx), public.fin_fx_line(m.id, null, v_ldesc, 0, v_amt, v_mfx));
      when 'lent' then
        if c.subtype <> 'receivable' then raise exception 'bad_category: money you lend or pay for someone sits on a "money owed to me" account'; end if;
        if v_party is null then raise exception 'party_required: say who owes you this'; end if;
        v_lines := jsonb_build_array(public.fin_fx_line(c.id, v_party, v_ldesc, v_amt, 0, v_cfx), public.fin_fx_line(m.id, null, v_ldesc, 0, v_amt, v_mfx));
      when 'repayment_in' then
        if c.subtype <> 'receivable' then raise exception 'bad_category: choose the "money owed to me" account being paid back'; end if;
        if v_party is null then raise exception 'party_required: say who paid you back'; end if;
        v_bal := public.fin_balance_of(c.id, v_party);
        if v_amt > v_bal then raise exception 'exceeds_outstanding: % is more than the % they owe you', v_amt, greatest(v_bal, 0); end if;
        v_lines := jsonb_build_array(public.fin_fx_line(m.id, null, v_ldesc, v_amt, 0, v_mfx), public.fin_fx_line(c.id, v_party, v_ldesc, 0, v_amt, v_cfx));
      when 'borrowed' then
        if c.type <> 'liability' then raise exception 'bad_category: borrowed money sits on a loan or payable account'; end if;
        v_lines := jsonb_build_array(public.fin_fx_line(m.id, null, v_ldesc, v_amt, 0, v_mfx), public.fin_fx_line(c.id, v_party, v_ldesc, 0, v_amt, v_cfx));
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
        -- foreign amounts split in the same proportion as the base amounts
        v_intfx := case when v_cfx is not null and v_int > 0 then round((v_cfx->>'fx_amount')::numeric * v_int / v_amt, 2) end;
        v_lines := jsonb_build_array(public.fin_fx_line(c.id, v_party, v_ldesc || case when v_int > 0 then ' (principal)' else '' end, v_amt - v_int, 0,
                     case when v_cfx is not null then jsonb_build_object('fx_currency', v_cfx->>'fx_currency', 'fx_amount', (v_cfx->>'fx_amount')::numeric - coalesce(v_intfx, 0)) end))
          || case when v_int > 0 then jsonb_build_array(public.fin_fx_line(ia.id, null, v_ldesc || ' (interest)', v_int, 0,
               case when v_cfx is not null and c.currency is null then jsonb_build_object('fx_currency', v_cfx->>'fx_currency', 'fx_amount', v_intfx) end)) else '[]'::jsonb end
          || jsonb_build_array(public.fin_fx_line(m.id, null, v_ldesc, 0, v_amt, v_mfx));
    end case;
    v_jid := public.fin_system_journal(e.id, v_date, left(v_desc, 300), v_ref, 'manual', null, v_lines);
  end if;

  if v_fx is not null then
    insert into public.fin_money_fx (journal_id, entity_id, currency, native_amount, base_amount, rate, rate_source)
      values (v_jid, e.id, v_ccy, v_fx, v_amt, round(v_fx / v_amt, 8), v_src) on conflict (journal_id) do nothing;
  end if;

  if v_row.id is not null then
    perform set_config('app.fin_money_posting', 'on', true);
    update public.fin_import_rows set status = 'posted', journal_id = v_jid, partner_txn_id = v_ptx, posted_at = now(), posted_by = (select auth.uid()),
      kind = v_kind, account_id = m.id, category_account_id = c.id, party_id = v_party, for_entity_id = nullif(p->>'for_entity_id', '')::uuid,
      business_account_id = ba.id, interest = nullif(v_int, 0), txn_date = v_date, description = left(v_desc, 300), merchant = left(v_merchant, 120),
      base_amount = v_amt, rate_source = case when v_fx is not null then v_src end
     where id = v_row.id;
    perform set_config('app.fin_money_posting', 'off', true);
  end if;
  return jsonb_build_object('journal_id', v_jid, 'partner_txn_id', v_ptx);
end $$;

-- a journal line, signed foreign amount added when given: positive with a debit, negative with a credit
create or replace function public.fin_fx_line(p_acc uuid, p_party uuid, p_desc text, p_dr numeric, p_cr numeric, p_fx jsonb) returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('account_id', p_acc, 'party_id', p_party, 'description', p_desc, 'debit', p_dr, 'credit', p_cr)
    || case when p_fx is null or p_fx->>'fx_currency' is null then '{}'::jsonb
            else jsonb_build_object('fx_currency', p_fx->>'fx_currency', 'fx_amount', case when p_dr > 0 then abs((p_fx->>'fx_amount')::numeric) else -abs((p_fx->>'fx_amount')::numeric) end) end $$;

-- link a business to these personal books in one step (owner of both); uses the business's existing partner account
create or replace function public.fin_money_link_business(p_personal uuid, p_business uuid, p_partner_name text) returns uuid language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  if not public.is_fin_owner(p_personal) or not public.is_fin_owner(p_business) then raise exception 'forbidden: you need to own both sets of books to link them'; end if;
  if (select kind from public.fin_entities where id = p_personal) <> 'personal' then raise exception 'bad_books: link a business to personal books'; end if;
  select id into v from public.fin_partner_links where entity_id = p_business and mirror_entity_id = p_personal;
  if v is not null then return v; end if;
  return public.fin_partner_link_create(p_business, coalesce(nullif(trim(p_partner_name), ''), 'Owner'), p_personal);
end $$;

-- ===================================================================== grants
revoke execute on function public.fin_accounts_currency_guard(), public.fin_lines_fx_guard() from public, anon, authenticated;
revoke execute on function public.fin_fx_line(uuid, uuid, text, numeric, numeric, jsonb) from public, anon, authenticated;
revoke execute on function public.fin_money_link_business(uuid, uuid, text) from public, anon;
grant execute on function public.fin_money_link_business(uuid, uuid, text) to authenticated;
grant select on public.fin_money_fx to authenticated;
