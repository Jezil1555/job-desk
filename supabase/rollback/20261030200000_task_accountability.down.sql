-- Undo 20261030200000_task_accountability. Restores the saved trigger functions, then removes the new columns and functions.
-- Data in assignee_id / reviewer_id / review fields is lost; take a backup first if it matters.
do $$ declare d text; begin
  for d in select definition from private.migration_snapshots where migration = '20261030200000' loop execute d; end loop;
end $$;
drop function if exists public.request_task_review(uuid, text);
drop function if exists public.review_task(uuid, text, text);
drop index if exists public.tasks_assignee_open_idx;
drop index if exists public.tasks_reviewer_idx;
alter table public.tasks drop column if exists assignee_id, drop column if exists reviewer_id, drop column if exists review_status,
  drop column if exists review_note, drop column if exists reviewed_by, drop column if exists reviewed_at;
delete from private.migration_snapshots where migration = '20261030200000';
