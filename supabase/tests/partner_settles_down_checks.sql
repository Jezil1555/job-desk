select 'settles gone: ' || (not exists (select 1 from information_schema.columns where table_name='fin_partner_txns' and column_name='settles_txn_id'))::text;
