-- Share an investor entity with someone before they sign up: they get view-only access when their account is created.
create table if not exists public.inv_pending_invites (
  entity_id uuid not null references public.inv_entities(id) on delete cascade,
  email text not null check (email = lower(trim(email))),
  added_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (entity_id, email)
);
create index if not exists inv_pending_invites_email_idx on public.inv_pending_invites(email);
create index if not exists inv_pending_invites_added_by_idx on public.inv_pending_invites(added_by);
alter table public.inv_pending_invites enable row level security;
create policy "inv invites: owner reads" on public.inv_pending_invites for select to authenticated using (public.is_inv_owner(entity_id));
create policy "inv invites: owner removes" on public.inv_pending_invites for delete to authenticated using (public.is_inv_owner(entity_id));
grant select, delete on public.inv_pending_invites to authenticated;

create or replace function public.inv_claim_invites() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.inv_members (entity_id, user_id, role, added_by)
    select i.entity_id, new.id, 'viewer', i.added_by from public.inv_pending_invites i where i.email = lower(trim(new.email))
    on conflict (entity_id, user_id) do nothing;
  delete from public.inv_pending_invites where email = lower(trim(new.email));
  return new;
end $$;
revoke execute on function public.inv_claim_invites() from public, anon, authenticated;
drop trigger if exists profiles_claim_inv_invites on public.profiles;
create trigger profiles_claim_inv_invites after insert on public.profiles for each row execute function public.inv_claim_invites();

create or replace function public.inv_add_viewer(p_entity uuid, p_email text) returns json language plpgsql security definer set search_path = '' as $$
declare v_user public.profiles; v_email text := lower(trim(p_email));
begin
  if not public.is_inv_owner(p_entity) then raise exception 'not_owner: only the owner can share this entity'; end if;
  select * into v_user from public.profiles where lower(email) = v_email;
  if v_user.id is null then
    insert into public.inv_pending_invites (entity_id, email, added_by) values (p_entity, v_email, (select auth.uid())) on conflict do nothing;
    return json_build_object('pending', true, 'email', v_email);
  end if;
  insert into public.inv_members (entity_id, user_id, role, added_by) values (p_entity, v_user.id, 'viewer', (select auth.uid())) on conflict (entity_id, user_id) do nothing;
  return json_build_object('id', v_user.id, 'email', v_user.email, 'display_name', v_user.display_name);
end $$;
revoke execute on function public.inv_add_viewer(uuid, text) from public, anon;
grant execute on function public.inv_add_viewer(uuid, text) to authenticated;
