-- Mark a quick to-do as critical (highlighted in red, shown first).
alter table public.quick_todos add column if not exists critical boolean not null default false;
