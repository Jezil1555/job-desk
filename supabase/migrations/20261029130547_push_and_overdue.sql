create extension if not exists pg_net;
create extension if not exists pg_cron;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table private.settings (key text primary key, value text not null);
-- NOTE: private.settings rows (vapid_public, vapid_private, push_secret, push_url) are secrets.
-- They are inserted manually per environment and are never committed to this repository.

-- read by the send-push edge function (service role only)
create or replace function public.get_push_config()
returns json language sql stable security definer set search_path = '' as $$
  select json_object_agg(key, value) from private.settings where key in ('vapid_public','vapid_private','push_secret');
$$;
revoke execute on function public.get_push_config() from public, anon, authenticated;
grant execute on function public.get_push_config() to service_role;

-- every new notification is handed to the edge function, which sends the phone push
create or replace function public.dispatch_push()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_url text; v_secret text;
begin
  select value into v_url from private.settings where key = 'push_url';
  select value into v_secret from private.settings where key = 'push_secret';
  if v_url is null or not exists (select 1 from public.push_subscriptions where user_id = new.user_id) then return new; end if;
  perform net.http_post(url := v_url, body := jsonb_build_object('notification_id', new.id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', v_secret), timeout_milliseconds := 8000);
  return new;
end $$;
revoke execute on function public.dispatch_push() from public, anon, authenticated;
create trigger notifications_push after insert on public.notifications for each row execute function public.dispatch_push();

-- overdue reminders: first when the deadline passes, then once a day until done
create or replace function public.notify_overdue()
returns int language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0;
begin
  for r in
    select t.id, t.title, t.project_id, coalesce(t.assignee_id, t.user_id) as recipient, p.name as project
    from public.tasks t join public.projects p on p.id = t.project_id
    where t.status <> 'done' and t.due_at is not null and t.due_at < now() and not p.archived
      and (t.overdue_notified_at is null or t.overdue_notified_at < now() - interval '24 hours')
    for update of t skip locked
  loop
    insert into public.notifications (user_id, kind, title, body, url, task_id, project_id)
    values (r.recipient, 'overdue', 'Overdue: ' || left(r.title, 80), r.project || ' — "' || left(r.title, 80) || '" is overdue. Please complete it.',
            '/#/p/' || r.project_id || '?task=' || r.id, r.id, r.project_id);
    update public.tasks set overdue_notified_at = now() where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.notify_overdue() from public, anon, authenticated;

select cron.schedule('jobdesk-overdue', '*/10 * * * *', $$select public.notify_overdue()$$);
