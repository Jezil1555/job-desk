-- Undo 20261030220000_project_baselines: removes baselines and the revision log (that history is lost — export it first).
drop view if exists public.schedule_variance;
drop function if exists public.set_project_baseline(uuid, text);
drop function if exists public.revise_project_dates(uuid, date, date, text);
drop function if exists public.revise_milestone_date(uuid, date, text);
drop trigger if exists projects_schedule_guard on public.projects;
drop trigger if exists milestones_schedule_guard on public.milestones;
drop function if exists public.projects_schedule_guard();
drop function if exists public.milestones_schedule_guard();
drop table if exists public.schedule_revisions;
alter table public.projects drop column if exists baseline_start_date, drop column if exists baseline_target_date, drop column if exists baselined_at, drop column if exists baselined_by;
alter table public.milestones drop column if exists baseline_date;
