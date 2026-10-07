#!/usr/bin/env bash
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "${1:-}" in
  -h|--help)
    echo "usage: bash backup.sh [target-dir]   (default: $HERE/backups)"
    echo
    echo "Stops API and database while the graph is dumped, starts both again and then backs up"
    echo "the accounts. Keeps the newest MANTA_BACKUP_KEEP backups (default 14; read from the"
    echo "shell or from deploy/.env)."
    echo
    echo "Works on the stack started from this folder. If you started it under another project"
    echo "name (docker compose -p NAME), run: COMPOSE_PROJECT_NAME=NAME bash backup.sh"
    exit 0 ;;
esac

DEST="${1:-$HERE/backups}"
mkdir -p "$DEST" || { echo "ERROR: cannot create $DEST" >&2; exit 2; }
DEST="$(cd "$DEST" && pwd)"
cd "$HERE" || exit 2

KEEP="${MANTA_BACKUP_KEEP:-}"
if [ -z "$KEEP" ] && [ -f .env ]; then
  KEEP="$(sed -n 's/^MANTA_BACKUP_KEEP=//p' .env | tail -1 | tr -d "[:space:]\"'")"
fi
KEEP="${KEEP:-14}"
case "$KEEP" in
  ''|*[!0-9]*) echo "ERROR: MANTA_BACKUP_KEEP must be a whole number of at least 1, not '$KEEP'" >&2; exit 2 ;;
esac
KEEP=$((10#$KEEP))
[ "$KEEP" -ge 1 ] || { echo "ERROR: MANTA_BACKUP_KEEP must be at least 1" >&2; exit 2; }

STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT
fail=0

echo "=== MANTA backup $STAMP -> $DEST"

echo "-- stopping API and database"
docker compose stop api neo4j >/dev/null 2>&1 || { echo "ERROR: could not stop the services" >&2; exit 1; }

echo "-- backing up the graph"
if ! docker compose run --rm --no-deps --entrypoint neo4j-admin \
        -v "$DEST:/backups" neo4j database dump neo4j --to-path=/backups --overwrite-destination=true \
        >"$LOG" 2>&1; then
  tail -5 "$LOG" >&2
  echo "ERROR: the dump failed; starting the services again" >&2
  docker compose start neo4j api >/dev/null 2>&1
  exit 1
fi
mv "$DEST/neo4j.dump" "$DEST/neo4j-$STAMP.dump" || { echo "ERROR: dump file missing in $DEST" >&2; fail=1; }

echo "-- starting the services again"
if ! docker compose start neo4j api >/dev/null 2>&1; then
  echo "ERROR: could not start the services again; run: docker compose up -d" >&2
  fail=1
fi

echo "-- backing up the accounts"
AUTH_FILE="$DEST/auth-$STAMP.db"
PY_BACKUP='
import os, sqlite3, sys, tempfile
src = "/data/manta_auth.db"
if not os.path.exists(src):
    sys.exit(3)
tmp = os.path.join(tempfile.mkdtemp(), "auth.db")
s = sqlite3.connect(src)
d = sqlite3.connect(tmp)
s.backup(d)
d.execute("PRAGMA journal_mode=DELETE")
d.close()
s.close()
with open(tmp, "rb") as f:
    sys.stdout.buffer.write(f.read())
'
docker compose run --rm -T --no-deps --entrypoint python api -c "$PY_BACKUP" >"$AUTH_FILE" 2>"$LOG"
rc=$?
if [ "$rc" = "3" ]; then
  rm -f "$AUTH_FILE"
  AUTH_FILE=""
  echo "   (no account database yet — no account created?)"
elif [ "$rc" = "0" ] && [ "$(head -c 15 "$AUTH_FILE")" = "SQLite format 3" ]; then
  echo "   $(basename "$AUTH_FILE")"
else
  tail -5 "$LOG" >&2
  rm -f "$AUTH_FILE"
  AUTH_FILE=""
  echo "ERROR: the account backup failed" >&2
  fail=1
fi

echo "-- removing old backups (keeping the newest $KEEP)"
ls -1t "$DEST"/neo4j-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm --
ls -1t "$DEST"/auth-*.db    2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm --

echo
echo "Backups present:"
ls -1sh "$DEST" | tail -n +2 | tail -6
echo
if [ "$fail" != "0" ]; then
  echo "Backup FINISHED WITH ERRORS (see above)." >&2
  exit 1
fi
echo "Done."
echo "IMPORTANT: a backup that has never been restored is not a backup."
echo "Restore with:  bash $HERE/restore.sh $DEST/neo4j-$STAMP.dump${AUTH_FILE:+ $AUTH_FILE}"
