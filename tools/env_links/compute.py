#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import math
import sys
from pathlib import Path

import numpy as np
from scipy import stats

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "apps" / "manta_mcp"))
sys.path.insert(0, str(ROOT / "tools" / "neo4j_ingest"))

import semantics

OUT_DIR = HERE / "out"
MIN_PAIRS = 8
DEFAULT_MAX_LAG = 3
DEFAULT_ALPHA = 0.05
METHOD = ("Spearman rank correlation of the ASV's share of the sample against the variable, at "
          "sample shifts -L..+L (in samples, not time units; k > 0: the ASV follows the variable "
          "by k samples); missing measurements dropped pairwise, never imputed; best shift = "
          "largest |r| (ties: smaller |k|, then positive); p = Spearman p at the best shift; "
          "Benjamini-Hochberg across all pairs of one variable; link for p_adj < alpha. The choice "
          "of the best of 2L+1 shifts is not corrected for.")



def spearman_at_lag(env: list[float | None], asv: list[float], lag: int) -> tuple[float | None, float | None, int]:
    pairs = []
    for t, e in enumerate(env):
        u = t + lag
        if e is None or u < 0 or u >= len(asv):
            continue
        pairs.append((float(e), float(asv[u])))
    if len(pairs) < MIN_PAIRS:
        return None, None, len(pairs)
    r, p = stats.spearmanr([e for e, _ in pairs], [a for _, a in pairs])
    if r is None or (isinstance(r, float) and math.isnan(r)):
        return None, None, len(pairs)
    return float(r), float(p), len(pairs)


def cross_correlate(env: list[float | None], asv: list[float], max_lag: int) -> dict | None:
    by_lag = {}
    for k in range(-max_lag, max_lag + 1):
        r, p, n = spearman_at_lag(env, asv, k)
        if r is not None:
            by_lag[k] = (r, p, n)
    if not by_lag:
        return None
    best = sorted(by_lag, key=lambda k: (-abs(by_lag[k][0]), abs(k), -k))[0]
    r, p, n = by_lag[best]
    r0, _, n0 = by_lag.get(0, (None, None, 0))
    return {"lag": best, "r": r, "p": p, "n": n, "r0": r0, "n0": n0,
            "n_lags_tested": len(by_lag)}


def benjamini_hochberg(ps: list[float]) -> list[float]:
    m = len(ps)
    if m == 0:
        return []
    order = sorted(range(m), key=lambda i: ps[i])
    adj = [0.0] * m
    running = 1.0
    for rank in range(m, 0, -1):
        i = order[rank - 1]
        running = min(running, ps[i] * m / rank)
        adj[i] = min(1.0, running)
    return adj


def compute_links(samples: list[dict], env_by_var: dict[str, list[float | None]],
                  shares: dict[str, list[float]], max_lag: int, alpha: float) -> list[dict]:
    rows = []
    for var in sorted(env_by_var):
        env = env_by_var[var]
        var_rows = []
        for asv_id in sorted(shares):
            cc = cross_correlate(env, shares[asv_id], max_lag)
            if cc is None:
                continue
            var_rows.append({"variable": var, "asv_id": asv_id, **cc})
        adj = benjamini_hochberg([r["p"] for r in var_rows])
        for r, pa in zip(var_rows, adj):
            r["p_adj"] = pa
            r["edge"] = bool(pa < alpha)
        rows += var_rows
    return rows



def read_dataset(driver, dataset_id: str) -> dict:
    keys = semantics.ENVIRONMENT_KEYS
    props = ", ".join(f"s.`{k}` AS `{k}`" for k in keys)
    with driver.session() as s:
        d = s.run("MATCH (d:Dataset {dataset_id:$d}) RETURN d.time_axis AS axis", d=dataset_id).single()
        if not d:
            raise SystemExit(f"Dataset {dataset_id!r} gibt es im Graphen nicht.")
        samples = [dict(r) for r in s.run(
            f"MATCH (s:Sample {{dataset_id:$d}}) "
            f"OPTIONAL MATCH (s)-[ha:HAS_ABUNDANCE]->(:ASV {{dataset_id:$d}}) "
            f"WITH s, coalesce(sum(ha.count), 0.0) AS live_total "
            f"RETURN s.sample_id AS sample, s.date AS date, "
            f"coalesce(s.analysed_reads_total, live_total) AS total, {props} "
            f"ORDER BY s.date, s.sample_id", d=dataset_id)]
        cells = [dict(r) for r in s.run(
            "MATCH (s:Sample {dataset_id:$d})-[ha:HAS_ABUNDANCE]->(a:ASV {dataset_id:$d}) "
            "RETURN s.sample_id AS sample, a.id AS asv, ha.count AS count", d=dataset_id)]
    return {"axis": d["axis"], "samples": samples, "cells": cells}


def build_series(samples: list[dict], cells: list[dict]) -> tuple[dict, dict]:
    idx = {s["sample"]: i for i, s in enumerate(samples)}
    n = len(samples)
    shares: dict[str, list[float]] = {}
    for c in cells:
        shares.setdefault(c["asv"], [0.0] * n)
        i = idx[c["sample"]]
        tot = samples[i]["total"] or 0.0
        shares[c["asv"]][i] = (float(c["count"]) / tot) if tot > 0 else 0.0
    env_by_var = {}
    for spec in semantics.ENVIRONMENT_VARS:
        k = spec["key"]
        vals = [s.get(k) for s in samples]
        if any(v is not None for v in vals):
            env_by_var[k] = [None if v is None else float(v) for v in vals]
    return env_by_var, shares


def write_tsv(dataset_id: str, rows: list[dict], out_dir: Path = OUT_DIR) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    p = out_dir / f"{dataset_id}.env_links.tsv"
    with p.open("w", encoding="utf-8", newline="\n") as fh:
        w = csv.writer(fh, delimiter="\t", lineterminator="\n")
        w.writerow(["variable", "asv_id", "lag", "r", "r0", "p", "p_adj", "n", "n0", "edge"])
        for r in rows:
            w.writerow([r["variable"], r["asv_id"], r["lag"], repr(r["r"]),
                        "" if r["r0"] is None else repr(r["r0"]), repr(r["p"]), repr(r["p_adj"]),
                        r["n"], r["n0"], int(r["edge"])])
    return p


def run_id_for(max_lag: int, alpha: float) -> str:
    return f"envlinks_spearman_L{max_lag}_bh{alpha:g}"


def compute_dataset(driver, dataset_id: str, max_lag: int = DEFAULT_MAX_LAG,
                    alpha: float = DEFAULT_ALPHA) -> dict:
    data = read_dataset(driver, dataset_id)
    env_by_var, shares = build_series(data["samples"], data["cells"])
    run_id = run_id_for(max_lag, alpha)
    absent = None
    if data["axis"] != semantics.TIME_AXIS_DATES:
        absent = ("This dataset has no real time axis (sample order only) — a shift in samples "
                  "would be a shift along an arbitrary order, so no links were computed.")
    elif not env_by_var:
        absent = "This dataset carries no environmental variables, so there is nothing to link."
    rows = [] if absent else compute_links(data["samples"], env_by_var, shares, max_lag, alpha)
    edges = [r for r in rows if r["edge"]]
    labels = {v["key"]: v for v in semantics.ENVIRONMENT_VARS}
    props = {
        "dataset_id": dataset_id, "run_id": run_id, "computed_by": "manta", "method": METHOD,
        "measure": "Spearman rank correlation", "quantity": "share",
        "max_lag": max_lag, "lag_unit": "samples", "alpha": alpha, "min_pairs": MIN_PAIRS,
        "correction": "Benjamini-Hochberg across all pairs of one variable",
        "n_samples": len(data["samples"]), "n_variables": len(env_by_var),
        "variables": sorted(env_by_var), "n_asv": len(shares), "n_pairs": len(rows),
        "n_links": len(edges), "absent_reason": absent,
    }
    with driver.session() as s:
        s.run("MATCH (:EnvVariable {dataset_id:$d})-[r:COVARIES_WITH {dataset_id:$d}]->() DELETE r", d=dataset_id)
        s.run("MATCH (v:EnvVariable {dataset_id:$d}) DETACH DELETE v", d=dataset_id)
        s.run("MATCH (x:EnvLinkRun {dataset_id:$d}) DETACH DELETE x", d=dataset_id)
        s.run("MATCH (d:Dataset {dataset_id:$d}) CREATE (x:EnvLinkRun $props) CREATE (x)-[:OF_DATASET]->(d)",
              d=dataset_id, props={k: v for k, v in props.items() if v is not None})
        if not absent:
            s.run("UNWIND $vars AS v MATCH (d:Dataset {dataset_id:$d}) "
                  "CREATE (e:EnvVariable {dataset_id:$d, name:v.name, label:v.label, unit:v.unit, "
                  "n_values:v.n, run_id:$run}) CREATE (e)-[:OF_DATASET]->(d)",
                  d=dataset_id, run=run_id,
                  vars=[{"name": k, "label": labels[k]["label"], "unit": labels[k]["unit"],
                         "n": sum(1 for v in env_by_var[k] if v is not None)} for k in sorted(env_by_var)])
            s.run("UNWIND $rows AS row MATCH (e:EnvVariable {dataset_id:$d, name:row.variable}) "
                  "MATCH (a:ASV {id:row.asv_id, dataset_id:$d}) "
                  "CREATE (e)-[:COVARIES_WITH {dataset_id:$d, run_id:$run, lag:row.lag, r:row.r, "
                  "r0:row.r0, p:row.p, p_adj:row.p_adj, n:row.n}]->(a)",
                  d=dataset_id, run=run_id,
                  rows=[{k: r[k] for k in ("variable", "asv_id", "lag", "r", "r0", "p", "p_adj", "n")}
                        for r in edges])
    props["tsv"] = str(write_tsv(dataset_id, rows))
    return props


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("dataset_id")
    ap.add_argument("--max-lag", type=int, default=DEFAULT_MAX_LAG)
    ap.add_argument("--alpha", type=float, default=DEFAULT_ALPHA)
    a = ap.parse_args(argv[1:])
    import ingest

    driver = ingest.connect()
    try:
        ingest.ensure_constraints(driver)
        p = compute_dataset(driver, a.dataset_id, a.max_lag, a.alpha)
    finally:
        driver.close()
    print(f"{p['dataset_id']}: {p['n_links']} Kanten aus {p['n_pairs']} Paaren "
          f"({p['n_variables']} Variablen x {p['n_asv']} ASVs, L={p['max_lag']}, alpha={p['alpha']}); "
          f"Lauf {p['run_id']} -> {p['tsv']}")
    if p.get("absent_reason"):
        print(f"  HINWEIS: {p['absent_reason']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
