#!/usr/bin/env bash
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  echo "usage: bash restore.sh <neo4j-*.dump> [auth-*.db]"
  echo
  echo "Overwrites the graph and, if an account file is given, all accounts. Stops API and"
  echo "database while it runs. Set MANTA_RESTORE_YES=1 to skip the question."
  echo
  echo "Works on the stack started from this folder. If you started it under another project"
  echo "name (docker compose -p NAME), run: COMPOSE_PROJECT_NAME=NAME bash restore.sh ..."
}
case "${1:-}" in -h|--help) usage; exit 0 ;; esac

DUMP="${1:-}"
AUTH="${2:-}"
if [ -z "$DUMP" ]; then usage >&2; exit 2; fi
[ -f "$DUMP" ] || { echo "ERROR: dump file not found: $DUMP" >&2; exit 2; }
if [ -n "$AUTH" ] && [ ! -f "$AUTH" ]; then echo "ERROR: account file not found: $AUTH" >&2; exit 2; fi
if [ -n "$AUTH" ] && [ "$(head -c 15 "$AUTH")" != "SQLite format 3" ]; then
  echo "ERROR: not an SQLite file: $AUTH" >&2; exit 2
fi
DUMPDIR="$(cd "$(dirname "$DUMP")" && pwd)"
DUMPNAME="$(basename "$DUMP")"
[ -z "$AUTH" ] || AUTH="$(cd "$(dirname "$AUTH")" && pwd)/$(basename "$AUTH")"
cd "$HERE" || exit 2

if [ "${MANTA_RESTORE_YES:-}" != "1" ]; then
  echo "This overwrites the current graph with $DUMPNAME."
  [ -z "$AUTH" ] || echo "It also replaces all accounts and sign-ins with $(basename "$AUTH")."
  printf "Continue? [y/N] "
  read -r a || a=""
  case "$a" in
    y|Y|yes|Yes|YES) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT
fail=0

echo "-- stopping API and database"
docker compose stop api neo4j >/dev/null 2>&1 || { echo "ERROR: could not stop the services" >&2; exit 1; }

echo "-- restoring the graph"
LOADDIR="$(mktemp -d "$DUMPDIR/.manta-restore.XXXXXX")" || { LOADDIR=""; fail=1; }
if [ -n "$LOADDIR" ]; then
  if ln "$DUMPDIR/$DUMPNAME" "$LOADDIR/neo4j.dump" 2>/dev/null \
     || cp "$DUMPDIR/$DUMPNAME" "$LOADDIR/neo4j.dump"; then
    docker compose run --rm --no-deps --entrypoint neo4j-admin \
      -v "$LOADDIR:/backups" neo4j database load neo4j --from-path=/backups --overwrite-destination=true \
      >"$LOG" 2>&1 || { tail -5 "$LOG" >&2; fail=1; }
  else
    fail=1
  fi
  rm -rf "$LOADDIR"
fi
[ "$fail" = "0" ] || echo "ERROR: loading the graph failed" >&2

if [ "$fail" = "0" ] && [ -n "$AUTH" ]; then
  echo "-- restoring the accounts"
  PY_RESTORE='
import os, sqlite3, sys, tempfile
tmp = os.path.join(tempfile.mkdtemp(), "auth.db")
with open(tmp, "wb") as f:
    f.write(sys.stdin.buffer.read())
s = sqlite3.connect(tmp)
try:
    n = s.execute("SELECT count(*) FROM users").fetchone()[0]
except sqlite3.DatabaseError as e:
    sys.exit(f"not a MANTA account database: {e}")
try:
    d = sqlite3.connect("/data/manta_auth.db")
    s.backup(d)
    d.close()
except sqlite3.Error as e:
    sys.exit(f"cannot write /data/manta_auth.db: {e}")
s.close()
print(f"   {n} account(s) restored")
'
  if ! docker compose run --rm -T --no-deps --entrypoint python api -c "$PY_RESTORE" <"$AUTH" 2>"$LOG"; then
    tail -5 "$LOG" >&2
    echo "ERROR: restoring the accounts failed. If /data/manta_auth.db belongs to another user:" >&2
    echo "  docker compose run --rm --user root --entrypoint chown api -R 10001:10001 /data" >&2
    fail=1
  fi
fi

echo "-- starting the services"
if ! docker compose start neo4j api >/dev/null 2>&1; then
  echo "ERROR: could not start the services; run: docker compose up -d" >&2
  fail=1
fi
if [ "$fail" != "0" ]; then
  echo "Restore FAILED (see above)." >&2
  exit 1
fi
echo "Done."
