-- Quick to-do list: a private sticky note of small daily items, outside projects. Open until ticked off.
create table if not exists public.quick_todos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  text text not null check (char_length(text) between 1 and 500),
  done_at timestamptz,
  sort int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists quick_todos_user_idx on public.quick_todos(user_id, done_at);
alter table public.quick_todos enable row level security;
create policy "quick todos: own read" on public.quick_todos for select to authenticated using (user_id = (select auth.uid()));
create policy "quick todos: own add" on public.quick_todos for insert to authenticated with check (user_id = (select auth.uid()));
create policy "quick todos: own edit" on public.quick_todos for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "quick todos: own delete" on public.quick_todos for delete to authenticated using (user_id = (select auth.uid()));
grant select, insert, update, delete on public.quick_todos to authenticated;
