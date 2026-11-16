-- Priority levels for quick to-dos (replaces the yes/no critical flag): critical, medium, low, or none.
alter table public.quick_todos add column if not exists priority text check (priority is null or priority in ('critical', 'medium', 'low'));
update public.quick_todos set priority = 'critical' where critical and priority is null;
alter table public.quick_todos drop column if exists critical;
