-- TDS on returns: amount = gross return, tds = tax deducted at source, net received = amount - tds.
-- The group split shares TDS by capital, exactly like the gross amount.
alter table public.inv_returns add column if not exists tds numeric not null default 0;
alter table public.inv_returns drop constraint if exists inv_returns_tds_check;
alter table public.inv_returns add constraint inv_returns_tds_check check (tds >= 0 and tds <= amount);
alter table public.inv_return_adjustments add column if not exists tds numeric;
alter table public.inv_return_log drop constraint if exists inv_return_log_field_check;
alter table public.inv_return_log add constraint inv_return_log_field_check check (field in ('narration', 'amount', 'tds'));

create or replace function public.inv_rebuild_pool(p_group uuid) returns void language plpgsql security definer set search_path = '' as $$
declare v_main uuid; v_wsum numeric;
begin
  select sales_from into v_main from public.inv_entities where id = p_group;
  if v_main is null then return; end if;
  select sum(amount) into v_wsum from public.inv_investors where entity_id = p_group and amount > 0;
  delete from public.inv_returns where entity_id = p_group and derived;
  if coalesce(v_wsum, 0) = 0 then return; end if;
  insert into public.inv_returns (entity_id, investor_id, paid_on, period, amount, auto_amount, tds, note, derived, edited_by, edited_at, edit_reason)
  with b as (
    select coalesce(r.period, r.paid_on) k, max(r.period) period, max(r.paid_on) paid_on, sum(r.amount) total, sum(r.tds) ttds,
           min(regexp_replace(coalesce(r.note, ''), ' — per LLP ledger.*$', '')) note
    from public.inv_returns r join public.inv_investors i on i.id = r.investor_id
    where r.entity_id = v_main and i.pools_into = p_group group by 1),
  gi as (select id, amount, row_number() over (order by sort desc, created_at desc) rn from public.inv_investors where entity_id = p_group and amount > 0),
  x as (select b.*, gi.id inv, gi.rn, round(b.total * gi.amount / v_wsum, 2) share, round(b.ttds * gi.amount / v_wsum, 2) tshare from b cross join gi),
  y as (select x.*, case when x.rn = 1 then x.total - coalesce(sum(case when x.rn > 1 then x.share end) over (partition by x.k), 0) else x.share end auto,
    case when x.rn = 1 then x.ttds - coalesce(sum(case when x.rn > 1 then x.tshare end) over (partition by x.k), 0) else x.tshare end atds from x)
  select p_group, y.inv, y.paid_on, y.period, coalesce(a.amount, y.auto), y.auto, least(coalesce(a.tds, y.atds), coalesce(a.amount, y.auto)),
    coalesce(nullif(a.narration, ''), coalesce(nullif(y.note, '') || ' ', '') || '(group total ₹' || to_char(y.total, 'FM99,99,99,999') || ')'), true,
    case when a.amount is not null or a.tds is not null then a.updated_by end, case when a.amount is not null or a.tds is not null then a.updated_at end, case when a.amount is not null or a.tds is not null then a.reason end
  from y left join public.inv_return_adjustments a on a.investor_id = y.inv and a.period_key = y.k;
end $$;
revoke execute on function public.inv_rebuild_pool(uuid) from public, anon, authenticated;

-- Edit narration and/or amount of one payment. Amount changes need a reason and are logged.
drop function if exists public.inv_edit_return(uuid, text, numeric, text);
create or replace function public.inv_edit_return(p_return uuid, p_narration text, p_amount numeric default null, p_reason text default null, p_tds numeric default null)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.inv_returns; v_key date; v_note text := nullif(trim(coalesce(p_narration, '')), ''); v_amt boolean; v_reason text := nullif(trim(coalesce(p_reason, '')), ''); v_old text; v_tds boolean;
begin
  select * into r from public.inv_returns where id = p_return;
  if r.id is null then raise exception 'not_found'; end if;
  if not public.can_write_inv(r.entity_id) then raise exception 'not_allowed: you can only view this entity'; end if;
  v_amt := p_amount is not null and p_amount <> r.amount;
  v_tds := p_tds is not null and p_tds <> r.tds;
  if v_amt and p_amount < 0 then raise exception 'bad_amount'; end if;
  if v_tds and (p_tds < 0 or p_tds > coalesce(p_amount, r.amount)) then raise exception 'bad_tds: TDS must be between 0 and the gross amount'; end if;
  if (v_amt or v_tds) and (v_reason is null or length(v_reason) < 3) then raise exception 'reason_required: give a reason for changing the amount'; end if;
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
    if v_tds then
      update public.inv_return_adjustments set tds = p_tds, reason = v_reason, updated_at = now()
        where investor_id = r.investor_id and period_key = v_key;
    end if;
    perform public.inv_rebuild_pool(r.entity_id);
  else
    v_old := r.note;
    update public.inv_returns set note = v_note,
      amount = case when v_amt then p_amount else amount end,
      tds = case when v_tds then p_tds else tds end,
      edited_by = case when v_amt or v_tds then (select auth.uid()) else edited_by end,
      edited_at = case when v_amt or v_tds then now() else edited_at end,
      edit_reason = case when v_amt or v_tds then v_reason else edit_reason end
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
  if v_tds then
    insert into public.inv_return_log (entity_id, investor_id, period_key, field, old_value, new_value, reason, changed_by)
      values (r.entity_id, r.investor_id, v_key, 'tds', r.tds::text, p_tds::text, v_reason, (select auth.uid()));
  end if;
end $$;
revoke execute on function public.inv_edit_return(uuid, text, numeric, text, numeric) from public, anon;
grant execute on function public.inv_edit_return(uuid, text, numeric, text, numeric) to authenticated;


select public.inv_rebuild_pool(id) from public.inv_entities where sales_from is not null;
