-- Increment 4: AI governance log. Every suggestion the assistant returns is recorded (its output, never the text you sent),
-- and what you did with it — accepted, accepted with edits, or rejected — is appended with a timestamp. Suggestions never
-- acted on expire after 14 days. The assistant itself still cannot change any record; it only writes this log.
create table public.ai_proposals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null check (action in ('draft_message','action_items','weekly_narrative','categorize')),
  target_type text check (target_type in ('task','follow_up','note','weekly_review','fin_account')),
  target_id uuid,
  proposal jsonb not null,
  model text,
  status text not null default 'proposed' check (status in ('proposed','accepted','edited','rejected','expired')),
  decisions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index on public.ai_proposals (user_id, created_at desc);
create index on public.ai_proposals (status, created_at) where status = 'proposed';
alter table public.ai_proposals enable row level security;
create policy "ai proposals: own rows" on public.ai_proposals for select to authenticated using (user_id = (select auth.uid()));
-- inserted only by the assistant edge function (service role); decisions only through record_ai_decision

create or replace function public.record_ai_decision(p_proposal uuid, p_decision text, p_detail jsonb default null) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.ai_proposals;
begin
  select * into p from public.ai_proposals where id = p_proposal for update;
  if not found or p.user_id is distinct from (select auth.uid()) then raise exception 'not_found: proposal not found'; end if;
  if p_decision not in ('accepted','edited','rejected') then raise exception 'bad_decision'; end if;
  if p.status = 'expired' then raise exception 'expired: this suggestion has expired'; end if;
  update public.ai_proposals set status = p_decision, decided_at = now(),
    decisions = decisions || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('at', now(), 'decision', p_decision, 'detail', p_detail)))
  where id = p_proposal;
end $$;
create or replace function public.expire_ai_proposals() returns int language sql security definer set search_path = '' as $$
  with x as (update public.ai_proposals set status = 'expired', decided_at = now() where status = 'proposed' and created_at < now() - interval '14 days' returning 1)
  select count(*)::int from x;
$$;
revoke execute on function public.record_ai_decision(uuid, text, jsonb), public.expire_ai_proposals() from public, anon, authenticated;
grant execute on function public.record_ai_decision(uuid, text, jsonb) to authenticated;
select cron.schedule('jobdesk-ai-expire', '17 2 * * *', $$select public.expire_ai_proposals()$$);
