from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from neo4j import GraphDatabase


def main() -> int:
    if len(sys.argv) != 2:
        print("Aufruf: ingest_ela.py <result.json>", file=sys.stderr)
        return 2
    r = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    if r.get("mode") != "base":
        print(f"Nur Basismodell-Ergebnisse werden ingestet (mode={r.get('mode')!r}).",
              file=sys.stderr)
        return 2
    if r.get("level", "asv") != "asv":
        print("Nur ASV-Ebene wird ingestet (Cluster-Ebene bleibt Report).", file=sys.stderr)
        return 2
    ds = r["dataset_id"]
    p = r["parameters"]
    run_id = f"ela_seed{int(p['seed'])}_ath{p['ath']}_nmax{int(p['nmax'])}"

    drv = GraphDatabase.driver(
        os.environ["NEO4J_URI"],
        auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]),
    )
    with drv.session() as s:
        if not s.run("MATCH (d:Dataset {dataset_id:$d}) RETURN d", d=ds).single():
            print(f"Dataset {ds!r} gibt es im Graphen nicht.", file=sys.stderr)
            return 1
        s.run("MATCH (x:StableState {dataset_id:$d}) DETACH DELETE x", d=ds)
        s.run("MATCH (x:ElaRun {dataset_id:$d}) DETACH DELETE x", d=ds)

        s.run(
            """
            MATCH (d:Dataset {dataset_id:$d})
            CREATE (e:ElaRun {dataset_id:$d, ela_run_id:$run,
                              seed:$seed, ath:$ath, minoc:$minoc, maxoc:$maxoc,
                              nmax:$nmax, rep:$rep, totalit:$totalit, boot:$boot,
                              n_species_model:$n_model, tool:$tool, reference:$ref,
                              model:$model, mode:'base'})
            CREATE (e)-[:OF_DATASET]->(d)
            """,
            d=ds, run=run_id, seed=int(p["seed"]), ath=p["ath"], minoc=p["minoc"],
            maxoc=p["maxoc"], nmax=int(p["nmax"]), rep=int(p["rep"]),
            totalit=int(p["totalit"]), boot=int(p["boot"]),
            n_model=r["preprocessing"]["n_species_model"],
            tool=r["provenance"]["tool"], ref=r["provenance"]["reference"],
            model=r["provenance"]["model"])

        recur = r["bootstrap"]["state_recurrence"]
        for st in r["stable_states"]:
            s.run(
                """
                MATCH (e:ElaRun {dataset_id:$d, ela_run_id:$run})
                CREATE (x:StableState {dataset_id:$d, ela_run_id:$run, state_id:$sid,
                                       energy:$energy, recurrence:$rec,
                                       n_active:$n_active})
                CREATE (x)-[:OF_ELA_RUN]->(e)
                WITH x UNWIND $active AS aid
                MATCH (a:ASV {dataset_id:$d, id:aid})
                CREATE (x)-[:HAS_ACTIVE {dataset_id:$d}]->(a)
                """,
                d=ds, run=run_id, sid=st["id"], energy=st["energy"],
                rec=recur.get(st["id"]), n_active=len(st["active"]),
                active=st["active"])
        for tp in r["tipping_points"]:
            s.run(
                """
                MATCH (a:StableState {dataset_id:$d, state_id:$s1}),
                      (b:StableState {dataset_id:$d, state_id:$s2})
                CREATE (a)-[:TIPPING {dataset_id:$d, energy:$energy}]->(b)
                """,
                d=ds, s1=tp["ss1"], s2=tp["ss2"], energy=tp["energy"])

        obs = (r.get("observed_communities") or {}).get("samples", [])
        n_obs = 0
        if obs:
            missing = []
            for o in obs:
                res = s.run(
                    """
                    MATCH (x:Sample {dataset_id:$d, sample_id:$sid}),
                          (e:ElaRun {dataset_id:$d, ela_run_id:$run})
                    CREATE (x)-[:HAS_ELA_ENERGY {dataset_id:$d, energy:$energy,
                                                 basin:$basin}]->(e)
                    RETURN count(*) AS n
                    """,
                    d=ds, run=run_id, sid=o["sample"], energy=o["energy"],
                    basin=o["basin"]).single()["n"]
                n_obs += res
                if not res:
                    missing.append(o["sample"])
            if missing:
                print(f"  WARNUNG: {len(missing)} Proben aus dem Ergebnis nicht im "
                      f"Graphen: {missing[:5]}{' ...' if len(missing) > 5 else ''}")

        n_states = s.run("MATCH (x:StableState {dataset_id:$d}) RETURN count(x) AS n",
                         d=ds).single()["n"]
        n_tip = s.run("MATCH (:StableState {dataset_id:$d})-[t:TIPPING]->() "
                      "RETURN count(t) AS n", d=ds).single()["n"]
    drv.close()
    print(f"{ds}: {n_states} stabile Zustaende, {n_tip} Kipp-Punkte, "
          f"{n_obs} Proben-Energien -> Graph ({run_id})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
