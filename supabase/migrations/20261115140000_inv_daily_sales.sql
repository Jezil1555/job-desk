-- Day-by-day sales for an investor entity; month totals in inv_sales are rolled up from these on import.
create table if not exists public.inv_daily_sales (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.inv_entities(id) on delete cascade,
  day date not null,
  amount numeric(16,2) not null default 0,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (entity_id, day)
);
create index if not exists inv_daily_sales_created_by_idx on public.inv_daily_sales(created_by);
alter table public.inv_daily_sales enable row level security;
create policy "inv_daily_sales: members read" on public.inv_daily_sales for select to authenticated using (public.is_inv_member(entity_id));
create policy "inv_daily_sales: owner adds" on public.inv_daily_sales for insert to authenticated with check (public.is_inv_owner(entity_id));
create policy "inv_daily_sales: owner edits" on public.inv_daily_sales for update to authenticated using (public.is_inv_owner(entity_id)) with check (public.is_inv_owner(entity_id));
create policy "inv_daily_sales: owner deletes" on public.inv_daily_sales for delete to authenticated using (public.is_inv_owner(entity_id));
grant select, insert, update, delete on public.inv_daily_sales to authenticated;
