-- Undo 20261030240000_notification_delivery: restore the previous push dispatcher; delivery history and snoozes are removed.
-- Deploy the previous send-push function as well.
select cron.unschedule('jobdesk-push-retry');
select cron.unschedule('jobdesk-snooze-release');
do $$ declare d text; begin
  for d in select definition from private.migration_snapshots where migration = '20261030240000' loop execute d; end loop;
end $$;
drop function if exists public.retry_push_deliveries();
drop function if exists public.release_snoozed_notifications();
drop function if exists public.snooze_notification(uuid, timestamptz);
drop function if exists public.queue_push(uuid, text);
drop table if exists public.notification_deliveries;
alter table public.notifications drop column if exists snoozed_until, drop column if exists snooze_count;
delete from private.migration_snapshots where migration = '20261030240000';
