#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR="$HERE/vendor"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
STAGE="$TMP/stage"
mkdir -p "$VENDOR" "$STAGE"

TMD_URL="https://zenodo.org/api/records/15149453/files/TMDv1.1_Jones.csv/content"
PR2_URL="https://github.com/pr2database/pr2database/releases/download/v5.1.0.0/pr2_version_5.1.0_taxonomy.xlsx"
PR2_SHA="970b56e9c740eeb4002c1c732e7903b17d03d98ff75dcf000fb03652f1e6431b"
FAP_URL="https://pages.uoregon.edu/slouca/LoucaLab/archive/FAPROTAX/SECTION_Download/MODULE_Downloads/CLASS_Latest%20release/UNIT_FAPROTAX_1.2.12/FAPROTAX_1.2.12.zip"
FAP_ZIP_SHA="87e229e5201c23f8286aeb5f092f50a95bfe6281c7746d89a50c0aac11a5923c"

sha() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}
need() {
  local ist; ist="$(sha "$1")"
  [ "$ist" = "$2" ] || { echo "ERROR: $(basename "$1") has SHA-256 $ist, expected ${2:-(none listed)}" >&2; exit 1; }
}
soll() { awk -v f="$1" '$2==f {print $1}' "$VENDOR/SHA256SUMS"; }

echo "-- Trophic Mode Database v1.1"
curl -fsSL --retry 3 -o "$STAGE/TMDv1.1_Jones.csv" "$TMD_URL"
need "$STAGE/TMDv1.1_Jones.csv" "$(soll TMDv1.1_Jones.csv)"

echo "-- PR2 v5.1.0 -> extract of the rows with mixoplankton / ecological_function"
curl -fsSL --retry 3 -o "$TMP/pr2_version_5.1.0_taxonomy.xlsx" "$PR2_URL"
need "$TMP/pr2_version_5.1.0_taxonomy.xlsx" "$PR2_SHA"
PY="${PYTHON:-$HERE/../neo4j_ingest/.venv/bin/python}"
[ -x "$PY" ] || { echo "ERROR: Python not found ($PY); set PYTHON=..." >&2; exit 1; }
"$PY" -c "import openpyxl" 2>/dev/null \
  || { echo "ERROR: $PY has no openpyxl. Install it with:" >&2
       echo "       uv pip install -p $PY openpyxl" >&2; exit 1; }
"$PY" "$HERE/make_pr2_sidecar.py" "$TMP/pr2_version_5.1.0_taxonomy.xlsx" "$STAGE"
need "$STAGE/pr2_version_5.1.0_mixoplankton.tsv" "$(soll pr2_version_5.1.0_mixoplankton.tsv)"
need "$STAGE/pr2_version_5.1.0_ecological_function.tsv" "$(soll pr2_version_5.1.0_ecological_function.tsv)"

echo "-- FAPROTAX 1.2.12"
curl -fsSL --retry 3 -o "$TMP/faprotax.zip" "$FAP_URL"
need "$TMP/faprotax.zip" "$FAP_ZIP_SHA"
unzip -q -o "$TMP/faprotax.zip" -d "$TMP/fap"
need "$TMP/fap/FAPROTAX_1.2.12/FAPROTAX.txt" "$(soll FAPROTAX_1.2.12.txt)"
need "$TMP/fap/FAPROTAX_1.2.12/README.txt" "$(soll FAPROTAX_1.2.12_README.txt)"
gzip -9 -n -c "$TMP/fap/FAPROTAX_1.2.12/FAPROTAX.txt" > "$STAGE/FAPROTAX_1.2.12.txt.gz"
cp "$TMP/fap/FAPROTAX_1.2.12/README.txt" "$STAGE/FAPROTAX_1.2.12_README.txt"

mv -f "$STAGE"/* "$VENDOR"/
echo "OK: all sources in $VENDOR, checksums match."
