-- Phone pushes: allow 30 s for the send-push function (a cold start can exceed the previous 8 s and drop the push).
create or replace function public.dispatch_push() returns trigger language plpgsql security definer set search_path = '' as $function$
declare v_url text; v_secret text;
begin
  select value into v_url from private.settings where key = 'push_url';
  select value into v_secret from private.settings where key = 'push_secret';
  if v_url is null or not exists (select 1 from public.push_subscriptions where user_id = new.user_id) then return new; end if;
  perform net.http_post(url := v_url, body := jsonb_build_object('notification_id', new.id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', v_secret), timeout_milliseconds := 30000);
  return new;
end $function$;
