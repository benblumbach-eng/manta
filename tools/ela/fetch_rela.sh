#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMMIT="94081065e1224e13daa0e0ce815bfadfa773a04f"
ARCHIVE_SHA="d5b85f187207ac044efcfbd80c3852de0f8d7a0a442b4929fa80c0b83255fee8"
TARBALL="rELA.v0.80.3.tar.gz"
TARBALL_SHA="aa4718529e7e2da727d3df73fcbc470551f1f8e0d3b1a3452bf931c27bfccd8a"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

curl -fsSL --retry 3 -o "$TMP/rela.tar.gz" "https://github.com/kecosz/rELA/archive/$COMMIT.tar.gz"
[ "$(sha "$TMP/rela.tar.gz")" = "$ARCHIVE_SHA" ] || { echo "FEHLER: Archiv-Pruefsumme stimmt nicht" >&2; exit 1; }
tar xzf "$TMP/rela.tar.gz" -C "$TMP" "rELA-$COMMIT/$TARBALL"
mkdir -p "$HERE/vendor"
cp "$TMP/rELA-$COMMIT/$TARBALL" "$HERE/vendor/$TARBALL"
[ "$(sha "$HERE/vendor/$TARBALL")" = "$TARBALL_SHA" ] || { echo "FEHLER: $TARBALL-Pruefsumme stimmt nicht" >&2; exit 1; }
echo "OK: $HERE/vendor/$TARBALL (Commit ${COMMIT:0:7}, Pruefsumme stimmt)"
