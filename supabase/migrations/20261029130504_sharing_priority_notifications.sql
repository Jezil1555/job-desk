-- ---------- profiles ----------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text not null default '',
  created_at timestamptz not null default now()
);
create unique index profiles_email_idx on public.profiles (lower(email));

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''), split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

insert into public.profiles (id, email, display_name)
select id, email, split_part(email, '@', 1) from auth.users on conflict do nothing;
update public.profiles set display_name = 'Jezz' where email = 'jezilsiddique555@gmail.com';

-- ---------- project members ----------
create table public.project_members (
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','member')),
  added_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index project_members_user_idx on public.project_members(user_id);
insert into public.project_members (project_id, user_id, role) select id, user_id, 'owner' from public.projects;

create or replace function public.add_project_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.project_members (project_id, user_id, role, added_by) values (new.id, new.user_id, 'owner', new.user_id) on conflict do nothing;
  return new;
end $$;
create trigger projects_add_owner after insert on public.projects for each row execute function public.add_project_owner();

-- ---------- helper checks (security definer to avoid RLS recursion) ----------
create or replace function public.is_project_member(pid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.project_members where project_id = pid and user_id = (select auth.uid()));
$$;
create or replace function public.is_project_owner(pid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.projects where id = pid and user_id = (select auth.uid()));
$$;
create or replace function public.shares_project(other uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.project_members a join public.project_members b on a.project_id = b.project_id
                 where a.user_id = (select auth.uid()) and b.user_id = other);
$$;
create or replace function public.can_see_task(tid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tasks t join public.project_members m on m.project_id = t.project_id
                 where t.id = tid and m.user_id = (select auth.uid()));
$$;

-- ---------- tasks: priority, assignee, due datetime; drop amount ----------
alter table public.tasks
  add column priority text not null default 'medium' check (priority in ('high','medium','low')),
  add column assignee_id uuid references auth.users(id) on delete set null,
  add column due_at timestamptz,
  add column due_all_day boolean not null default true,
  add column overdue_notified_at timestamptz;
update public.tasks set priority = case when urgent then 'high' else 'medium' end,
  due_at = case when due is not null then (due::timestamp + time '23:59') at time zone 'Asia/Qatar' end;
alter table public.tasks drop column urgent, drop column due, drop column amount, drop column amount_settled;
create index tasks_assignee_idx on public.tasks(assignee_id);
create index tasks_due_idx on public.tasks(due_at) where status <> 'done';

create or replace function public.check_task_assignee()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.assignee_id is not null and not exists (select 1 from public.project_members where project_id = new.project_id and user_id = new.assignee_id) then
    raise exception 'Assignee must be a member of the project';
  end if;
  if tg_op = 'UPDATE' and new.due_at is distinct from old.due_at then new.overdue_notified_at := null; end if;
  return new;
end $$;
create trigger tasks_check_assignee before insert or update on public.tasks for each row execute function public.check_task_assignee();

alter table public.task_updates rename column user_id to author_id;

-- ---------- notifications & push ----------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  title text not null,
  body text not null default '',
  url text,
  task_id uuid references public.tasks(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications(user_id, created_at desc);

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now()
);
create index push_subscriptions_user_idx on public.push_subscriptions(user_id);

-- ---------- RLS ----------
drop policy "own projects" on public.projects;
drop policy "own tasks" on public.tasks;
drop policy "own updates" on public.task_updates;

alter table public.profiles enable row level security;
alter table public.project_members enable row level security;
alter table public.notifications enable row level security;
alter table public.push_subscriptions enable row level security;

create policy "see self and co-members" on public.profiles for select to authenticated using (id = (select auth.uid()) or public.shares_project(id));
create policy "edit own profile" on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "members see project" on public.projects for select to authenticated using (user_id = (select auth.uid()) or public.is_project_member(id));
create policy "create own project" on public.projects for insert to authenticated with check (user_id = (select auth.uid()));
create policy "owner edits project" on public.projects for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "owner deletes project" on public.projects for delete to authenticated using (user_id = (select auth.uid()));

create policy "members see members" on public.project_members for select to authenticated using (public.is_project_member(project_id));
create policy "owner removes or member leaves" on public.project_members for delete to authenticated
  using (role <> 'owner' and (public.is_project_owner(project_id) or user_id = (select auth.uid())));

create policy "members see tasks" on public.tasks for select to authenticated using (public.is_project_member(project_id));
create policy "members add tasks" on public.tasks for insert to authenticated with check (user_id = (select auth.uid()) and public.is_project_member(project_id));
create policy "members update tasks" on public.tasks for update to authenticated using (public.is_project_member(project_id)) with check (public.is_project_member(project_id));
create policy "creator or owner deletes task" on public.tasks for delete to authenticated using (user_id = (select auth.uid()) or public.is_project_owner(project_id));

alter table public.task_updates alter column author_id set default auth.uid();
create policy "members see updates" on public.task_updates for select to authenticated using (public.can_see_task(task_id));
create policy "members log updates" on public.task_updates for insert to authenticated with check (author_id = (select auth.uid()) and public.can_see_task(task_id));
create policy "author deletes update" on public.task_updates for delete to authenticated using (author_id = (select auth.uid()));

create policy "own notifications" on public.notifications for select to authenticated using (user_id = (select auth.uid()));
create policy "mark own read" on public.notifications for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "delete own notifications" on public.notifications for delete to authenticated using (user_id = (select auth.uid()));

create policy "own push subs" on public.push_subscriptions for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ---------- member management RPCs ----------
create or replace function public.add_project_member(p_project uuid, p_email text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_user public.profiles;
begin
  if not public.is_project_owner(p_project) then raise exception 'Only the project owner can add people'; end if;
  select * into v_user from public.profiles where lower(email) = lower(trim(p_email));
  if v_user.id is null then raise exception 'not_registered'; end if;
  insert into public.project_members (project_id, user_id, role, added_by) values (p_project, v_user.id, 'member', (select auth.uid())) on conflict do nothing;
  return json_build_object('id', v_user.id, 'email', v_user.email, 'display_name', v_user.display_name);
end $$;
revoke execute on function public.add_project_member(uuid, text) from public, anon;
grant execute on function public.add_project_member(uuid, text) to authenticated;

create or replace function public.unassign_removed_member()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.tasks set assignee_id = null where project_id = old.project_id and assignee_id = old.user_id;
  return old;
end $$;
create trigger project_members_unassign after delete on public.project_members for each row execute function public.unassign_removed_member();

-- ---------- notification triggers ----------
create or replace function public.actor_name()
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select nullif(display_name, '') from public.profiles where id = (select auth.uid())), 'Someone');
$$;

create or replace function public.notify_task_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_project text; v_actor uuid := (select auth.uid());
begin
  select name into v_project from public.projects where id = new.project_id;
  if new.assignee_id is not null and new.assignee_id is distinct from v_actor
     and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id) then
    insert into public.notifications (user_id, kind, title, body, url, task_id, project_id, actor_id)
    values (new.assignee_id, 'assigned', public.actor_name() || ' assigned you a task', v_project || ': ' || new.title,
            '/#/p/' || new.project_id || '?task=' || new.id, new.id, new.project_id, v_actor);
  end if;
  if tg_op = 'UPDATE' and new.status = 'done' and old.status <> 'done' and new.user_id is distinct from v_actor then
    insert into public.notifications (user_id, kind, title, body, url, task_id, project_id, actor_id)
    values (new.user_id, 'completed', public.actor_name() || ' completed a task', v_project || ': ' || new.title,
            '/#/p/' || new.project_id || '?task=' || new.id, new.id, new.project_id, v_actor);
  end if;
  return new;
end $$;
create trigger tasks_notify after insert or update on public.tasks for each row execute function public.notify_task_change();

create or replace function public.notify_task_update()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_task public.tasks; v_project text; v_actor uuid := new.author_id;
begin
  if new.kind <> 'note' then return new; end if;
  select * into v_task from public.tasks where id = new.task_id;
  select name into v_project from public.projects where id = v_task.project_id;
  insert into public.notifications (user_id, kind, title, body, url, task_id, project_id, actor_id)
  select r, 'update', public.actor_name() || ' updated "' || left(v_task.title, 60) || '"', v_project || ': ' || left(new.body, 140),
         '/#/p/' || v_task.project_id || '?task=' || v_task.id, v_task.id, v_task.project_id, v_actor
  from (select distinct unnest(array[v_task.user_id, v_task.assignee_id]) as r) x
  where r is not null and r is distinct from v_actor;
  return new;
end $$;
create trigger task_updates_notify after insert on public.task_updates for each row execute function public.notify_task_update();

create or replace function public.notify_member_added()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_project text;
begin
  if new.role = 'owner' or new.user_id = new.added_by then return new; end if;
  select name into v_project from public.projects where id = new.project_id;
  insert into public.notifications (user_id, kind, title, body, url, project_id, actor_id)
  values (new.user_id, 'added', public.actor_name() || ' added you to a project', v_project, '/#/p/' || new.project_id, new.project_id, new.added_by);
  return new;
end $$;
create trigger project_members_notify after insert on public.project_members for each row execute function public.notify_member_added();

revoke execute on function public.handle_new_user(), public.add_project_owner(), public.check_task_assignee(), public.unassign_removed_member(),
  public.notify_task_change(), public.notify_task_update(), public.notify_member_added() from public, anon, authenticated;

alter publication supabase_realtime add table public.notifications, public.project_members;
