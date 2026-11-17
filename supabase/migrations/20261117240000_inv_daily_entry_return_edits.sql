-- Daily sales entry (one day at a time, month total kept in step) and
-- narration / authorised amount edits on returns, incl. the auto-split group rows.

alter table public.inv_returns add column if not exists auto_amount numeric;
alter table public.inv_returns add column if not exists edited_by uuid references auth.users(id) on delete set null;
alter table public.inv_returns add column if not exists edited_at timestamptz;
alter table public.inv_returns add column if not exists edit_reason text;

-- Overrides for auto-split group rows survive every rebuild.
create table if not exists public.inv_return_adjustments (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.inv_entities(id) on delete cascade,
  investor_id uuid not null references public.inv_investors(id) on delete cascade,
  period_key date not null,
  amount numeric,
  narration text,
  reason text,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (investor_id, period_key)
);
create index if not exists inv_return_adjustments_entity_idx on public.inv_return_adjustments(entity_id);
alter table public.inv_return_adjustments enable row level security;
drop policy if exists "inv_return_adjustments: members read" on public.inv_return_adjustments;
create policy "inv_return_adjustments: members read" on public.inv_return_adjustments for select to authenticated using (public.is_inv_member(entity_id));

-- Audit trail of every narration / amount change.
create table if not exists public.inv_return_log (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.inv_entities(id) on delete cascade,
  investor_id uuid references public.inv_investors(id) on delete set null,
  period_key date,
  field text not null,
  old_value text,
  new_value text,
  reason text,
  changed_by uuid references auth.users(id) on delete set null,
  changed_at timestamptz not null default now()
);
create index if not exists inv_return_log_entity_idx on public.inv_return_log(entity_id, changed_at desc);
alter table public.inv_return_log enable row level security;
drop policy if exists "inv_return_log: members read" on public.inv_return_log;
create policy "inv_return_log: members read" on public.inv_return_log for select to authenticated using (public.is_inv_member(entity_id));

create or replace function public.inv_rebuild_pool(p_group uuid) returns void language plpgsql security definer set search_path = '' as $$
declare v_main uuid; v_wsum numeric;
begin
  select sales_from into v_main from public.inv_entities where id = p_group;
  if v_main is null then return; end if;
  select sum(amount) into v_wsum from public.inv_investors where entity_id = p_group and amount > 0;
  delete from public.inv_returns where entity_id = p_group and derived;
  if coalesce(v_wsum, 0) = 0 then return; end if;
  insert into public.inv_returns (entity_id, investor_id, paid_on, period, amount, auto_amount, note, derived, edited_by, edited_at, edit_reason)
  with b as (
    select coalesce(r.period, r.paid_on) k, max(r.period) period, max(r.paid_on) paid_on, sum(r.amount) total,
           min(regexp_replace(coalesce(r.note, ''), ' — per LLP ledger.*$', '')) note
    from public.inv_returns r join public.inv_investors i on i.id = r.investor_id
    where r.entity_id = v_main and i.pools_into = p_group group by 1),
  gi as (select id, amount, row_number() over (order by sort desc, created_at desc) rn from public.inv_investors where entity_id = p_group and amount > 0),
  x as (select b.*, gi.id inv, gi.rn, round(b.total * gi.amount / v_wsum, 2) share from b cross join gi),
  y as (select x.*, case when x.rn = 1 then x.total - coalesce(sum(case when x.rn > 1 then x.share end) over (partition by x.k), 0) else x.share end auto from x)
  select p_group, y.inv, y.paid_on, y.period, coalesce(a.amount, y.auto), y.auto,
    coalesce(nullif(a.narration, ''), coalesce(nullif(y.note, '') || ' ', '') || '(group total ₹' || to_char(y.total, 'FM99,99,99,999') || ')'), true,
    case when a.amount is not null then a.updated_by end, case when a.amount is not null then a.updated_at end, case when a.amount is not null then a.reason end
  from y left join public.inv_return_adjustments a on a.investor_id = y.inv and a.period_key = y.k;
end $$;
revoke execute on function public.inv_rebuild_pool(uuid) from public, anon, authenticated;

-- Edit narration and/or amount of one payment. Amount changes need a reason and are logged.
create or replace function public.inv_edit_return(p_return uuid, p_narration text, p_amount numeric default null, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.inv_returns; v_key date; v_note text := nullif(trim(coalesce(p_narration, '')), ''); v_amt boolean; v_reason text := nullif(trim(coalesce(p_reason, '')), ''); v_old text;
begin
  select * into r from public.inv_returns where id = p_return;
  if r.id is null then raise exception 'not_found'; end if;
  if not public.can_write_inv(r.entity_id) then raise exception 'not_allowed: you can only view this entity'; end if;
  v_amt := p_amount is not null and p_amount <> r.amount;
  if v_amt and p_amount < 0 then raise exception 'bad_amount'; end if;
  if v_amt and (v_reason is null or length(v_reason) < 3) then raise exception 'reason_required: give a reason for changing the amount'; end if;
  v_key := coalesce(r.period, r.paid_on);
  if r.derived then
    select narration into v_old from public.inv_return_adjustments where investor_id = r.investor_id and period_key = v_key;
    insert into public.inv_return_adjustments (entity_id, investor_id, period_key, narration, updated_by)
      values (r.entity_id, r.investor_id, v_key, v_note, (select auth.uid()))
      on conflict (investor_id, period_key) do update set narration = excluded.narration, updated_by = excluded.updated_by, updated_at = now();
    if v_amt then
      update public.inv_return_adjustments set amount = case when p_amount = r.auto_amount then null else p_amount end, reason = v_reason, updated_at = now()
        where investor_id = r.investor_id and period_key = v_key;
    end if;
    perform public.inv_rebuild_pool(r.entity_id);
  else
    v_old := r.note;
    update public.inv_returns set note = v_note,
      amount = case when v_amt then p_amount else amount end,
      edited_by = case when v_amt then (select auth.uid()) else edited_by end,
      edited_at = case when v_amt then now() else edited_at end,
      edit_reason = case when v_amt then v_reason else edit_reason end
      where id = r.id; -- trigger re-splits the group
  end if;
  if coalesce(v_note, '') <> coalesce(v_old, '') then
    insert into public.inv_return_log (entity_id, investor_id, period_key, field, old_value, new_value, changed_by)
      values (r.entity_id, r.investor_id, v_key, 'narration', v_old, v_note, (select auth.uid()));
  end if;
  if v_amt then
    insert into public.inv_return_log (entity_id, investor_id, period_key, field, old_value, new_value, reason, changed_by)
      values (r.entity_id, r.investor_id, v_key, 'amount', r.amount::text, p_amount::text, v_reason, (select auth.uid()));
  end if;
end $$;
revoke execute on function public.inv_edit_return(uuid, text, numeric, text) from public, anon;
grant execute on function public.inv_edit_return(uuid, text, numeric, text) to authenticated;

-- Add / change / remove one day's sales; keeps the month total equal to the sum of its days.
create or replace function public.inv_set_daily_sale(p_entity uuid, p_day date, p_amount numeric)
returns json language plpgsql security definer set search_path = '' as $$
declare v_month date := date_trunc('month', p_day)::date; v_had boolean; v_row public.inv_sales; v_sum numeric; v_sync boolean;
begin
  if not public.can_write_inv(p_entity) then raise exception 'not_allowed: only partners with edit access can add sales'; end if;
  if exists (select 1 from public.inv_entities where id = p_entity and sales_from is not null) then raise exception 'linked: add sales in the main entity'; end if;
  if p_amount is not null and p_amount < 0 then raise exception 'bad_amount'; end if;
  select exists (select 1 from public.inv_daily_sales where entity_id = p_entity and day >= v_month and day < (v_month + interval '1 month')) into v_had;
  select * into v_row from public.inv_sales where entity_id = p_entity and month = v_month;
  if p_amount is null then
    delete from public.inv_daily_sales where entity_id = p_entity and day = p_day;
  else
    insert into public.inv_daily_sales (entity_id, day, amount, created_by) values (p_entity, p_day, p_amount, (select auth.uid()))
      on conflict (entity_id, day) do update set amount = excluded.amount;
  end if;
  select coalesce(sum(amount), 0) into v_sum from public.inv_daily_sales where entity_id = p_entity and day >= v_month and day < (v_month + interval '1 month');
  -- a month that so far only had a typed-in total keeps it; otherwise the total follows the days
  v_sync := v_row.id is null or v_had;
  if v_sync then
    if v_row.id is null then
      if v_sum > 0 then insert into public.inv_sales (entity_id, month, sales, created_by) values (p_entity, v_month, v_sum, (select auth.uid())); end if;
    else
      update public.inv_sales set sales = v_sum, updated_at = now() where id = v_row.id;
    end if;
  end if;
  return json_build_object('month', v_month, 'month_total', v_sum, 'synced', v_sync);
end $$;
revoke execute on function public.inv_set_daily_sale(uuid, date, numeric) from public, anon;
grant execute on function public.inv_set_daily_sale(uuid, date, numeric) to authenticated;

-- fill auto_amount on the existing group rows
select public.inv_rebuild_pool(id) from public.inv_entities where sales_from is not null;
