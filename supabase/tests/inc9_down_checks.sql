select 'custom column gone: ' || (not exists (select 1 from information_schema.columns where table_name = 'tasks' and column_name = 'custom'))::text;
