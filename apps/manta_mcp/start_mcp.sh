#!/bin/sh
set -e

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENVDATEI="$ROOT/apps/manta_web/backend/.env"
PYTHON="$ROOT/apps/manta_web/backend/.venv/bin/python"

[ -f "$ENVDATEI" ] || { echo "MANTA-MCP: $ENVDATEI is missing — it holds NEO4J_URI/USER/PASSWORD." >&2; exit 1; }
[ -x "$PYTHON" ]   || { echo "MANTA-MCP: $PYTHON is missing — create the backend venv first." >&2; exit 1; }

set -a
. "$ENVDATEI"
set +a

exec "$PYTHON" "$ROOT/apps/manta_mcp/server.py"
