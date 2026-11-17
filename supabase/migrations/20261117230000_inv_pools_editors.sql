-- Enter once, reflect everywhere:
--  * inv_investors.pools_into: returns paid to these investors (e.g. Jezil, Nihan) in the main entity are
--    automatically re-split by capital among the investors of the linked group entity.
--  * linked entities also see the main entity's documents (read-only).
--  * a third role, 'editor', can add returns, sales, documents and investors (owner keeps settings and sharing).

alter table public.inv_investors add column if not exists pools_into uuid references public.inv_entities(id) on delete set null;
create index if not exists inv_investors_pools_into_idx on public.inv_investors(pools_into);
alter table public.inv_returns add column if not exists derived boolean not null default false;

alter table public.inv_members drop constraint if exists inv_members_role_check;
alter table public.inv_members add constraint inv_members_role_check check (role in ('owner', 'editor', 'viewer'));
alter table public.inv_pending_invites add column if not exists role text not null default 'viewer' check (role in ('editor', 'viewer'));

create or replace function public.can_write_inv(e uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.inv_members where entity_id = e and user_id = (select auth.uid()) and role in ('owner', 'editor'));
$$;
revoke execute on function public.can_write_inv(uuid) from public, anon;
grant execute on function public.can_write_inv(uuid) to authenticated;

-- can read a main entity's files if a member of it, or of a group entity linked to it
create or replace function public.can_read_inv_files(e uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_inv_member(e) or exists (select 1 from public.inv_entities c where c.sales_from = e and public.is_inv_member(c.id));
$$;
revoke execute on function public.can_read_inv_files(uuid) from public, anon;
grant execute on function public.can_read_inv_files(uuid) to authenticated;

-- write policies: owner or editor (derived group returns are maintained by the system only)
do $$ declare t text; begin
  foreach t in array array['inv_investors', 'inv_sales', 'inv_documents', 'inv_daily_sales'] loop
    execute format('drop policy if exists "%1$s: owner adds" on public.%1$I', t);
    execute format('drop policy if exists "%1$s: owner edits" on public.%1$I', t);
    execute format('drop policy if exists "%1$s: owner deletes" on public.%1$I', t);
    execute format('create policy "%1$s: editors add" on public.%1$I for insert to authenticated with check (public.can_write_inv(entity_id))', t);
    execute format('create policy "%1$s: editors edit" on public.%1$I for update to authenticated using (public.can_write_inv(entity_id)) with check (public.can_write_inv(entity_id))', t);
    execute format('create policy "%1$s: editors delete" on public.%1$I for delete to authenticated using (public.can_write_inv(entity_id))', t);
  end loop;
end $$;
drop policy if exists "inv_returns: owner adds" on public.inv_returns;
drop policy if exists "inv_returns: owner edits" on public.inv_returns;
drop policy if exists "inv_returns: owner deletes" on public.inv_returns;
create policy "inv_returns: editors add" on public.inv_returns for insert to authenticated with check (public.can_write_inv(entity_id) and not derived);
create policy "inv_returns: editors edit" on public.inv_returns for update to authenticated using (public.can_write_inv(entity_id) and not derived) with check (public.can_write_inv(entity_id) and not derived);
create policy "inv_returns: editors delete" on public.inv_returns for delete to authenticated using (public.can_write_inv(entity_id) and not derived);
drop policy if exists "inv members: owner removes viewers" on public.inv_members;
create policy "inv members: owner removes others" on public.inv_members for delete to authenticated using (public.is_inv_owner(entity_id) and role <> 'owner');

drop policy if exists "investor bucket: members read" on storage.objects;
drop policy if exists "investor bucket: owner upload" on storage.objects;
drop policy if exists "investor bucket: owner delete" on storage.objects;
create policy "investor bucket: members read" on storage.objects for select to authenticated using (bucket_id = 'investor' and public.can_read_inv_files(public.storage_ws(name)));
create policy "investor bucket: editors upload" on storage.objects for insert to authenticated with check (bucket_id = 'investor' and public.can_write_inv(public.storage_ws(name)));
create policy "investor bucket: editors delete" on storage.objects for delete to authenticated using (bucket_id = 'investor' and public.can_write_inv(public.storage_ws(name)));

-- rebuild a group's returns from the pooled investors' returns in its main entity, split by capital
create or replace function public.inv_rebuild_pool(p_group uuid) returns void language plpgsql security definer set search_path = '' as $$
declare v_main uuid; v_wsum numeric;
begin
  select sales_from into v_main from public.inv_entities where id = p_group;
  if v_main is null then return; end if;
  select sum(amount) into v_wsum from public.inv_investors where entity_id = p_group and amount > 0;
  delete from public.inv_returns where entity_id = p_group and derived;
  if coalesce(v_wsum, 0) = 0 then return; end if;
  insert into public.inv_returns (entity_id, investor_id, paid_on, period, amount, note, derived)
  with b as (
    select coalesce(r.period, r.paid_on) k, max(r.period) period, max(r.paid_on) paid_on, sum(r.amount) total,
           min(regexp_replace(coalesce(r.note, ''), ' — per LLP ledger.*$', '')) note
    from public.inv_returns r join public.inv_investors i on i.id = r.investor_id
    where r.entity_id = v_main and i.pools_into = p_group group by 1),
  gi as (select id, amount, row_number() over (order by sort desc, created_at desc) rn from public.inv_investors where entity_id = p_group and amount > 0),
  x as (select b.*, gi.id inv, gi.rn, round(b.total * gi.amount / v_wsum, 2) share from b cross join gi)
  select p_group, x.inv, x.paid_on, x.period,
    case when x.rn = 1 then x.total - coalesce(sum(case when x.rn > 1 then x.share end) over (partition by x.k), 0) else x.share end,
    coalesce(nullif(x.note, '') || ' ', '') || '(group total ₹' || to_char(x.total, 'FM99,99,99,999') || ')', true
  from x;
end $$;
revoke execute on function public.inv_rebuild_pool(uuid) from public, anon, authenticated;

create or replace function public.inv_returns_pool_sync() returns trigger language plpgsql security definer set search_path = '' as $$
declare g uuid;
begin
  for g in select distinct i.pools_into from public.inv_investors i
           where i.id in (coalesce(new.investor_id, old.investor_id), coalesce(old.investor_id, new.investor_id)) and i.pools_into is not null loop
    perform public.inv_rebuild_pool(g);
  end loop;
  return null;
end $$;
revoke execute on function public.inv_returns_pool_sync() from public, anon, authenticated;
drop trigger if exists inv_returns_pool_sync on public.inv_returns;
create trigger inv_returns_pool_sync after insert or update or delete on public.inv_returns for each row when (pg_trigger_depth() < 1) execute function public.inv_returns_pool_sync();

create or replace function public.inv_investors_pool_sync() returns trigger language plpgsql security definer set search_path = '' as $$
declare g uuid;
begin
  for g in select x from unnest(array[new.pools_into, old.pools_into,
             (select id from public.inv_entities where id = coalesce(new.entity_id, old.entity_id) and sales_from is not null)]) x where x is not null loop
    perform public.inv_rebuild_pool(g);
  end loop;
  return null;
end $$;
revoke execute on function public.inv_investors_pool_sync() from public, anon, authenticated;
drop trigger if exists inv_investors_pool_sync on public.inv_investors;
create trigger inv_investors_pool_sync after insert or update of amount, pools_into, sort or delete on public.inv_investors for each row when (pg_trigger_depth() < 1) execute function public.inv_investors_pool_sync();

-- linked data for group members: sales, daily sales and the main entity's documents
create or replace function public.inv_linked_sales(p_entity uuid) returns json language plpgsql stable security definer set search_path = '' as $$
declare v_src uuid;
begin
  if not public.is_inv_member(p_entity) then return null; end if;
  select sales_from into v_src from public.inv_entities where id = p_entity;
  if v_src is null then return null; end if;
  return json_build_object(
    'source_name', (select name from public.inv_entities where id = v_src),
    'sales', coalesce((select json_agg(json_build_object('id', s.id, 'month', s.month, 'sales', s.sales, 'expenses', s.expenses, 'net_profit', s.net_profit, 'note', s.note) order by s.month) from public.inv_sales s where s.entity_id = v_src), '[]'::json),
    'daily', coalesce((select json_agg(json_build_object('id', d.id, 'day', d.day, 'amount', d.amount) order by d.day) from public.inv_daily_sales d where d.entity_id = v_src), '[]'::json),
    'docs', coalesce((select json_agg(json_build_object('id', d.id, 'kind', d.kind, 'title', d.title, 'period', d.period, 'storage_path', d.storage_path, 'mime_type', d.mime_type, 'size_bytes', d.size_bytes, 'created_at', d.created_at) order by d.created_at desc) from public.inv_documents d where d.entity_id = v_src), '[]'::json));
end $$;

-- share with a role; works before sign-up
drop function if exists public.inv_add_viewer(uuid, text);
create or replace function public.inv_add_viewer(p_entity uuid, p_email text, p_role text default 'viewer') returns json language plpgsql security definer set search_path = '' as $$
declare v_user public.profiles; v_email text := lower(trim(p_email));
begin
  if not public.is_inv_owner(p_entity) then raise exception 'not_owner: only the owner can share this entity'; end if;
  if p_role not in ('viewer', 'editor') then raise exception 'bad_role'; end if;
  select * into v_user from public.profiles where lower(email) = v_email;
  if v_user.id is null then
    insert into public.inv_pending_invites (entity_id, email, added_by, role) values (p_entity, v_email, (select auth.uid()), p_role)
      on conflict (entity_id, email) do update set role = excluded.role;
    return json_build_object('pending', true, 'email', v_email, 'role', p_role);
  end if;
  insert into public.inv_members (entity_id, user_id, role, added_by) values (p_entity, v_user.id, p_role, (select auth.uid()))
    on conflict (entity_id, user_id) do update set role = excluded.role where public.inv_members.role <> 'owner';
  return json_build_object('id', v_user.id, 'email', v_user.email, 'display_name', v_user.display_name, 'role', p_role);
end $$;
revoke execute on function public.inv_add_viewer(uuid, text, text) from public, anon;
grant execute on function public.inv_add_viewer(uuid, text, text) to authenticated;

create or replace function public.inv_claim_invites() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.inv_members (entity_id, user_id, role, added_by)
    select i.entity_id, new.id, i.role, i.added_by from public.inv_pending_invites i where i.email = lower(trim(new.email))
    on conflict (entity_id, user_id) do nothing;
  delete from public.inv_pending_invites where email = lower(trim(new.email));
  return new;
end $$;

-- Kakkanad: Jezil's and Nihan's returns feed the Jezil & Nihan group (existing group rows become system-maintained)
update public.inv_returns r set derived = true from public.inv_entities g where g.id = r.entity_id and g.sales_from is not null and g.name like 'Kakkanad – Jezil%';
update public.inv_investors i set pools_into = g.id
from public.inv_entities m, public.inv_entities g
where m.id = i.entity_id and m.name = 'The Burgery In - Kakkanad' and g.sales_from = m.id and g.name like 'Kakkanad – Jezil%' and i.name in ('Jezil', 'Nihan');
