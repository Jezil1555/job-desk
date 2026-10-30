-- Live Google Calendar sync for tasks: when a task's deadline or follow-up changes, the gcal-sync edge function
-- creates, updates or removes the matching event in the owner's Google Calendar (only for people who connected Google).
-- Google refresh tokens live in a table nobody can read through the API (RLS on, no policies, no grants).

create table public.calendar_sync (
  user_id uuid primary key references auth.users(id) on delete cascade,
  provider text not null default 'google' check (provider = 'google'),
  google_email text,
  calendar_id text not null default 'primary',
  status text not null default 'connected' check (status in ('connected','error')),
  last_error text,
  last_synced_at timestamptz,
  connected_at timestamptz not null default now()
);
alter table public.calendar_sync enable row level security;
create policy "calendar sync: own row" on public.calendar_sync for select to authenticated using (user_id = (select auth.uid()));
-- written only by the edge function (service role)

create table public.gcal_tokens (
  user_id uuid primary key references auth.users(id) on delete cascade,
  refresh_token text not null,
  updated_at timestamptz not null default now()
);
alter table public.gcal_tokens enable row level security;
revoke all on public.gcal_tokens from anon, authenticated;

-- shared secret between the database and the edge function
insert into private.settings (key, value) values ('gcal_secret', encode(extensions.gen_random_bytes(32), 'hex')) on conflict (key) do nothing;
insert into private.settings (key, value)
  select 'gcal_url', replace(value, '/functions/v1/send-push', '/functions/v1/gcal-sync/task') from private.settings where key = 'push_url'
  on conflict (key) do nothing;

create or replace function public.get_gcal_config() returns json language sql stable security definer set search_path = '' as $$
  select json_object_agg(key, value) from private.settings where key in ('gcal_secret');
$$;
revoke execute on function public.get_gcal_config() from public, anon, authenticated;
grant execute on function public.get_gcal_config() to service_role;

-- hand changed tasks to the edge function (old and new owner, so a reassigned task moves calendars)
create or replace function public.dispatch_gcal() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_url text; v_secret text; v_users uuid[]; v_id uuid;
begin
  v_id := coalesce(new.id, old.id);
  select array_agg(distinct u) into v_users from unnest(array[
      case when tg_op <> 'DELETE' then coalesce(new.owner_id, new.created_by) end,
      case when tg_op <> 'INSERT' then coalesce(old.owner_id, old.created_by) end]) u
    where u is not null and exists (select 1 from public.calendar_sync s where s.user_id = u and s.status = 'connected');
  if v_users is null then return coalesce(new, old); end if;
  if tg_op = 'INSERT' and new.due_at is null and new.follow_up_at is null then return new; end if;
  select value into v_url from private.settings where key = 'gcal_url';
  select value into v_secret from private.settings where key = 'gcal_secret';
  if v_url is null then return coalesce(new, old); end if;
  perform net.http_post(url := v_url, body := jsonb_build_object('task_id', v_id, 'users', to_jsonb(v_users)),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-gcal-secret', v_secret), timeout_milliseconds := 30000);
  return coalesce(new, old);
end $$;
revoke execute on function public.dispatch_gcal() from public, anon, authenticated;
create trigger tasks_gcal_ins after insert on public.tasks for each row execute function public.dispatch_gcal();
create trigger tasks_gcal_upd after update of title, due_at, due_all_day, follow_up_at, status, owner_id, deleted_at, next_action, waiting_on, workspace_id on public.tasks
  for each row when (old.* is distinct from new.*) execute function public.dispatch_gcal();
create trigger tasks_gcal_del after delete on public.tasks for each row execute function public.dispatch_gcal();
