-- Multi-currency money tests. ONE transaction, ROLLED BACK: no data persists. Throwaway users and isolated test books only.
begin;
create temp table r (n serial, name text, ok boolean, detail text);
create temp table ids (k text primary key, v uuid);
grant all on r, ids to authenticated, anon;
grant usage, select on sequence r_n_seq to authenticated, anon;
create or replace function pg_temp.expect_error(p_name text, p_sql text, p_code text) returns void language plpgsql as $$
begin
  execute p_sql;
  insert into r(name, ok, detail) values (p_name, false, 'no error raised');
exception when others then
  insert into r(name, ok, detail) values (p_name, sqlerrm like p_code || '%', sqlerrm);
end $$;
grant execute on function pg_temp.expect_error(text, text, text) to authenticated, anon;
create or replace function pg_temp.id(k text) returns uuid language sql stable as $$ select v from ids where ids.k = $1 $$;
grant execute on function pg_temp.id(text) to authenticated, anon;
create or replace function pg_temp.acc(e text, c text) returns uuid language sql stable as $$ select id from public.fin_accounts where entity_id = pg_temp.id(e) and code = c $$;
grant execute on function pg_temp.acc(text, text) to authenticated, anon;
create or replace function pg_temp.bal(e text, c text) returns numeric language sql stable as $$
  select coalesce(sum(l.debit - l.credit), 0) from public.fin_lines l join public.fin_journals j on j.id = l.journal_id where j.status = 'posted' and l.account_id = pg_temp.acc(e, c) $$;
create or replace function pg_temp.nat(e text, c text) returns numeric language sql stable as $$
  select coalesce(sum(l.fx_amount), 0) from public.fin_lines l join public.fin_journals j on j.id = l.journal_id where j.status = 'posted' and l.account_id = pg_temp.acc(e, c) $$;
create or replace function pg_temp.tb(e text) returns numeric language sql stable as $$
  select coalesce(sum(l.debit - l.credit), 0) from public.fin_lines l join public.fin_journals j on j.id = l.journal_id where j.status = 'posted' and l.entity_id = pg_temp.id(e) $$;
grant execute on function pg_temp.bal(text, text), pg_temp.nat(text, text), pg_temp.tb(text) to authenticated;
create or replace function pg_temp.post(k text, p jsonb) returns jsonb language plpgsql as $$
declare v jsonb; begin v := public.fin_money_post(p || jsonb_build_object('entity_id', pg_temp.id('pers'))); insert into ids values (k, (v->>'journal_id')::uuid) on conflict do nothing; return v; end $$;
grant execute on function pg_temp.post(text, jsonb) to authenticated;

insert into auth.users (id, email, aud, role, instance_id) values
  ('aaaaaaaa-0000-4000-8000-0000000000d1', 'xa@example.invalid', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-0000000000d1","role":"authenticated"}', true);
with e as (insert into public.fin_entities (name, kind, base_currency) values ('XTest Personal', 'personal', 'QAR') returning id) insert into ids select 'pers', id from e;
with e as (insert into public.fin_entities (name, kind, base_currency) values ('XTest Burger', 'business', 'INR') returning id) insert into ids select 'biz', id from e;
insert into r(name, ok) select 'personal books get the exchange differences account', pg_temp.acc('pers','6870') is not null;

-- accounts in other currencies
insert into public.fin_accounts (entity_id, code, name, type, subtype, currency) values (pg_temp.id('pers'), '1030', 'Indian bank', 'asset', 'bank', 'INR');
insert into public.fin_accounts (entity_id, code, name, type, subtype, currency) values (pg_temp.id('pers'), '1040', 'Another QAR', 'asset', 'bank', 'QAR');
insert into r(name, ok) select 'an account in the base currency is stored as base (no currency)', currency is null from public.fin_accounts where id = pg_temp.acc('pers','1040');
select pg_temp.expect_error('only money, savings, investment and loan accounts take a currency', format('insert into public.fin_accounts (entity_id, code, name, type, subtype, currency) values (%L, $q$6999$q$, $q$x$q$, $q$expense$q$, $q$other$q$, $q$INR$q$)', pg_temp.id('pers')), 'currency_account');

-- opening balance in INR at the planning rate
select pg_temp.post('open', jsonb_build_object('kind','opening','txn_date','2026-11-01','account_id',pg_temp.acc('pers','1030'),'currency','INR','fx_amount',52000,'amount',1992.34,'rate_source','planning','description','Indian bank opening'));
insert into r(name, ok, detail) select 'INR account opens with INR 52,000 and its QAR equivalent', pg_temp.nat('pers','1030') = 52000 and pg_temp.bal('pers','1030') = 1992.34, pg_temp.nat('pers','1030') || ' / ' || pg_temp.bal('pers','1030');
insert into r(name, ok) select 'the planning rate is recorded and flagged', (select rate_source = 'planning' and native_amount = 52000 and base_amount = 1992.34 from public.fin_money_fx where journal_id = pg_temp.id('open'));
insert into r(name, ok) select 'opening is an opening-balance entry', (select source = 'opening' from public.fin_journals where id = pg_temp.id('open'));
select pg_temp.expect_error('the account currency can''t change once it has entries', format('update public.fin_accounts set currency = $q$BHD$q$ where id = %L', pg_temp.acc('pers','1030')), 'currency_locked');

-- a classic manual entry can't touch an INR account without the INR amount
reset role;
select pg_temp.expect_error('a line on an INR account without the INR amount is refused', format('select public.fin_system_journal(%L, $q$2026-11-02$q$, $q$x$q$, null, $q$manual$q$, null, %L)', pg_temp.id('pers'),
  jsonb_build_array(jsonb_build_object('account_id', pg_temp.acc('pers','6100'), 'debit', 10, 'credit', 0), jsonb_build_object('account_id', pg_temp.acc('pers','1030'), 'debit', 0, 'credit', 10))), 'foreign_account');
set local role authenticated;

-- spending from the INR account; spending an INR price from the QAR bank
select pg_temp.post('s1', jsonb_build_object('kind','spend','txn_date','2026-11-02','account_id',pg_temp.acc('pers','1030'),'currency','INR','fx_amount',5000,'amount',191.57,'category_account_id',pg_temp.acc('pers','6600'),'description','Family in Kerala'));
insert into r(name, ok, detail) select 'INR spend reduces the INR balance by exactly 5,000', pg_temp.nat('pers','1030') = 47000 and pg_temp.bal('pers','6600') = 191.57, pg_temp.nat('pers','1030')::text;
select pg_temp.post('s2', jsonb_build_object('kind','spend','txn_date','2026-11-02','account_id',pg_temp.acc('pers','1010'),'currency','INR','fx_amount',2610,'amount',100,'rate_source','actual','category_account_id',pg_temp.acc('pers','6700'),'description','Flight booked in INR'));
insert into r(name, ok) select 'INR price paid from the QAR bank: QAR bank down by what actually left, INR noted on the category', pg_temp.bal('pers','1010') = -100
  and (select fx_currency = 'INR' and fx_amount = 2610 from public.fin_lines where journal_id = pg_temp.id('s2') and account_id = pg_temp.acc('pers','6700'))
  and (select fx_currency is null from public.fin_lines where journal_id = pg_temp.id('s2') and account_id = pg_temp.acc('pers','1010'));
insert into r(name, ok) select 'actual rate recorded (26.10)', (select rate = 26.1 and rate_source = 'actual' from public.fin_money_fx where journal_id = pg_temp.id('s2'));
select pg_temp.expect_error('a foreign amount without the QAR amount is refused', format('select pg_temp.post($q$x$q$, %L)', jsonb_build_object('kind','spend','txn_date','2026-11-02','account_id',pg_temp.acc('pers','1010'),'currency','INR','amount',100,'category_account_id',pg_temp.acc('pers','6700'),'description','x')), 'fx_amount_required');
select pg_temp.expect_error('BHD on the INR account is refused', format('select pg_temp.post($q$x$q$, %L)', jsonb_build_object('kind','spend','txn_date','2026-11-02','account_id',pg_temp.acc('pers','1030'),'currency','BHD','fx_amount',10,'amount',96,'category_account_id',pg_temp.acc('pers','6700'),'description','x')), 'currency_mismatch');
select pg_temp.expect_error('a QAR amount on the INR account is refused', format('select pg_temp.post($q$x$q$, %L)', jsonb_build_object('kind','spend','txn_date','2026-11-02','account_id',pg_temp.acc('pers','1030'),'amount',10,'category_account_id',pg_temp.acc('pers','6700'),'description','x')), 'currency_mismatch');

-- sending money home: QAR bank → INR account
select pg_temp.post('t1', jsonb_build_object('kind','transfer','txn_date','2026-11-03','account_id',pg_temp.acc('pers','1010'),'amount',1000,'category_account_id',pg_temp.acc('pers','1030'),'to_fx_amount',26500,'description','Remittance to Indian bank'));
insert into r(name, ok, detail) select 'remittance: QAR 1,000 out, INR 26,500 in, not income or spending', pg_temp.nat('pers','1030') = 47000 + 26500 and pg_temp.bal('pers','1010') = -1100
  and not exists (select 1 from public.fin_lines l join public.fin_accounts a on a.id = l.account_id where l.journal_id = pg_temp.id('t1') and a.type in ('income','expense')), pg_temp.nat('pers','1030')::text;
select pg_temp.expect_error('remittance without the INR received is refused', format('select pg_temp.post($q$x$q$, %L)', jsonb_build_object('kind','transfer','txn_date','2026-11-03','account_id',pg_temp.acc('pers','1010'),'amount',10,'category_account_id',pg_temp.acc('pers','1030'),'description','x')), 'to_fx_amount_required');

-- reversal keeps the INR balance right
reset role;
select public.fin_reverse_journal(pg_temp.id('s1'), 'test reversal', null);
set local role authenticated;
insert into r(name, ok, detail) select 'reversing an INR spend restores the INR balance', pg_temp.nat('pers','1030') = 52000 + 26500, pg_temp.nat('pers','1030')::text;

-- a business kept in INR
insert into ids select 'link', public.fin_money_link_business(pg_temp.id('pers'), pg_temp.id('biz'), 'Me');
insert into r(name, ok) select 'linking the INR business to personal books is one step and idempotent', public.fin_money_link_business(pg_temp.id('pers'), pg_temp.id('biz'), 'Me') = pg_temp.id('link');
insert into ids select 'bparty', mirror_party_id from public.fin_partner_links where id = pg_temp.id('link');
insert into ids select 'brecv', mirror_receivable_account_id from public.fin_partner_links where id = pg_temp.id('link');
create or replace function pg_temp.owed() returns numeric language sql stable as $$
  select coalesce(sum(debit - credit), 0) from public.fin_lines where account_id = pg_temp.id('brecv') and party_id = pg_temp.id('bparty') $$;
grant execute on function pg_temp.owed() to authenticated;
select pg_temp.expect_error('paying for an INR business from QAR needs the INR amount', format('select pg_temp.post($q$x$q$, %L)', jsonb_build_object('kind','paid_for_business','txn_date','2026-11-04','account_id',pg_temp.acc('pers','1010'),'amount',500,'for_entity_id',pg_temp.id('biz'),'business_account_id',pg_temp.acc('biz','1200'),'description','x')), 'business_amount_required');
select pg_temp.post('b1', jsonb_build_object('kind','paid_for_business','txn_date','2026-11-04','account_id',pg_temp.acc('pers','1010'),'amount',500,'business_amount',13000,'for_entity_id',pg_temp.id('biz'),'business_account_id',pg_temp.acc('biz','1200'),'description','Kitchen equipment'));
insert into r(name, ok, detail) select 'business books record INR 13,000; personal books QAR 500 owed (INR noted)', pg_temp.bal('biz','2300') = -13000 and pg_temp.bal('biz','1200') = 13000 and pg_temp.owed() = 500
  and (select fx_currency = 'INR' and fx_amount = 13000 from public.fin_lines where journal_id = pg_temp.id('b1') and account_id = pg_temp.id('brecv')), pg_temp.bal('biz','2300') || ' / ' || pg_temp.owed();
select pg_temp.post('b2', jsonb_build_object('kind','paid_for_business','txn_date','2026-11-04','account_id',pg_temp.acc('pers','1030'),'currency','INR','fx_amount',2600,'amount',100,'rate_source','planning','for_entity_id',pg_temp.id('biz'),'business_account_id',pg_temp.acc('biz','6900'),'description','Gas cylinder'));
insert into r(name, ok, detail) select 'paid from the INR account: business amount taken from the INR paid, INR balance down 2,600', pg_temp.bal('biz','2300') = -15600 and pg_temp.nat('pers','1030') = 78500 - 2600 and pg_temp.owed() = 600, pg_temp.nat('pers','1030')::text;
select pg_temp.post('b3', jsonb_build_object('kind','business_repaid','txn_date','2026-11-05','account_id',pg_temp.acc('pers','1010'),'amount',590,'business_amount',15600,'for_entity_id',pg_temp.id('biz'),'business_account_id',pg_temp.acc('biz','1010'),'description','Burger repaid me'));
insert into r(name, ok, detail) select 'fully repaid in INR: both sides at zero, the QAR 10 difference cleared as an exchange loss', pg_temp.bal('biz','2300') = 0 and pg_temp.owed() = 0 and pg_temp.bal('pers','6870') = 10,
  pg_temp.bal('biz','2300') || ' / ' || pg_temp.owed() || ' / ' || pg_temp.bal('pers','6870');
select pg_temp.expect_error('business can''t repay more than it owes in INR', format('select pg_temp.post($q$x$q$, %L)', jsonb_build_object('kind','business_repaid','txn_date','2026-11-05','account_id',pg_temp.acc('pers','1010'),'amount',1,'business_amount',1,'for_entity_id',pg_temp.id('biz'),'business_account_id',pg_temp.acc('biz','1010'),'description','x')), 'exceeds_outstanding');

-- budgets in their own currency
insert into public.fin_budgets (entity_id, account_id, month, amount, native_currency, native_amount) values (pg_temp.id('pers'), pg_temp.acc('pers','6600'), '2026-11-01', 1915.71, 'INR', 50000);
insert into r(name, ok) select 'a budget keeps its INR amount and QAR equivalent', exists (select 1 from public.fin_budgets where account_id = pg_temp.acc('pers','6600') and native_amount = 50000 and amount = 1915.71);

-- imports carry the QAR amount beside the foreign amount
insert into ids select 'imp', public.fin_import_add(pg_temp.id('pers'), 'sms', 'INR SMS', null, pg_temp.acc('pers','1030'), 'rules', jsonb_build_array(jsonb_build_object('txn_date','2026-11-06','amount',1200,'direction','out','currency','INR','description','SWIGGY')));
insert into ids select 'row', id from public.fin_import_rows where import_id = pg_temp.id('imp');
update public.fin_import_rows set base_amount = 45.98, rate_source = 'planning', kind = 'spend', category_account_id = pg_temp.acc('pers','6700') where id = pg_temp.id('row');
select pg_temp.post('i1', jsonb_build_object('kind','spend','txn_date','2026-11-06','account_id',pg_temp.acc('pers','1030'),'currency','INR','fx_amount',1200,'amount',45.98,'rate_source','planning','category_account_id',pg_temp.acc('pers','6700'),'description','SWIGGY','import_row_id',pg_temp.id('row')));
insert into r(name, ok) select 'imported INR line posts with both amounts', (select status = 'posted' and base_amount = 45.98 and amount = 1200 and rate_source = 'planning' from public.fin_import_rows where id = pg_temp.id('row'));

insert into r(name, ok, detail) select 'personal trial balance balances', pg_temp.tb('pers') = 0, pg_temp.tb('pers')::text;
insert into r(name, ok, detail) select 'business trial balance balances', pg_temp.tb('biz') = 0, pg_temp.tb('biz')::text;
reset role;
select count(*) filter (where ok) || '/' || count(*) || coalesce(' FAILED: ' || string_agg(name || ' [' || coalesce(detail, '') || ']', '; ') filter (where not ok), '') from r;
rollback;
