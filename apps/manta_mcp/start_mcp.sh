#!/bin/sh
set -e

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENVDATEI="$ROOT/apps/manta_web/backend/.env"
PYTHON="$ROOT/apps/manta_web/backend/.venv/bin/python"

[ -f "$ENVDATEI" ] || { echo "MANTA-MCP: $ENVDATEI fehlt — dort stehen NEO4J_URI/USER/PASSWORD." >&2; exit 1; }
[ -x "$PYTHON" ]   || { echo "MANTA-MCP: $PYTHON fehlt — venv des Backends anlegen." >&2; exit 1; }

set -a
. "$ENVDATEI"
set +a

exec "$PYTHON" "$ROOT/apps/manta_mcp/server.py"
