#!/bin/sh
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
for UV in "$(command -v uv 2>/dev/null)" "$HOME/.local/bin/uv" "/opt/homebrew/bin/uv" "/usr/local/bin/uv"; do
  [ -n "$UV" ] && [ -x "$UV" ] && break
done
[ -x "$UV" ] || { echo "stats-MCP: uv nicht gefunden (gesucht: PATH, ~/.local/bin, /opt/homebrew/bin)." >&2; exit 1; }
exec "$UV" run --quiet "$HERE/server.py"
