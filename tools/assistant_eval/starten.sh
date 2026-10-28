#!/usr/bin/env bash
# Starts a measurement on the server in one go: fetches the current script and catalog into ~/messung,
# stops an older run, asks for the password once, then runs in the background (a lost SSH
# connection does not stop it) and shows the log. Ctrl+C only ends the view.
#   bash <(curl -fsS https://raw.githubusercontent.com/benblumbach-eng/manta/main/tools/assistant_eval/starten.sh) --user ben2 --dataset teststation --model qwen3:8b
# Watch later: tail -f ~/messung/lauf.log
set -euo pipefail
QUELLE=https://raw.githubusercontent.com/benblumbach-eng/manta/main/tools/assistant_eval
mkdir -p ~/messung && cd ~/messung
for f in messen.py fragen.json; do curl -fsSO "$QUELLE/$f"; done
pkill -f 'python3 .*messen\.py' && echo "older run stopped" || true
read -rsp "MANTA password: " MANTA_PASSWORD && echo
export MANTA_PASSWORD
nohup python3 -u messen.py "$@" > lauf.log 2>&1 < /dev/null &
echo "running in the background, log: ~/messung/lauf.log (Ctrl+C ends only this view)"
tail -f lauf.log
