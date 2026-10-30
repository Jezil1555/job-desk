-- Undo 20261031030000_templates_custom_fields. Refuses once fields, values or templates exist (archive them instead).
do $$ begin
  if exists (select 1 from public.field_defs) or exists (select 1 from public.project_templates) or exists (select 1 from public.tasks where custom <> '{}'::jsonb) then
    raise exception 'custom fields or templates exist — rolling back would delete them';
  end if;
end $$;
drop function if exists public.save_project_as_template(uuid, text, text);
drop function if exists public.create_project_from_template(uuid, text, date, date);
drop table if exists public.project_templates;
drop function if exists public.project_templates_guard();
drop function if exists public.template_body_check(jsonb);
drop trigger if exists tasks_custom_log on public.tasks;
drop trigger if exists tasks_custom_guard on public.tasks;
drop function if exists public.tasks_custom_log();
drop function if exists public.tasks_custom_guard();
alter table public.tasks drop column if exists custom;
drop table if exists public.field_defs;
drop function if exists public.field_defs_guard();
