select 'reverse restored: ' || (position('production' in pg_get_functiondef('public.fin_reverse_journal(uuid,text,date)'::regprocedure)) = 0)::text;
