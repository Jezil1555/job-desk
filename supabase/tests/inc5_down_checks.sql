select 'push dispatcher restored: ' || (position('ORIGINAL-PUSH' in pg_get_functiondef('public.dispatch_push()'::regprocedure)) > 0)::text;
