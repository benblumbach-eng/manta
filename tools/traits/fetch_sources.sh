#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR="$HERE/vendor"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$VENDOR"

TMD_URL="https://zenodo.org/api/records/15149453/files/TMDv1.1_Jones.csv/content"
PR2_URL="https://github.com/pr2database/pr2database/releases/download/v5.1.0.0/pr2_version_5.1.0_taxonomy.xlsx"
PR2_SHA="970b56e9c740eeb4002c1c732e7903b17d03d98ff75dcf000fb03652f1e6431b"
FAP_URL="https://pages.uoregon.edu/slouca/LoucaLab/archive/FAPROTAX/SECTION_Download/MODULE_Downloads/CLASS_Latest%20release/UNIT_FAPROTAX_1.2.12/FAPROTAX_1.2.12.zip"

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
need() {
  local ist; ist="$(sha "$1")"
  [ "$ist" = "$2" ] || { echo "FEHLER: $(basename "$1") hat SHA-256 $ist, erwartet $2" >&2; exit 1; }
}
soll() { awk -v f="$1" '$2==f {print $1}' "$VENDOR/SHA256SUMS"; }

echo "-- Trophic Mode Database v1.1"
curl -fsSL --retry 3 -o "$VENDOR/TMDv1.1_Jones.csv" "$TMD_URL"
need "$VENDOR/TMDv1.1_Jones.csv" "$(soll TMDv1.1_Jones.csv)"

echo "-- PR2 v5.1.0 -> Auszug der Zeilen mit mixoplankton"
curl -fsSL --retry 3 -o "$TMP/pr2_version_5.1.0_taxonomy.xlsx" "$PR2_URL"
need "$TMP/pr2_version_5.1.0_taxonomy.xlsx" "$PR2_SHA"
PY="${PYTHON:-$HERE/../neo4j_ingest/.venv/bin/python}"
[ -x "$PY" ] || { echo "FEHLER: Python fehlt ($PY); PYTHON=... setzen" >&2; exit 1; }
"$PY" -c "import openpyxl" 2>/dev/null \
  || { echo "FEHLER: $PY hat kein openpyxl. Nachinstallieren:" >&2
       echo "        uv pip install -p $PY openpyxl" >&2; exit 1; }
"$PY" "$HERE/make_pr2_sidecar.py" "$TMP/pr2_version_5.1.0_taxonomy.xlsx"
need "$VENDOR/pr2_version_5.1.0_mixoplankton.tsv" "$(soll pr2_version_5.1.0_mixoplankton.tsv)"

echo "-- FAPROTAX 1.2.12"
curl -fsSL --retry 3 -o "$TMP/faprotax.zip" "$FAP_URL"
unzip -q -o "$TMP/faprotax.zip" -d "$TMP/fap"
gzip -9 -n -c "$TMP/fap/FAPROTAX_1.2.12/FAPROTAX.txt" > "$VENDOR/FAPROTAX_1.2.12.txt.gz"
cp "$TMP/fap/FAPROTAX_1.2.12/README.txt" "$VENDOR/FAPROTAX_1.2.12_README.txt"
need "$VENDOR/FAPROTAX_1.2.12.txt.gz" "$(soll FAPROTAX_1.2.12.txt.gz)"
need "$VENDOR/FAPROTAX_1.2.12_README.txt" "$(soll FAPROTAX_1.2.12_README.txt)"

echo "OK: alle Quellen in $VENDOR, Pruefsummen stimmen."
