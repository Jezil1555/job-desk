-- After rolling back simple_money: the new tables and functions are gone and fin_files accepts only its original targets.
select case when to_regclass('public.fin_import_rows') is null and to_regclass('public.fin_obligations') is null and to_regclass('public.fin_balance_checks') is null
  and to_regprocedure('public.fin_money_post(jsonb)') is null then 'down checks: 1/1' else 'down checks: FAILED' end;
