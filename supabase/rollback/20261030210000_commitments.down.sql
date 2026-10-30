-- Undo 20261030210000_commitments: restore the previous trigger function and remove the commitment fields (their data is lost).
do $$ declare d text; begin
  for d in select definition from private.migration_snapshots where migration = '20261030210000' loop execute d; end loop;
end $$;
alter table public.follow_ups drop column if exists commitment_type, drop column if exists expectation, drop column if exists response,
  drop column if exists response_at, drop column if exists outcome, drop column if exists outcome_note;
delete from private.migration_snapshots where migration = '20261030210000';
