#!/usr/bin/env python3
from __future__ import annotations

import csv
import hashlib
import sys
from pathlib import Path

import openpyxl

HERE = Path(__file__).resolve().parent
USAGE = ("usage: make_pr2_sidecar.py <pr2_version_5.1.0_taxonomy.xlsx> [out_dir]\n"
         "Writes the PR2 v5.1.0 rows that carry `mixoplankton` or `ecological_function` to\n"
         "out_dir (default: tools/traits/vendor/) as sorted TSV files. The .xlsx must have the\n"
         "pinned SHA-256.")
OUT = HERE / "vendor" / "pr2_version_5.1.0_mixoplankton.tsv"
OUT_FUN = HERE / "vendor" / "pr2_version_5.1.0_ecological_function.tsv"
PR2_TAXONOMY_SHA256 = "970b56e9c740eeb4002c1c732e7903b17d03d98ff75dcf000fb03652f1e6431b"
RANKS = ("domain", "supergroup", "division", "subdivision", "class", "order", "family",
         "genus", "species")


def main(argv: list[str]) -> int:
    if len(argv) not in (2, 3):
        print(USAGE, file=sys.stderr)
        return 2
    src = Path(argv[1])
    out_mix, out_fun = OUT, OUT_FUN
    if len(argv) == 3:
        out_mix, out_fun = Path(argv[2]) / OUT.name, Path(argv[2]) / OUT_FUN.name
    digest = hashlib.sha256(src.read_bytes()).hexdigest()
    if digest != PR2_TAXONOMY_SHA256:
        print(f"ERROR: {src} has SHA-256 {digest}, expected {PR2_TAXONOMY_SHA256} "
              f"(PR2 v5.1.0 taxonomy.xlsx)", file=sys.stderr)
        return 1
    ws = openpyxl.load_workbook(src, read_only=True).worksheets[0]
    rows = ws.iter_rows(values_only=True)
    hdr = [str(h) for h in next(rows)]
    idx = {h: i for i, h in enumerate(hdr)}
    for need in RANKS + ("mixoplankton", "ecological_function"):
        if need not in idx:
            print(f"ERROR: column {need!r} is missing in {src}", file=sys.stderr)
            return 1
    out, funktionen = [], []
    for r in rows:
        linie = [("" if r[idx[k]] is None else str(r[idx[k]])) for k in RANKS]
        mix = r[idx["mixoplankton"]]
        if mix is not None and str(mix).strip() != "":
            out.append(linie + [str(mix).strip()])
        fun = r[idx["ecological_function"]]
        if fun is not None and str(fun).strip() != "":
            funktionen.append(linie + [str(fun).strip()])
    out.sort()
    funktionen.sort()
    out_mix.parent.mkdir(parents=True, exist_ok=True)
    with out_mix.open("w", encoding="utf-8", newline="\n") as fh:
        w = csv.writer(fh, delimiter="\t", lineterminator="\n")
        w.writerow(list(RANKS) + ["mixoplankton"])
        w.writerows(out)
    print(f"{len(out)} rows with mixoplankton -> {out_mix}")
    with out_fun.open("w", encoding="utf-8", newline="\n") as fh:
        w = csv.writer(fh, delimiter="\t", lineterminator="\n")
        w.writerow(list(RANKS) + ["ecological_function"])
        w.writerows(funktionen)
    print(f"{len(funktionen)} rows with ecological_function -> {out_fun}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
