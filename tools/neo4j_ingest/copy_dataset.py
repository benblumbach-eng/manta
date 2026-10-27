from __future__ import annotations

import argparse
import json

from ingest import RUN_SCOPED_ASV_PROPS, connect, ensure_constraints

COPIED_LABELS = {"Dataset": None, "Sample": "sample_id", "ASV": "id", "Dada2Run": None,
                 "EnvLinkRun": None, "EnvVariable": "name"}
NOT_COPIED_LABELS = {
    "Run": "the old network run; the new dataset gets its own",
    "Cluster": "modules of the old network; names, colours and notes stay with the original",
    "Star": "a mark a person set on the original",
    "Note": "a note a person wrote on the original",
}
COPIED_RELS = ("IN_DATASET", "OF_DATASET", "AT_STATION", "HAS_ABUNDANCE", "COVARIES_WITH")
NOT_COPIED_RELS = {"CO_OCCURS_WITH", "INFLUENCES", "CCM_REJECTED", "MEMBER_OF",
                   "RECOMPUTED_FROM"}
SINGLE_RUNS = ("Dada2Run", "EnvLinkRun")
HAS_ABUNDANCE_BATCH = 5000


class CopyRefused(SystemExit):
    pass


def _q(session, query, **params):
    return [r.data() for r in session.run(query, **params)]


def preflight(session, src: str, dst: str) -> None:
    if not _q(session, "MATCH (d:Dataset {dataset_id:$d}) RETURN d.dataset_id AS d", d=src):
        raise CopyRefused(f"ABORT: there is no dataset {src!r} to copy from.")
    if _q(session, "MATCH (n {dataset_id:$d}) RETURN n LIMIT 1", d=dst):
        raise CopyRefused(f"ABORT: {dst!r} is already in use; nothing was written.")
    labels = {l for r in _q(session, "MATCH (n {dataset_id:$d}) RETURN DISTINCT labels(n) AS l",
                            d=src) for l in r["l"]}
    unbekannt = sorted(labels - set(COPIED_LABELS) - set(NOT_COPIED_LABELS))
    if unbekannt:
        raise CopyRefused(f"ABORT: {src!r} carries node types this copy does not know: "
                          f"{unbekannt}. Decide in copy_dataset.py whether they belong to the "
                          f"measurement (copy) or to the analysis (leave); nothing was written.")
    typen = {r["t"] for r in _q(session,
             "MATCH (n {dataset_id:$d})-[r]-() RETURN DISTINCT type(r) AS t", d=src)}
    unbekannt = sorted(typen - set(COPIED_RELS) - NOT_COPIED_RELS)
    if unbekannt:
        raise CopyRefused(f"ABORT: {src!r} carries relationship types this copy does not know: "
                          f"{unbekannt}; nothing was written.")


def _ds_prop(props: dict, src: str, dst: str) -> dict:
    p = dict(props)
    if p.get("dataset_id") == src:
        p["dataset_id"] = dst
    return p


def copy_measurement(driver, src: str, dst: str, label: str, at: str,
                     params: dict | None = None) -> dict:
    ensure_constraints(driver)
    with driver.session() as s:
        preflight(s, src, dst)
    try:
        _copy(driver, src, dst, label, at, params or {})
        return _verify(driver, src, dst)
    except BaseException:
        with driver.session() as s:
            s.run("MATCH (n {dataset_id:$d}) DETACH DELETE n", d=dst)
        raise


def _copy(driver, src, dst, label, at, params) -> None:
    strip = ", ".join(f"c.{p}" for p in RUN_SCOPED_ASV_PROPS)
    with driver.session() as s:
        s.run("MATCH (o:Dataset {dataset_id:$src}) CREATE (n:Dataset) "
              "SET n = o {.*, dataset_id: $dst, region: $label, recomputed_from: $src, "
              "recomputed_at: $at}", src=src, dst=dst, label=label, at=at)
        s.run("MATCH (o:Sample {dataset_id:$src}) MATCH (d:Dataset {dataset_id:$dst}) "
              "CREATE (c:Sample) SET c = o {.*, dataset_id: $dst} "
              "CREATE (c)-[:IN_DATASET]->(d)", src=src, dst=dst)
        s.run("MATCH (o:Sample {dataset_id:$src})-[r:AT_STATION]->(st:Station) "
              "MATCH (c:Sample {dataset_id:$dst, sample_id:o.sample_id}) "
              "CREATE (c)-[n:AT_STATION]->(st) SET n = properties(r)", src=src, dst=dst)
        s.run("MATCH (o:ASV {dataset_id:$src}) CREATE (c:ASV) SET c = o {.*, dataset_id: $dst} "
              f"REMOVE {strip}", src=src, dst=dst)
        for lab in SINGLE_RUNS:
            s.run(f"MATCH (o:{lab} {{dataset_id:$src}}) MATCH (d:Dataset {{dataset_id:$dst}}) "
                  f"CREATE (c:{lab}) SET c = o {{.*, dataset_id: $dst}} "
                  f"CREATE (c)-[:OF_DATASET]->(d)", src=src, dst=dst)
        s.run("MATCH (o:EnvVariable {dataset_id:$src}) MATCH (d:Dataset {dataset_id:$dst}) "
              "CREATE (c:EnvVariable) SET c = o {.*, dataset_id: $dst} "
              "CREATE (c)-[:OF_DATASET]->(d)", src=src, dst=dst)
        covaries = _q(s, "MATCH (v:EnvVariable {dataset_id:$src})-[r:COVARIES_WITH]->"
                         "(a:ASV {dataset_id:$src}) RETURN v.name AS v, a.id AS a, "
                         "properties(r) AS p", src=src)
        s.run("UNWIND $rows AS row MATCH (v:EnvVariable {dataset_id:$dst, name:row.v}) "
              "MATCH (a:ASV {dataset_id:$dst, id:row.a}) "
              "CREATE (v)-[r:COVARIES_WITH]->(a) SET r = row.p",
              dst=dst, rows=[{**r, "p": _ds_prop(r["p"], src, dst)} for r in covaries])
        zellen = _q(s, "MATCH (smp:Sample {dataset_id:$src})-[r:HAS_ABUNDANCE]->"
                       "(a:ASV {dataset_id:$src}) RETURN smp.sample_id AS s, a.id AS a, "
                       "properties(r) AS p", src=src)
        rows = [{"s": z["s"], "a": z["a"], "p": _ds_prop(z["p"], src, dst)} for z in zellen]
        for i in range(0, len(rows), HAS_ABUNDANCE_BATCH):
            s.run("UNWIND $rows AS row MATCH (smp:Sample {dataset_id:$dst, sample_id:row.s}) "
                  "MATCH (a:ASV {dataset_id:$dst, id:row.a}) "
                  "CREATE (smp)-[r:HAS_ABUNDANCE]->(a) SET r = row.p",
                  dst=dst, rows=rows[i:i + HAS_ABUNDANCE_BATCH])
        rel = {"at": at, **{k: v for k, v in params.items()
                             if isinstance(v, (int, float, str, bool))}}
        s.run("MATCH (n:Dataset {dataset_id:$dst}) MATCH (o:Dataset {dataset_id:$src}) "
              "CREATE (n)-[r:RECOMPUTED_FROM]->(o) SET r = $rel", src=src, dst=dst, rel=rel)


def _zaehlung(session, ds: str) -> dict:
    out = {}
    for lab in COPIED_LABELS:
        out[lab] = _q(session, f"MATCH (n:{lab} {{dataset_id:$d}}) RETURN count(n) AS n",
                      d=ds)[0]["n"]
    out["HAS_ABUNDANCE"] = _q(session, "MATCH (:Sample {dataset_id:$d})-[r:HAS_ABUNDANCE]->"
                                       "(:ASV {dataset_id:$d}) RETURN count(r) AS n", d=ds)[0]["n"]
    out["IN_DATASET"] = _q(session, "MATCH (:Sample {dataset_id:$d})-[r:IN_DATASET]->"
                                    "(:Dataset {dataset_id:$d}) RETURN count(r) AS n", d=ds)[0]["n"]
    out["OF_DATASET"] = _q(session, "MATCH (n {dataset_id:$d})-[r:OF_DATASET]->"
                                    "(:Dataset {dataset_id:$d}) WHERE any(l IN labels(n) "
                                    "WHERE l IN $labs) RETURN count(r) AS n", d=ds,
                           labs=list(SINGLE_RUNS) + ["EnvVariable"])[0]["n"]
    out["AT_STATION"] = _q(session, "MATCH (:Sample {dataset_id:$d})-[r:AT_STATION]->() "
                                    "RETURN count(r) AS n", d=ds)[0]["n"]
    out["COVARIES_WITH"] = _q(session, "MATCH (:EnvVariable {dataset_id:$d})-[r:COVARIES_WITH]->"
                                       "(:ASV {dataset_id:$d}) RETURN count(r) AS n",
                              d=ds)[0]["n"]
    return out


def _verify(driver, src, dst) -> dict:
    with driver.session() as s:
        a, b = _zaehlung(s, src), _zaehlung(s, dst)
    if a != b:
        abweichend = {k: (a[k], b[k]) for k in a if a[k] != b[k]}
        raise RuntimeError(f"copy of {src!r} into {dst!r} is incomplete (original, copy): "
                           f"{abweichend}")
    return b


def main() -> int:
    p = argparse.ArgumentParser(
        description="Create a new dataset from the measurement of an existing one: samples, "
                    "values, environment and taxonomy are copied, the network is not. The "
                    "original is only read.")
    p.add_argument("--from", dest="src", required=True, help="dataset to copy from")
    p.add_argument("--to", dest="dst", required=True, help="new dataset id (must be unused)")
    p.add_argument("--label", required=True, help="label of the new dataset")
    p.add_argument("--at", required=True, help="time of the recompute, ISO 8601 UTC")
    p.add_argument("--params", default="{}",
                   help="JSON object of the thresholds the new network is computed with")
    args = p.parse_args()
    driver = connect()
    try:
        counts = copy_measurement(driver, args.src, args.dst, args.label, args.at,
                                  json.loads(args.params))
        print(f"Copy ok ({args.src} -> {args.dst}): {counts}", flush=True)
    finally:
        driver.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
