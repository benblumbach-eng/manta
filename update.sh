#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  echo "MANTA update"
  echo
  echo "  bash update.sh          fetch, update and restart what is running"
  echo "  bash update.sh --check  only look; exit code 10 means a newer version exists"
  exit 0
fi
NUR_SEHEN=0
[ "${1:-}" = "--check" ] && NUR_SEHEN=1

warn() { echo "warning: $*" >&2; }

OTTER=submodules/otter
otter_gitlink() { case "$(git ls-files -s -- "$OTTER")" in 160000\ *) return 0 ;; esac; return 1; }
otter_blocked() {
  otter_gitlink && [ -d "$OTTER" ] && [ ! -e "$OTTER/.git" ] && [ -n "$(ls -A "$OTTER")" ]
}
otter_fetch() {
  if ! otter_blocked; then
    git submodule update --init --quiet
    return
  fi
  local rest t rc=0
  rm -f "$OTTER/.DS_Store"
  rest="$(ls -A "$OTTER" | grep -vx '\.venv' || true)"
  if [ -n "$rest" ]; then
    echo "$OTTER should hold the OTTER checkout, but it is a plain folder with these entries:" >&2
    echo "$rest" | sed 's/^/    /' >&2
    echo "Move them out of $OTTER, then run 'bash update.sh' again." >&2
    return 1
  fi
  if [ ! -e "$OTTER/.venv" ]; then
    git submodule update --init --quiet
    return
  fi
  echo "-- fetching OTTER into $OTTER (its .venv is kept)"
  t="$(mktemp -d "$PWD/.otter-venv.XXXXXX")" || return 1
  mv "$OTTER/.venv" "$t/.venv" || { rmdir "$t"; return 1; }
  git submodule update --init --quiet || rc=$?
  mkdir -p "$OTTER" && mv "$t/.venv" "$OTTER/.venv" && rmdir "$t" || {
    echo "could not move the OTTER environment back; it is in $t/.venv" >&2
    return 1
  }
  return "$rc"
}

zweig="$(git rev-parse --abbrev-ref HEAD)"
git fetch --quiet origin "$zweig"
alt="$(git rev-parse HEAD)"
neu="$(git rev-parse "origin/$zweig")"

RESUME=0
if [ "$alt" != "$neu" ] && ! git merge-base --is-ancestor "$neu" "$alt" &&
   ! git merge-base --is-ancestor "$alt" "$neu"; then
  echo "This clone cannot be updated in place: its history and the published one have diverged" >&2
  echo "(the published history was rewritten, or this clone has commits of its own)." >&2
  echo "Your imported data are not affected. Clone MANTA again and repeat step 2 of the README there:" >&2
  echo "  git clone $(git remote get-url origin) <new folder>" >&2
  exit 1
fi
if [ "$alt" = "$neu" ] || git merge-base --is-ancestor "$neu" "$alt"; then
  echo "MANTA is up to date ($(git log -1 --format='%h  %ad' --date=short))"
  otter_blocked || exit 0
  if [ "$NUR_SEHEN" = 1 ]; then
    echo "but OTTER is missing in $OTTER; run 'bash update.sh' to fetch it"
    exit 0
  fi
  echo "-- OTTER is missing; finishing the previous update"
  RESUME=1
else
  anzahl="$(git rev-list --count "$alt..$neu")"
  echo "A newer MANTA is available: $anzahl commit(s), $(git log -1 --format='%ad' --date=short "$neu")"
  if [ "$NUR_SEHEN" = 1 ]; then
    echo "run 'bash update.sh' to install it"
    exit 10
  fi

  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "local changes in this clone — commit or stash them first:" >&2
    git status --short >&2
    exit 1
  fi

  git merge --ff-only "origin/$zweig"
fi

PENDING=""
pending() { PENDING="$PENDING
    $1"; }
if ! otter_fetch; then
  if otter_blocked; then pending "bash update.sh"; else pending "git submodule update --init"; fi
fi

geaendert() { [ "$RESUME" = 1 ] || [ -n "$(git diff --name-only "$alt" "$neu" -- "$1")" ]; }
uv_oder_pip() {
  if command -v uv >/dev/null 2>&1; then uv pip install -q -p "$1/bin/python" -r "$2"
  else "$1/bin/python" -m pip install -q -r "$2"; fi
}

for paar in "apps/manta_web/backend:apps/manta_web/backend/requirements.txt" \
            "tools/neo4j_ingest:tools/neo4j_ingest/requirements.txt" \
            "tools/dada2_to_otter:tools/dada2_to_otter/requirements.txt" \
            "submodules/otter:tools/otter_runner/requirements-otter.txt"; do
  ordner="${paar%%:*}"; liste="${paar#*:}"
  if [ -x "$ordner/.venv/bin/python" ] && geaendert "$liste"; then
    echo "-- dependencies: $liste"
    uv_oder_pip "$ordner/.venv" "$liste" || pending "uv pip install -p $ordner/.venv/bin/python -r $liste"
  fi
done

frontend_changed() {
  local lock=apps/manta_web/frontend/package-lock.json
  if [ "$RESUME" = 1 ]; then [ "$lock" -nt apps/manta_web/frontend/node_modules/.package-lock.json ]
  else geaendert "$lock"; fi
}
if [ -d apps/manta_web/frontend/node_modules ] && frontend_changed; then
  echo "-- dependencies: apps/manta_web/frontend"
  (cd apps/manta_web/frontend && npm ci --silent) || pending "(cd apps/manta_web/frontend && npm ci)"
fi

own_services() {
  [ -f deploy/.env ] && command -v docker >/dev/null 2>&1 || return 0
  local here dir svc
  here="$(cd deploy && pwd -P)"
  docker ps --filter label=com.docker.compose.service \
    --format '{{.Label "com.docker.compose.project.working_dir"}}|{{.Label "com.docker.compose.service"}}' \
    2>/dev/null | while IFS='|' read -r dir svc; do
      [ -n "$dir" ] && [ "$(cd "$dir" 2>/dev/null && pwd -P)" = "$here" ] && echo "$svc"
    done | sort -u
  return 0
}

WEB_PORT="$( { sed -n 's/^HTTP_PORT=//p' deploy/.env 2>/dev/null || true; } | tail -1)"
if [ -f deploy/.env ] && ! docker info >/dev/null 2>&1; then
  warn "Docker not reachable; afterwards run: cd deploy && docker compose up -d --build"
fi
services="$(own_services || true)"
if [ -n "$services" ]; then
  services="$(echo $services)"
  echo "-- rebuilding the running containers: $services"
  if (cd deploy && docker compose up -d --build $services); then
    case " $services " in *" caddy "*) echo "   site: http://localhost:${WEB_PORT:-8080}" ;; esac
  else
    warn "the update is installed, but the containers did not restart; run: cd deploy && docker compose up -d --build $services"
  fi
fi

if bash apps/manta_web/dev.sh status >/dev/null 2>&1; then
  echo "-- restarting the local stack"
  if ! bash apps/manta_web/dev.sh restart; then
    warn "the update is installed, but the local stack did not restart cleanly; see: bash apps/manta_web/dev.sh status"
  fi
fi

echo "MANTA is now at $(git log -1 --format='%h  %ad' --date=short)"
if [ -n "$PENDING" ]; then
  echo "Some steps failed (see the messages above). Fix the cause, then run in $PWD:$PENDING" >&2
  exit 1
fi
