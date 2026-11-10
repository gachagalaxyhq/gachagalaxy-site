#!/usr/bin/env bash
# Phase 7 DB test runner. LOCAL ONLY: creates a throwaway PostgreSQL cluster
# under /home/user/workspace/pg (port 55432, localhost only), applies the real
# migrations to it, runs the suite, and stops the cluster. Never targets any
# other server; ignores PG* environment variables.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PGROOT="${PHASE7_PGROOT:-/home/user/workspace/pg}"
PORT=55432
unset PGHOST PGPORT PGUSER PGDATABASE PGPASSWORD PGSERVICE PGSSLMODE DATABASE_URL || true

BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
if [ -z "$BIN" ] || [ ! -x "$BIN/initdb" ]; then
  sudo apt-get install -y postgresql >/dev/null
  BIN="$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)"
fi
python3 -c 'import psycopg2' 2>/dev/null || pip install -q psycopg2-binary

if [ -f "$PGROOT/data/postmaster.pid" ]; then "$BIN/pg_ctl" -D "$PGROOT/data" -m immediate -w stop || true; fi
rm -rf "$PGROOT"; mkdir -p "$PGROOT/sock"
"$BIN/initdb" -D "$PGROOT/data" -U supabase_admin -A trust --no-locale -E UTF8 >"$PGROOT/initdb.log"
"$BIN/pg_ctl" -D "$PGROOT/data" -l "$PGROOT/server.log" -w start \
  -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$PGROOT/sock -c max_connections=60 -c fsync=off" >/dev/null
stop() { "$BIN/pg_ctl" -D "$PGROOT/data" -m fast -w stop >/dev/null 2>&1 || true; }
trap stop EXIT

echo "python backfill tests:"
python3 -m unittest "$REPO/tests/test_phase7_backfill.py" 2>&1 | tail -1
python3 "$REPO/scripts/phase7_backfill.py" --check
echo "postgres $("$BIN/postgres" --version | awk '{print $3}') on 127.0.0.1:$PORT"
PHASE7_PSQL="$BIN/psql" PHASE7_PORT=$PORT PHASE7_REPO="$REPO" python3 "$REPO/tests/phase7/test_phase7_db.py" "$@"
