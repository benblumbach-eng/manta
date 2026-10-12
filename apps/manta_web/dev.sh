#!/usr/bin/env bash
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
BACK="$HERE/backend"
FRONT="$HERE/frontend"
PY="$BACK/.venv/bin/python"
VITE="$FRONT/node_modules/.bin/vite"
BACKEND_PORT="${MANTA_BACKEND_PORT:-8000}"
FRONTEND_PORT="${MANTA_FRONTEND_PORT:-5173}"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac
TMP="${TMPDIR:-/tmp}"
LOGDIR="${TMP%/}/manta-dev.$(printf '%s' "$HERE" | cksum | cut -d' ' -f1)"
BACKLOG="$LOGDIR/backend.log"
FRONTLOG="$LOGDIR/frontend.log"
BACKPID="$LOGDIR/backend.pid"
FRONTPID="$LOGDIR/frontend.pid"
DB_CONTAINER="${MANTA_DB_CONTAINER:-deploy-neo4j-1}"
DB_URI="$( { set +u; [ -f "$BACK/.env" ] && set -a && . "$BACK/.env"; } >/dev/null 2>&1
           printf '%s' "${NEO4J_URI:-bolt://localhost:7687}")"

usage() {
  cat <<'EOF'
Usage: bash apps/manta_web/dev.sh <command>

  start       start Neo4j (if needed), the backend (:8000) and the web interface (:5173)
  stop        stop the backend and the web interface; Neo4j keeps running
  stop --db   also stop the Neo4j container
  restart     stop and start again on the ports this clone's processes use now
              (MANTA_BACKEND_PORT / MANTA_FRONTEND_PORT, if set, take precedence)
  status      show what is running (exit code 0 if this clone's backend or
              web interface runs, 3 if neither does)
  logs        show the last lines of both logs

Environment variables:
  MANTA_BACKEND_PORT    backend port (default 8000)
  MANTA_FRONTEND_PORT   web interface port (default 5173)
  MANTA_DB_CONTAINER    Neo4j container that start and stop --db use (default deploy-neo4j-1)
The database address is NEO4J_URI in apps/manta_web/backend/.env.
EOF
}

error() { echo "   ERROR: $*" >&2; }

db_responds() {
  [ -x "$PY" ] || return 2
  "$PY" - "$DB_URI" >/dev/null 2>&1 <<'EOF'
import socket, ssl, sys
from urllib.parse import urlsplit
u = urlsplit(sys.argv[1])
s = socket.create_connection((u.hostname or "localhost", u.port or 7687), timeout=2)
if "+s" in u.scheme:
    s = ssl._create_unverified_context().wrap_socket(s, server_hostname=u.hostname)
s.settimeout(2)
s.sendall(bytes.fromhex("6060b017" + "00000405" + "00" * 12))
sys.exit(0 if s.recv(4)[:2] == bytes(2) else 1)
EOF
}

listen_pids() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null
  elif command -v ss >/dev/null 2>&1; then
    ss -Hltnp "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2
  fi | sort -u
}

proc_cwd() {
  if [ -d "/proc/$1" ]; then readlink "/proc/$1/cwd" 2>/dev/null
  else lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'; fi
}

proc_args() { ps -ww -o args= -p "$1" 2>/dev/null; }

proc_port() {
  local a
  a="$(proc_args "$1")"
  case "$a" in
    *"--port "[0-9]*) a="${a##*--port }"; echo "${a%% *}" ;;
    *) echo "$2" ;;
  esac
}

is_own_backend() {
  local args
  args="$(proc_args "$1")" || return 1
  case "$args" in
    "$PY -m uvicorn app:app"*) return 0 ;;
    *"-m uvicorn app:app"*) [ "$(proc_cwd "$1")" = "$BACK" ] ;;
    *) return 1 ;;
  esac
}

is_own_frontend() {
  local args
  args="$(proc_args "$1")" || return 1
  case "$args" in
    *"$VITE"*) return 0 ;;
    *) return 1 ;;
  esac
}

own_pid() {
  local pid
  pid="$(cat "$2" 2>/dev/null)"
  case "$pid" in ''|*[!0-9]*) pid="" ;; esac
  if [ -n "$pid" ] && "is_own_$1" "$pid"; then echo "$pid"; return 0; fi
  rm -f "$2"
  for pid in $(listen_pids "$3"); do
    "is_own_$1" "$pid" && { echo "$pid"; return 0; }
  done
  return 1
}

port_busy() {
  [ -n "$(listen_pids "$1")" ] && return 0
  curl -s -o /dev/null --max-time 2 "http://localhost:$1/" 2>/dev/null
  [ $? -ne 7 ]
}

port_owner() {
  local p
  for p in $(listen_pids "$1"); do printf ' (pid %s: %s)' "$p" "$(proc_args "$p" | cut -c1-120)"; done
}

stop_pid() {
  kill "$1" 2>/dev/null || return 0
  for _ in $(seq 1 50); do kill -0 "$1" 2>/dev/null || return 0; sleep 0.2; done
  kill -9 "$1" 2>/dev/null
  sleep 0.5
  ! kill -0 "$1" 2>/dev/null
}

http_code() { curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "$1" 2>/dev/null; }


start() {
  [ -x "$PY" ] || { error "no Python environment at $BACK/.venv; install it as in README step 2"; return 1; }
  [ -f "$BACK/.env" ] || { error "$BACK/.env is missing; copy .env.example there and set NEO4J_PASSWORD (README step 2)"; return 1; }
  [ -x "$VITE" ] || { error "the web interface is not installed; run: (cd $FRONT && npm ci)"; return 1; }
  mkdir -p "$LOGDIR"

  if db_responds; then
    echo "-- Neo4j already running ($DB_URI)"
  elif docker start "$DB_CONTAINER" >/dev/null 2>&1; then
    printf -- "-- Neo4j started (container %s), waiting" "$DB_CONTAINER"
    for _ in $(seq 1 60); do db_responds && break; printf .; sleep 1; done; echo
    db_responds || echo "   warning: $DB_URI does not answer yet; the backend reports it once it does"
  else
    error "no database answers at $DB_URI (NEO4J_URI in $BACK/.env),"
    echo "   and the container '$DB_CONTAINER' could not be started. Step 1 creates it:" >&2
    echo "       cd deploy && docker compose up -d neo4j" >&2
    echo "   If it runs under another name: MANTA_DB_CONTAINER=<name> bash $0 start" >&2
    return 1
  fi

  local bpid fpid p
  if bpid="$(own_pid backend "$BACKPID" "$BACKEND_PORT")"; then
    p="$(proc_port "$bpid" "$BACKEND_PORT")"
    if [ "$p" != "$BACKEND_PORT" ]; then
      error "this clone's backend already runs on port $p (pid $bpid); to move it to $BACKEND_PORT, run 'bash $0 stop' first"
      return 1
    fi
    echo "-- Backend already running (pid $bpid, :$BACKEND_PORT)"
  elif port_busy "$BACKEND_PORT"; then
    error "port $BACKEND_PORT is in use by another program$(port_owner "$BACKEND_PORT")."
    echo "   Stop it, or choose another port: MANTA_BACKEND_PORT=<port> bash $0 start" >&2
    return 1
  else
    echo "-- Starting backend (:$BACKEND_PORT)  log: $BACKLOG"
    ( cd "$BACK" || exit 1
      [ "$FRONTEND_PORT" = 5173 ] ||
        export MANTA_ALLOWED_ORIGINS="${MANTA_ALLOWED_ORIGINS:-http://localhost:$FRONTEND_PORT,http://localhost:8080}"
      set -a; . ./.env; set +a
      nohup "$PY" -m uvicorn app:app --port "$BACKEND_PORT" >"$BACKLOG" 2>&1 </dev/null &
      echo $! >"$BACKPID" )
    bpid="$(cat "$BACKPID" 2>/dev/null)"
  fi

  if fpid="$(own_pid frontend "$FRONTPID" "$FRONTEND_PORT")"; then
    p="$(proc_port "$fpid" "$FRONTEND_PORT")"
    if [ "$p" != "$FRONTEND_PORT" ]; then
      error "this clone's web interface already runs on port $p (pid $fpid); to move it to $FRONTEND_PORT, run 'bash $0 stop' first"
      return 1
    fi
    echo "-- Web interface already running (pid $fpid, :$FRONTEND_PORT)"
  elif port_busy "$FRONTEND_PORT"; then
    error "port $FRONTEND_PORT is in use by another program$(port_owner "$FRONTEND_PORT")."
    echo "   Stop it, or choose another port: MANTA_FRONTEND_PORT=<port> bash $0 start" >&2
    return 1
  else
    echo "-- Starting web interface (:$FRONTEND_PORT)  log: $FRONTLOG"
    ( cd "$FRONT" || exit 1
      [ "$BACKEND_PORT" = 8000 ] ||
        export VITE_API_BASE="${VITE_API_BASE:-http://localhost:$BACKEND_PORT}"
      nohup "$VITE" --port "$FRONTEND_PORT" --strictPort >"$FRONTLOG" 2>&1 </dev/null &
      echo $! >"$FRONTPID" )
    fpid="$(cat "$FRONTPID" 2>/dev/null)"
  fi

  local ok=0
  printf -- "-- waiting for the backend"
  for _ in $(seq 1 40); do
    [ "$(http_code "http://localhost:$BACKEND_PORT/health")" = 000 ] || break
    kill -0 "${bpid:-0}" 2>/dev/null || break
    printf .; sleep 1
  done; echo
  printf -- "-- waiting for the web interface"
  for _ in $(seq 1 40); do
    curl -fsS --max-time 2 "http://localhost:$FRONTEND_PORT/" >/dev/null 2>&1 && break
    kill -0 "${fpid:-0}" 2>/dev/null || break
    printf .; sleep 1
  done; echo
  echo
  status
  echo
  [ "$(http_code "http://localhost:$BACKEND_PORT/health")" = 200 ] &&
    curl -fsS --max-time 2 "http://localhost:$FRONTEND_PORT/" >/dev/null 2>&1 && ok=1
  if [ "$ok" = 1 ]; then
    echo "   http://localhost:$FRONTEND_PORT"
    echo "   Without an account you only see public datasets, and all of them are set to 'internal'."
    echo "   Create an account:  cd $BACK && set -a && . ./.env && set +a && .venv/bin/python manage.py adduser <name> --role admin"
  else
    echo "   Not everything came up. The logs: bash $0 logs" >&2
    return 1
  fi
}

stop() {
  local pid
  echo "-- Stopping the web interface and the backend"
  if pid="$(own_pid frontend "$FRONTPID" "$FRONTEND_PORT")"; then
    if stop_pid "$pid"; then echo "   Web interface stopped (pid $pid)"
    else error "web interface (pid $pid) did not stop"; fi
  else
    echo "   Web interface was not running"
  fi
  rm -f "$FRONTPID"
  if pid="$(own_pid backend "$BACKPID" "$BACKEND_PORT")"; then
    if stop_pid "$pid"; then echo "   Backend stopped (pid $pid)"
    else error "backend (pid $pid) did not stop"; fi
  else
    echo "   Backend was not running"
  fi
  rm -f "$BACKPID"
  if [ "${1:-}" = "--db" ]; then
    docker stop -t 120 "$DB_CONTAINER" >/dev/null 2>&1 && echo "   Neo4j stopped ($DB_CONTAINER)" \
      || echo "   Container '$DB_CONTAINER' not stopped; if the database runs differently, set MANTA_DB_CONTAINER"
  else
    echo "   Neo4j keeps running (use stop --db to stop it too)"
  fi
}

backend_state() {
  local code url="http://localhost:$2"
  code="$(http_code "$url/health")"
  case "$code" in
    200) echo "running  $url" ;;
    000|"") echo "not answering on :$2 (pid $1); see: bash $0 logs" ;;
    503) echo "running, but cannot reach the database; reason: $(curl -sS --max-time 2 "$url/health" 2>/dev/null | sed 's/.*unreachable: //; s/"}$//' | cut -c1-90)" ;;
    *)   echo "answers with HTTP $code  $url" ;;
  esac
}

status() {
  local pid port rc=3 db
  db_responds
  case $? in
    0) db="running  $DB_URI" ;;
    2) db="unknown (no Python environment at $BACK/.venv yet)" ;;
    *) db="not reachable at $DB_URI" ;;
  esac
  printf "   %-14s %s\n" "Neo4j" "$db"
  if pid="$(own_pid backend "$BACKPID" "$BACKEND_PORT")"; then
    rc=0
    printf "   %-14s %s\n" "Backend" "$(backend_state "$pid" "$(proc_port "$pid" "$BACKEND_PORT")")"
  elif port_busy "$BACKEND_PORT"; then
    printf "   %-14s %s\n" "Backend" "stopped (port $BACKEND_PORT is used by another program)"
  else
    printf "   %-14s %s\n" "Backend" "stopped"
  fi
  if pid="$(own_pid frontend "$FRONTPID" "$FRONTEND_PORT")"; then
    rc=0
    port="$(proc_port "$pid" "$FRONTEND_PORT")"
    if curl -fsS --max-time 2 "http://localhost:$port/" >/dev/null 2>&1; then
      printf "   %-14s %s\n" "Web interface" "running  http://localhost:$port"
    else
      printf "   %-14s %s\n" "Web interface" "not answering on :$port (pid $pid); see: bash $0 logs"
    fi
  elif port_busy "$FRONTEND_PORT"; then
    printf "   %-14s %s\n" "Web interface" "stopped (port $FRONTEND_PORT is used by another program)"
  else
    printf "   %-14s %s\n" "Web interface" "stopped"
  fi
  return "$rc"
}

restart() {
  local pid
  if [ -z "${MANTA_BACKEND_PORT:-}" ] && pid="$(own_pid backend "$BACKPID" "$BACKEND_PORT")"; then
    BACKEND_PORT="$(proc_port "$pid" "$BACKEND_PORT")"
  fi
  if [ -z "${MANTA_FRONTEND_PORT:-}" ] && pid="$(own_pid frontend "$FRONTPID" "$FRONTEND_PORT")"; then
    FRONTEND_PORT="$(proc_port "$pid" "$FRONTEND_PORT")"
  fi
  stop "" >/dev/null && start
}

case "${1:-status}" in
  start)  start ;;
  restart) restart ;;
  stop)   case "${2:-}" in
            ""|--db) stop "${2:-}" ;;
            *) usage >&2; exit 2 ;;
          esac ;;
  status) echo "MANTA (local):"; status ;;
  logs)   echo "=== Backend ($BACKLOG)"; tail -15 "$BACKLOG" 2>/dev/null || echo "   (no log yet)"
          echo; echo "=== Web interface ($FRONTLOG)"; tail -15 "$FRONTLOG" 2>/dev/null || echo "   (no log yet)" ;;
  help|-h|--help) usage ;;
  *)      usage >&2; exit 2 ;;
esac
