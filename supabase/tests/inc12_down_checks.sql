-- After rolling back multi_currency: no currency column, no fx table, partner functions back to their earlier versions.
select case when not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'fin_accounts' and column_name = 'currency')
  and to_regclass('public.fin_money_fx') is null and to_regprocedure('public.fin_money_link_business(uuid, uuid, text)') is null
  and pg_get_functiondef('public.fin_partner_post_mirror(uuid)'::regprocedure) not like '%mirror_amount%' then 'down checks: 1/1' else 'down checks: FAILED' end;
