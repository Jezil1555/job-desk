-- Local stand-in for the live operations tables (same columns and types as production on 30 Oct 2026), used to test
-- migrations and their rollback scripts on a plain Postgres. Load after stubs.sql. Never applied to the real project.
drop table if exists public.tasks cascade;
drop table if exists public.workspace_members cascade;
drop table if exists public.workspaces cascade;
drop table if exists public.notifications cascade;
create table public.workspaces (id uuid primary key default gen_random_uuid(), owner_id uuid, name text not null, color text not null default '#1f5f8b', archived boolean not null default false,
  sort integer not null default 0, created_at timestamptz not null default now(), description text, kind text not null default 'business');
create table public.workspace_members (workspace_id uuid not null references public.workspaces(id) on delete cascade, user_id uuid not null, role text not null default 'member', added_by uuid,
  created_at timestamptz not null default now(), primary key (workspace_id, user_id));
create table public.profiles (id uuid primary key, email text not null, display_name text not null default '', created_at timestamptz not null default now(), timezone text not null default 'Asia/Qatar',
  prefs jsonb not null default '{}', is_admin boolean not null default false);
create table public.projects (id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id), name text not null, description text, owner_id uuid,
  priority text not null default 'medium', start_date date, target_date date, manual_status text, manual_status_reason text, budget numeric(14,2), budget_currency text, next_action text,
  archived boolean not null default false, created_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table public.milestones (id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects(id) on delete cascade, title text not null, planned_date date, actual_date date,
  weight numeric(6,2) not null default 1, is_critical boolean not null default false, notes text, sort integer not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table public.contacts (id uuid primary key default gen_random_uuid(), workspace_id uuid not null, name text not null, organisation text, kind text not null default 'person', email text, phone text, notes text,
  archived boolean not null default false, created_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table public.tasks (id uuid primary key default gen_random_uuid(), created_by uuid not null default auth.uid(), workspace_id uuid not null references public.workspaces(id), title text not null, client_name text, reference text,
  description text, status text not null default 'not_started', sort bigint not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), completed_at timestamptz,
  priority text not null default 'medium', owner_id uuid default auth.uid(), due_at timestamptz, due_all_day boolean not null default true, overdue_notified_at timestamptz, project_id uuid, milestone_id uuid, parent_id uuid,
  category text, start_date date, follow_up_at timestamptz, progress smallint not null default 0, next_action text, completion_criteria jsonb not null default '[]', waiting_on text, waiting_on_contact_id uuid,
  waiting_for text, blocker text, blocker_impact text, unblock_action text, recurrence text, recurrence_parent_id uuid, cancelled_reason text, deleted_at timestamptz, due_soon_for timestamptz, followup_reminded_for timestamptz);
create table public.task_dependencies (task_id uuid not null, depends_on_id uuid not null, created_by uuid, created_at timestamptz not null default now(), primary key (task_id, depends_on_id));
create table public.task_comments (id uuid primary key default gen_random_uuid(), author_id uuid default auth.uid(), task_id uuid not null, body text not null, kind text not null default 'note', created_at timestamptz not null default now());
create table public.activity (id bigint generated always as identity primary key, workspace_id uuid, entity_type text not null, entity_id uuid not null, actor_id uuid, action text not null,
  changes jsonb not null default '{}', note text, created_at timestamptz not null default now());
create table public.notifications (id uuid primary key default gen_random_uuid(), user_id uuid not null, kind text not null, title text not null, body text not null default '', url text, task_id uuid,
  workspace_id uuid, actor_id uuid, read_at timestamptz, created_at timestamptz not null default now(), follow_up_id uuid);
create table public.follow_ups (id uuid primary key default gen_random_uuid(), workspace_id uuid not null, task_id uuid, project_id uuid, contact_id uuid, counterpart text, subject text not null,
  direction text not null default 'they_owe', last_contact_at date, expected_at date, next_follow_up_at timestamptz, escalate_at date, status text not null default 'open', notes text, document_url text,
  owner_id uuid, reminded_for timestamptz, closed_at timestamptz, created_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table public.follow_up_logs (id uuid primary key default gen_random_uuid(), follow_up_id uuid not null, body text not null, contacted_at timestamptz not null default now(), author_id uuid, created_at timestamptz not null default now());
create function public.actor_name() returns text language sql stable as $$ select 'Someone' $$;
create function public.next_occurrence(t timestamptz, r text) returns timestamptz language sql immutable as $$ select t + interval '1 day' $$;
-- stand-ins for the production trigger functions (marked so a rollback test can see they were restored)
create function public.tasks_before_write() returns trigger language plpgsql set search_path = '' as $$ begin /* ORIGINAL-BEFORE */ new.updated_at := now(); return new; end $$;
create function public.tasks_after_write() returns trigger language plpgsql set search_path = '' as $$ begin /* ORIGINAL-AFTER */ return new; end $$;
create function public.follow_ups_before_write() returns trigger language plpgsql set search_path = '' as $$ begin /* ORIGINAL-FU */ new.updated_at := now(); return new; end $$;
create trigger tasks_before_write before insert or update on public.tasks for each row execute function public.tasks_before_write();
create trigger tasks_after_write after insert or update on public.tasks for each row execute function public.tasks_after_write();
create trigger follow_ups_before_write before insert or update on public.follow_ups for each row execute function public.follow_ups_before_write();
create function public.reopen_task(p_task uuid, p_reason text, p_status text default 'in_progress') returns void language plpgsql as $$
begin perform set_config('app.reopen_reason', trim(p_reason), true); update public.tasks set status = p_status where id = p_task; end $$;
create schema if not exists private;
create table if not exists private.migration_snapshots (migration text not null, object text not null, definition text not null, saved_at timestamptz not null default now(), primary key (migration, object));
create or replace function public.is_ws_member(ws uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspace_members where workspace_id = ws and user_id = (select auth.uid())) $$;
create or replace function public.can_write_ws(ws uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspace_members where workspace_id = ws and user_id = (select auth.uid()) and role in ('owner','member')) $$;
create or replace function cron.unschedule(n text) returns boolean language sql as $$ select true $$;
create table if not exists private.settings (key text primary key, value text not null);
insert into private.settings values ('push_url', 'https://example.invalid/functions/v1/send-push'), ('push_secret', 'test-secret') on conflict do nothing;
create table public.push_subscriptions (id uuid primary key default gen_random_uuid(), user_id uuid not null, endpoint text not null, p256dh text, auth text, user_agent text, created_at timestamptz not null default now());
create schema if not exists net;
create table if not exists net.calls (id bigserial primary key, url text, body jsonb, at timestamptz default now());
create or replace function net.http_post(url text, body jsonb, headers jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ insert into net.calls (url, body) values (url, body) returning id $$;
create function public.dispatch_push() returns trigger language plpgsql security definer set search_path = '' as $$ begin /* ORIGINAL-PUSH */ return new; end $$;
create trigger notifications_push after insert on public.notifications for each row execute function public.dispatch_push();
