-- Tasks as milestones: every task keeps its original target (baseline) and an actual completion date,
-- so a project's tasks read as a timeline: baseline -> target -> actual -> delay.
alter table public.tasks
  add column if not exists baseline_due_at timestamptz,
  add column if not exists actual_date date,
  add column if not exists due_today_for timestamptz;

comment on column public.tasks.baseline_due_at is 'Original target: the first deadline ever set. Frozen; reset only via rebaseline_task().';
comment on column public.tasks.actual_date is 'Day the task was actually completed (Qatar date). Set on completion, editable, cleared on reopen.';

-- Backfill existing rows without firing audit/calendar triggers.
alter table public.tasks disable trigger user;
update public.tasks set baseline_due_at = due_at where baseline_due_at is null and due_at is not null;
update public.tasks set actual_date = (completed_at at time zone 'Asia/Qatar')::date where status = 'completed' and actual_date is null and completed_at is not null;
alter table public.tasks enable trigger user;

-- Runs after tasks_before_write (triggers fire in name order).
create or replace function public.tasks_zz_dates() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_today date := (now() at time zone 'Asia/Qatar')::date; v_owner uuid; v_by uuid := (select auth.uid()); v_ws text; v_days int;
begin
  -- baseline: the first target ever set, then frozen (rebaseline_task sets app.task_rebaseline = on)
  if tg_op = 'INSERT' then
    new.baseline_due_at := coalesce(new.baseline_due_at, new.due_at);
  elsif coalesce(current_setting('app.task_rebaseline', true), '') = 'on' then
    new.baseline_due_at := new.due_at;
  else
    new.baseline_due_at := coalesce(old.baseline_due_at, new.due_at);
  end if;

  -- actual completion date
  if new.status = 'completed' then
    new.actual_date := coalesce(new.actual_date, (coalesce(new.completed_at, now()) at time zone 'Asia/Qatar')::date);
    if new.actual_date > v_today then raise exception 'actual_in_future: the actual completion date can''t be in the future'; end if;
  else
    new.actual_date := null;
  end if;

  if tg_op = 'UPDATE' and new.due_at is distinct from old.due_at then
    new.due_today_for := null;
    -- someone else pushed your target later: tell the owner
    v_owner := coalesce(new.owner_id, new.created_by);
    if old.due_at is not null and new.due_at > old.due_at and v_by is not null and v_by <> v_owner and new.status not in ('completed','cancelled') then
      select name into v_ws from public.workspaces where id = new.workspace_id;
      v_days := (new.due_at at time zone 'Asia/Qatar')::date - (old.due_at at time zone 'Asia/Qatar')::date;
      insert into public.notifications (user_id, kind, title, body, url, task_id, workspace_id)
      values (v_owner, 'slipped', 'Target moved: ' || left(new.title, 80),
              coalesce(v_ws, '') || ' — target moved ' || to_char(old.due_at at time zone 'Asia/Qatar', 'DD Mon') || ' → ' || to_char(new.due_at at time zone 'Asia/Qatar', 'DD Mon')
              || case when v_days > 0 then ' (+' || v_days || 'd)' else '' end,
              '/#/t/' || new.id, new.id, new.workspace_id);
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.tasks_zz_dates() from public, anon, authenticated;
drop trigger if exists tasks_zz_dates on public.tasks;
create trigger tasks_zz_dates before insert or update on public.tasks for each row execute function public.tasks_zz_dates();

-- Make today's target the new baseline (e.g. after the client agrees a new plan).
create or replace function public.rebaseline_task(p_task uuid) returns void language plpgsql security invoker set search_path = '' as $$
begin
  perform set_config('app.task_rebaseline', 'on', true);
  update public.tasks set baseline_due_at = due_at where id = p_task;
  if not found then raise exception 'not_found: task not found or not editable'; end if;
  perform set_config('app.task_rebaseline', '', true);
end $$;
revoke execute on function public.rebaseline_task(uuid) from public, anon;
grant execute on function public.rebaseline_task(uuid) to authenticated;

-- Reminders: adds "due today" (from 08:00 Qatar on the target day) and days-late in the overdue alert.
create or replace function public.run_reminders() returns jsonb language plpgsql security definer set search_path = '' as $function$
declare r record; n_over int := 0; n_soon int := 0; n_today int := 0; n_tfu int := 0; n_fu int := 0; n_esc int := 0;
  v_local timestamp := now() at time zone 'Asia/Qatar'; v_days int;
begin
  for r in select t.id, t.title, t.workspace_id, t.due_at, coalesce(t.owner_id, t.created_by) as uid, w.name as ws, p.name as proj
           from public.tasks t join public.workspaces w on w.id = t.workspace_id left join public.projects p on p.id = t.project_id
           where t.deleted_at is null and t.status not in ('completed','cancelled') and t.due_at < now() and not w.archived
             and (t.overdue_notified_at is null or t.overdue_notified_at < now() - interval '24 hours')
           for update of t skip locked loop
    v_days := v_local::date - (r.due_at at time zone 'Asia/Qatar')::date;
    insert into public.notifications (user_id, kind, title, body, url, task_id, workspace_id)
    values (r.uid, 'overdue', case when v_days > 0 then v_days || 'd late: ' else 'Overdue: ' end || left(r.title, 80),
            r.ws || coalesce(' · ' || r.proj, '') || ' — target was ' || to_char(r.due_at at time zone 'Asia/Qatar', 'Dy DD Mon')
            || case when v_days > 0 then ', now ' || v_days || ' day' || case when v_days = 1 then '' else 's' end || ' late.' else '. Please complete it.' end,
            '/#/t/' || r.id, r.id, r.workspace_id);
    update public.tasks set overdue_notified_at = now() where id = r.id;
    n_over := n_over + 1;
  end loop;
  for r in select t.id, t.title, t.workspace_id, t.due_at, coalesce(t.owner_id, t.created_by) as uid, w.name as ws, p.name as proj
           from public.tasks t join public.workspaces w on w.id = t.workspace_id left join public.projects p on p.id = t.project_id
           where t.deleted_at is null and t.status not in ('completed','cancelled') and not w.archived
             and t.due_at > now() and t.due_at <= now() + interval '24 hours' and t.due_soon_for is distinct from t.due_at
             and (t.due_at at time zone 'Asia/Qatar')::date > v_local::date
           for update of t skip locked loop
    insert into public.notifications (user_id, kind, title, body, url, task_id, workspace_id)
    values (r.uid, 'due_soon', 'Due tomorrow: ' || left(r.title, 80), r.ws || coalesce(' · ' || r.proj, '') || ' — target ' || to_char(r.due_at at time zone 'Asia/Qatar', 'Dy DD Mon'), '/#/t/' || r.id, r.id, r.workspace_id);
    update public.tasks set due_soon_for = r.due_at where id = r.id;
    n_soon := n_soon + 1;
  end loop;
  if extract(hour from v_local) >= 8 then
    for r in select t.id, t.title, t.workspace_id, t.due_at, t.due_all_day, coalesce(t.owner_id, t.created_by) as uid, w.name as ws, p.name as proj
             from public.tasks t join public.workspaces w on w.id = t.workspace_id left join public.projects p on p.id = t.project_id
             where t.deleted_at is null and t.status not in ('completed','cancelled') and not w.archived
               and t.due_at >= now() and (t.due_at at time zone 'Asia/Qatar')::date = v_local::date and t.due_today_for is distinct from t.due_at
             for update of t skip locked loop
      insert into public.notifications (user_id, kind, title, body, url, task_id, workspace_id)
      values (r.uid, 'due_soon', 'Due today: ' || left(r.title, 80), r.ws || coalesce(' · ' || r.proj, '') || ' — target is today' || case when r.due_all_day then '' else ' at ' || to_char(r.due_at at time zone 'Asia/Qatar', 'HH24:MI') end || '.', '/#/t/' || r.id, r.id, r.workspace_id);
      update public.tasks set due_today_for = r.due_at, due_soon_for = r.due_at where id = r.id;
      n_today := n_today + 1;
    end loop;
  end if;
  for r in select t.id, t.title, t.workspace_id, t.follow_up_at, t.waiting_on, coalesce(t.owner_id, t.created_by) as uid, w.name as ws
           from public.tasks t join public.workspaces w on w.id = t.workspace_id
           where t.deleted_at is null and t.status not in ('completed','cancelled') and t.follow_up_at <= now()
             and t.followup_reminded_for is distinct from t.follow_up_at
           for update of t skip locked loop
    insert into public.notifications (user_id, kind, title, body, url, task_id, workspace_id)
    values (r.uid, 'follow_up', 'Follow up: ' || left(r.title, 80), r.ws || coalesce(' — waiting on ' || r.waiting_on, '') || '. Time to chase.', '/#/t/' || r.id, r.id, r.workspace_id);
    update public.tasks set followup_reminded_for = r.follow_up_at where id = r.id;
    n_tfu := n_tfu + 1;
  end loop;
  for r in select f.id, f.subject, f.workspace_id, f.next_follow_up_at, coalesce(c.name, f.counterpart) as party, coalesce(f.owner_id, f.created_by) as uid, w.name as ws
           from public.follow_ups f join public.workspaces w on w.id = f.workspace_id left join public.contacts c on c.id = f.contact_id
           where f.status in ('open','escalated') and f.next_follow_up_at <= now() and f.reminded_for is distinct from f.next_follow_up_at
           for update of f skip locked loop
    insert into public.notifications (user_id, kind, title, body, url, follow_up_id, workspace_id)
    values (r.uid, 'follow_up', 'Follow up with ' || left(coalesce(r.party, 'contact'), 60), r.ws || ' — ' || left(r.subject, 120), '/#/f/' || r.id, r.id, r.workspace_id);
    update public.follow_ups set reminded_for = r.next_follow_up_at where id = r.id;
    n_fu := n_fu + 1;
  end loop;
  for r in select f.id, f.subject, f.workspace_id, coalesce(c.name, f.counterpart) as party, coalesce(f.owner_id, f.created_by) as uid, w.name as ws
           from public.follow_ups f join public.workspaces w on w.id = f.workspace_id left join public.contacts c on c.id = f.contact_id
           where f.status = 'open' and f.escalate_at <= v_local::date
           for update of f skip locked loop
    update public.follow_ups set status = 'escalated' where id = r.id;
    insert into public.notifications (user_id, kind, title, body, url, follow_up_id, workspace_id)
    values (r.uid, 'escalation', 'Escalate: ' || left(coalesce(r.party, 'no response'), 60), r.ws || ' — no response on "' || left(r.subject, 100) || '". Escalate or change approach.', '/#/f/' || r.id, r.id, r.workspace_id);
    n_esc := n_esc + 1;
  end loop;
  return jsonb_build_object('overdue', n_over, 'due_soon', n_soon, 'due_today', n_today, 'task_follow_ups', n_tfu, 'follow_ups', n_fu, 'escalations', n_esc);
end $function$;
