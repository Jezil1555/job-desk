#!/bin/sh
# Usage: run_with.sh <test.sql> <migration.sql>... — fresh local db with stubs + ops replica + finance engine + given migrations, then the test in a rolled-back transaction.
set -e
H=/var/lib/postgresql/jdtest; P="psql -h $H -p 54329 -v ON_ERROR_STOP=1 -q -X"
D=$H/rw; rm -rf $D; mkdir -p $D; T=$1; shift
cp supabase/tests/local/stubs.sql supabase/tests/local/replica_ops.sql $T $D/
for f in supabase/migrations/20261030090000_phase3_finance.sql supabase/migrations/20261030110000_fin_tighten_grants.sql supabase/migrations/20261030160000_partner_accounts.sql supabase/migrations/20261030170000_partner_settles.sql "$@"; do cp $f $D/; done
chown -R postgres $D
LIST=""; for f in 20261030090000_phase3_finance.sql 20261030110000_fin_tighten_grants.sql 20261030160000_partner_accounts.sql 20261030170000_partner_settles.sql; do LIST="$LIST $f"; done
for f in "$@"; do LIST="$LIST $(basename $f)"; done
su postgres -c "dropdb -h $H -p 54329 --if-exists jdw && createdb -h $H -p 54329 jdw && sed '/^create role/d' $D/stubs.sql | $P -d jdw && $P -d jdw -f $D/replica_ops.sql && for f in $LIST; do $P -d jdw -f $D/\$f; done && (echo 'begin;'; cat $D/$(basename $T); echo 'rollback;') | psql -h $H -p 54329 -q -X -At -d jdw" 2>&1 | grep -v '^$' | grep -v '^{' | tail -3
