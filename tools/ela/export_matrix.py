from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from neo4j import GraphDatabase

HERE = Path(__file__).resolve().parent

ENV_KEYS = ["temp", "sal", "depth", "mld", "chl_sens", "par_satellite", "pw_frac", "o2_conc"]


def main() -> int:
    argv = [a for a in sys.argv[1:] if a != "--level"]
    level = "asv"
    if "--level" in sys.argv:
        i = sys.argv.index("--level")
        level = sys.argv[i + 1]
        argv.remove(level)
    if len(argv) != 1 or level not in ("asv", "cluster"):
        print("usage: export_matrix.py <dataset_id> [--level asv|cluster]", file=sys.stderr)
        return 2
    ds = argv[0]

    drv = GraphDatabase.driver(
        os.environ["NEO4J_URI"],
        auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]),
        notifications_disabled_categories=["UNRECOGNIZED", "DEPRECATION"],
    )

    def q(cypher, **p):
        with drv.session() as s:
            return [r.data() for r in s.run(cypher, dataset=ds, **p)]

    d = q("MATCH (d:Dataset {dataset_id:$dataset}) "
          "RETURN d.value_kind AS value_kind, d.time_axis AS time_axis")
    if not d:
        print(f"Dataset {ds!r} is not in the graph.", file=sys.stderr)
        return 1

    env_props = ", ".join(f"s.`{k}` AS `{k}`" for k in ENV_KEYS)
    samples = q(
        f"MATCH (s:Sample {{dataset_id:$dataset}}) "
        f"RETURN s.sample_id AS sample, toString(s.date) AS date, {env_props} "
        f"ORDER BY s.date, s.same_day_index, s.ordinal_index, s.sample_id"
    )
    if level == "asv":
        asvs = [r["asv"] for r in q(
            "MATCH (a:ASV {dataset_id:$dataset}) RETURN a.id AS asv ORDER BY a.id"
        )]
        cells = q(
            "MATCH (s:Sample {dataset_id:$dataset})-[r:HAS_ABUNDANCE]->(a:ASV) "
            "RETURN s.sample_id AS sample, a.id AS asv, r.count AS count"
        )
    else:
        asvs = [f"cluster_{r['label']}" for r in q(
            "MATCH (c:Cluster {dataset_id:$dataset}) "
            "RETURN c.louvain_label AS label ORDER BY c.louvain_label"
        )]
        cells = q(
            "MATCH (s:Sample {dataset_id:$dataset})-[r:HAS_ABUNDANCE]->"
            "(a:ASV)-[:MEMBER_OF]->(c:Cluster {dataset_id:$dataset}) "
            "RETURN s.sample_id AS sample, 'cluster_' + toString(c.louvain_label) AS asv, "
            "sum(r.count) AS count"
        )

    by_cell = {(c["sample"], c["asv"]): c["count"] for c in cells}
    abundance = [[by_cell.get((s["sample"], a), 0) for a in asvs] for s in samples]

    env_present = [k for k in ENV_KEYS if any(s[k] is not None for s in samples)]
    environment = {k: [s[k] for s in samples] for k in env_present}

    n_members = None
    if level == "cluster":
        n_members = q("MATCH (:ASV {dataset_id:$dataset})-[m:MEMBER_OF]->"
                      "(:Cluster {dataset_id:$dataset}) RETURN count(m) AS n")[0]["n"]

    out = {
        "dataset_id": ds,
        "level": level,
        "value_kind": d[0]["value_kind"],
        "time_axis": d[0]["time_axis"],
        "n_sample": len(samples),
        "n_asv": len(asvs),
        "samples": [s["sample"] for s in samples],
        "dates": [s["date"] for s in samples],
        "asvs": asvs,
        "abundance": abundance,
        "environment": environment,
        "environment_absent": [k for k in ENV_KEYS if k not in env_present],
        "provenance": {
            "source": ("neo4j HAS_ABUNDANCE.count, missing cells = 0" if level == "asv"
                       else f"neo4j sum(HAS_ABUNDANCE.count) per Louvain cluster — only the "
                            f"{n_members} network ASVs with MEMBER_OF, not the whole dataset"),
            "order": "samples by (date, same_day_index, ordinal_index, sample_id), columns by id",
        },
    }
    suffix = ".input.json" if level == "asv" else ".cluster.input.json"
    dst = HERE / "out" / f"{ds}{suffix}"
    dst.parent.mkdir(exist_ok=True)
    dst.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n",
                   encoding="utf-8")
    print(f"{dst}  ({len(samples)} samples × {len(asvs)} ASVs, "
          f"environment: {', '.join(env_present) or 'none'})")
    drv.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
