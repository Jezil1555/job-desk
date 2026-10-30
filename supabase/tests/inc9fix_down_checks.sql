select 'helper gone: ' || (to_regprocedure('public.log_template_use(uuid,uuid,date)') is null)::text;
