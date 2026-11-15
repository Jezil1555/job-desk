alter table public.inv_investors add column if not exists equity_pct numeric(6,3) check (equity_pct is null or (equity_pct >= 0 and equity_pct <= 100));
comment on column public.inv_investors.equity_pct is 'Ownership share of the business in %, which can differ from the share of capital put in (e.g. a partner with sweat equity and no capital).';
