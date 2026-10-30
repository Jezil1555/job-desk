-- Undo 20261031031000_template_log_fix: restore the previous create_project_from_template and drop the helper.
do $$ declare d text; begin
  for d in select definition from private.migration_snapshots where migration = '20261031031000' loop execute d; end loop;
end $$;
drop function if exists public.log_template_use(uuid, uuid, date);
delete from private.migration_snapshots where migration = '20261031031000';
