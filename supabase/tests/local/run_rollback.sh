#!/bin/sh
# Usage: run_rollback.sh <migration.sql> <rollback.sql> <checks.sql>
# Fresh local database: stubs + ops replica + finance + migration, snapshot schema, then rollback, and compare.
set -e
# EXTRA: earlier finance migrations this one builds on (paths); EXTRA_BASE: their file names
EXTRA=${EXTRA:-}; EXTRA_BASE=""; for x in $EXTRA; do EXTRA_BASE="$EXTRA_BASE $(basename $x)"; done
H=/var/lib/postgresql/jdtest; P="psql -h $H -p 54329 -v ON_ERROR_STOP=1 -q -X"
D=$H/rb; rm -rf $D; mkdir -p $D; cp "$@" $D/; cp supabase/tests/local/stubs.sql supabase/tests/local/replica_ops.sql $D/; for f in supabase/migrations/20261030090000_phase3_finance.sql supabase/migrations/20261030110000_fin_tighten_grants.sql supabase/migrations/20261030160000_partner_accounts.sql supabase/migrations/20261030170000_partner_settles.sql $EXTRA; do cp $f $D/; done
chown -R postgres $D
M=$(basename $1); R=$(basename $2); C=$(basename $3)
su postgres -c "dropdb -h $H -p 54329 --if-exists jdrb && createdb -h $H -p 54329 jdrb && sed '/^create role/d' $D/stubs.sql | $P -d jdrb && $P -d jdrb -f $D/replica_ops.sql \
 && for f in 20261030090000_phase3_finance.sql 20261030110000_fin_tighten_grants.sql 20261030160000_partner_accounts.sql 20261030170000_partner_settles.sql $EXTRA_BASE; do $P -d jdrb -f $D/\$f; done \
 && $P -d jdrb -At -c \"select md5(string_agg(x, '|' order by x)) from (select table_name||'.'||column_name||':'||data_type x from information_schema.columns where table_schema='public' union all select p.oid::regprocedure::text||md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' union all select tablename||'.'||policyname from pg_policies where schemaname='public' union all select indexname from pg_indexes where schemaname='public') s\" > $D/before.txt \
 && $P -d jdrb -f $D/$M && $P -d jdrb -f $D/$R \
 && $P -d jdrb -At -c \"select md5(string_agg(x, '|' order by x)) from (select table_name||'.'||column_name||':'||data_type x from information_schema.columns where table_schema='public' union all select p.oid::regprocedure::text||md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' union all select tablename||'.'||policyname from pg_policies where schemaname='public' union all select indexname from pg_indexes where schemaname='public') s\" > $D/after.txt \
 && $P -d jdrb -At -f $D/$C"
if cmp -s $D/before.txt $D/after.txt; then echo "ROLLBACK OK: schema identical to before the migration"; else echo "ROLLBACK MISMATCH"; cat $D/before.txt $D/after.txt; exit 1; fi
