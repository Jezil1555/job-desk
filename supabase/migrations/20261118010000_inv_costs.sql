-- Costs shared by partners (e.g. CA fees): one batch = one cost, stored as one row per partner's share.
-- Shares of partners who pool into a group (Jezil, Nihan) are re-split into that group by capital, like returns.
create table if not exists public.inv_costs (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.inv_entities(id) on delete cascade,
  investor_id uuid not null references public.inv_investors(id) on delete cascade,
  batch_id uuid not null,
  spent_on date not null,
  title text not null check (length(title) between 1 and 300),
  category text not null default 'professional' check (category in ('professional', 'legal', 'tax', 'other')),
  amount numeric not null check (amount >= 0),
  total numeric not null check (total >= 0),
  split text not null default 'equal' check (split in ('equal', 'capital')),
  note text,
  derived boolean not null default false,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists inv_costs_entity_idx on public.inv_costs(entity_id, spent_on desc);
create index if not exists inv_costs_investor_idx on public.inv_costs(investor_id);
create index if not exists inv_costs_batch_idx on public.inv_costs(batch_id);
alter table public.inv_costs enable row level security;
drop policy if exists "inv_costs: members read" on public.inv_costs;
create policy "inv_costs: members read" on public.inv_costs for select to authenticated using (public.is_inv_member(entity_id));
drop policy if exists "inv_costs: editors delete" on public.inv_costs;
create policy "inv_costs: editors delete" on public.inv_costs for delete to authenticated using (public.can_write_inv(entity_id) and not derived);
-- inserts go through inv_add_cost so the split is always worked out the same way

create or replace function public.inv_rebuild_cost_pool(p_group uuid) returns void language plpgsql security definer set search_path = '' as $$
declare v_main uuid; v_wsum numeric;
begin
  select sales_from into v_main from public.inv_entities where id = p_group;
  if v_main is null then return; end if;
  select sum(amount) into v_wsum from public.inv_investors where entity_id = p_group and amount > 0;
  delete from public.inv_costs where entity_id = p_group and derived;
  if coalesce(v_wsum, 0) = 0 then return; end if;
  insert into public.inv_costs (entity_id, investor_id, batch_id, spent_on, title, category, amount, total, split, note, derived, created_by)
  with b as (
    select c.batch_id, max(c.spent_on) spent_on, max(c.title) title, max(c.category) category, max(c.note) note, sum(c.amount) pooled, max(c.total) total
    from public.inv_costs c join public.inv_investors i on i.id = c.investor_id
    where c.entity_id = v_main and not c.derived and i.pools_into = p_group group by c.batch_id),
  gi as (select id, amount, row_number() over (order by sort desc, created_at desc) rn from public.inv_investors where entity_id = p_group and amount > 0),
  x as (select b.*, gi.id inv, gi.rn, round(b.pooled * gi.amount / v_wsum, 2) share from b cross join gi)
  select p_group, x.inv, x.batch_id, x.spent_on, x.title, x.category,
    case when x.rn = 1 then x.pooled - coalesce(sum(case when x.rn > 1 then x.share end) over (partition by x.batch_id), 0) else x.share end,
    x.pooled, 'capital', coalesce(nullif(x.note, '') || ' ', '') || '(group share of ₹' || to_char(x.total, 'FM99,99,99,999') || ')', true, null
  from x;
end $$;
revoke execute on function public.inv_rebuild_cost_pool(uuid) from public, anon, authenticated;

create or replace function public.inv_costs_pool_sync() returns trigger language plpgsql security definer set search_path = '' as $$
declare g uuid;
begin
  for g in select distinct i.pools_into from public.inv_investors i
           where i.id in (coalesce(new.investor_id, old.investor_id), coalesce(old.investor_id, new.investor_id)) and i.pools_into is not null loop
    perform public.inv_rebuild_cost_pool(g);
  end loop;
  return null;
end $$;
revoke execute on function public.inv_costs_pool_sync() from public, anon, authenticated;
drop trigger if exists inv_costs_pool_sync on public.inv_costs;
create trigger inv_costs_pool_sync after insert or update or delete on public.inv_costs for each row when (pg_trigger_depth() < 1) execute function public.inv_costs_pool_sync();

-- keep the group in step when the group's own capital or the pooling changes
create or replace function public.inv_investors_pool_sync() returns trigger language plpgsql security definer set search_path = '' as $$
declare g uuid;
begin
  for g in select x from unnest(array[new.pools_into, old.pools_into,
             (select id from public.inv_entities where id = coalesce(new.entity_id, old.entity_id) and sales_from is not null)]) x where x is not null loop
    perform public.inv_rebuild_pool(g);
    perform public.inv_rebuild_cost_pool(g);
  end loop;
  return null;
end $$;

-- Add one shared cost: total split equally (or by capital) between the chosen partners.
create or replace function public.inv_add_cost(p_entity uuid, p_spent_on date, p_title text, p_category text, p_total numeric, p_split text, p_investors uuid[], p_note text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_batch uuid := gen_random_uuid(); v_n int; v_wsum numeric;
begin
  if not public.can_write_inv(p_entity) then raise exception 'not_allowed: only partners with edit access can add costs'; end if;
  if exists (select 1 from public.inv_entities where id = p_entity and sales_from is not null) then raise exception 'linked: add costs in the main entity — the group share is worked out automatically'; end if;
  if p_total is null or p_total <= 0 then raise exception 'bad_amount: enter the total cost'; end if;
  if p_split not in ('equal', 'capital') then raise exception 'bad_split'; end if;
  select count(*), sum(amount) into v_n, v_wsum from public.inv_investors where entity_id = p_entity and id = any(p_investors);
  if v_n = 0 or v_n <> coalesce(array_length(p_investors, 1), 0) then raise exception 'pick_partners: choose who shares this cost'; end if;
  if p_split = 'capital' and coalesce(v_wsum, 0) = 0 then raise exception 'no_capital: the chosen partners have no capital to split by'; end if;
  insert into public.inv_costs (entity_id, investor_id, batch_id, spent_on, title, category, amount, total, split, note)
  with gi as (select id, amount, row_number() over (order by sort desc, created_at desc) rn from public.inv_investors where entity_id = p_entity and id = any(p_investors)),
  x as (select gi.*, round(case when p_split = 'equal' then p_total / v_n else p_total * gi.amount / v_wsum end, 2) share from gi)
  select p_entity, x.id, v_batch, p_spent_on, trim(p_title), coalesce(p_category, 'professional'),
    case when x.rn = 1 then p_total - coalesce((select sum(share) from x x2 where x2.rn > 1), 0) else x.share end,
    p_total, p_split, nullif(trim(coalesce(p_note, '')), '')
  from x;
  return v_batch;
end $$;
revoke execute on function public.inv_add_cost(uuid, date, text, text, numeric, text, uuid[], text) from public, anon;
grant execute on function public.inv_add_cost(uuid, date, text, text, numeric, text, uuid[], text) to authenticated;

-- delete a whole cost (all partners' shares) at once
create or replace function public.inv_delete_cost(p_batch uuid) returns void language plpgsql security definer set search_path = '' as $$
declare v_entity uuid;
begin
  select entity_id into v_entity from public.inv_costs where batch_id = p_batch and not derived limit 1;
  if v_entity is null then raise exception 'not_found'; end if;
  if not public.can_write_inv(v_entity) then raise exception 'not_allowed'; end if;
  delete from public.inv_costs where batch_id = p_batch and not derived;
end $$;
revoke execute on function public.inv_delete_cost(uuid) from public, anon;
grant execute on function public.inv_delete_cost(uuid) to authenticated;

