#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

VORGABE="qwen2.5:7b"

hilfe() {
  echo "MANTA assistant"
  echo
  echo "  bash assistant.sh on [model]   add the assistant (default: $VORGABE)"
  echo "  bash assistant.sh off          remove it again; the pulled models stay"
  echo "  bash assistant.sh status       what is running right now"
  echo
  echo "Models that MANTA has been used with (all of them speak the tool protocol):"
  echo "  qwen2.5:7b     4.7 GB   Apache 2.0        the default"
  echo "  qwen2.5:1.5b   1.0 GB   Apache 2.0        for an 8 GB machine"
  echo "  llama3.1:8b    4.9 GB   Llama 3.1 licence  a second opinion"
  echo
  echo "Any other Ollama model with tool support works: bash assistant.sh on <name>"
}

[ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ] && { hilfe; exit 0; }
BEFEHL="${1:-status}"
MODELL="${2:-$VORGABE}"

[ -f deploy/.env ] || {
  echo "deploy/.env is missing — set the installation up first (see the README, step 1)." >&2
  exit 2
}

setze() {
  local name="$1" wert="$2" datei="deploy/.env"
  if grep -q "^${name}=" "$datei"; then
    awk -v n="$name" -v w="$wert" 'BEGIN{FS=OFS="="} $1==n {print n "=" w; next} {print}' \
      "$datei" > "$datei.neu" && mv "$datei.neu" "$datei"
  else
    printf '%s=%s\n' "$name" "$wert" >> "$datei"
  fi
}

case "$BEFEHL" in
  on)
    echo "-- deploy/.env: COMPOSE_PROFILES=assistant, OLLAMA_MODEL=$MODELL"
    setze COMPOSE_PROFILES assistant
    setze OLLAMA_MODEL "$MODELL"
    echo "-- starting the model service"
    (cd deploy && docker compose up -d)
    echo "-- pulling $MODELL (this is the download; it happens once)"
    (cd deploy && docker compose exec -T ollama ollama pull "$MODELL")
    echo
    echo "The assistant is in. Reload the page; the model switch now offers $MODELL."
    ;;
  off)
    echo "-- deploy/.env: COMPOSE_PROFILES="
    setze COMPOSE_PROFILES ""
    (cd deploy && docker compose stop ollama >/dev/null 2>&1 || true)
    (cd deploy && docker compose rm -f ollama >/dev/null 2>&1 || true)
    echo
    echo "The assistant is out. Everything else keeps running, and the chat says that no model"
    echo "is reachable. The pulled models stay in their volume — switching it back on costs no"
    echo "second download (remove them with: docker volume rm deploy_ollama_models)."
    ;;
  status)
    profil="$(grep '^COMPOSE_PROFILES=' deploy/.env | cut -d= -f2- || true)"
    modell="$(grep '^OLLAMA_MODEL=' deploy/.env | cut -d= -f2- || true)"
    laeuft="$( (cd deploy && docker compose ps --status running --services 2>/dev/null) | grep -c '^ollama$' || true)"
    echo "profile:  ${profil:-<empty>}"
    echo "model:    ${modell:-$VORGABE}"
    echo "service:  $([ "$laeuft" = "1" ] && echo running || echo "not running")"
    if [ "$laeuft" = "1" ]; then
      echo "pulled:"
      (cd deploy && docker compose exec -T ollama ollama list 2>/dev/null | sed '1d;s/^/  /') || true
    else
      echo
      echo "Add it with: bash assistant.sh on"
    fi
    ;;
  *)
    hilfe; exit 2 ;;
esac
