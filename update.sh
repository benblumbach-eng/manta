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

zweig="$(git rev-parse --abbrev-ref HEAD)"
git fetch --quiet origin "$zweig"
alt="$(git rev-parse HEAD)"
neu="$(git rev-parse "origin/$zweig")"

if [ "$alt" = "$neu" ]; then
  echo "MANTA is up to date ($(git log -1 --format='%h  %ad' --date=short))"
  exit 0
fi
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
git submodule update --init --quiet

geaendert() { [ -n "$(git diff --name-only "$alt" "$neu" -- "$1")" ]; }
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
    uv_oder_pip "$ordner/.venv" "$liste"
  fi
done

if [ -d apps/manta_web/frontend/node_modules ] && geaendert apps/manta_web/frontend/package-lock.json; then
  echo "-- dependencies: apps/manta_web/frontend"
  (cd apps/manta_web/frontend && npm ci --silent)
fi

antwortet() { curl -fsS --max-time 2 "$1" >/dev/null 2>&1; }

if antwortet "http://localhost:${MANTA_WEB_PORT:-8080}/"; then
  echo "-- rebuilding the container stack"
  (cd deploy && docker compose up -d --build)
fi
if antwortet "http://localhost:8000/health" || antwortet "http://localhost:5173/"; then
  echo "-- restarting the local stack"
  bash apps/manta_web/dev.sh stop >/dev/null
  bash apps/manta_web/dev.sh start
fi

echo "MANTA is now at $(git log -1 --format='%h  %ad' --date=short)"
