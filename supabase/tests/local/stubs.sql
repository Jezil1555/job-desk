-- Minimal stand-ins for the Supabase platform so migrations and tests can run on a plain local Postgres.
-- Used only for local testing; never applied to the real project.
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
grant anon, authenticated to postgres;
create schema auth; create schema storage; create schema cron; create schema private;
grant usage on schema auth, storage, public to anon, authenticated;
create table auth.users (id uuid primary key, email text unique, aud text, role text, instance_id uuid, raw_user_meta_data jsonb);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid $$;
grant execute on function auth.uid() to anon, authenticated;
create table storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, owner uuid, unique (bucket_id, name));
alter table storage.objects enable row level security;
grant select, insert, update, delete on storage.objects to authenticated; grant select on storage.buckets to authenticated;
create function cron.schedule(n text, s text, c text) returns bigint language sql as $$ select 1::bigint $$;
create publication supabase_realtime;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;
-- existing app pieces the finance migration depends on
create table public.workspaces (id uuid primary key default gen_random_uuid(), name text, owner_id uuid);
create table public.workspace_members (workspace_id uuid, user_id uuid, role text, primary key (workspace_id, user_id));
create table public.tasks (id uuid primary key default gen_random_uuid(), workspace_id uuid references public.workspaces(id), title text);
create table public.notifications (id uuid primary key default gen_random_uuid(), user_id uuid not null, kind text not null, title text not null, body text not null, url text,
  task_id uuid, workspace_id uuid, actor_id uuid, read_at timestamptz, created_at timestamptz not null default now(), follow_up_id uuid);
create function public.touch_updated_at() returns trigger language plpgsql set search_path = '' as $$ begin new.updated_at := now(); return new; end $$;
create function public.storage_ws(path text) returns uuid language plpgsql immutable set search_path = '' as $$
begin return (string_to_array(path, '/'))[1]::uuid; exception when others then return null; end $$;
create function public.can_see_task(tid uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tasks t join public.workspace_members m on m.workspace_id = t.workspace_id where t.id = tid and m.user_id = (select auth.uid())) $$;
