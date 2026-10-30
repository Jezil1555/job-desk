-- Increment 5: reliable notifications. Every phone push has a delivery record (idempotent per notification + reason),
-- failed pushes are retried with backoff by a server job, and alerts can be snoozed — they come back (and push again) at the chosen time.
insert into private.migration_snapshots (migration, object, definition) values
  ('20261030240000', 'public.dispatch_push()', pg_get_functiondef('public.dispatch_push()'::regprocedure)) on conflict do nothing;

alter table public.notifications add column snoozed_until timestamptz, add column snooze_count int not null default 0;

create table public.notification_deliveries (
  id bigint generated always as identity primary key,
  notification_id uuid not null references public.notifications(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null default 'push' check (channel = 'push'),
  attempt_key text not null default 'initial',           -- 'initial', or 'snooze-N' when a snoozed alert returns
  status text not null default 'pending' check (status in ('pending','sent','failed','no_device','gave_up')),
  attempts int not null default 0,
  next_attempt_at timestamptz,
  last_error text,
  devices_sent int,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (notification_id, channel, attempt_key)
);
create index on public.notification_deliveries (next_attempt_at) where status in ('pending','failed');
alter table public.notification_deliveries enable row level security;
create policy "deliveries: own rows" on public.notification_deliveries for select to authenticated using (user_id = (select auth.uid()));

-- queue one push (idempotent): records the delivery and hands it to the send-push function
create or replace function public.queue_push(p_notification uuid, p_attempt_key text default 'initial') returns bigint language plpgsql security definer set search_path = '' as $$
declare v_url text; v_secret text; v_user uuid; v_id bigint;
begin
  select user_id into v_user from public.notifications where id = p_notification;
  if v_user is null then return null; end if;
  if not exists (select 1 from public.push_subscriptions where user_id = v_user) then
    insert into public.notification_deliveries (notification_id, user_id, attempt_key, status) values (p_notification, v_user, p_attempt_key, 'no_device')
      on conflict (notification_id, channel, attempt_key) do nothing;
    return null;
  end if;
  insert into public.notification_deliveries (notification_id, user_id, attempt_key, status, next_attempt_at) values (p_notification, v_user, p_attempt_key, 'pending', now() + interval '3 minutes')
    on conflict (notification_id, channel, attempt_key) do nothing returning id into v_id;
  if v_id is null then return null; end if; -- already queued for this reason
  select value into v_url from private.settings where key = 'push_url';
  select value into v_secret from private.settings where key = 'push_secret';
  if v_url is null then return v_id; end if;
  perform net.http_post(url := v_url, body := jsonb_build_object('notification_id', p_notification, 'delivery_id', v_id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', v_secret), timeout_milliseconds := 30000);
  return v_id;
end $$;

create or replace function public.dispatch_push() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.queue_push(new.id, 'initial');
  return new;
end $$;

-- retry job: re-sends deliveries whose attempt failed or never reported back; gives up after 5 attempts
create or replace function public.retry_push_deliveries() returns int language plpgsql security definer set search_path = '' as $$
declare d record; v_url text; v_secret text; n int := 0;
begin
  update public.notification_deliveries set status = 'gave_up', next_attempt_at = null, last_error = coalesce(last_error, 'no response')
    where status in ('pending','failed') and attempts >= 5 and next_attempt_at <= now();
  select value into v_url from private.settings where key = 'push_url';
  select value into v_secret from private.settings where key = 'push_secret';
  if v_url is null then return 0; end if;
  for d in select * from public.notification_deliveries where status in ('pending','failed') and attempts < 5 and next_attempt_at <= now() order by next_attempt_at limit 50 for update skip locked loop
    update public.notification_deliveries set status = 'pending', next_attempt_at = now() + interval '3 minutes' where id = d.id;
    perform net.http_post(url := v_url, body := jsonb_build_object('notification_id', d.notification_id, 'delivery_id', d.id),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', v_secret), timeout_milliseconds := 30000);
    n := n + 1;
  end loop;
  return n;
end $$;

-- snooze: hide an alert until a time (max 30 days); it returns unread and pushes again then
create or replace function public.snooze_notification(p_notification uuid, p_until timestamptz) returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_until is null or p_until <= now() + interval '1 minute' or p_until > now() + interval '30 days' then
    raise exception 'bad_time: choose a time between now and 30 days ahead';
  end if;
  update public.notifications set snoozed_until = p_until, read_at = coalesce(read_at, now()), snooze_count = snooze_count + 1
    where id = p_notification and user_id = (select auth.uid());
  if not found then raise exception 'not_found: alert not found'; end if;
end $$;
create or replace function public.release_snoozed_notifications() returns int language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0;
begin
  for r in select id, snooze_count from public.notifications where snoozed_until is not null and snoozed_until <= now() for update skip locked loop
    update public.notifications set snoozed_until = null, read_at = null, created_at = now() where id = r.id;
    perform public.queue_push(r.id, 'snooze-' || r.snooze_count);
    n := n + 1;
  end loop;
  return n;
end $$;

revoke execute on function public.queue_push(uuid, text), public.retry_push_deliveries(), public.release_snoozed_notifications(), public.dispatch_push() from public, anon, authenticated;
revoke execute on function public.snooze_notification(uuid, timestamptz) from public, anon;
grant execute on function public.snooze_notification(uuid, timestamptz) to authenticated;
select cron.schedule('jobdesk-push-retry', '*/2 * * * *', $$select public.retry_push_deliveries()$$);
select cron.schedule('jobdesk-snooze-release', '* * * * *', $$select public.release_snoozed_notifications()$$);
