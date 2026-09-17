#!/usr/bin/env bash
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACK="$HERE/backend"
FRONT="$HERE/frontend"
LOGDIR="${TMPDIR:-/tmp}"
BACKLOG="$LOGDIR/manta-backend.log"
FRONTLOG="$LOGDIR/manta-frontend.log"
DB_CONTAINER="${MANTA_DB_CONTAINER:-deploy-neo4j-1}"
DB_HTTP="http://localhost:${MANTA_DB_HTTP_PORT:-7474}"

db_antwortet() { curl -fsS --max-time 2 "$DB_HTTP" >/dev/null 2>&1; }

laeuft() { pgrep -f "$1" >/dev/null 2>&1; }


start() {
  if db_antwortet; then
    echo "-- Neo4j laeuft bereits ($DB_HTTP)"
  elif docker start "$DB_CONTAINER" >/dev/null 2>&1; then
    echo "-- Neo4j gestartet ($DB_CONTAINER)"
    for _ in $(seq 1 30); do db_antwortet && break; sleep 1; done
  else
    echo "   FEHLER: keine Datenbank unter $DB_HTTP, und der Container '$DB_CONTAINER' liess"
    echo "   sich nicht starten. Schritt 1 legt sie an:"
    echo "       cd deploy && docker compose up -d neo4j"
    echo "   Laeuft sie unter einem anderen Namen: MANTA_DB_CONTAINER=<name> bash $0 start"
    return 1
  fi

  if laeuft "uvicorn app:app"; then
    echo "-- Backend laeuft bereits (:8000)"
  else
    [ -f "$BACK/.env" ] || { echo "   FEHLER: $BACK/.env fehlt"; return 1; }
    echo "-- Backend starten (:8000)  Protokoll: $BACKLOG"
    ( cd "$BACK" && set -a && . ./.env && set +a &&
      nohup ./.venv/bin/python -m uvicorn app:app --port 8000 >"$BACKLOG" 2>&1 </dev/null & )
  fi

  if laeuft "$FRONT/node_modules/.bin/vite"; then
    echo "-- Oberflaeche laeuft bereits (:5173)"
  else
    echo "-- Oberflaeche starten (:5173)  Protokoll: $FRONTLOG"
    ( cd "$FRONT" && nohup npm run dev >"$FRONTLOG" 2>&1 </dev/null & )
  fi

  printf -- "-- warte auf das Backend"
  for _ in $(seq 1 40); do
    curl -fsS --max-time 2 http://localhost:8000/health >/dev/null 2>&1 && break
    printf .; sleep 1
  done; echo
  printf -- "-- warte auf die Oberflaeche"
  for _ in $(seq 1 40); do
    curl -fsS --max-time 2 http://localhost:5173/ >/dev/null 2>&1 && break
    printf .; sleep 1
  done; echo
  echo
  status
  echo
  echo "   http://localhost:5173"
  echo "   Ohne Konto siehst du nur oeffentliche Datensaetze — und alle stehen auf 'internal'."
  echo "   Eigenes Konto:  cd $BACK && set -a && . ./.env && set +a && .venv/bin/python manage.py adduser <name> --role admin"
}

stop() {
  echo "-- Oberflaeche und Backend beenden"
  pkill -f "uvicorn app:app" 2>/dev/null && echo "   Backend beendet" || echo "   Backend lief nicht"
  pkill -f "$FRONT/node_modules/.bin/vite" 2>/dev/null && echo "   Oberflaeche beendet" \
    || echo "   Oberflaeche lief nicht"
  if [ "${1:-}" = "--db" ]; then
    docker stop "$DB_CONTAINER" >/dev/null 2>&1 && echo "   Neo4j angehalten ($DB_CONTAINER)" \
      || echo "   Container '$DB_CONTAINER' nicht angehalten — laeuft die Datenbank anders, MANTA_DB_CONTAINER setzen"
  else
    echo "   Neo4j laeuft weiter (mit --db auch anhalten)"
  fi
}

backend_zustand() {
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 http://localhost:8000/health 2>/dev/null)"
  case "$code" in
    200) echo "laeuft  http://localhost:8000" ;;
    000|"") echo "aus" ;;
    503) echo "laeuft, erreicht aber die Datenbank NICHT — Grund: $(curl -sS --max-time 2 http://localhost:8000/health 2>/dev/null | sed 's/.*unreachable: //; s/"}$//' | cut -c1-90)" ;;
    *)   echo "antwortet mit HTTP $code" ;;
  esac
}

status() {
  printf "   %-12s %s\n" "Neo4j" \
    "$(db_antwortet && echo "laeuft  $DB_HTTP" || echo 'aus')"
  printf "   %-12s %s\n" "Backend" "$(backend_zustand)"
  printf "   %-12s %s\n" "Oberflaeche" \
    "$(curl -fsS --max-time 2 http://localhost:5173/ >/dev/null 2>&1 && echo 'laeuft  http://localhost:5173' || echo 'aus')"
}

case "${1:-status}" in
  start)  start ;;
  stop)   stop "${2:-}" ;;
  status) echo "MANTA lokal:"; status ;;
  logs)   echo "=== Backend ($BACKLOG)"; tail -15 "$BACKLOG" 2>/dev/null
          echo; echo "=== Oberflaeche ($FRONTLOG)"; tail -15 "$FRONTLOG" 2>/dev/null ;;
  *)      sed -n '2,14p' "$0" ;;
esac
