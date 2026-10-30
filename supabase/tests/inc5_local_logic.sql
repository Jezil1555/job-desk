-- Local logic test for increment 5 (net.http_post is a stand-in that records calls).
\set ON_ERROR_STOP on
create temp table r (name text, ok boolean, detail text);
insert into auth.users (id, email) values ('aaaaaaaa-0000-4000-8000-0000000005a5','i5a@example.invalid'), ('bbbbbbbb-0000-4000-8000-0000000005b5','i5b@example.invalid') on conflict do nothing;
insert into public.push_subscriptions (user_id, endpoint) values ('aaaaaaaa-0000-4000-8000-0000000005a5', 'https://push.example/1');
insert into public.notifications (id, user_id, kind, title) values ('0b000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000005a5', 'due', 'Book container');
insert into public.notifications (id, user_id, kind, title) values ('0b000000-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-0000000005b5', 'due', 'No phone');
insert into r select 'new alert queues one push and records it', (select count(*) from net.calls where body->>'notification_id' = '0b000000-0000-4000-8000-000000000001') = 1
  and (select status from public.notification_deliveries where notification_id = '0b000000-0000-4000-8000-000000000001') = 'pending', null;
insert into r select 'person without a device: recorded as no device, nothing sent', (select status from public.notification_deliveries where notification_id = '0b000000-0000-4000-8000-000000000002') = 'no_device'
  and (select count(*) from net.calls where body->>'notification_id' = '0b000000-0000-4000-8000-000000000002') = 0, null;
select public.queue_push('0b000000-0000-4000-8000-000000000001', 'initial');
insert into r select 'queueing the same alert again is ignored (idempotent)', (select count(*) from net.calls where body->>'notification_id' = '0b000000-0000-4000-8000-000000000001') = 1, null;
-- simulate send-push reporting a failure, then time passing
update public.notification_deliveries set status = 'failed', attempts = 1, last_error = '503', next_attempt_at = now() - interval '1 second' where notification_id = '0b000000-0000-4000-8000-000000000001';
create temp table t1 as select public.retry_push_deliveries() n;
insert into r select 'retry job re-sends a failed push', (select n from t1) = 1 and (select count(*) from net.calls where body->>'notification_id' = '0b000000-0000-4000-8000-000000000001') = 2, null;
insert into r select 'not re-sent again while the attempt is in flight', public.retry_push_deliveries() = 0, null;
update public.notification_deliveries set status = 'failed', attempts = 5, next_attempt_at = now() - interval '1 second' where notification_id = '0b000000-0000-4000-8000-000000000001';
select public.retry_push_deliveries();
insert into r select 'gives up after 5 attempts', (select status from public.notification_deliveries where notification_id = '0b000000-0000-4000-8000-000000000001') = 'gave_up', null;
-- snooze
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000005a5"}', false);
do $$ begin perform public.snooze_notification('0b000000-0000-4000-8000-000000000001', now() + interval '40 days'); insert into r values ('snooze longer than 30 days refused', false, 'no error');
exception when others then insert into r values ('snooze longer than 30 days refused', sqlerrm like 'bad_time%', sqlerrm); end $$;
do $$ begin perform public.snooze_notification('0b000000-0000-4000-8000-000000000002', now() + interval '1 hour'); insert into r values ('can''t snooze someone else''s alert', false, 'no error');
exception when others then insert into r values ('can''t snooze someone else''s alert', sqlerrm like 'not_found%', sqlerrm); end $$;
select public.snooze_notification('0b000000-0000-4000-8000-000000000001', now() + interval '1 hour');
insert into r select 'snoozed alert is hidden (marked read) until the time', read_at is not null and snoozed_until > now(), null from public.notifications where id = '0b000000-0000-4000-8000-000000000001';
insert into r select 'nothing released before the snooze time', public.release_snoozed_notifications() = 0, null;
update public.notifications set snoozed_until = now() - interval '1 second' where id = '0b000000-0000-4000-8000-000000000001';
create temp table t2 as select public.release_snoozed_notifications() n;
insert into r select 'snooze ends: alert comes back unread and pushes again', (select n from t2) = 1
  and (select read_at is null and snoozed_until is null from public.notifications where id = '0b000000-0000-4000-8000-000000000001')
  and exists (select 1 from public.notification_deliveries where notification_id = '0b000000-0000-4000-8000-000000000001' and attempt_key = 'snooze-1' and status = 'pending'), null;
select count(*) filter (where ok) || '/' || count(*) || ' passed' || coalesce(' — FAILED: ' || string_agg(name || ' (' || coalesce(detail, '') || ')', '; ') filter (where not ok), '') from r;
