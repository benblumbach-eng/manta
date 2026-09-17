from __future__ import annotations

import argparse
import csv
from pathlib import Path

from ingest import connect

TAXA_COLUMNS = ["Kingdom", "Phylum", "Class", "Order", "Family", "Genus", "Species"]
TAXA_PROPS = ["kingdom", "phylum", "class", "order", "family", "genus", "species"]
ENV_PROPS = ["MLD", "temp", "PW_frac", "chl_sens", "PAR_satellite", "sal", "O2_conc", "depth"]


def _q(driver, query, **params):
    with driver.session() as s:
        return [r.data() for r in s.run(query, **params)]


def export(driver, dataset_id: str, out: Path) -> dict:
    out.mkdir(parents=True, exist_ok=True)

    samples = _q(driver, "MATCH (s:Sample {dataset_id:$d}) RETURN s.sample_id AS id, "
                         "s.date AS date, properties(s) AS props ORDER BY s.date, s.sample_id",
                 d=dataset_id)
    asvs = _q(driver, "MATCH (a:ASV {dataset_id:$d}) RETURN a.id AS id, properties(a) AS props "
                      "ORDER BY a.id", d=dataset_id)
    if not samples or not asvs:
        raise SystemExit(f"dataset_id={dataset_id!r} hat keine Proben oder keine ASVs")

    cells = _q(driver, "MATCH (s:Sample {dataset_id:$d})-[r:HAS_ABUNDANCE]->(a:ASV {dataset_id:$d}) "
                       "RETURN s.sample_id AS s, a.id AS a, r.count AS c", d=dataset_id)
    grid = {(c["s"], c["a"]): c["c"] for c in cells}

    asv_ids = [a["id"] for a in asvs]
    with open(out / "abundance.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, delimiter=";")
        w.writerow([""] + asv_ids)
        for s in samples:
            w.writerow([s["id"]] + [repr(grid.get((s["id"], a), 0.0)) for a in asv_ids])

    with open(out / "taxa_info.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, delimiter=";")
        w.writerow(["ASV"] + TAXA_COLUMNS)
        for a in asvs:
            p = a["props"]
            w.writerow([a["id"]] + [p.get(k) or "" for k in TAXA_PROPS])

    with open(out / "environment_info.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, delimiter=";")
        w.writerow(["date"] + ENV_PROPS)
        for s in samples:
            p = s["props"]
            w.writerow([s["id"]] + ["" if p.get(k) is None else p[k] for k in ENV_PROPS])

    return {"samples": len(samples), "asvs": len(asv_ids), "cells": len(cells)}


def main() -> int:
    p = argparse.ArgumentParser(description="Ingesteten Datensatz -> 3 OTTER-Eingabe-CSVs.")
    p.add_argument("--dataset-id", required=True)
    p.add_argument("--out", required=True)
    args = p.parse_args()
    driver = connect()
    try:
        driver.verify_connectivity()
        counts = export(driver, args.dataset_id, Path(args.out))
        print(f"Export ok ({args.dataset_id}): {counts}")
    finally:
        driver.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
