#!/usr/bin/env bash
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE" || exit 2
DUMP="${1:-}"
AUTH="${2:-}"
[ -f "$DUMP" ] || { echo "Nutzung: bash restore.sh <neo4j-*.dump> [auth-*.db]"; exit 2; }
DUMPDIR="$(cd "$(dirname "$DUMP")" && pwd)"
DUMPNAME="$(basename "$DUMP")"

if [ "${MANTA_RESTORE_YES:-}" != "1" ]; then
  echo "Das ueberschreibt den laufenden Graphen mit $DUMPNAME."
  printf "Weiter? [ja/NEIN] "; read -r a
  [ "$a" = "ja" ] || { echo "abgebrochen"; exit 1; }
fi

echo "-- API und Datenbank anhalten"
docker compose stop api neo4j >/dev/null 2>&1

echo "-- Graphen zuruecklegen"
cp "$DUMPDIR/$DUMPNAME" "$DUMPDIR/neo4j.dump"
ok=1
docker compose run --rm --no-deps --entrypoint neo4j-admin \
  -v "$DUMPDIR:/backups" neo4j database load neo4j --from-path=/backups --overwrite-destination=true \
  >/dev/null 2>&1 || ok=0
rm -f "$DUMPDIR/neo4j.dump"

echo "-- Dienste starten"
docker compose start neo4j api >/dev/null 2>&1
[ "$ok" = "1" ] || { echo "FEHLER: load fehlgeschlagen"; exit 1; }

if [ -n "$AUTH" ] && [ -f "$AUTH" ]; then
  echo "-- Konten zuruecklegen"
  docker compose cp "$AUTH" api:/data/manta_auth.db && docker compose restart api >/dev/null 2>&1
fi
echo "Fertig."
