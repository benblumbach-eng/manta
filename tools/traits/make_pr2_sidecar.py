#!/usr/bin/env python3
from __future__ import annotations

import csv
import hashlib
import sys
from pathlib import Path

import openpyxl

HERE = Path(__file__).resolve().parent
OUT = HERE / "vendor" / "pr2_version_5.1.0_mixoplankton.tsv"
PR2_TAXONOMY_SHA256 = "970b56e9c740eeb4002c1c732e7903b17d03d98ff75dcf000fb03652f1e6431b"
RANKS = ("domain", "supergroup", "division", "subdivision", "class", "order", "family",
         "genus", "species")


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    src = Path(argv[1])
    digest = hashlib.sha256(src.read_bytes()).hexdigest()
    if digest != PR2_TAXONOMY_SHA256:
        print(f"ABBRUCH: {src} hat SHA-256 {digest}, erwartet {PR2_TAXONOMY_SHA256} "
              f"(PR2 v5.1.0 taxonomy.xlsx)", file=sys.stderr)
        return 1
    ws = openpyxl.load_workbook(src, read_only=True).worksheets[0]
    rows = ws.iter_rows(values_only=True)
    hdr = [str(h) for h in next(rows)]
    idx = {h: i for i, h in enumerate(hdr)}
    for need in RANKS + ("mixoplankton",):
        if need not in idx:
            print(f"ABBRUCH: Spalte {need!r} fehlt in {src}", file=sys.stderr)
            return 1
    out = []
    for r in rows:
        mix = r[idx["mixoplankton"]]
        if mix is None or str(mix).strip() == "":
            continue
        out.append([("" if r[idx[k]] is None else str(r[idx[k]])) for k in RANKS]
                   + [str(mix).strip()])
    out.sort()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8", newline="\n") as fh:
        w = csv.writer(fh, delimiter="\t", lineterminator="\n")
        w.writerow(list(RANKS) + ["mixoplankton"])
        w.writerows(out)
    print(f"{len(out)} annotierte Zeilen -> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
