select 'follow-up trigger restored: ' || (position('ORIGINAL-FU' in pg_get_functiondef('public.follow_ups_before_write()'::regprocedure)) > 0)::text;
