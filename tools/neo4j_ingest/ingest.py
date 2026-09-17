from __future__ import annotations

import csv
import os
import time
from pathlib import Path

from neo4j import GraphDatabase

NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "")

GOLDEN_DIR = Path(os.environ.get("GOLDEN_DIR", Path(__file__).resolve().parent.parent / "otter_out"))
OTTER_TESTS = Path(os.environ.get("OTTER_TESTS", Path(__file__).resolve().parent.parent.parent / "submodules" / "otter" / "tests"))
ENRICHED = "PyTest_Hellinger_False_14_Enriched_Hellinger_14_complete_network_table_meta_CON_CCM.csv"
CON = "PyTest_Hellinger_False_14_Pearson_FFT__complete_network_table_0.7_0.05.csv"
PRUNED = "PyTest_Hellinger_False_14_Pruned_CCM_CON_MAP_Network.csv"
PV = "PyTest_Hellinger_False_14_PV_CCM_CON_MAP_Network.csv"
FFT = "PyTest_Hellinger_False_14_FFT_Amplitudes.csv"
ABUNDANCE = "abundance.csv"
ENVIRONMENT = "environment_info.csv"
ID_MAP = "id_map.csv"

MANIFEST = "manta_manifest.json"
MANIFEST_ALT = "orca_manifest.json"


def _manifest() -> dict:
    path = GOLDEN_DIR / MANIFEST
    if not path.exists():
        path = GOLDEN_DIR / MANIFEST_ALT
    if not path.exists():
        return {}
    import json
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return {}


def _table(kind: str, fallback: str) -> Path:
    named = _manifest().get(kind)
    if named:
        if Path(named).exists():
            return Path(named)
        if (GOLDEN_DIR / Path(named).name).exists():
            return GOLDEN_DIR / Path(named).name
    return GOLDEN_DIR / fallback


def run_params() -> dict:
    return _manifest().get("params") or {}


DADA2_MANIFEST = "dada2_manifest.json"


def _dada2_manifest() -> dict:
    path = OTTER_TESTS / DADA2_MANIFEST
    if not path.exists():
        return {}
    import json
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return {}


ENTRY_POINTS = {
    "fastq": True,
    "dada2_output": True,
    "otter_input": False,
    "otter_output": False,
    "unknown": None,
}


def network_scope() -> dict:
    return _manifest().get("network_scope") or {}


HAS_ABUNDANCE_BATCH = 10000

CONNECT_TIMEOUT = float(os.environ.get("MANTA_NEO4J_CONNECT_TIMEOUT", "120"))
CONNECT_ATTEMPTS = int(os.environ.get("MANTA_NEO4J_CONNECT_ATTEMPTS", "5"))
CONNECT_BACKOFF = float(os.environ.get("MANTA_NEO4J_CONNECT_BACKOFF", "30"))


def _f(v):
    if v is None or v == "":
        return None
    try:
        return float(v)
    except ValueError:
        return None


def _i(v):
    f = _f(v)
    return None if f is None else int(round(f))


def read_enriched():
    rows = []
    with open(_table("enriched", ENRICHED), newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh, delimiter=","):
            asv_id = (r.get("Nodes") or "").strip()
            if not asv_id:
                continue
            props = {
                "kingdom": r.get("Kingdom"), "phylum": r.get("Phylum"), "class": r.get("Class"),
                "order": r.get("Order"), "family": r.get("Family"), "genus": r.get("Genus"),
                "species": r.get("Species"),
                "louvain_label": _i(r.get("LouvainLabelD")), "louvain_label_res": _i(r.get("LouvainLabelD_res")),
                "read_count_total": _f(r.get("Abundance4y")),
                "peak_mld": _f(r.get("MLD")), "peak_temp": _f(r.get("temp")), "peak_pw_frac": _f(r.get("PW_frac")),
                "peak_chl_sens": _f(r.get("chl_sens")), "peak_par_satellite": _f(r.get("PAR_satellite")),
                "peak_sal": _f(r.get("sal")), "peak_o2_conc": _f(r.get("O2_conc")), "peak_depth": _f(r.get("depth")),
                "ccm_betweenness": _f(r.get("CCM_Betweenness_Centrality")), "ccm_closeness": _f(r.get("CCM_Closeness Centrality")),
                "ccm_cluster_closeness": _f(r.get("ccm_cluster_closseness_centrality")), "ccm_cluster_betweenness": _f(r.get("ccm_cluster_betweeness_centrality")),
                "con_betweenness": _f(r.get("CON_Betweenness_Centrality")), "con_closeness": _f(r.get("CON_Closeness Centrality")),
                "con_cluster_closeness": _f(r.get("con_cluster_closseness_centrality")), "con_cluster_betweenness": _f(r.get("con_cluster_betweeness_centrality")),
                "color_label": r.get("ColorLabel"), "louvain_label_color": r.get("louvain_label_color"),
                "max_abundance_month_color": r.get("max_abundance_month_color"), "shape": r.get("Shape"),
            }
            rows.append({"id": asv_id, "props": {k: v for k, v in props.items() if v is not None}})
    return rows


def _read_semicolon_edges(path, fields):
    out = []
    with open(path, newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh, delimiter=";"):
            src = (r.get("from") or "").strip(); dst = (r.get("to") or "").strip()
            if not src or not dst:
                continue
            edge = {"from": src, "to": dst}
            for col, (prop, conv) in fields.items():
                edge[prop] = conv(r.get(col))
            out.append(edge)
    return out


def read_con():
    return _read_semicolon_edges(_table("con", CON), {"corr": ("corr", _f), "p-value": ("p_value", _f), "p-value_adj_fdr_bh": ("p_adj_fdr", _f)})


def read_pruned():
    return _read_semicolon_edges(_table("pruned", PRUNED), {"corr": ("nmi", _f), "p-value": ("p_value", _f), "from_clu": ("from_clu", _i), "to_clu": ("to_clu", _i)})


def read_pv():
    path = _table("pv", PV)
    if not path.exists():
        pruned = _table("pruned", PRUNED)
        sibling = pruned.with_name(pruned.name.replace("_Pruned_CCM_CON_MAP_", "_PV_CCM_CON_MAP_"))
        if "_Pruned_CCM_CON_MAP_" in pruned.name and sibling.exists():
            path = sibling
        else:
            return None
    return _read_semicolon_edges(path, {"corr": ("nmi", _f), "p-value": ("p_value", _f), "from_clu": ("from_clu", _i), "to_clu": ("to_clu", _i)})


def read_fft():
    path = _table("fft", FFT)
    if not path.exists() and (GOLDEN_DIR / "fft" / FFT).exists():
        path = GOLDEN_DIR / "fft" / FFT
    if not path.exists():
        return None
    amps, harmonics = {}, None
    with open(path, newline="", encoding="utf-8") as fh:
        rd = csv.DictReader(fh, delimiter=";")
        cols = [c for c in (rd.fieldnames or []) if c and c != "ASV"]
        harmonics = [int(c) for c in cols]
        for r in rd:
            aid = (r.get("ASV") or "").strip()
            if aid:
                amps[aid] = [float(r[c]) for c in cols]
    return harmonics, amps


def read_rejected(pv, pruned):
    kept = {(e["from"], e["to"]) for e in pruned}
    tested = {(e["from"], e["to"]) for e in pv}
    if not kept <= tested:
        raise SystemExit(f"ABBRUCH: {len(kept - tested)} behaltene CCM-Richtungen fehlen in der "
                         f"PV-Tabelle ({sorted(kept - tested)[:3]} …) — Pruned muss Teilmenge von PV sein.")
    return [e for e in pv if (e["from"], e["to"]) not in kept]


ENV_COLUMNS = {"MLD": "mld", "temp": "temp", "PW_frac": "pw_frac", "chl_sens": "chl_sens",
               "PAR_satellite": "par_satellite", "sal": "sal", "O2_conc": "o2_conc",
               "depth": "depth"}


def read_environment():
    env, ignored = {}, []
    with open(OTTER_TESTS / ENVIRONMENT, newline="", encoding="utf-8") as fh:
        rd = csv.DictReader(fh, delimiter=";")
        ignored = [c for c in (rd.fieldnames or [])
                   if c and c != "date" and c not in ENV_COLUMNS]
        for r in rd:
            sid = (r.get("date") or "").strip()
            if not sid:
                continue
            env[sid] = {prop: _f(r.get(col)) for col, prop in ENV_COLUMNS.items()}
    return env, ignored


def read_id_map():
    path = OTTER_TESTS / ID_MAP
    if not path.exists():
        return {}
    out = {}
    with open(path, newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh, delimiter=";"):
            oid = (r.get("ordinal_id") or "").strip()
            seq = (r.get("sequence") or "").strip()
            if oid and seq:
                out[oid] = {"sequence": seq, "seq_hash": (r.get("hash_id") or "").strip()}
    return out


def read_abundance():
    with open(OTTER_TESTS / ABUNDANCE, newline="", encoding="utf-8") as fh:
        rd = csv.reader(fh, delimiter=";")
        header = next(rd)
        asv_ids = [c.strip() for c in header[1:]]
        sample_ids, cells = [], []
        for row in rd:
            sid = row[0].strip()
            if not sid:
                continue
            sample_ids.append(sid)
            for aid, val in zip(asv_ids, row[1:]):
                f = _f(val)
                if f is not None and f != 0.0:
                    cells.append({"sample": sid, "asv": aid, "count": f})
    return sample_ids, asv_ids, cells


import schema_decl

CONSTRAINTS = schema_decl.constraint_statements()
INDEXES = schema_decl.index_statements()


Q_DATASET = ("MERGE (d:Dataset {dataset_id:$d}) "
             "SET d.visibility = coalesce(d.visibility, 'internal'), "
             "d.marker=$marker, d.region=$region, "
             "d.station=$station, d.lat=$lat, d.lon=$lon, d.time_axis=$time_axis, "
             "d.source_doi = coalesce($source_doi, d.source_doi), "
             "d.citation = coalesce($citation, d.citation)")
Q_VALUE_KIND = ("MATCH (d:Dataset {dataset_id:$d}) "
                "CALL { WITH d MATCH (:Sample {dataset_id:d.dataset_id})-[r:HAS_ABUNDANCE]->() "
                "RETURN sum(CASE WHEN r.count <> round(r.count) THEN 1 ELSE 0 END) AS frac, "
                "count(r) AS n } "
                "SET d.value_kind = CASE WHEN n = 0 THEN 'unknown' "
                "WHEN frac = 0 THEN 'reads' ELSE 'transformed' END")
Q_ANALYSED_TOTAL = (
    "MATCH (d:Dataset {dataset_id:$d}) WITH d.value_kind AS vk "
    "MATCH (s:Sample {dataset_id:$d}) "
    "OPTIONAL MATCH (s)-[r:HAS_ABUNDANCE]->(:ASV {dataset_id:$d}) "
    "WITH vk, s, coalesce(sum(r.count), 0) AS t "
    "SET s.analysed_reads_total = CASE WHEN vk = 'reads' THEN t ELSE null END")
Q_MAX_MONTH_SET = (
    "MATCH (smp:Sample {dataset_id:$d})-[r:HAS_ABUNDANCE]->(a:ASV {dataset_id:$d}) "
    "WITH a, smp, r ORDER BY r.count DESC, smp.date ASC "
    "WITH a, collect(smp.date)[0] AS peak_date "
    "SET a.max_abundance_month = toInteger(substring(peak_date, 5, 2))")
Q_MAX_MONTH_CLEAR = (
    "MATCH (a:ASV {dataset_id:$d}) WHERE a.max_abundance_month IS NOT NULL "
    "REMOVE a.max_abundance_month")
Q_RUN = ("MERGE (r:Run {dataset_id:$d, run_id:$run}) SET r.params=$params, r += $threshold_props "
         "WITH r MATCH (ds:Dataset {dataset_id:$d}) MERGE (r)-[:OF_DATASET]->(ds)")
Q_DADA2_RUN = ("MERGE (x:Dada2Run {dataset_id:$d}) SET x += $props "
               "WITH x MATCH (ds:Dataset {dataset_id:$d}) MERGE (x)-[:OF_DATASET]->(ds)")
Q_DADA2_STATE = ("MATCH (d:Dataset {dataset_id:$d}) "
                 "SET d.dada2_provenance = $state, d.entry_point = $entry")
Q_ASV = "UNWIND $rows AS row MERGE (a:ASV {id: row.id, dataset_id:$d}) SET a += row.props, a.run_id=$run"
Q_CLUSTER = "UNWIND $labels AS lbl MERGE (c:Cluster {louvain_label: lbl, dataset_id:$d, run_id:$run})"
Q_MEMBER = ("UNWIND $rows AS row MATCH (a:ASV {id: row.id, dataset_id:$d}) "
            "MATCH (c:Cluster {louvain_label: row.louvain_label, dataset_id:$d, run_id:$run}) "
            "MERGE (a)-[:MEMBER_OF {run_id:$run}]->(c)")
Q_CO = ("UNWIND $rows AS row MATCH (a:ASV {id: row.from, dataset_id:$d}) MATCH (b:ASV {id: row.to, dataset_id:$d}) "
        "MERGE (a)-[r:CO_OCCURS_WITH {dataset_id:$d, run_id:$run}]-(b) "
        "SET r.corr=row.corr, r.p_value=row.p_value, r.p_adj_fdr=row.p_adj_fdr")
Q_INF = ("UNWIND $rows AS row MATCH (a:ASV {id: row.from, dataset_id:$d}) MATCH (b:ASV {id: row.to, dataset_id:$d}) "
         "MERGE (a)-[r:INFLUENCES {dataset_id:$d, run_id:$run}]->(b) "
         "SET r.nmi=row.nmi, r.p_value=row.p_value, r.from_clu=row.from_clu, r.to_clu=row.to_clu")
Q_REJ = ("UNWIND $rows AS row MATCH (a:ASV {id: row.from, dataset_id:$d}) MATCH (b:ASV {id: row.to, dataset_id:$d}) "
         "MERGE (a)-[r:CCM_REJECTED {dataset_id:$d, run_id:$run}]->(b) "
         "SET r.nmi=row.nmi, r.p_value=row.p_value, r.from_clu=row.from_clu, r.to_clu=row.to_clu")
Q_RUN_TESTED = ("MATCH (r:Run {dataset_id:$d, run_id:$run}) SET r.ccm_tested_directions = $n")
Q_FFT = ("UNWIND $rows AS row MATCH (a:ASV {id: row.id, dataset_id:$d}) "
         "SET a.fft_amplitudes = row.amps RETURN count(a) AS n")
Q_RUN_FFT = ("MATCH (r:Run {dataset_id:$d, run_id:$run}) SET r.fft_harmonics = $ks")
Q_SAMPLE = ("UNWIND $rows AS row MERGE (s:Sample {sample_id: row.sample_id, dataset_id:$d}) SET s += row.props "
            "WITH s MATCH (ds:Dataset {dataset_id:$d}) MERGE (s)-[:IN_DATASET]->(ds)")
Q_ASV_LIGHT = "UNWIND $ids AS aid MERGE (a:ASV {id: aid, dataset_id:$d})"
Q_ASV_SEQ = ("UNWIND $rows AS row MATCH (a:ASV {id: row.id, dataset_id:$d}) "
             "SET a.sequence = row.sequence, a.seq_hash = row.seq_hash")
Q_HAS_AB = ("UNWIND $rows AS row MATCH (s:Sample {sample_id: row.sample, dataset_id:$d}) "
            "MATCH (a:ASV {id: row.asv, dataset_id:$d}) MERGE (s)-[r:HAS_ABUNDANCE]->(a) SET r.count=row.count")


def ensure_constraints(driver):
    with driver.session() as s:
        verletzt = []
        for label, q in schema_decl.duplikat_abfragen():
            try:
                n = s.run(q).single()["doppelt"]
            except Exception:
                continue
            if n:
                verletzt.append(f"{label}: {n}")
        if verletzt:
            print(f"  WARNUNG: doppelte Schluessel im Graphen — {', '.join(verletzt)}. "
                  f"Ein Constraint darauf wird fehlschlagen; die Deklaration steht in "
                  f"tools/neo4j_ingest/schema_decl.py.", flush=True)
        for c in CONSTRAINTS + INDEXES:
            s.run(c)


def ingest_network(driver, dataset_id, run_id, marker=None, region=None, params="PyTest defaults",
                   station=None, lat=None, lon=None, time_axis="ordinal",
                   source_doi=None, citation=None):
    asvs = read_enriched(); con = read_con(); pruned = read_pruned()
    pv = read_pv()
    rejected = read_rejected(pv, pruned) if pv is not None else None
    with driver.session() as _s:
        _vk_row = _s.run("MATCH (d:Dataset {dataset_id:$d}) RETURN d.value_kind AS vk",
                         d=dataset_id).single()
    _vk = _vk_row["vk"] if _vk_row else None
    if _vk != "reads":
        stripped = sum(1 for a in asvs if a["props"].pop("read_count_total", None) is not None)
        if stripped:
            print(f"  read_count_total: NICHT geschrieben ({stripped} ASVs) — "
                  f"value_kind={_vk!r}, eine Summe ueber solche Werte ist unbelegt.", flush=True)
    labels = sorted({a["props"]["louvain_label"] for a in asvs if "louvain_label" in a["props"]})
    members = [{"id": a["id"], "louvain_label": a["props"]["louvain_label"]} for a in asvs if "louvain_label" in a["props"]]
    with driver.session() as s:
        prev = s.run("MATCH (d:Dataset {dataset_id:$d}) RETURN d.time_axis AS ta",
                     d=dataset_id).single()
        if prev and prev["ta"] and prev["ta"] != time_axis:
            print(f"WARNING: time_axis of {dataset_id!r} changes {prev['ta']!r} -> {time_axis!r}. "
                  f"Month, year and season statements depend on this.", flush=True)
        s.run(Q_DATASET, d=dataset_id, marker=marker, region=region,
              station=station, lat=lat, lon=lon, time_axis=time_axis,
              source_doi=source_doi, citation=citation)
        props = dict(run_params())
        if props:
            props["computed_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        for key, prop in (("n_asv_in_network_run", "n_asv_in_network_run"),
                          ("n_asv_available", "n_asv_available_to_network_run")):
            val = network_scope().get(key)
            if val is not None:
                props[prop] = int(val)
        fremde = [r["run_id"] for r in s.run(
            "MATCH (r:Run {dataset_id:$d}) WHERE r.run_id <> $run "
            "RETURN r.run_id AS run_id ORDER BY r.run_id", d=dataset_id, run=run_id)]
        if fremde:
            raise SystemExit(
                f"ABBRUCH: {dataset_id!r} hat bereits den Lauf {fremde[0]!r}"
                + (f" (und {fremde[1:]})" if len(fremde) > 1 else "")
                + f", geladen werden soll {run_id!r}. Ein Bestand darf nur EINEN Lauf haben: die "
                f"Leseschicht filtert nur auf dataset_id, ein zweiter Lauf legt Parallelkanten "
                f"zwischen dieselben ASVs und die Oberflaeche zeigt dann willkuerlich einen von "
                f"beiden. Den alten ersetzen: --wipe-network-first mitgeben.")
        s.run(Q_RUN, d=dataset_id, run=run_id, params=params, threshold_props=props)
        s.run(Q_ASV, rows=asvs, d=dataset_id, run=run_id)
        s.run(Q_CLUSTER, labels=labels, d=dataset_id, run=run_id)
        s.run(Q_MEMBER, rows=members, d=dataset_id, run=run_id)
        s.run(Q_CO, rows=con, d=dataset_id, run=run_id)
        s.run(Q_INF, rows=pruned, d=dataset_id, run=run_id)
        if rejected is not None:
            s.run(Q_REJ, rows=rejected, d=dataset_id, run=run_id)
            s.run(Q_RUN_TESTED, d=dataset_id, run=run_id, n=len(pv))
        else:
            print("  CCM_REJECTED: NICHT geschrieben — keine PV-Tabelle im Ausgabeverzeichnis; "
                  "verworfene Richtungen bleiben fuer diesen Bestand unbekannt.", flush=True)
    n_fft = write_fft(driver, dataset_id, run_id)
    return {"asv_network": len(asvs), "cluster": len(labels), "member_of": len(members),
            "co_occurs": len(con), "influences": len(pruned),
            "ccm_rejected": (len(rejected) if rejected is not None else None),
            "fft_amplitudes": n_fft}


def write_fft(driver, dataset_id, run_id):
    fft = read_fft()
    if fft is None:
        print("  fft_amplitudes: NICHT geschrieben — keine FFT-Tabelle im Ausgabeverzeichnis.", flush=True)
        return None
    harmonics, amps = fft
    rows = [{"id": k, "amps": v} for k, v in amps.items()]
    with driver.session() as s:
        n = s.run(Q_FFT, rows=rows, d=dataset_id).single()["n"]
        s.run(Q_RUN_FFT, d=dataset_id, run=run_id, ks=harmonics)
    if n != len(rows):
        print(f"  fft_amplitudes: {n} von {len(rows)} ASVs beschrieben — die uebrigen haben "
              f"(noch) keinen Knoten.", flush=True)
    return n


def ingest_samples(driver, dataset_id, marker=None, region=None, station=None,
                   lat=None, lon=None, time_axis="ordinal", source_doi=None, citation=None):
    sample_ids, asv_ids, cells = read_abundance()
    env, env_ignored = read_environment()
    if env_ignored:
        print(f"  environment: Spalten NICHT uebernommen (MANTA kennt sie nicht): "
              f"{', '.join(env_ignored)}", flush=True)
    sample_rows = []
    for sid in sample_ids:
        props = {"date": sid}
        if station is not None:
            props["station"] = station
        props.update({k: v for k, v in env.get(sid, {}).items() if v is not None})
        sample_rows.append({"sample_id": sid, "props": props})
    with driver.session() as s:
        s.run(Q_DATASET, d=dataset_id, marker=marker, region=region,
              station=station, lat=lat, lon=lon, time_axis=time_axis,
              source_doi=source_doi, citation=citation)
        s.run("MATCH (d:Dataset {dataset_id:$d}) SET d.env_ignored_columns=$cols",
              d=dataset_id, cols=env_ignored)
        s.run(Q_ASV_LIGHT, ids=asv_ids, d=dataset_id)
        id_map = read_id_map()
        if id_map:
            s.run(Q_ASV_SEQ, d=dataset_id,
                  rows=[{"id": k, **v} for k, v in id_map.items() if k in set(asv_ids)])
        s.run(Q_SAMPLE, rows=sample_rows, d=dataset_id)
        for i in range(0, len(cells), HAS_ABUNDANCE_BATCH):
            s.run(Q_HAS_AB, rows=cells[i:i + HAS_ABUNDANCE_BATCH], d=dataset_id)
        s.run(Q_VALUE_KIND, d=dataset_id)
        s.run(Q_ANALYSED_TOTAL, d=dataset_id)
        vk = s.run("MATCH (d:Dataset {dataset_id:$d}) RETURN d.value_kind AS vk",
                   d=dataset_id).single()["vk"]
        if time_axis == "dates" and vk == "reads":
            s.run(Q_MAX_MONTH_SET, d=dataset_id)
        else:
            s.run(Q_MAX_MONTH_CLEAR, d=dataset_id)
    return {"sample": len(sample_ids), "asv_total": len(asv_ids), "has_abundance": len(cells)}


def ingest_dada2_provenance(driver, dataset_id, entry_point="unknown"):
    man = _dada2_manifest()
    laeuft_dada2 = ENTRY_POINTS.get(entry_point, None)
    if man:
        state = "recorded"
    elif laeuft_dada2 is None:
        state = "unknown"
    elif laeuft_dada2:
        state = "absent"
    else:
        state = "not_applicable"

    with driver.session() as s:
        s.run(Q_DADA2_STATE, d=dataset_id, state=state, entry=entry_point)
        if man:
            props = {k: v for k, v in (man.get("params") or {}).items() if v is not None}
            for k in ("tool", "dada2_version", "r_version", "written_at"):
                if man.get(k) is not None:
                    props[k] = man[k]
            si = man.get("session_info")
            if si:
                props["session_info"] = [str(x) for x in si]
            s.run(Q_DADA2_RUN, d=dataset_id, props=props)
    print(f"  DADA2-Provenienz: {state}"
          + (f" ({len(man.get('params') or {})} Parameter)" if man else ""), flush=True)
    return {"dada2_provenance": state}


def ingest_all(driver, dataset_id, run_id, marker=None, region=None, station=None,
               lat=None, lon=None, time_axis="ordinal", entry_point="unknown",
               source_doi=None, citation=None):
    ensure_constraints(driver)
    sm = ingest_samples(driver, dataset_id, marker, region, station, lat=lat, lon=lon,
                        time_axis=time_axis, source_doi=source_doi, citation=citation)
    n = ingest_network(driver, dataset_id, run_id, marker, region,
                       station=station, lat=lat, lon=lon, time_axis=time_axis,
                       source_doi=source_doi, citation=citation)
    dp = ingest_dada2_provenance(driver, dataset_id, entry_point)
    return {**n, **sm, **dp}


RUN_SCOPED_ASV_PROPS = [
    "louvain_label", "louvain_label_res", "louvain_label_color", "color_label", "shape",
    "fft_amplitudes",
    "read_count_total", "max_abundance_month_color",
    "ccm_betweenness", "ccm_closeness", "ccm_cluster_closeness", "ccm_cluster_betweenness",
    "con_betweenness", "con_closeness", "con_cluster_closeness", "con_cluster_betweenness",
    "peak_mld", "peak_temp", "peak_pw_frac", "peak_chl_sens", "peak_par_satellite",
    "peak_sal", "peak_o2_conc", "peak_depth",
    "trait_function", "trait_source", "trait_rank", "trait_run_id",
]


def wipe_network(driver, dataset_id):
    with driver.session() as s:
        s.run("MATCH (:ASV {dataset_id:$d})-[r:CO_OCCURS_WITH {dataset_id:$d}]-() DELETE r", d=dataset_id)
        s.run("MATCH (:ASV {dataset_id:$d})-[r:INFLUENCES {dataset_id:$d}]-() DELETE r", d=dataset_id)
        s.run("MATCH (:ASV {dataset_id:$d})-[r:CCM_REJECTED {dataset_id:$d}]-() DELETE r", d=dataset_id)
        s.run("MATCH (c:Cluster {dataset_id:$d}) DETACH DELETE c", d=dataset_id)
        s.run("MATCH (a:ASV {dataset_id:$d}) REMOVE a." +
              ", a.".join(RUN_SCOPED_ASV_PROPS), d=dataset_id)
        s.run("MATCH (r:Run {dataset_id:$d}) DETACH DELETE r", d=dataset_id)
        s.run("MATCH (t:TraitRun {dataset_id:$d}) DETACH DELETE t", d=dataset_id)
        s.run("MATCH (:EnvVariable {dataset_id:$d})-[r:COVARIES_WITH {dataset_id:$d}]->() DELETE r", d=dataset_id)
        s.run("MATCH (v:EnvVariable {dataset_id:$d}) DETACH DELETE v", d=dataset_id)
        s.run("MATCH (x:EnvLinkRun {dataset_id:$d}) DETACH DELETE x", d=dataset_id)


def wipe(driver, dataset_id):
    with driver.session() as s:
        s.run("MATCH (n {dataset_id:$d}) DETACH DELETE n", d=dataset_id)


def wipe_all_labels(driver):
    with driver.session() as s:
        s.run("MATCH (n) WHERE n:ASV OR n:Cluster OR n:Sample OR n:Dataset OR n:Run DETACH DELETE n")


def connect():
    if not NEO4J_PASSWORD:
        raise SystemExit("NEO4J_PASSWORD ist nicht gesetzt — bitte als Env-Variable übergeben.")
    last = None
    for attempt in range(CONNECT_ATTEMPTS):
        try:
            drv = GraphDatabase.driver(
                NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD),
                connection_timeout=CONNECT_TIMEOUT,
                max_transaction_retry_time=CONNECT_TIMEOUT,
            )
            drv.verify_connectivity()
            return drv
        except Exception as e:
            last = e
            if attempt + 1 < CONNECT_ATTEMPTS:
                print(f"Neo4j antwortet nicht (Versuch {attempt + 1}/{CONNECT_ATTEMPTS}): {e}\n"
                      f"  neuer Versuch in {CONNECT_BACKOFF}s", flush=True)
                time.sleep(CONNECT_BACKOFF)
    raise SystemExit(f"Neo4j ist nach {CONNECT_ATTEMPTS} Versuchen nicht erreichbar: {last}")


def main():
    import argparse
    p = argparse.ArgumentParser(description="OTTER-Tabellen -> Neo4j (dataset/run-gescopt).")
    p.add_argument("--dataset-id", default="hausgarten_f4_18s")
    p.add_argument("--run-id", default="PyTest")
    p.add_argument("--marker", default="18S")
    p.add_argument("--region", default="HAUSGARTEN/Fram Strait F4")
    p.add_argument("--station", default=None)
    p.add_argument("--lat", type=float, default=None, help="Breitengrad der Herkunft (Dezimalgrad)")
    p.add_argument("--lon", type=float, default=None, help="Laengengrad der Herkunft (Dezimalgrad)")
    p.add_argument("--time-axis", choices=["dates", "ordinal"], default="ordinal",
                   help="sind die Daten in metadata.csv echte Kalenderdaten oder nur Reihenfolge?")
    p.add_argument("--network-only", action="store_true",
                   help="nur die Netzwerk-Ebene ingesten (Proben/Zeitreihe bleiben, wie sie sind)")
    p.add_argument("--wipe-network-first", action="store_true",
                   help="vorhandenes Netz dieses Datensatzes vorher entfernen (Proben bleiben)")
    p.add_argument("--source-doi", default=None,
                   help="DOI der Publikation, aus der die Rohdaten stammen (optional)")
    p.add_argument("--citation", default=None,
                   help="Zitationstext dieser Publikation (optional)")
    p.add_argument("--entry-point", choices=sorted(ENTRY_POINTS), default="unknown",
                   help="Import-Einstieg; bestimmt, ob eine fehlende DADA2-Provenienz "
                        "'absent' (die Stufe lief) oder 'not_applicable' (gab es nie) heisst")
    args = p.parse_args()
    driver = connect()
    try:
        driver.verify_connectivity()
        ensure_constraints(driver)
        if args.wipe_network_first:
            wipe_network(driver, args.dataset_id)
        run = ingest_network if args.network_only else ingest_all
        extra = {} if args.network_only else {"entry_point": args.entry_point}
        counts = run(driver, args.dataset_id, args.run_id,
                     marker=args.marker, region=args.region, station=args.station,
                     lat=args.lat, lon=args.lon, time_axis=args.time_axis,
                     source_doi=args.source_doi, citation=args.citation, **extra)
        print(f"Ingestion ok ({args.dataset_id}): {counts}")
    finally:
        driver.close()


if __name__ == "__main__":
    main()
