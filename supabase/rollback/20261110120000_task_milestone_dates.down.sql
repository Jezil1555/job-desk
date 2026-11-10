-- Rollback: task baseline / actual dates. run_reminders is restored from 20261029140000/phase migrations' last version (re-apply that definition).
drop trigger if exists tasks_zz_dates on public.tasks;
drop function if exists public.tasks_zz_dates();
drop function if exists public.rebaseline_task(uuid);
alter table public.tasks drop column if exists baseline_due_at, drop column if exists actual_date, drop column if exists due_today_for;
-- previous run_reminders()
CREATE OR REPLACE FUNCTION public.run_reminders() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
declare r record; n_over int := 0; n_soon int := 0; n_tfu int := 0; n_fu int := 0; n_esc int := 0;
begin
  for r in select t.id, t.title, t.workspace_id, coalesce(t.owner_id, t.created_by) as uid, w.name as ws
           from public.tasks t join public.workspaces w on w.id = t.workspace_id
           where t.deleted_at is null and t.status not in ('completed','cancelled') and t.due_at < now() and not w.archived
             and (t.overdue_notified_at is null or t.overdue_notified_at < now() - interval '24 hours')
           for update of t skip locked loop
    insert into public.notifications (user_id, kind, title, body, url, task_id, workspace_id)
    values (r.uid, 'overdue', 'Overdue: ' || left(r.title, 80), r.ws || ' — "' || left(r.title, 80) || '" is overdue. Please complete it.', '/#/t/' || r.id, r.id, r.workspace_id);
    update public.tasks set overdue_notified_at = now() where id = r.id;
    n_over := n_over + 1;
  end loop;
  for r in select t.id, t.title, t.workspace_id, t.due_at, coalesce(t.owner_id, t.created_by) as uid, w.name as ws
           from public.tasks t join public.workspaces w on w.id = t.workspace_id
           where t.deleted_at is null and t.status not in ('completed','cancelled') and not w.archived
             and t.due_at > now() and t.due_at <= now() + interval '24 hours' and t.due_soon_for is distinct from t.due_at
           for update of t skip locked loop
    insert into public.notifications (user_id, kind, title, body, url, task_id, workspace_id)
    values (r.uid, 'due_soon', 'Due soon: ' || left(r.title, 80), r.ws || ' — due ' || to_char(r.due_at at time zone 'Asia/Qatar', 'Dy DD Mon HH24:MI'), '/#/t/' || r.id, r.id, r.workspace_id);
    update public.tasks set due_soon_for = r.due_at where id = r.id;
    n_soon := n_soon + 1;
  end loop;
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
           where f.status = 'open' and f.escalate_at <= (now() at time zone 'Asia/Qatar')::date
           for update of f skip locked loop
    update public.follow_ups set status = 'escalated' where id = r.id;
    insert into public.notifications (user_id, kind, title, body, url, follow_up_id, workspace_id)
    values (r.uid, 'escalation', 'Escalate: ' || left(coalesce(r.party, 'no response'), 60), r.ws || ' — no response on "' || left(r.subject, 100) || '". Escalate or change approach.', '/#/f/' || r.id, r.id, r.workspace_id);
    n_esc := n_esc + 1;
  end loop;
  return jsonb_build_object('overdue', n_over, 'due_soon', n_soon, 'task_follow_ups', n_tfu, 'follow_ups', n_fu, 'escalations', n_esc);
end $function$;
