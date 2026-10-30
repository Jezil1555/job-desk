-- Phase 4: calendar feed (read-only iCal link) and AI assistant plumbing.
-- Additive only. Nothing here sends messages or changes records on its own.

-- ===================================================================== calendar feed
-- One private feed per user. Only a SHA-256 hash of the token is stored; the token itself is shown once.
create table public.calendar_feeds (
  user_id uuid primary key references auth.users(id) on delete cascade,
  token_hash text not null unique,
  include_finance boolean not null default false,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
alter table public.calendar_feeds enable row level security;
create policy "calendar feed: own row" on public.calendar_feeds for select to authenticated using (user_id = (select auth.uid()));
-- no insert/update/delete policies: changed only through the functions below

create or replace function public.create_calendar_feed(p_include_finance boolean default false) returns text
language plpgsql security definer set search_path = '' as $$
declare v_token text; v_uid uuid := (select auth.uid());
begin
  if v_uid is null then raise exception 'forbidden'; end if;
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.calendar_feeds (user_id, token_hash, include_finance) values (v_uid, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), coalesce(p_include_finance, false))
    on conflict (user_id) do update set token_hash = excluded.token_hash, include_finance = excluded.include_finance, created_at = now(), last_used_at = null;
  return v_token; -- shown to the person once; a new call replaces (and so revokes) the old link
end $$;
create or replace function public.revoke_calendar_feed() returns void language sql security definer set search_path = '' as $$
  delete from public.calendar_feeds where user_id = (select auth.uid());
$$;

-- Events for a feed token. Called only by the calendar-feed edge function (service role).
create or replace function public.calendar_feed_events(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare f public.calendar_feeds; v jsonb;
begin
  select * into f from public.calendar_feeds where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex');
  if not found then return null; end if;
  update public.calendar_feeds set last_used_at = now() where user_id = f.user_id;
  with ws as (select workspace_id from public.workspace_members where user_id = f.user_id),
  ev as (
    -- my open tasks with a deadline
    select 'task-due-' || t.id as uid, 'Due: ' || t.title as title, t.due_at as at, t.due_all_day as all_day,
           coalesce(w.name, '') || case when t.next_action is not null then E'\nNext: ' || t.next_action else '' end as description, '/#/t/' || t.id as url
      from public.tasks t join public.workspaces w on w.id = t.workspace_id
      where t.workspace_id in (select workspace_id from ws) and t.deleted_at is null and t.status not in ('completed','cancelled') and t.due_at is not null
        and coalesce(t.owner_id, t.created_by) = f.user_id and not w.archived
    union all
    -- my task follow-ups
    select 'task-fu-' || t.id, 'Follow up: ' || t.title, t.follow_up_at, false,
           coalesce(w.name, '') || case when t.waiting_on is not null then E'\nWaiting on: ' || t.waiting_on else '' end, '/#/t/' || t.id
      from public.tasks t join public.workspaces w on w.id = t.workspace_id
      where t.workspace_id in (select workspace_id from ws) and t.deleted_at is null and t.status not in ('completed','cancelled') and t.follow_up_at is not null
        and coalesce(t.owner_id, t.created_by) = f.user_id and not w.archived
    union all
    -- follow-up tracker items I own
    select 'fu-' || x.id, 'Chase: ' || x.subject || coalesce(' (' || coalesce(c.name, x.counterpart) || ')', ''), x.next_follow_up_at, false, w.name, '/#/f/' || x.id
      from public.follow_ups x join public.workspaces w on w.id = x.workspace_id left join public.contacts c on c.id = x.contact_id
      where x.workspace_id in (select workspace_id from ws) and x.status in ('open','escalated') and x.next_follow_up_at is not null and x.owner_id = f.user_id and not w.archived
    union all
    -- upcoming milestones in my workspaces
    select 'ms-' || m.id, 'Milestone: ' || m.title || ' — ' || p.name, m.planned_date::timestamptz, true, w.name, '/#/p/' || p.id
      from public.milestones m join public.projects p on p.id = m.project_id join public.workspaces w on w.id = p.workspace_id
      where p.workspace_id in (select workspace_id from ws) and m.actual_date is null and m.planned_date is not null and not p.archived and not w.archived
    union all
    -- bills due (only if the person chose to include finance, and only books they keep)
    select 'bill-' || i.id, 'Bill due: ' || coalesce(pa.name, '') || ' ' || coalesce(i.number, ''), i.due_date::timestamptz, true,
           e.name || ' · ' || e.base_currency || ' ' || to_char(t.total - t.paid, 'FM999,999,990.00') || ' outstanding', '/#/finance/' || e.id || '/bills'
      from public.fin_invoices i join public.fin_entities e on e.id = i.entity_id join public.fin_members fm on fm.entity_id = e.id and fm.user_id = f.user_id and fm.role in ('owner','bookkeeper')
        left join public.fin_parties pa on pa.id = i.party_id
        join lateral (select coalesce(sum(l.amount),0) total, coalesce((select sum(a.amount) from public.fin_allocations a join public.fin_payments py on py.id = a.payment_id where a.invoice_id = i.id and py.status = 'posted'),0) paid
                      from public.fin_invoice_lines l where l.invoice_id = i.id) t on true
      where f.include_finance and i.kind = 'purchase' and i.status = 'posted' and i.due_date is not null and t.total > t.paid and not e.archived
  )
  select coalesce(jsonb_agg(jsonb_build_object('uid', uid, 'title', title, 'at', at, 'all_day', all_day, 'description', description, 'url', url) order by at), '[]'::jsonb) into v
    from ev where at > now() - interval '60 days' and at < now() + interval '400 days';
  return jsonb_build_object('user_id', f.user_id, 'tz', (select timezone from public.profiles where id = f.user_id), 'events', v);
end $$;
revoke execute on function public.calendar_feed_events(text) from public, anon, authenticated;
revoke execute on function public.create_calendar_feed(boolean), public.revoke_calendar_feed() from public, anon;
grant execute on function public.create_calendar_feed(boolean), public.revoke_calendar_feed() to authenticated;
grant execute on function public.calendar_feed_events(text) to service_role;

-- ===================================================================== AI assistant
-- Opt-in per person (profiles.prefs.ai_enabled). The assistant only returns suggestions; it cannot write records.
-- Usage is logged without any content, for a daily limit and transparency.
create table public.ai_usage (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  input_tokens int, output_tokens int,
  ok boolean not null default true,
  created_at timestamptz not null default now()
);
create index on public.ai_usage (user_id, created_at desc);
alter table public.ai_usage enable row level security;
create policy "ai usage: own rows" on public.ai_usage for select to authenticated using (user_id = (select auth.uid()));
