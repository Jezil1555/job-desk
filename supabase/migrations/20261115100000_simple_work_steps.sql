-- Simple work model (monday-style): workspace -> project (a job) -> tasks -> steps.
-- Steps are the small milestones inside a task, each with a status and a responsible person
-- (free text, so it can be someone without a J. Desk login, e.g. a tailor or forwarder).
-- Projects can be closed (closed_at) so dashboards can count open vs closed jobs.

alter table public.projects
  add column if not exists closed_at timestamptz,
  add column if not exists closed_by uuid references auth.users(id) on delete set null;

create table if not exists public.task_steps (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 300),
  status text not null default 'pending' check (status in ('pending', 'done')),
  responsible text check (responsible is null or char_length(responsible) <= 80),
  note text check (note is null or char_length(note) <= 2000),
  sort int not null default 0,
  done_at timestamptz,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  updated_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists task_steps_task_idx on public.task_steps(task_id, sort);
create index if not exists task_steps_ws_idx on public.task_steps(workspace_id);
create index if not exists task_steps_created_by_idx on public.task_steps(created_by);
create index if not exists task_steps_updated_by_idx on public.task_steps(updated_by);
create index if not exists projects_closed_by_idx on public.projects(closed_by);

-- workspace always follows the task; done_at and who-changed-it are kept by the server
create or replace function public.task_steps_before_write() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  select workspace_id into new.workspace_id from public.tasks where id = new.task_id;
  if new.workspace_id is null then raise exception 'not_found: task not found'; end if;
  new.title := trim(new.title);
  new.responsible := nullif(trim(coalesce(new.responsible, '')), '');
  new.updated_at := now();
  new.updated_by := (select auth.uid());
  if new.status = 'done' then
    new.done_at := case when tg_op = 'UPDATE' and old.status = 'done' then old.done_at else now() end;
  else
    new.done_at := null;
  end if;
  return new;
end $$;
revoke execute on function public.task_steps_before_write() from public, anon, authenticated;
drop trigger if exists task_steps_before_write on public.task_steps;
create trigger task_steps_before_write before insert or update on public.task_steps for each row execute function public.task_steps_before_write();

alter table public.task_steps enable row level security;
drop policy if exists "task_steps: members read" on public.task_steps;
drop policy if exists "task_steps: writers add" on public.task_steps;
drop policy if exists "task_steps: writers edit" on public.task_steps;
drop policy if exists "task_steps: writers delete" on public.task_steps;
create policy "task_steps: members read" on public.task_steps for select to authenticated using (public.is_ws_member(workspace_id));
create policy "task_steps: writers add" on public.task_steps for insert to authenticated
  with check (public.can_write_ws(workspace_id) and exists (select 1 from public.tasks t where t.id = task_id and t.workspace_id = task_steps.workspace_id));
create policy "task_steps: writers edit" on public.task_steps for update to authenticated using (public.can_write_ws(workspace_id)) with check (public.can_write_ws(workspace_id));
create policy "task_steps: writers delete" on public.task_steps for delete to authenticated using (public.can_write_ws(workspace_id));

grant select, insert, update, delete on public.task_steps to authenticated;

do $$ begin
  alter publication supabase_realtime add table public.task_steps;
exception when duplicate_object then null; when undefined_object then null; end $$;
