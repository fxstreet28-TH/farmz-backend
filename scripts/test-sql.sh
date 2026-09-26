#!/usr/bin/env bash
# Runs migrations + SQL scenario tests against a throwaway local Postgres (needs PG >= 15 binaries).
# Usage: PG_BIN=/usr/lib/postgresql/16/bin scripts/test-sql.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PG_BIN=${PG_BIN:-$(dirname "$(command -v pg_ctl || echo /usr/lib/postgresql/16/bin/pg_ctl)")}
PORT=${PG_TEST_PORT:-55433}
DATA=$(mktemp -d)
RUN_AS=()
if [ "$(id -u)" = "0" ]; then chown postgres "$DATA"; RUN_AS=(su postgres -s /bin/bash -c); fi
run() { if [ ${#RUN_AS[@]} -gt 0 ]; then "${RUN_AS[@]}" "$*"; else bash -c "$*"; fi; }
run "$PG_BIN/initdb -D $DATA -U postgres -A trust >/dev/null"
run "$PG_BIN/pg_ctl -D $DATA -o '-p $PORT -k /tmp -c timezone=UTC' -l $DATA/log -w start >/dev/null"
trap 'run "$PG_BIN/pg_ctl -D $DATA -m immediate stop >/dev/null"; rm -rf "$DATA"' EXIT
PSQL=(psql -h /tmp -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q -X)
for f in tests/sql/00_supabase_stub.sql supabase/migrations/*.sql; do "${PSQL[@]}" -f "$f" >/dev/null 2>&1 || "${PSQL[@]}" -f "$f"; done
"${PSQL[@]}" -f tests/sql/10_game_test.sql
