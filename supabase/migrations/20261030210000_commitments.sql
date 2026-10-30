-- Increment 2: follow-ups become full commitments. Adds internal/external, what exactly is expected, the actual response,
-- and an outcome that must be recorded to close. Completing a related task still never closes a commitment.
insert into private.migration_snapshots (migration, object, definition) values
  ('20261030210000', 'public.follow_ups_before_write()', pg_get_functiondef('public.follow_ups_before_write()'::regprocedure))
  on conflict do nothing;

alter table public.follow_ups
  add column commitment_type text not null default 'external' check (commitment_type in ('external','internal')),
  add column expectation text check (expectation is null or char_length(expectation) <= 2000),
  add column response text check (response is null or char_length(response) <= 4000),
  add column response_at date,
  add column outcome text check (outcome in ('fulfilled','partly_fulfilled','not_fulfilled','renegotiated','no_longer_needed')),
  add column outcome_note text check (outcome_note is null or char_length(outcome_note) <= 2000);

create or replace function public.follow_ups_before_write()
 returns trigger language plpgsql security definer set search_path to ''
as $function$
begin
  new.updated_at := now();
  if new.status in ('closed','cancelled') and (tg_op = 'INSERT' or old.status not in ('closed','cancelled')) then
    if new.status = 'closed' and new.outcome is null then
      raise exception 'outcome_required: record the outcome (fulfilled, partly, not fulfilled, renegotiated or no longer needed) before closing';
    end if;
    if new.status = 'cancelled' and char_length(coalesce(trim(new.outcome_note), '')) < 3 then
      raise exception 'cancel_reason_required: say why this commitment is cancelled';
    end if;
    if new.status = 'cancelled' and new.outcome is null then new.outcome := 'no_longer_needed'; end if;
    new.closed_at := now();
  end if;
  if new.status in ('open','escalated') then
    new.closed_at := null;
    if tg_op = 'UPDATE' and old.status in ('closed','cancelled') then new.outcome := null; new.outcome_note := null; end if; -- reopened: the old outcome stays in the audit history
  end if;
  if new.response_at is not null and new.response_at > (now() at time zone 'utc')::date + 1 then
    raise exception 'response_in_future: the response date can''t be in the future';
  end if;
  if tg_op = 'UPDATE' and new.next_follow_up_at is distinct from old.next_follow_up_at then new.reminded_for := null; end if;
  return new;
end $function$;
