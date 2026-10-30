-- Increment 7: production costing for made-to-order work (Dlusso). Separates fabric purchase (bill), fabric receipt (goods received),
-- inventory, consumption into work in progress, finished-order cost and supplier payment. Every stock movement stays in the auditable
-- stock ledger; negative stock is refused unless the owner authorises an exception with a reason, which is recorded.
insert into private.migration_snapshots (migration, object, definition) values
  ('20261031010000', 'public.fin_reverse_journal(uuid,text,date)', pg_get_functiondef('public.fin_reverse_journal(uuid,text,date)'::regprocedure)) on conflict do nothing;

alter table public.fin_journals drop constraint fin_journals_source_check;
alter table public.fin_journals add constraint fin_journals_source_check check (source in ('manual','opening','invoice','bill','payment','reversal','stock','partner','intercompany','receipt','production'));
alter table public.fin_accounts drop constraint fin_accounts_system_key_check;
alter table public.fin_accounts add constraint fin_accounts_system_key_check check (system_key in ('cash','bank','ar','ap','inventory','cogs','sales','capital','drawings','retained','opening','intercompany','wip','grni'));
alter table public.fin_stock_moves drop constraint fin_stock_moves_source_check;
alter table public.fin_stock_moves add constraint fin_stock_moves_source_check check (source in ('purchase','sale','void','adjustment','opening','receipt','production'));

create or replace function public.fin_reverse_journal(p_journal uuid, p_reason text, p_date date default null) returns uuid language plpgsql security definer set search_path = '' as $$
declare j public.fin_journals; v_new uuid; v_lines jsonb;
begin
  select * into j from public.fin_journals where id = p_journal for update;
  if not found then raise exception 'not_found: entry not found'; end if;
  if not public.can_write_fin(j.entity_id) then raise exception 'forbidden: only owners and bookkeepers can reverse'; end if;
  if j.status <> 'posted' then raise exception 'not_posted: only posted entries can be reversed — delete the draft instead'; end if;
  if j.reversed_by is not null then raise exception 'already_reversed: this entry was already reversed'; end if;
  if j.reversal_of is not null then raise exception 'is_reversal: a reversal can''t itself be reversed — post a new entry'; end if;
  if j.source in ('invoice','bill','payment','stock','partner','intercompany','receipt','production') and coalesce(current_setting('app.fin_doc_void', true), '') <> 'on' then
    raise exception 'use_document: void or reverse the document (invoice, bill, payment, partner, inter-entity, goods receipt or production cost) instead of its entry';
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

create table public.fin_production_orders (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.fin_entities(id) on delete cascade,
  order_no text not null,
  title text not null check (char_length(title) between 1 and 200),
  party_id uuid references public.fin_parties(id),
  job_ref text,
  status text not null default 'open' check (status in ('open','completed','cancelled')),
  opened_on date not null default current_date,
  completed_on date,
  completion_journal_id uuid references public.fin_journals(id),
  total_cost numeric(16,2),
  invoice_id uuid references public.fin_invoices(id),
  notes text,
  cancel_reason text,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  unique (entity_id, order_no)
);
create table public.fin_stock_exceptions (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.fin_entities(id) on delete cascade,
  item_id uuid not null references public.fin_items(id),
  qty_short numeric(14,3) not null,
  reason text not null check (char_length(reason) >= 3),
  authorised_by uuid not null references auth.users(id),
  authorised_at timestamptz not null default now()
);
create table public.fin_production_costs (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.fin_production_orders(id) on delete cascade,
  entity_id uuid not null references public.fin_entities(id) on delete cascade,
  kind text not null check (kind in ('material','other')),
  cost_date date not null,
  item_id uuid references public.fin_items(id),
  qty numeric(14,3),
  unit_cost numeric(16,4),
  amount numeric(16,2) not null check (amount > 0),
  source_account_id uuid references public.fin_accounts(id),   -- for 'other': where the cost comes from (expense to reclassify, bank, payable)
  note text,
  journal_id uuid references public.fin_journals(id),
  stock_move_id uuid references public.fin_stock_moves(id),
  exception_id uuid references public.fin_stock_exceptions(id),
  status text not null default 'posted' check (status in ('posted','reversed')),
  reversal_journal_id uuid references public.fin_journals(id),
  reversal_reason text,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  constraint material_has_item check (kind <> 'material' or (item_id is not null and qty > 0))
);
create index on public.fin_production_costs (order_id);
create table public.fin_goods_receipts (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.fin_entities(id) on delete cascade,
  receipt_no text not null,
  item_id uuid not null references public.fin_items(id),
  party_id uuid references public.fin_parties(id),
  receipt_date date not null,
  qty numeric(14,3) not null check (qty > 0),
  unit_cost numeric(16,4) not null check (unit_cost >= 0),
  reference text,
  journal_id uuid references public.fin_journals(id),
  stock_move_id uuid references public.fin_stock_moves(id),
  status text not null default 'posted' check (status in ('posted','reversed')),
  reversal_journal_id uuid references public.fin_journals(id),
  reversal_reason text,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  unique (entity_id, receipt_no)
);
alter table public.fin_stock_moves add column production_order_id uuid references public.fin_production_orders(id), add column exception_id uuid references public.fin_stock_exceptions(id);

alter table public.fin_production_orders enable row level security;
alter table public.fin_production_costs enable row level security;
alter table public.fin_goods_receipts enable row level security;
alter table public.fin_stock_exceptions enable row level security;
create policy "production orders: members read" on public.fin_production_orders for select to authenticated using (public.is_fin_member(entity_id));
create policy "production orders: writers edit notes" on public.fin_production_orders for update to authenticated using (public.can_write_fin(entity_id)) with check (public.can_write_fin(entity_id));
create policy "production costs: members read" on public.fin_production_costs for select to authenticated using (public.is_fin_member(entity_id));
create policy "goods receipts: members read" on public.fin_goods_receipts for select to authenticated using (public.is_fin_member(entity_id));
create policy "stock exceptions: members read" on public.fin_stock_exceptions for select to authenticated using (public.is_fin_member(entity_id));
create trigger fin_production_orders_audit after insert or update on public.fin_production_orders for each row execute function public.fin_audit_trg();
create trigger fin_production_costs_audit after insert or update on public.fin_production_costs for each row execute function public.fin_audit_trg();
create trigger fin_goods_receipts_audit after insert or update on public.fin_goods_receipts for each row execute function public.fin_audit_trg();
create trigger fin_stock_exceptions_audit after insert on public.fin_stock_exceptions for each row execute function public.fin_audit_trg();

-- only notes / invoice link are editable directly; money fields move only through the functions below
create or replace function public.fin_production_orders_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('app.fin_production', true), '') <> 'on' and (new.status, new.total_cost, new.completed_on, new.completion_journal_id, new.order_no, new.entity_id)
     is distinct from (old.status, old.total_cost, old.completed_on, old.completion_journal_id, old.order_no, old.entity_id) then
    raise exception 'use_function: complete or cancel the order with its buttons';
  end if;
  return new;
end $$;
create trigger fin_production_orders_guard before update on public.fin_production_orders for each row execute function public.fin_production_orders_guard();

create or replace function public.fin_sys_account_ensure(p_entity uuid, p_key text) returns uuid language plpgsql security definer set search_path = '' as $$
declare v uuid; v_code text; v_name text; v_type text; v_desc text;
begin
  select id into v from public.fin_accounts where entity_id = p_entity and system_key = p_key;
  if v is not null then return v; end if;
  if p_key = 'wip' then v_code := '1250'; v_name := 'Work in progress'; v_type := 'asset'; v_desc := 'Fabric and costs issued to open production orders';
  elsif p_key = 'grni' then v_code := '2050'; v_name := 'Goods received, not yet billed'; v_type := 'liability'; v_desc := 'Stock received before the supplier''s bill; the bill clears it';
  else raise exception 'bad_key'; end if;
  while exists (select 1 from public.fin_accounts where entity_id = p_entity and code = v_code) loop v_code := (v_code::int + 1)::text; end loop;
  insert into public.fin_accounts (entity_id, code, name, type, subtype, system_key, description) values (p_entity, v_code, v_name, v_type, 'other', p_key, v_desc) returning id into v;
  return v;
end $$;

-- cost to use when stock goes out: average cost, or the last receipt cost when nothing is on hand
create or replace function public.fin_issue_cost(p_item uuid) returns numeric language sql stable security definer set search_path = '' as $$
  select coalesce(nullif((select avg_cost from public.fin_item_avg_cost(p_item)), 0),
                  (select unit_cost from public.fin_stock_moves where item_id = p_item and qty > 0 order by move_date desc, created_at desc limit 1));
$$;

-- ---------- goods received (before the bill) ----------
create or replace function public.fin_goods_receipt(p jsonb) returns uuid language plpgsql security definer set search_path = '' as $$
declare it public.fin_items; v_id uuid := gen_random_uuid(); v_no text; v_inv uuid; v_grni uuid; v_qty numeric := (p->>'qty')::numeric; v_cost numeric := (p->>'unit_cost')::numeric;
  v_date date := coalesce((p->>'receipt_date')::date, current_date); v_val numeric; v_jid uuid; v_mid uuid; v_party uuid := nullif(p->>'party_id','')::uuid;
begin
  select * into it from public.fin_items where id = (p->>'item_id')::uuid;
  if not found then raise exception 'not_found: item not found'; end if;
  if not public.can_write_fin(it.entity_id) then raise exception 'forbidden'; end if;
  if v_qty is null or v_qty <= 0 then raise exception 'qty_required: enter the quantity received'; end if;
  if v_cost is null or v_cost < 0 then raise exception 'cost_required: enter the unit cost from the delivery note or PO'; end if;
  if v_party is not null and (select entity_id from public.fin_parties where id = v_party) is distinct from it.entity_id then raise exception 'bad_party'; end if;
  v_inv := coalesce(it.inventory_account_id, public.fin_sys_account(it.entity_id, 'inventory')); v_grni := public.fin_sys_account_ensure(it.entity_id, 'grni');
  select 'GRN-' || lpad((count(*) + 1)::text, 4, '0') into v_no from public.fin_goods_receipts where entity_id = it.entity_id;
  v_val := round(v_qty * v_cost, 2);
  if v_val > 0 then
    v_jid := public.fin_system_journal(it.entity_id, v_date, left(v_no || ' received: ' || it.name, 300), nullif(trim(p->>'reference'), ''), 'receipt', v_id,
      jsonb_build_array(jsonb_build_object('account_id', v_inv, 'description', it.name || ' × ' || v_qty, 'debit', v_val, 'credit', 0),
                        jsonb_build_object('account_id', v_grni, 'party_id', v_party, 'description', v_no || ' awaiting bill', 'debit', 0, 'credit', v_val)));
  else perform public.fin_check_open(it.entity_id, v_date); end if;
  insert into public.fin_stock_moves (entity_id, item_id, move_date, qty, unit_cost, source, journal_id, note) values (it.entity_id, it.id, v_date, v_qty, v_cost, 'receipt', v_jid, v_no) returning id into v_mid;
  insert into public.fin_goods_receipts (id, entity_id, receipt_no, item_id, party_id, receipt_date, qty, unit_cost, reference, journal_id, stock_move_id)
    values (v_id, it.entity_id, v_no, it.id, v_party, v_date, v_qty, v_cost, nullif(trim(p->>'reference'), ''), v_jid, v_mid);
  return v_id;
end $$;
create or replace function public.fin_goods_receipt_reverse(p_receipt uuid, p_reason text) returns void language plpgsql security definer set search_path = '' as $$
declare g public.fin_goods_receipts; v_onhand numeric; v_r uuid;
begin
  select * into g from public.fin_goods_receipts where id = p_receipt for update;
  if not found then raise exception 'not_found'; end if;
  if not public.can_write_fin(g.entity_id) then raise exception 'forbidden'; end if;
  if g.status <> 'posted' then raise exception 'already_reversed'; end if;
  if char_length(coalesce(trim(p_reason), '')) < 3 then raise exception 'reason_required: give a reason'; end if;
  select on_hand into v_onhand from public.fin_item_avg_cost(g.item_id);
  if v_onhand < g.qty then raise exception 'insufficient_stock: some of this delivery has already been used (% on hand)', v_onhand; end if;
  if g.journal_id is not null then
    perform set_config('app.fin_doc_void', 'on', true);
    v_r := public.fin_reverse_journal(g.journal_id, g.receipt_no || ': ' || trim(p_reason), null);
    perform set_config('app.fin_doc_void', 'off', true);
  end if;
  insert into public.fin_stock_moves (entity_id, item_id, move_date, qty, unit_cost, source, journal_id, note) values (g.entity_id, g.item_id, g.receipt_date, -g.qty, g.unit_cost, 'receipt', v_r, 'Reversed ' || g.receipt_no || ': ' || trim(p_reason));
  update public.fin_goods_receipts set status = 'reversed', reversal_journal_id = v_r, reversal_reason = trim(p_reason) where id = p_receipt;
end $$;

-- ---------- production orders ----------
create or replace function public.fin_production_open(p_entity uuid, p_title text, p_party uuid default null, p_job_ref text default null, p_date date default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_no text;
begin
  if not public.can_write_fin(p_entity) then raise exception 'forbidden'; end if;
  if char_length(coalesce(trim(p_title), '')) = 0 then raise exception 'title_required'; end if;
  if p_party is not null and (select entity_id from public.fin_parties where id = p_party) is distinct from p_entity then raise exception 'bad_party'; end if;
  perform 1 from public.fin_entities where id = p_entity for update;
  select 'JOB-' || lpad((count(*) + 1)::text, 4, '0') into v_no from public.fin_production_orders where entity_id = p_entity;
  insert into public.fin_production_orders (entity_id, order_no, title, party_id, job_ref, opened_on) values (p_entity, v_no, trim(p_title), p_party, nullif(trim(p_job_ref), ''), coalesce(p_date, current_date)) returning id into v_id;
  return v_id;
end $$;

-- issue fabric/material to an order: Inventory → Work in progress at average cost. Short stock needs the owner's authorised reason.
create or replace function public.fin_production_issue(p_order uuid, p_item uuid, p_qty numeric, p_date date default null, p_note text default null, p_authorise_reason text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare o public.fin_production_orders; it public.fin_items; v_onhand numeric; v_cost numeric; v_val numeric; v_inv uuid; v_wip uuid; v_jid uuid; v_mid uuid; v_exc uuid; v_id uuid := gen_random_uuid(); v_date date := coalesce(p_date, current_date);
begin
  select * into o from public.fin_production_orders where id = p_order for update;
  if not found then raise exception 'not_found: order not found'; end if;
  if not public.can_write_fin(o.entity_id) then raise exception 'forbidden'; end if;
  if o.status <> 'open' then raise exception 'order_closed: the order is %', o.status; end if;
  select * into it from public.fin_items where id = p_item;
  if it.entity_id is distinct from o.entity_id then raise exception 'bad_item: choose an item from these books'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'qty_required: enter the quantity used'; end if;
  select on_hand into v_onhand from public.fin_item_avg_cost(p_item);
  v_cost := public.fin_issue_cost(p_item);
  if v_cost is null then raise exception 'cost_unknown: "%" has never been received, so its cost is unknown — record the receipt first', it.name; end if;
  if v_onhand < p_qty then
    if p_authorise_reason is null then raise exception 'insufficient_stock: only % % of "%" in stock', v_onhand, it.unit, it.name; end if;
    if not public.is_fin_owner(o.entity_id) then raise exception 'forbidden: only the owner can authorise using more stock than recorded'; end if;
    if char_length(trim(p_authorise_reason)) < 3 then raise exception 'reason_required: say why stock can go negative'; end if;
    insert into public.fin_stock_exceptions (entity_id, item_id, qty_short, reason, authorised_by) values (o.entity_id, p_item, p_qty - greatest(v_onhand, 0), trim(p_authorise_reason), (select auth.uid())) returning id into v_exc;
  end if;
  v_val := round(p_qty * v_cost, 2);
  if v_val <= 0 then raise exception 'zero_cost: this material has no recorded cost'; end if;
  v_inv := coalesce(it.inventory_account_id, public.fin_sys_account(o.entity_id, 'inventory')); v_wip := public.fin_sys_account_ensure(o.entity_id, 'wip');
  v_jid := public.fin_system_journal(o.entity_id, v_date, left(o.order_no || ' material: ' || it.name || ' × ' || p_qty, 300), o.order_no, 'production', v_id,
    jsonb_build_array(jsonb_build_object('account_id', v_wip, 'description', o.order_no || ' · ' || it.name, 'debit', v_val, 'credit', 0),
                      jsonb_build_object('account_id', v_inv, 'description', o.order_no || ' · ' || it.name, 'debit', 0, 'credit', v_val)));
  insert into public.fin_stock_moves (entity_id, item_id, move_date, qty, unit_cost, source, journal_id, note, production_order_id, exception_id)
    values (o.entity_id, p_item, v_date, -p_qty, v_cost, 'production', v_jid, o.order_no || coalesce(' — ' || nullif(trim(p_note), ''), ''), o.id, v_exc) returning id into v_mid;
  insert into public.fin_production_costs (id, order_id, entity_id, kind, cost_date, item_id, qty, unit_cost, amount, note, journal_id, stock_move_id, exception_id)
    values (v_id, o.id, o.entity_id, 'material', v_date, p_item, p_qty, v_cost, v_val, nullif(trim(p_note), ''), v_jid, v_mid, v_exc);
  return v_id;
end $$;

-- other job costs (stitching, trims, embroidery): Work in progress ← an expense already booked, a payable, or the bank/cash that paid it
create or replace function public.fin_production_add_cost(p_order uuid, p_amount numeric, p_account uuid, p_date date default null, p_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare o public.fin_production_orders; a public.fin_accounts; v_wip uuid; v_jid uuid; v_id uuid := gen_random_uuid(); v_date date := coalesce(p_date, current_date);
begin
  select * into o from public.fin_production_orders where id = p_order for update;
  if not found then raise exception 'not_found'; end if;
  if not public.can_write_fin(o.entity_id) then raise exception 'forbidden'; end if;
  if o.status <> 'open' then raise exception 'order_closed: the order is %', o.status; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'amount_required'; end if;
  if char_length(coalesce(trim(p_note), '')) < 3 then raise exception 'note_required: say what the cost is'; end if;
  select * into a from public.fin_accounts where id = p_account;
  if a.entity_id is distinct from o.entity_id or not a.is_active then raise exception 'bad_account'; end if;
  if a.type in ('income','equity') or a.system_key in ('wip','inventory') then raise exception 'bad_account: take the cost from an expense, payable, bank or cash account'; end if;
  v_wip := public.fin_sys_account_ensure(o.entity_id, 'wip');
  v_jid := public.fin_system_journal(o.entity_id, v_date, left(o.order_no || ' cost: ' || trim(p_note), 300), o.order_no, 'production', v_id,
    jsonb_build_array(jsonb_build_object('account_id', v_wip, 'description', o.order_no || ' · ' || trim(p_note), 'debit', round(p_amount, 2), 'credit', 0),
                      jsonb_build_object('account_id', a.id, 'description', o.order_no || ' · ' || trim(p_note), 'debit', 0, 'credit', round(p_amount, 2))));
  insert into public.fin_production_costs (id, order_id, entity_id, kind, cost_date, amount, source_account_id, note, journal_id)
    values (v_id, o.id, o.entity_id, 'other', v_date, round(p_amount, 2), a.id, trim(p_note), v_jid);
  return v_id;
end $$;

create or replace function public.fin_production_reverse_cost(p_cost uuid, p_reason text) returns void language plpgsql security definer set search_path = '' as $$
declare c public.fin_production_costs; o public.fin_production_orders; v_r uuid;
begin
  select * into c from public.fin_production_costs where id = p_cost for update;
  if not found then raise exception 'not_found'; end if;
  select * into o from public.fin_production_orders where id = c.order_id;
  if not public.can_write_fin(c.entity_id) then raise exception 'forbidden'; end if;
  if c.status <> 'posted' then raise exception 'already_reversed'; end if;
  if o.status <> 'open' then raise exception 'order_closed: reopen is not possible — record a correction on a new order'; end if;
  if char_length(coalesce(trim(p_reason), '')) < 3 then raise exception 'reason_required'; end if;
  perform set_config('app.fin_doc_void', 'on', true);
  v_r := public.fin_reverse_journal(c.journal_id, o.order_no || ': ' || trim(p_reason), null);
  perform set_config('app.fin_doc_void', 'off', true);
  if c.kind = 'material' then
    insert into public.fin_stock_moves (entity_id, item_id, move_date, qty, unit_cost, source, journal_id, note, production_order_id)
      values (c.entity_id, c.item_id, c.cost_date, c.qty, c.unit_cost, 'production', v_r, 'Returned from ' || o.order_no || ': ' || trim(p_reason), o.id);
  end if;
  update public.fin_production_costs set status = 'reversed', reversal_journal_id = v_r, reversal_reason = trim(p_reason) where id = p_cost;
end $$;

-- finish: the order's whole cost moves from Work in progress to Cost of goods sold (made-to-order goods go straight to the customer)
create or replace function public.fin_production_complete(p_order uuid, p_date date default null) returns numeric language plpgsql security definer set search_path = '' as $$
declare o public.fin_production_orders; v_total numeric; v_wip uuid; v_cogs uuid; v_jid uuid; v_date date := coalesce(p_date, current_date);
begin
  select * into o from public.fin_production_orders where id = p_order for update;
  if not found then raise exception 'not_found'; end if;
  if not public.can_write_fin(o.entity_id) then raise exception 'forbidden'; end if;
  if o.status <> 'open' then raise exception 'order_closed: the order is %', o.status; end if;
  select coalesce(sum(amount), 0) into v_total from public.fin_production_costs where order_id = p_order and status = 'posted';
  if v_total <= 0 then raise exception 'no_costs: record the material and costs before completing'; end if;
  v_wip := public.fin_sys_account_ensure(o.entity_id, 'wip'); v_cogs := public.fin_sys_account(o.entity_id, 'cogs');
  if v_cogs is null then raise exception 'missing_account: these books have no cost of goods sold account'; end if;
  v_jid := public.fin_system_journal(o.entity_id, v_date, left(o.order_no || ' completed: ' || o.title, 300), o.order_no, 'production', o.id,
    jsonb_build_array(jsonb_build_object('account_id', v_cogs, 'description', o.order_no || ' finished cost', 'debit', v_total, 'credit', 0),
                      jsonb_build_object('account_id', v_wip, 'description', o.order_no || ' finished cost', 'debit', 0, 'credit', v_total)));
  perform set_config('app.fin_production', 'on', true);
  update public.fin_production_orders set status = 'completed', completed_on = v_date, completion_journal_id = v_jid, total_cost = v_total where id = p_order;
  perform set_config('app.fin_production', 'off', true);
  return v_total;
end $$;
create or replace function public.fin_production_cancel(p_order uuid, p_reason text) returns void language plpgsql security definer set search_path = '' as $$
declare o public.fin_production_orders;
begin
  select * into o from public.fin_production_orders where id = p_order for update;
  if not found then raise exception 'not_found'; end if;
  if not public.can_write_fin(o.entity_id) then raise exception 'forbidden'; end if;
  if o.status <> 'open' then raise exception 'order_closed'; end if;
  if char_length(coalesce(trim(p_reason), '')) < 3 then raise exception 'reason_required'; end if;
  if exists (select 1 from public.fin_production_costs where order_id = p_order and status = 'posted') then
    raise exception 'has_costs: reverse the material and costs first (material goes back into stock)';
  end if;
  perform set_config('app.fin_production', 'on', true);
  update public.fin_production_orders set status = 'cancelled', cancel_reason = trim(p_reason) where id = p_order;
  perform set_config('app.fin_production', 'off', true);
end $$;

-- per-order costing with revenue from the linked sales invoice
create or replace view public.fin_production_summary with (security_invoker = true) as
  select o.id as order_id, o.entity_id, o.order_no, o.title, o.status,
    coalesce(sum(c.amount) filter (where c.kind = 'material' and c.status = 'posted'), 0) as material_cost,
    coalesce(sum(c.amount) filter (where c.kind = 'other' and c.status = 'posted'), 0) as other_cost,
    coalesce(sum(c.amount) filter (where c.status = 'posted'), 0) as total_cost,
    (select coalesce(sum(l.amount), 0) from public.fin_invoice_lines l join public.fin_invoices i on i.id = l.invoice_id where i.id = o.invoice_id and i.status = 'posted') as revenue
  from public.fin_production_orders o left join public.fin_production_costs c on c.order_id = o.id
  group by o.id;

revoke execute on function public.fin_sys_account_ensure(uuid, text), public.fin_issue_cost(uuid), public.fin_production_orders_guard() from public, anon, authenticated;
revoke execute on function public.fin_goods_receipt(jsonb), public.fin_goods_receipt_reverse(uuid, text), public.fin_production_open(uuid, text, uuid, text, date), public.fin_production_issue(uuid, uuid, numeric, date, text, text),
  public.fin_production_add_cost(uuid, numeric, uuid, date, text), public.fin_production_reverse_cost(uuid, text), public.fin_production_complete(uuid, date), public.fin_production_cancel(uuid, text) from public, anon;
grant execute on function public.fin_goods_receipt(jsonb), public.fin_goods_receipt_reverse(uuid, text), public.fin_production_open(uuid, text, uuid, text, date), public.fin_production_issue(uuid, uuid, numeric, date, text, text),
  public.fin_production_add_cost(uuid, numeric, uuid, date, text), public.fin_production_reverse_cost(uuid, text), public.fin_production_complete(uuid, date), public.fin_production_cancel(uuid, text) to authenticated;
grant select on public.fin_production_summary to authenticated;
