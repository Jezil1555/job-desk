-- Investor Portal: one entity per investment (e.g. The Burgery In - Kakkanad), with its project cost,
-- investors and their capital, monthly sales / P&L figures, returns received per investor, and
-- supporting documents (P&L reports, payment ledgers, partner contracts, ITR filings).
-- Private to the owner; the owner can invite partners as read-only viewers of one entity.

create table if not exists public.inv_entities (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  description text check (description is null or char_length(description) <= 2000),
  currency text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  project_cost numeric(16,2) check (project_cost is null or project_cost >= 0),
  start_date date,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  archived boolean not null default false,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.inv_members (
  entity_id uuid not null references public.inv_entities(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'viewer' check (role in ('owner', 'viewer')),
  added_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (entity_id, user_id)
);
create table if not exists public.inv_investors (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.inv_entities(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  amount numeric(16,2) not null default 0 check (amount >= 0),
  invested_on date,
  is_me boolean not null default false,
  note text check (note is null or char_length(note) <= 1000),
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.inv_returns (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.inv_entities(id) on delete cascade,
  investor_id uuid not null references public.inv_investors(id) on delete cascade,
  paid_on date not null,
  period date,
  amount numeric(16,2) not null check (amount > 0),
  note text check (note is null or char_length(note) <= 1000),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create table if not exists public.inv_sales (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.inv_entities(id) on delete cascade,
  month date not null check (extract(day from month) = 1),
  sales numeric(16,2) not null default 0,
  expenses numeric(16,2),
  net_profit numeric(16,2),
  note text check (note is null or char_length(note) <= 1000),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entity_id, month)
);
create table if not exists public.inv_documents (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.inv_entities(id) on delete cascade,
  kind text not null default 'other' check (kind in ('pl', 'ledger', 'contract', 'itr', 'other')),
  title text not null check (char_length(title) between 1 and 200),
  period date,
  storage_path text not null,
  mime_type text,
  size_bytes bigint,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists inv_entities_owner_idx on public.inv_entities(owner_id);
create index if not exists inv_members_user_idx on public.inv_members(user_id);
create index if not exists inv_members_added_by_idx on public.inv_members(added_by);
create index if not exists inv_investors_entity_idx on public.inv_investors(entity_id);
create index if not exists inv_returns_entity_idx on public.inv_returns(entity_id, paid_on);
create index if not exists inv_returns_investor_idx on public.inv_returns(investor_id);
create index if not exists inv_returns_created_by_idx on public.inv_returns(created_by);
create index if not exists inv_sales_created_by_idx on public.inv_sales(created_by);
create index if not exists inv_documents_entity_idx on public.inv_documents(entity_id, kind);
create index if not exists inv_documents_created_by_idx on public.inv_documents(created_by);

-- access helpers
create or replace function public.is_inv_member(e uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.inv_members where entity_id = e and user_id = (select auth.uid()));
$$;
create or replace function public.is_inv_owner(e uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.inv_members where entity_id = e and user_id = (select auth.uid()) and role = 'owner');
$$;
revoke execute on function public.is_inv_member(uuid) from public, anon;
revoke execute on function public.is_inv_owner(uuid) from public, anon;
grant execute on function public.is_inv_member(uuid) to authenticated;
grant execute on function public.is_inv_owner(uuid) to authenticated;

-- the creator becomes the owner member
create or replace function public.inv_entities_add_owner() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.inv_members (entity_id, user_id, role, added_by) values (new.id, new.owner_id, 'owner', new.owner_id) on conflict do nothing;
  return new;
end $$;
revoke execute on function public.inv_entities_add_owner() from public, anon, authenticated;
drop trigger if exists inv_entities_add_owner on public.inv_entities;
create trigger inv_entities_add_owner after insert on public.inv_entities for each row execute function public.inv_entities_add_owner();

create or replace function public.inv_touch() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;
revoke execute on function public.inv_touch() from public, anon, authenticated;
drop trigger if exists inv_entities_touch on public.inv_entities;
create trigger inv_entities_touch before update on public.inv_entities for each row execute function public.inv_touch();
drop trigger if exists inv_investors_touch on public.inv_investors;
create trigger inv_investors_touch before update on public.inv_investors for each row execute function public.inv_touch();
drop trigger if exists inv_sales_touch on public.inv_sales;
create trigger inv_sales_touch before update on public.inv_sales for each row execute function public.inv_touch();

-- a return must belong to an investor of the same entity
create or replace function public.inv_returns_check() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.inv_investors where id = new.investor_id and entity_id = new.entity_id) then
    raise exception 'investor_wrong_entity: that investor belongs to a different entity';
  end if;
  return new;
end $$;
revoke execute on function public.inv_returns_check() from public, anon, authenticated;
drop trigger if exists inv_returns_check on public.inv_returns;
create trigger inv_returns_check before insert or update on public.inv_returns for each row execute function public.inv_returns_check();

-- RLS
alter table public.inv_entities enable row level security;
alter table public.inv_members enable row level security;
alter table public.inv_investors enable row level security;
alter table public.inv_returns enable row level security;
alter table public.inv_sales enable row level security;
alter table public.inv_documents enable row level security;

create policy "inv entities: members read" on public.inv_entities for select to authenticated using (public.is_inv_member(id) or owner_id = (select auth.uid()));
create policy "inv entities: create own" on public.inv_entities for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "inv entities: owner edits" on public.inv_entities for update to authenticated using (public.is_inv_owner(id)) with check (public.is_inv_owner(id));
create policy "inv entities: owner deletes" on public.inv_entities for delete to authenticated using (public.is_inv_owner(id));

create policy "inv members: members read" on public.inv_members for select to authenticated using (public.is_inv_member(entity_id));
create policy "inv members: owner removes viewers" on public.inv_members for delete to authenticated using (public.is_inv_owner(entity_id) and role = 'viewer');

do $$ declare t text; begin
  foreach t in array array['inv_investors', 'inv_returns', 'inv_sales', 'inv_documents'] loop
    execute format('create policy "%1$s: members read" on public.%1$I for select to authenticated using (public.is_inv_member(entity_id))', t);
    execute format('create policy "%1$s: owner adds" on public.%1$I for insert to authenticated with check (public.is_inv_owner(entity_id))', t);
    execute format('create policy "%1$s: owner edits" on public.%1$I for update to authenticated using (public.is_inv_owner(entity_id)) with check (public.is_inv_owner(entity_id))', t);
    execute format('create policy "%1$s: owner deletes" on public.%1$I for delete to authenticated using (public.is_inv_owner(entity_id))', t);
  end loop;
end $$;

grant select, insert, update, delete on public.inv_entities, public.inv_investors, public.inv_returns, public.inv_sales, public.inv_documents to authenticated;
grant select, delete on public.inv_members to authenticated;

-- invite a partner (read-only) by email; they must have signed up first
create or replace function public.inv_add_viewer(p_entity uuid, p_email text) returns json language plpgsql security definer set search_path = '' as $$
declare v_user public.profiles;
begin
  if not public.is_inv_owner(p_entity) then raise exception 'not_owner: only the owner can share this entity'; end if;
  select * into v_user from public.profiles where lower(email) = lower(trim(p_email));
  if v_user.id is null then raise exception 'not_registered: ask them to sign up to J. Desk first, then add their email again'; end if;
  insert into public.inv_members (entity_id, user_id, role, added_by) values (p_entity, v_user.id, 'viewer', (select auth.uid())) on conflict (entity_id, user_id) do nothing;
  return json_build_object('id', v_user.id, 'email', v_user.email, 'display_name', v_user.display_name);
end $$;
revoke execute on function public.inv_add_viewer(uuid, text) from public, anon;
grant execute on function public.inv_add_viewer(uuid, text) to authenticated;

-- who can see an entity (names and emails), for members of that entity only
create or replace function public.inv_member_list(p_entity uuid) returns table (user_id uuid, role text, email text, display_name text) language sql stable security definer set search_path = '' as $$
  select m.user_id, m.role, p.email, p.display_name from public.inv_members m join public.profiles p on p.id = m.user_id
  where m.entity_id = p_entity and public.is_inv_member(p_entity) order by m.role, p.email;
$$;
revoke execute on function public.inv_member_list(uuid) from public, anon;
grant execute on function public.inv_member_list(uuid) to authenticated;

-- private storage: investor/<entity_id>/<file>
insert into storage.buckets (id, name, public, file_size_limit) values ('investor', 'investor', false, 26214400) on conflict (id) do nothing;
drop policy if exists "investor bucket: members read" on storage.objects;
drop policy if exists "investor bucket: owner upload" on storage.objects;
drop policy if exists "investor bucket: owner delete" on storage.objects;
create policy "investor bucket: members read" on storage.objects for select to authenticated using (bucket_id = 'investor' and public.is_inv_member(public.storage_ws(name)));
create policy "investor bucket: owner upload" on storage.objects for insert to authenticated with check (bucket_id = 'investor' and public.is_inv_owner(public.storage_ws(name)));
create policy "investor bucket: owner delete" on storage.objects for delete to authenticated using (bucket_id = 'investor' and public.is_inv_owner(public.storage_ws(name)));
