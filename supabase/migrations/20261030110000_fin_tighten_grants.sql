-- Finance functions are for signed-in users only (each also checks the caller's role in the books).
-- Supabase grants EXECUTE to anon by default; remove it. Internal helpers aren't callable from the API at all.
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and (p.proname like 'fin\_%' or p.proname in ('is_fin_member','can_write_fin','is_fin_owner')) loop
    execute format('revoke execute on function %s from public, anon', f.sig);
  end loop;
end $$;
revoke execute on function public.fin_check_open(uuid, date), public.fin_sys_account(uuid, text) from authenticated;
