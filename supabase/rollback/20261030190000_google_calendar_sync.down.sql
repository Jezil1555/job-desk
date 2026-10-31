-- Undo 20261030190000_google_calendar_sync. Refuses while anyone has Google Calendar connected (their tokens would be lost);
-- disconnect in Settings first. Events already in Google calendars are not touched.
do $$ begin
  if exists (select 1 from public.calendar_sync) or exists (select 1 from public.gcal_tokens) then
    raise exception 'Google Calendar is connected for someone — disconnect first';
  end if;
end $$;
drop trigger if exists tasks_gcal_ins on public.tasks;
drop trigger if exists tasks_gcal_upd on public.tasks;
drop trigger if exists tasks_gcal_del on public.tasks;
drop function if exists public.dispatch_gcal();
drop function if exists public.get_gcal_config();
drop table if exists public.gcal_tokens;
drop table if exists public.calendar_sync;
delete from private.settings where key in ('gcal_secret', 'gcal_url');
