#!/usr/bin/env bash
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE" || exit 2
ZIEL="${1:-$HERE/backups}"
BEHALTEN="${MANTA_BACKUP_KEEP:-14}"
STAMPEL="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$ZIEL"

echo "=== MANTA-Sicherung $STAMPEL -> $ZIEL"

echo "-- API und Datenbank anhalten"
docker compose stop api neo4j >/dev/null 2>&1 || { echo "FEHLER: konnte Dienste nicht anhalten"; exit 1; }

echo "-- Graphen sichern"
if ! docker compose run --rm --no-deps --entrypoint neo4j-admin \
        -v "$ZIEL:/backups" neo4j database dump neo4j --to-path=/backups --overwrite-destination=true \
        >/dev/null 2>&1; then
  echo "FEHLER: dump fehlgeschlagen — Dienste werden wieder gestartet"
  docker compose start neo4j api >/dev/null 2>&1
  exit 1
fi
mv "$ZIEL/neo4j.dump" "$ZIEL/neo4j-$STAMPEL.dump"

echo "-- Dienste wieder starten"
docker compose start neo4j api >/dev/null 2>&1

echo "-- Konten sichern"
docker compose run --rm --no-deps --entrypoint sh -v "$ZIEL:/backups" api \
  -c "python -c \"import sqlite3,sys
q=sqlite3.connect('/data/manta_auth.db'); z=sqlite3.connect('/backups/auth-$STAMPEL.db')
q.backup(z); z.close(); q.close()\"" >/dev/null 2>&1 \
  && echo "   auth-$STAMPEL.db" || echo "   (keine Kontendatei vorhanden — noch kein Konto angelegt?)"

echo "-- Alte Staende aufraeumen (die letzten $BEHALTEN bleiben)"
ls -1t "$ZIEL"/neo4j-*.dump 2>/dev/null | tail -n +$((BEHALTEN + 1)) | xargs -r rm --
ls -1t "$ZIEL"/auth-*.db    2>/dev/null | tail -n +$((BEHALTEN + 1)) | xargs -r rm --

echo
echo "Fertig. Vorhandene Staende:"
ls -1sh "$ZIEL" | tail -n +2 | tail -6
echo
echo "WICHTIG: eine Sicherung, die nie zurueckgespielt wurde, ist keine."
echo "Zuruecklegen:  bash restore.sh $ZIEL/neo4j-$STAMPEL.dump"
