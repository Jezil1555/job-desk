-- Increment 8: foreign-currency invoices, bills and payments; realised and unrealised exchange differences.
-- The ledger stays in each book's base currency. Foreign documents carry their currency and the rate used; ledger lines carry the foreign amount
-- (fin_lines.fx_currency / fx_amount). Base-currency documents post exactly as before (rate 1).
insert into private.migration_snapshots (migration, object, definition) values
  ('20261031020000', 'public.fin_reverse_journal(uuid,text,date)', pg_get_functiondef('public.fin_reverse_journal(uuid,text,date)'::regprocedure)),
  ('20261031020000', 'public.fin_system_journal(uuid,date,text,text,text,uuid,jsonb,uuid)', pg_get_functiondef('public.fin_system_journal(uuid,date,text,text,text,uuid,jsonb,uuid)'::regprocedure)),
  ('20261031020000', 'public.fin_post_invoice(uuid)', pg_get_functiondef('public.fin_post_invoice(uuid)'::regprocedure)),
  ('20261031020000', 'public.fin_reminders()', pg_get_functiondef('public.fin_reminders()'::regprocedure))
on conflict do nothing;

alter table public.fin_journals drop constraint fin_journals_source_check;
alter table public.fin_journals add constraint fin_journals_source_check check (source in ('manual','opening','invoice','bill','payment','reversal','stock','partner','intercompany','receipt','production','revaluation'));
alter table public.fin_accounts drop constraint fin_accounts_system_key_check;
alter table public.fin_accounts add constraint fin_accounts_system_key_check check (system_key in ('cash','bank','ar','ap','inventory','cogs','sales','capital','drawings','retained','opening','intercompany','wip','grni','fx'));

-- ---------------------------------------------------------------- document currency
alter table public.fin_invoices
  add column currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  add column fx_rate numeric(18,8) check (fx_rate is null or fx_rate > 0);
comment on column public.fin_invoices.currency is 'Document currency; null = the books'' base currency. Line prices are in this currency.';
comment on column public.fin_invoices.fx_rate is 'Base currency per 1 unit of the document currency, used when posting.';
alter table public.fin_payments
  add column currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  add column fx_rate numeric(18,8) check (fx_rate is null or fx_rate > 0),
  add column base_amount numeric(16,2) check (base_amount is null or base_amount > 0),
  add column fx_gain numeric(16,2);
comment on column public.fin_payments.amount is 'In the payment currency (base unless currency is set).';
comment on column public.fin_payments.base_amount is 'For a foreign-currency payment: what actually went in or out of the bank, in base currency.';
comment on column public.fin_payments.fx_gain is 'Realised exchange gain (+) or loss (−) posted with this payment, in base currency.';

create or replace function public.fin_invoices_fx_guard() returns trigger language plpgsql set search_path = '' as $$
declare v_base text;
begin
  if tg_op = 'UPDATE' and old.status <> 'draft' and (new.currency, new.fx_rate) is distinct from (old.currency, old.fx_rate) then
    raise exception 'posted_immutable: the currency and rate of a posted invoice can''t change — void it and raise a new one';
  end if;
  select base_currency into v_base from public.fin_entities where id = new.entity_id;
  if new.currency = v_base then new.currency := null; end if;
  if new.currency is null then new.fx_rate := null; end if;
  return new;
end $$;
create trigger fin_invoices_fx_guard before insert or update on public.fin_invoices for each row execute function public.fin_invoices_fx_guard();

-- a payment only settles invoices in its own currency
create or replace function public.fin_allocations_fx_guard() returns trigger language plpgsql set search_path = '' as $$
declare v_pc text; v_ic text;
begin
  select currency into v_pc from public.fin_payments where id = new.payment_id;
  select currency into v_ic from public.fin_invoices where id = new.invoice_id;
  if v_pc is distinct from v_ic then
    raise exception 'currency_mismatch: a % payment can''t settle a % invoice — record the payment in the invoice''s currency', coalesce(v_pc, 'base-currency'), coalesce(v_ic, 'base-currency');
  end if;
  return new;
end $$;
create trigger fin_allocations_fx_guard before insert on public.fin_allocations for each row execute function public.fin_allocations_fx_guard();

-- ---------------------------------------------------------------- exchange account
create or replace function public.fin_fx_account(p_entity uuid) returns uuid language plpgsql security definer set search_path = '' as $$
declare v uuid; v_code text := '4900';
begin
  select id into v from public.fin_accounts where entity_id = p_entity and system_key = 'fx';
  if v is not null then return v; end if;
  while exists (select 1 from public.fin_accounts where entity_id = p_entity and code = v_code) loop v_code := (v_code::int + 1)::text; end loop;
  insert into public.fin_accounts (entity_id, code, name, type, subtype, system_key, description)
    values (p_entity, v_code, 'Exchange gains and losses', 'income', 'other', 'fx', 'Realised and unrealised differences on foreign-currency invoices, bills and payments (a loss shows as negative income)')
    returning id into v;
  return v;
end $$;

-- ---------------------------------------------------------------- system journal: carry the foreign amount on lines
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
    insert into public.fin_lines (journal_id, entity_id, account_id, party_id, description, debit, credit, fx_currency, fx_amount, sort)
      values (v_id, e, (l->>'account_id')::uuid, nullif(l->>'party_id','')::uuid, l->>'description', coalesce((l->>'debit')::numeric,0), coalesce((l->>'credit')::numeric,0),
              nullif(l->>'fx_currency',''), (l->>'fx_amount')::numeric, i);
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
  if j.source in ('invoice','bill','payment','stock','partner','intercompany','receipt','production','revaluation') and coalesce(current_setting('app.fin_doc_void', true), '') <> 'on' then
    raise exception 'use_document: void or reverse the document (invoice, bill, payment, partner, inter-entity, goods receipt, production cost or revaluation) instead of its entry';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required: give a reason for the reversal'; end if;
  select jsonb_agg(jsonb_build_object('account_id', account_id, 'party_id', party_id, 'description', description, 'debit', credit, 'credit', debit,
                   'fx_currency', fx_currency, 'fx_amount', -fx_amount) order by sort) into v_lines
    from public.fin_lines where journal_id = p_journal;
  v_new := public.fin_system_journal(j.entity_id, coalesce(p_date, j.entry_date), 'Reversal of #' || j.number || ': ' || p_reason, j.reference, 'reversal', j.id, v_lines, j.id);
  perform set_config('app.fin_posting', 'on', true);
  update public.fin_journals set reversed_by = v_new, reversal_reason = p_reason where id = p_journal;
  perform set_config('app.fin_posting', 'off', true);
  return v_new;
end $$;

-- ---------------------------------------------------------------- posting invoices: convert to base at the document rate
create or replace function public.fin_post_invoice(p_invoice uuid) returns text language plpgsql security definer set search_path = '' as $$
declare inv public.fin_invoices; l record; it public.fin_items; v_lines jsonb := '[]'::jsonb; v_total numeric := 0; v_ctrl uuid; v_acc uuid;
  v_no text; v_jid uuid; v_cost numeric; v_onhand numeric; v_cogs numeric; v_inv_acc uuid; v_cogs_acc uuid; v_moves jsonb := '[]'::jsonb; m jsonb;
  v_rate numeric := 1; v_amt numeric; v_doc_total numeric := 0; v_ccy text;
begin
  select * into inv from public.fin_invoices where id = p_invoice for update;
  if not found then raise exception 'not_found: invoice not found'; end if;
  if not public.can_write_fin(inv.entity_id) then raise exception 'forbidden: only owners and bookkeepers can post'; end if;
  if inv.status <> 'draft' then raise exception 'already_posted: this invoice is already posted'; end if;
  if inv.party_id is null then raise exception 'party_required: choose the %', case inv.kind when 'sale' then 'customer' else 'supplier' end; end if;
  if inv.currency is not null then
    if inv.fx_rate is null then raise exception 'rate_required: enter the exchange rate for % (how much base currency 1 % is worth on the invoice date)', inv.currency, inv.currency; end if;
    v_rate := inv.fx_rate; v_ccy := inv.currency;
  end if;
  perform public.fin_check_open(inv.entity_id, inv.issue_date);
  v_ctrl := public.fin_sys_account(inv.entity_id, case inv.kind when 'sale' then 'ar' else 'ap' end);
  if v_ctrl is null then raise exception 'missing_account: no % control account in these books', case inv.kind when 'sale' then 'receivable' else 'payable' end; end if;
  for l in select * from public.fin_invoice_lines where invoice_id = p_invoice order by sort loop
    it := null; v_inv_acc := null; v_cogs_acc := null;
    v_amt := round(l.amount * v_rate, 2);
    v_total := v_total + v_amt; v_doc_total := v_doc_total + l.amount;
    if l.item_id is not null then
      select * into it from public.fin_items where id = l.item_id;
      v_inv_acc := coalesce(it.inventory_account_id, public.fin_sys_account(inv.entity_id, 'inventory'));
      v_cogs_acc := coalesce(it.cogs_account_id, public.fin_sys_account(inv.entity_id, 'cogs'));
      if v_inv_acc is null then raise exception 'missing_account: no inventory account in these books'; end if;
    end if;
    if inv.kind = 'sale' then
      v_acc := coalesce(l.account_id, it.income_account_id, public.fin_sys_account(inv.entity_id, 'sales'));
      if v_acc is null then raise exception 'missing_account: choose an income account for "%"', l.description; end if;
      v_lines := v_lines || jsonb_build_object('account_id', v_acc, 'description', l.description, 'debit', 0, 'credit', v_amt, 'fx_currency', v_ccy, 'fx_amount', case when v_ccy is not null then -l.amount end);
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
      v_lines := v_lines || jsonb_build_object('account_id', v_acc, 'description', l.description, 'debit', v_amt, 'credit', 0, 'fx_currency', v_ccy, 'fx_amount', case when v_ccy is not null then l.amount end);
      if l.item_id is not null then
        v_moves := v_moves || jsonb_build_object('item_id', l.item_id, 'qty', l.qty, 'unit_cost', round(l.unit_price * v_rate, 4), 'source', 'purchase');
      end if;
    end if;
  end loop;
  if v_total <= 0 then raise exception 'zero_invoice: add at least one line with an amount'; end if;
  v_lines := v_lines || jsonb_build_object('account_id', v_ctrl, 'party_id', inv.party_id, 'description', case inv.kind when 'sale' then 'Invoice total' else 'Bill total' end,
    'debit', case inv.kind when 'sale' then v_total else 0 end, 'credit', case inv.kind when 'sale' then 0 else v_total end,
    'fx_currency', v_ccy, 'fx_amount', case when v_ccy is null then null when inv.kind = 'sale' then v_doc_total else -v_doc_total end);
  perform set_config('app.fin_posting', 'on', true);
  if inv.number is null then
    if inv.kind = 'sale' then update public.fin_entities set next_invoice_no = next_invoice_no + 1 where id = inv.entity_id returning 'INV-' || lpad((next_invoice_no - 1)::text, 4, '0') into v_no;
    else update public.fin_entities set next_bill_no = next_bill_no + 1 where id = inv.entity_id returning 'BILL-' || lpad((next_bill_no - 1)::text, 4, '0') into v_no; end if;
  else v_no := inv.number; end if;
  v_jid := public.fin_system_journal(inv.entity_id, inv.issue_date, case inv.kind when 'sale' then 'Invoice ' else 'Bill ' end || v_no || coalesce(' (' || v_ccy || ' ' || to_char(v_doc_total, 'FM999,999,990.00') || ' @ ' || v_rate::text || ')', ''),
    coalesce(inv.party_reference, v_no), case inv.kind when 'sale' then 'invoice' else 'bill' end, inv.id, v_lines);
  perform set_config('app.fin_posting', 'on', true);
  for m in select * from jsonb_array_elements(v_moves) loop
    insert into public.fin_stock_moves (entity_id, item_id, move_date, qty, unit_cost, source, invoice_id, journal_id)
      values (inv.entity_id, (m->>'item_id')::uuid, inv.issue_date, (m->>'qty')::numeric, (m->>'unit_cost')::numeric, m->>'source', inv.id, v_jid);
  end loop;
  update public.fin_invoices set status = 'posted', number = v_no, journal_id = v_jid, posted_at = now() where id = p_invoice;
  perform set_config('app.fin_posting', 'off', true);
  return v_no;
end $$;

-- ---------------------------------------------------------------- foreign-currency payments with realised difference
-- p: {entity_id, direction in|out, party_id, pay_date, currency, amount (foreign), base_amount (what hit the bank), account_id, reference, memo,
--     allocations: [{invoice_id, amount (foreign)}]}
create or replace function public.fin_record_fx_payment(p jsonb) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_e uuid := (p->>'entity_id')::uuid; v_dir text := p->>'direction'; v_party uuid := nullif(p->>'party_id','')::uuid; v_date date := coalesce((p->>'pay_date')::date, current_date);
  v_ccy text := upper(trim(p->>'currency')); v_amt numeric := (p->>'amount')::numeric; v_base numeric := (p->>'base_amount')::numeric;
  v_acc public.fin_accounts; v_ctrl uuid; v_fx uuid; v_pe uuid; a jsonb; inv public.fin_invoices; v_out numeric; v_sum numeric := 0; v_ctrl_base numeric := 0;
  v_rate numeric; v_gain numeric; v_pid uuid; v_jid uuid; v_lines jsonb; v_basecur text;
begin
  if not public.can_write_fin(v_e) then raise exception 'forbidden: only owners and bookkeepers can record payments'; end if;
  if v_dir not in ('in','out') then raise exception 'bad_direction'; end if;
  select base_currency into v_basecur from public.fin_entities where id = v_e;
  if v_ccy is null or v_ccy !~ '^[A-Z]{3}$' then raise exception 'currency_required: choose the payment currency'; end if;
  if v_ccy = v_basecur then raise exception 'base_currency: this is the books'' own currency — use the normal payment form'; end if;
  if v_amt is null or v_amt <= 0 then raise exception 'amount_required: enter the amount in %', v_ccy; end if;
  if v_base is null or v_base <= 0 then raise exception 'base_amount_required: enter what actually % the bank in % (from the bank advice) — no rate is assumed', case v_dir when 'in' then 'reached' else 'left' end, v_basecur; end if;
  if v_party is null then raise exception 'party_required: choose the customer or supplier'; end if;
  select entity_id into v_pe from public.fin_parties where id = v_party; if v_pe is distinct from v_e then raise exception 'party_other_entity'; end if;
  select * into v_acc from public.fin_accounts where id = (p->>'account_id')::uuid;
  if v_acc.entity_id is distinct from v_e or v_acc.subtype not in ('cash','bank','card') then raise exception 'bad_account: pay from or into a cash, bank or card account'; end if;
  v_rate := round(v_base / v_amt, 8);
  v_ctrl := public.fin_sys_account(v_e, case v_dir when 'in' then 'ar' else 'ap' end);
  for a in select * from jsonb_array_elements(coalesce(p->'allocations', '[]'::jsonb)) loop
    if coalesce((a->>'amount')::numeric, 0) <= 0 then continue; end if;
    select * into inv from public.fin_invoices where id = (a->>'invoice_id')::uuid for update;
    if inv.entity_id is distinct from v_e or inv.status <> 'posted' then raise exception 'bad_invoice: only posted invoices in these books can be paid'; end if;
    if inv.kind <> (case v_dir when 'in' then 'sale' else 'purchase' end) then raise exception 'wrong_kind: money in settles invoices; money out settles bills'; end if;
    if inv.party_id is distinct from v_party then raise exception 'wrong_party: the invoice belongs to a different customer/supplier'; end if;
    if inv.currency is distinct from v_ccy then raise exception 'currency_mismatch: % is in %, not %', inv.number, coalesce(inv.currency, v_basecur), v_ccy; end if;
    select total - paid into v_out from public.fin_invoice_totals where invoice_id = inv.id;
    if (a->>'amount')::numeric > v_out then raise exception 'overpayment: % is more than the % outstanding on %', (a->>'amount'), v_out, inv.number; end if;
    v_sum := v_sum + (a->>'amount')::numeric;
    v_ctrl_base := v_ctrl_base + round((a->>'amount')::numeric * inv.fx_rate, 2);   -- clears the invoice at the rate it was booked at
  end loop;
  if v_sum > v_amt then raise exception 'allocation_exceeds_payment: allocations add up to more than the payment'; end if;
  v_ctrl_base := v_ctrl_base + round((v_amt - v_sum) * v_rate, 2);                       -- any unallocated part sits on account at today's rate
  v_gain := case v_dir when 'in' then v_base - v_ctrl_base else v_ctrl_base - v_base end;
  insert into public.fin_payments (entity_id, direction, party_id, pay_date, amount, account_id, reference, memo, currency, fx_rate, base_amount, fx_gain)
    values (v_e, v_dir, v_party, v_date, v_amt, v_acc.id, nullif(trim(p->>'reference'),''), nullif(trim(p->>'memo'),''), v_ccy, v_rate, v_base, v_gain) returning id into v_pid;
  v_lines := jsonb_build_array(
    jsonb_build_object('account_id', v_acc.id, 'description', coalesce(nullif(trim(p->>'memo'),''), 'Payment') || ' (' || v_ccy || ' ' || to_char(v_amt, 'FM999,999,990.00') || ')',
      'debit', case v_dir when 'in' then v_base else 0 end, 'credit', case v_dir when 'in' then 0 else v_base end),
    jsonb_build_object('account_id', v_ctrl, 'party_id', v_party, 'description', coalesce(nullif(trim(p->>'memo'),''), 'Payment'),
      'debit', case v_dir when 'in' then 0 else v_ctrl_base end, 'credit', case v_dir when 'in' then v_ctrl_base else 0 end,
      'fx_currency', v_ccy, 'fx_amount', case v_dir when 'in' then -v_amt else v_amt end));
  if v_gain <> 0 then
    v_fx := public.fin_fx_account(v_e);
    v_lines := v_lines || jsonb_build_object('account_id', v_fx, 'description', 'Realised exchange ' || case when v_gain > 0 then 'gain' else 'loss' end || ' (' || v_ccy || ')',
      'debit', case when v_gain < 0 then -v_gain else 0 end, 'credit', case when v_gain > 0 then v_gain else 0 end);
  end if;
  v_jid := public.fin_system_journal(v_e, v_date, case v_dir when 'in' then 'Payment received' else 'Payment made' end || ' ' || v_ccy || ' ' || to_char(v_amt, 'FM999,999,990.00')
    || coalesce(' — ' || nullif(trim(p->>'reference'),''), ''), nullif(trim(p->>'reference'),''), 'payment', v_pid, v_lines);
  update public.fin_payments set journal_id = v_jid where id = v_pid;
  for a in select * from jsonb_array_elements(coalesce(p->'allocations', '[]'::jsonb)) loop
    if coalesce((a->>'amount')::numeric, 0) > 0 then insert into public.fin_allocations (payment_id, invoice_id, entity_id, amount) values (v_pid, (a->>'invoice_id')::uuid, v_e, (a->>'amount')::numeric); end if;
  end loop;
  return v_pid;
end $$;

-- ---------------------------------------------------------------- month-end revaluation (unrealised, reversed the next day)
create table public.fin_fx_revaluations (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.fin_entities(id) on delete cascade,
  rev_date date not null,
  rates jsonb not null,
  detail jsonb not null,
  net numeric(16,2) not null,
  journal_id uuid references public.fin_journals(id),
  reversal_journal_id uuid references public.fin_journals(id),
  status text not null default 'posted' check (status in ('posted','cancelled')),
  cancel_reason text,
  cancel_journal_ids uuid[],
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now()
);
create unique index fin_fx_revaluations_one_per_day on public.fin_fx_revaluations (entity_id, rev_date) where status = 'posted';
alter table public.fin_fx_revaluations enable row level security;
create policy "fx revaluations: members read" on public.fin_fx_revaluations for select to authenticated using (public.is_fin_member(entity_id));
create trigger fin_fx_revaluations_audit after insert or update on public.fin_fx_revaluations for each row execute function public.fin_audit_trg();

-- what would be revalued, without posting (used for the preview)
create or replace function public.fin_fx_open_items(p_entity uuid, p_date date) returns table (invoice_id uuid, number text, kind text, party_id uuid, currency text, outstanding numeric, booked_rate numeric, booked_base numeric)
language sql stable security definer set search_path = '' as $$
  select i.id, i.number, i.kind, i.party_id, i.currency, t.total - coalesce((select sum(a.amount) from public.fin_allocations a join public.fin_payments py on py.id = a.payment_id
           where a.invoice_id = i.id and py.status = 'posted' and py.pay_date <= p_date), 0), i.fx_rate,
         round((t.total - coalesce((select sum(a.amount) from public.fin_allocations a join public.fin_payments py on py.id = a.payment_id
           where a.invoice_id = i.id and py.status = 'posted' and py.pay_date <= p_date), 0)) * i.fx_rate, 2)
  from public.fin_invoices i join public.fin_invoice_totals t on t.invoice_id = i.id
  where public.is_fin_member(p_entity) and i.entity_id = p_entity and i.status = 'posted' and i.currency is not null and i.issue_date <= p_date
    and t.total - coalesce((select sum(a.amount) from public.fin_allocations a join public.fin_payments py on py.id = a.payment_id
           where a.invoice_id = i.id and py.status = 'posted' and py.pay_date <= p_date), 0) > 0
  order by i.currency, i.issue_date;
$$;

create or replace function public.fin_fx_revalue(p_entity uuid, p_date date, p_rates jsonb) returns uuid language plpgsql security definer set search_path = '' as $$
declare r record; v_rate numeric; v_new numeric; v_diff numeric; v_lines jsonb := '[]'::jsonb; v_detail jsonb := '[]'::jsonb; v_net numeric := 0;
  v_fx uuid; v_ar uuid; v_ap uuid; v_id uuid := gen_random_uuid(); v_jid uuid; v_rid uuid; v_missing text[];
begin
  if not public.can_write_fin(p_entity) then raise exception 'forbidden: only owners and bookkeepers can revalue'; end if;
  if p_date is null then raise exception 'date_required'; end if;
  if exists (select 1 from public.fin_fx_revaluations where entity_id = p_entity and rev_date = p_date and status = 'posted') then
    raise exception 'already_revalued: these books were already revalued on % — cancel that one first', to_char(p_date, 'DD Mon YYYY');
  end if;
  select array_agg(distinct x.currency) into v_missing from public.fin_fx_open_items(p_entity, p_date) x
    where coalesce((p_rates->>x.currency)::numeric, 0) <= 0;
  if v_missing is not null then raise exception 'rate_required: enter the closing rate for %', array_to_string(v_missing, ', '); end if;
  v_ar := public.fin_sys_account(p_entity, 'ar'); v_ap := public.fin_sys_account(p_entity, 'ap');
  for r in select * from public.fin_fx_open_items(p_entity, p_date) loop
    v_rate := (p_rates->>r.currency)::numeric;
    v_new := round(r.outstanding * v_rate, 2);
    v_diff := v_new - r.booked_base;                                          -- change in the base value of the open item
    v_detail := v_detail || jsonb_build_object('invoice_id', r.invoice_id, 'number', r.number, 'currency', r.currency, 'outstanding', r.outstanding,
      'booked_rate', r.booked_rate, 'closing_rate', v_rate, 'booked_base', r.booked_base, 'revalued_base', v_new,
      'gain', case r.kind when 'sale' then v_diff else -v_diff end);
    if v_diff = 0 then continue; end if;
    v_net := v_net + case r.kind when 'sale' then v_diff else -v_diff end;
    v_lines := v_lines || jsonb_build_object('account_id', case r.kind when 'sale' then v_ar else v_ap end, 'party_id', r.party_id,
      'description', 'Revalue ' || r.number || ' ' || r.currency || ' ' || to_char(r.outstanding, 'FM999,999,990.00') || ' @ ' || v_rate::text,
      'debit', case when v_diff > 0 then v_diff else 0 end, 'credit', case when v_diff < 0 then -v_diff else 0 end);
  end loop;
  if v_net = 0 and jsonb_array_length(v_lines) = 0 then raise exception 'nothing_to_revalue: no open foreign-currency invoices or bills differ at these rates'; end if;
  if v_net <> 0 then
    v_fx := public.fin_fx_account(p_entity);
    v_lines := v_lines || jsonb_build_object('account_id', v_fx, 'description', 'Unrealised exchange ' || case when v_net > 0 then 'gain' else 'loss' end,
      'debit', case when v_net < 0 then -v_net else 0 end, 'credit', case when v_net > 0 then v_net else 0 end);
  end if;
  v_jid := public.fin_system_journal(p_entity, p_date, 'Foreign-currency revaluation at ' || to_char(p_date, 'DD Mon YYYY'), 'FX-REVAL', 'revaluation', v_id, v_lines);
  perform set_config('app.fin_doc_void', 'on', true);
  v_rid := public.fin_reverse_journal(v_jid, 'automatic reversal of the month-end revaluation', p_date + 1);
  perform set_config('app.fin_doc_void', 'off', true);
  insert into public.fin_fx_revaluations (id, entity_id, rev_date, rates, detail, net, journal_id, reversal_journal_id)
    values (v_id, p_entity, p_date, p_rates, v_detail, v_net, v_jid, v_rid);
  return v_id;
end $$;

-- cancelling posts the opposite of both entries (the originals stay on record)
create or replace function public.fin_fx_revaluation_cancel(p_id uuid, p_reason text) returns void language plpgsql security definer set search_path = '' as $$
declare v public.fin_fx_revaluations; v_a uuid; v_b uuid; j public.fin_journals;
  opp text := $q$select jsonb_agg(jsonb_build_object('account_id', account_id, 'party_id', party_id, 'description', 'Cancel: ' || coalesce(description, ''), 'debit', credit, 'credit', debit) order by sort) from public.fin_lines where journal_id = $1$q$;
  v_lines jsonb;
begin
  select * into v from public.fin_fx_revaluations where id = p_id for update;
  if not found then raise exception 'not_found'; end if;
  if not public.can_write_fin(v.entity_id) then raise exception 'forbidden'; end if;
  if v.status <> 'posted' then raise exception 'already_cancelled'; end if;
  if char_length(coalesce(trim(p_reason), '')) < 3 then raise exception 'reason_required: give a reason'; end if;
  execute opp into v_lines using v.journal_id;
  select * into j from public.fin_journals where id = v.journal_id;
  v_a := public.fin_system_journal(v.entity_id, v.rev_date, 'Cancel revaluation #' || j.number || ': ' || trim(p_reason), 'FX-REVAL', 'revaluation', v.id, v_lines);
  execute opp into v_lines using v.reversal_journal_id;
  select * into j from public.fin_journals where id = v.reversal_journal_id;
  v_b := public.fin_system_journal(v.entity_id, j.entry_date, 'Cancel reversal #' || j.number || ': ' || trim(p_reason), 'FX-REVAL', 'revaluation', v.id, v_lines);
  update public.fin_fx_revaluations set status = 'cancelled', cancel_reason = trim(p_reason), cancel_journal_ids = array[v_a, v_b] where id = p_id;
end $$;

-- reminders: show the invoice's own currency
create or replace function public.fin_reminders() returns jsonb language plpgsql security definer set search_path = '' as $$
declare r record; v_today date; n_due int := 0; n_over int := 0;
begin
  for r in
    select i.*, e.name as ename, coalesce(i.currency, e.base_currency) as ccy, t.total - t.paid as outstanding, (now() at time zone 'Asia/Qatar')::date as today
    from public.fin_invoices i join public.fin_entities e on e.id = i.entity_id join public.fin_invoice_totals t on t.invoice_id = i.id
    where i.status = 'posted' and i.due_date is not null and t.total - t.paid > 0 and not e.archived
    for update of i skip locked
  loop
    v_today := r.today;
    if r.kind = 'purchase' and r.due_date between v_today and v_today + 3 and r.due_reminded_for is distinct from r.due_date then
      insert into public.notifications (user_id, kind, title, body, url)
        select m.user_id, 'bill_due', 'Bill due ' || case when r.due_date = v_today then 'today' else to_char(r.due_date, 'Dy DD Mon') end || ': ' || coalesce(r.number, ''),
               r.ename || ' · ' || r.ccy || ' ' || to_char(r.outstanding, 'FM999,999,990.00') || ' outstanding', '/#/finance/' || r.entity_id || '/bills'
        from public.fin_members m where m.entity_id = r.entity_id and m.role in ('owner','bookkeeper');
      update public.fin_invoices set due_reminded_for = r.due_date where id = r.id; n_due := n_due + 1;
    elsif r.due_date < v_today and r.overdue_reminded_for is distinct from r.due_date then
      insert into public.notifications (user_id, kind, title, body, url)
        select m.user_id, case r.kind when 'purchase' then 'bill_overdue' else 'invoice_overdue' end,
               case r.kind when 'purchase' then 'Overdue bill: ' else 'Customer invoice overdue: ' end || coalesce(r.number, ''),
               r.ename || ' · ' || r.ccy || ' ' || to_char(r.outstanding, 'FM999,999,990.00') || ' · due ' || to_char(r.due_date, 'DD Mon'),
               '/#/finance/' || r.entity_id || case r.kind when 'purchase' then '/bills' else '/invoices' end
        from public.fin_members m where m.entity_id = r.entity_id and m.role in ('owner','bookkeeper');
      update public.fin_invoices set overdue_reminded_for = r.due_date where id = r.id; n_over := n_over + 1;
    end if;
  end loop;
  return jsonb_build_object('due', n_due, 'overdue', n_over);
end $$;
revoke execute on function public.fin_reminders() from public, anon, authenticated;

revoke execute on function public.fin_fx_account(uuid), public.fin_invoices_fx_guard(), public.fin_allocations_fx_guard() from public, anon, authenticated;
revoke execute on function public.fin_record_fx_payment(jsonb), public.fin_fx_open_items(uuid, date), public.fin_fx_revalue(uuid, date, jsonb), public.fin_fx_revaluation_cancel(uuid, text) from public, anon;
grant execute on function public.fin_record_fx_payment(jsonb), public.fin_fx_open_items(uuid, date), public.fin_fx_revalue(uuid, date, jsonb), public.fin_fx_revaluation_cancel(uuid, text) to authenticated;
