create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  color text not null default '#1f5f8b',
  archived boolean not null default false,
  sort int not null default 0,
  created_at timestamptz not null default now()
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 300),
  client text,
  ref text,
  details text,
  status text not null default 'todo' check (status in ('todo','doing','waiting','done')),
  urgent boolean not null default false,
  due date,
  amount numeric(12,2),
  amount_settled boolean not null default false,
  sort bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  done_at timestamptz
);

create table public.task_updates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 2000),
  kind text not null default 'note' check (kind in ('note','status','system')),
  created_at timestamptz not null default now()
);

create index projects_user_idx on public.projects(user_id);
create index tasks_user_idx on public.tasks(user_id);
create index tasks_project_idx on public.tasks(project_id);
create index task_updates_user_idx on public.task_updates(user_id);
create index task_updates_task_idx on public.task_updates(task_id, created_at);

create or replace function public.touch_task()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  if new.status = 'done' and (old.status is distinct from 'done') then new.done_at := now(); end if;
  if new.status <> 'done' then new.done_at := null; end if;
  return new;
end $$;

create trigger tasks_touch before update on public.tasks
for each row execute function public.touch_task();

alter table public.projects enable row level security;
alter table public.tasks enable row level security;
alter table public.task_updates enable row level security;

create policy "own projects" on public.projects for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own tasks" on public.tasks for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and exists (select 1 from public.projects p where p.id = project_id and p.user_id = (select auth.uid())));
create policy "own updates" on public.task_updates for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and exists (select 1 from public.tasks t where t.id = task_id and t.user_id = (select auth.uid())));

alter publication supabase_realtime add table public.projects, public.tasks, public.task_updates;
