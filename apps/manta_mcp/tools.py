from __future__ import annotations

import contextvars
import functools
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from typing import Any

from neo4j import GraphDatabase
from neo4j.exceptions import Neo4jError

import access
import semantics
import statistik

SCHEMA_VERSION = "manta-graph-1"
TOOLS_VERSION = "0.8.0"
MAX_LIMIT = 500
MAX_LIMIT_TAXA = 100

_DATASET_LITERAL_RE = re.compile(r"""dataset_id\s*(?::|=)\s*(['"])(.*?)\1""")
_DATASET_TOKEN_RE = re.compile(r"\bdataset_id\b")

NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "")

_driver = None


def driver():
    global _driver
    if _driver is None:
        if not NEO4J_PASSWORD:
            raise RuntimeError("NEO4J_PASSWORD ist nicht gesetzt")
        _driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    return _driver


class ToolError(Exception):
    pass



_QUERY_LOG: contextvars.ContextVar = contextvars.ContextVar("manta_query_log", default=None)


def mit_abfrageprotokoll(fn):
    @functools.wraps(fn)
    def wrapper(*a, **kw):
        token = _QUERY_LOG.set([])
        try:
            return fn(*a, **kw)
        finally:
            _QUERY_LOG.reset(token)
    return wrapper


def _run(query: str, **params) -> list[dict]:
    log = _QUERY_LOG.get()
    if log is None:
        log = []
        _QUERY_LOG.set(log)
    log.append({"cypher": " ".join(query.split()), "params": dict(params)})
    with driver().session(default_access_mode="READ") as s:
        return [r.data() for r in s.run(query, **params)]


def _snapshot() -> dict:
    rows = _run("MATCH (n) WHERE n:ASV OR n:Sample RETURN count(n) AS n")
    return {"asv_plus_sample_nodes": rows[0]["n"] if rows else None}


def _q(query: str, **params) -> list[dict]:
    return _run(query, **params)


def _envelope(tool: str, query: str, params: dict, data: Any, n: int) -> dict:
    grenze = params.get("limit") if isinstance(params, dict) else None
    ds = None
    if isinstance(params, dict):
        ds = params.get("dataset_id") or params.get("d")
    lauf = None
    if ds:
        try:
            rows = _q("MATCH (r:Run {dataset_id:$d}) "
                      "RETURN r.run_id AS run_id, r.computed_at AS computed_at "
                      "ORDER BY coalesce(r.computed_at, '') DESC, r.run_id LIMIT 1", d=ds)
            lauf = ({"run_id": rows[0]["run_id"], "computed_at": rows[0]["computed_at"],
                     "recorded": True} if rows else
                    {"run_id": None, "computed_at": None, "recorded": False})
        except Exception:
            lauf = None
    protokoll = list(_QUERY_LOG.get() or [])
    snap = _snapshot()
    env = {
        "data": data,
        "provenance": {
            "tool": tool,
            "tools_version": TOOLS_VERSION,
            "schema_version": SCHEMA_VERSION,
            "cypher": protokoll or [{"cypher": " ".join(query.split()), "params": params}],
            "params": params,
            "n_results": n,
            **({"truncated": n >= int(grenze)} if isinstance(grenze, int) else {}),
            "graph_snapshot": snap,
            **({"run": lauf} if lauf else {}),
            "retrieved_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        },
    }
    env["provenance"].update(_kennung(env))
    return env


def _kanonisch(o: Any) -> bytes:
    return json.dumps(o, sort_keys=True, ensure_ascii=False, default=str,
                      separators=(",", ":")).encode("utf-8")


_NICHT_IN_DIE_KENNUNG = ("retrieved_at", "cypher", "result_id", "data_id")


def _kennung(env: dict) -> dict:
    data_id = "dat_" + hashlib.sha256(_kanonisch(env.get("data"))).hexdigest()[:12]
    basis = {k: v for k, v in env["provenance"].items() if k not in _NICHT_IN_DIE_KENNUNG}
    roh = hashlib.sha256(_kanonisch({"provenance": basis, "data_id": data_id})).hexdigest()
    return {"result_id": "res_" + roh[:12], "data_id": data_id}



def live_schema() -> dict:
    labels = [r["label"] for r in _run("CALL db.labels() YIELD label RETURN label")]
    rels = [r["relationshipType"] for r in
            _run("CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType")]
    props = [r["propertyKey"] for r in _run("CALL db.propertyKeys() YIELD propertyKey RETURN propertyKey")]
    return {"labels": sorted(labels), "relationship_types": sorted(rels), "property_keys": sorted(props)}


_schema_cache: dict | None = None


def schema() -> dict:
    global _schema_cache
    if _schema_cache is None:
        _schema_cache = live_schema()
    return _schema_cache



def list_datasets() -> dict:
    q = """
    MATCH (d:Dataset)
    WHERE """ + access.cypher_condition("d") + """
    RETURN d.dataset_id AS dataset_id, d.region AS region, d.marker AS marker,
           coalesce(d.time_axis, 'ordinal') AS time_axis,
           coalesce(d.value_kind, 'unknown') AS value_kind,
           COUNT { MATCH (a:ASV {dataset_id: d.dataset_id}) } AS n_asv,
           COUNT { MATCH (a:ASV {dataset_id: d.dataset_id}) WHERE a.louvain_label IS NOT NULL } AS n_in_network,
           COUNT { MATCH (s:Sample {dataset_id: d.dataset_id}) } AS n_samples
    ORDER BY d.dataset_id
    """
    rows = _run(q)
    return _envelope("list_datasets", q, {}, rows, len(rows))


def _require_dataset(dataset_id: str) -> None:
    if not dataset_id:
        raise ToolError("dataset_id fehlt. Erst list_datasets aufrufen und eine gueltige id waehlen.")
    rows = _run(f"MATCH (d:Dataset {{dataset_id:$d}}) WHERE {access.cypher_condition('d')} "
                "RETURN d.dataset_id AS id", d=dataset_id)
    if not rows:
        known = [r["dataset_id"] for r in _run(
            f"MATCH (d:Dataset) WHERE {access.cypher_condition('d')} "
            "RETURN d.dataset_id AS dataset_id ORDER BY d.dataset_id")]
        raise ToolError(f"unbekannte dataset_id {dataset_id!r}. Bekannt: {known}")


def dataset_summary(dataset_id: str) -> dict:
    _require_dataset(dataset_id)
    q = """
    MATCH (d:Dataset {dataset_id:$d})
    OPTIONAL MATCH (s:Sample {dataset_id:$d})
    WITH d, count(s) AS n_samples, min(s.date) AS first_date, max(s.date) AS last_date
    RETURN d.dataset_id AS dataset_id, d.region AS region, d.marker AS marker,
           n_samples, first_date, last_date,
           d.source_doi AS source_doi, d.citation AS citation,
           COUNT { MATCH (a:ASV {dataset_id:$d}) } AS n_asv,
           COUNT { MATCH (a:ASV {dataset_id:$d}) WHERE a.louvain_label IS NOT NULL } AS n_in_network,
           COUNT { MATCH (c:Cluster {dataset_id:$d}) } AS n_clusters,
           COUNT { MATCH (:ASV {dataset_id:$d})-[r:CO_OCCURS_WITH {dataset_id:$d}]->(:ASV {dataset_id:$d}) } AS n_con_edges,
           COUNT { MATCH (:ASV {dataset_id:$d})-[r:INFLUENCES {dataset_id:$d}]->(:ASV {dataset_id:$d}) } AS n_ccm_edges
    """
    rows = _run(q, d=dataset_id)
    out = dict(rows[0]) if rows else None
    if out is not None:
        if not (out.get("source_doi") or out.get("citation")):
            out["source_note"] = ("No source publication is recorded for this dataset. That is "
                                  "NOT the same as unpublished — it means none was stated at "
                                  "import. Do not name one, and do not use the publication cited "
                                  "next to cluster or edge definitions: that is the source of the "
                                  "method, not of these data.")
    if out is not None:
        out["time_axis"] = semantics.time_axis(_q, dataset_id)
        out["quantity"] = semantics.quantity(_q, dataset_id)
        hub = semantics.hub_set(_q, dataset_id)
        out["hubs"] = {key: hub[key] for key in
                       ("n_marked", "n_with_value", "n_network", "measure", "measure_label",
                        "k", "mu", "sigma", "threshold", "statement")}
        if out["time_axis"] != semantics.TIME_AXIS_DATES:
            out["first_date"] = out["last_date"] = None
            out["time_axis_note"] = ("No real time axis: the samples only have an order, not a "
                                     "calendar. No period can be given.")
        out["modules"] = list(semantics.module_labels(_q, dataset_id).values())
    return _envelope("dataset_summary", q, {"dataset_id": dataset_id}, out, len(rows))


def find_asv(dataset_id: str, genus: str | None = None, asv_id: str | None = None,
             cluster: int | None = None, limit: int = 25) -> dict:
    _require_dataset(dataset_id)
    limit = max(1, min(int(limit), MAX_LIMIT))
    genus = genus or None
    q = """
    MATCH (a:ASV {dataset_id:$d})
    WHERE ($genus   IS NULL OR toLower(a.genus) CONTAINS toLower($genus))
      AND ($asv_id  IS NULL OR a.id = $asv_id)
      AND ($cluster IS NULL OR a.louvain_label = $cluster)
    RETURN a.id AS asv_id, a.genus AS genus, a.family AS family, a.phylum AS phylum,
           a.louvain_label AS cluster, a.read_count_total AS read_count_total,
           COUNT { (a)<-[:HAS_ABUNDANCE]-(:Sample) } AS n_samples_present
    ORDER BY coalesce(a.read_count_total, 0) DESC, a.id
    LIMIT $limit
    """
    q_total = """
    MATCH (a:ASV {dataset_id:$d})
    WHERE ($genus   IS NULL OR toLower(a.genus) CONTAINS toLower($genus))
      AND ($asv_id  IS NULL OR a.id = $asv_id)
      AND ($cluster IS NULL OR a.louvain_label = $cluster)
    RETURN count(a) AS n
    """
    p = {"d": dataset_id, "genus": genus, "asv_id": asv_id, "cluster": cluster, "limit": limit}
    rows = _run(q, **p)
    total = _run(q_total, d=dataset_id, genus=genus, asv_id=asv_id, cluster=cluster)
    env = _envelope("find_asv", q, p,
                    {"asvs": rows, "n_returned": len(rows),
                     "n_matching_total": total[0]["n"] if total else None},
                    len(rows))
    env["value_declaration"] = {
        **semantics.value_declaration(_q, dataset_id, semantics.frame_summed(_q, dataset_id)),
        "applies_to": "read_count_total",
    }
    mods = semantics.module_labels(_q, dataset_id)
    for r in env["data"]["asvs"]:
        m = mods.get(r["cluster"])
        r["cluster_name"] = (m["name"] or "") if m else ""
    return env


def asv_detail(dataset_id: str, asv_id: str) -> dict:
    _require_dataset(dataset_id)
    q = """
    MATCH (a:ASV {dataset_id:$d, id:$id})
    RETURN a.id AS asv_id, a.kingdom AS kingdom, a.phylum AS phylum, a.class AS class,
           a.order AS `order`, a.family AS family, a.genus AS genus, a.species AS species,
           a.louvain_label AS cluster, a.read_count_total AS read_count_total,
           COUNT { (a)<-[:HAS_ABUNDANCE]-(:Sample) } AS n_samples_present,
           a.max_abundance_month AS peak_month
    """
    rows = _run(q, d=dataset_id, id=asv_id)
    if not rows:
        raise ToolError(f"ASV {asv_id!r} in Datensatz {dataset_id!r} nicht gefunden")
    out = dict(rows[0])
    axis = semantics.time_axis(_q, dataset_id)
    out["hub_glow"] = asv_id in set(semantics.hub_set(_q, dataset_id)["ids"])
    out["hub_glow_means"] = semantics.HUB_NODE_TOOLTIP
    out["quantity"] = semantics.quantity(_q, dataset_id)
    out["value_declaration"] = {
        **semantics.value_declaration(_q, dataset_id, semantics.frame_summed(_q, dataset_id)),
        "applies_to": "read_count_total",
    }
    out["n_samples_total"] = _run("MATCH (s:Sample {dataset_id:$d}) RETURN count(s) AS n",
                                  d=dataset_id)[0]["n"]
    out["time_axis"] = axis
    if axis != semantics.TIME_AXIS_DATES:
        out["peak_month"] = None
        out["peak_month_note"] = "This dataset has no real time axis — no peak month."
    if out["cluster"] is None:
        out["network_note"] = ("This ASV is NOT in the network (no Louvain cluster, no links). "
                               "It only appeared in the abundance table.")
    out["funktion"] = ("Not derivable from amplicon data. Ecological function, metabolism, role "
                       "in the food web and pathogenicity are NOT in these data. If asked, say "
                       "exactly that — do not infer anything from the taxonomy.")
    out["environment_profile"] = semantics.environment_profile(_q, dataset_id, asv_id)
    out["cluster_name"] = ((semantics.module_label(_q, dataset_id, out["cluster"])["name"] or "")
                           if out.get("cluster") is not None else "")
    return _envelope("asv_detail", q, {"dataset_id": dataset_id, "asv_id": asv_id}, out, 1)


def asv_abundance_series(dataset_id: str, asv_id: str) -> dict:
    _require_dataset(dataset_id)
    q = """
    MATCH (s:Sample {dataset_id:$d})-[r:HAS_ABUNDANCE]->(a:ASV {dataset_id:$d, id:$id})
    RETURN s.sample_id AS sample_id, s.date AS date, r.count AS count
    ORDER BY s.date, s.sample_id
    """
    rows = _run(q, d=dataset_id, id=asv_id)
    axis = semantics.time_axis(_q, dataset_id)
    out = {
        "asv_id": asv_id,
        "series": rows,
        "n_nonzero_samples": len(rows),
        "time_axis": axis,
        "quantity": semantics.quantity(_q, dataset_id),
        "caveat": ("Values are compositional (shares of the sequencing depth); the absolute "
                   "scaling is undetermined. Only non-zero values are stored."),
    }
    if axis != semantics.TIME_AXIS_DATES:
        out["time_axis_note"] = ("WARNING: no real time axis. The 'date' field only reflects the "
                                 "ORDER of the samples, not a calendar. Statements about months, "
                                 "seasons or years are not permissible here.")
    return _envelope("asv_abundance_series", q, {"dataset_id": dataset_id, "asv_id": asv_id}, out, len(rows))


def asv_spectrum(dataset_id: str, asv_id: str) -> dict:
    _require_dataset(dataset_id)
    sp = semantics.spectrum(_run, dataset_id, asv_id)
    if sp is None:
        raise ToolError(f"ASV {asv_id!r} in Datensatz {dataset_id!r} nicht gefunden")
    q = ("MATCH (a:ASV {id:$id, dataset_id:$d}) OPTIONAL MATCH (r:Run {dataset_id:$d}) "
         "RETURN a.fft_amplitudes AS amps, r.fft_harmonics AS ks, r.hellinger AS hellinger "
         "ORDER BY coalesce(r.computed_at, '') DESC, r.run_id LIMIT 1")
    data = {"asv_id": asv_id, **sp,
            "value_declaration": {**semantics.value_declaration(_q, dataset_id, "the whole series, in sample order"),
                                  "applies_to": "amplitudes (input scale of the run)"}}
    return _envelope("asv_spectrum", q, {"dataset_id": dataset_id, "asv_id": asv_id}, data, sp["n"])


def asv_function(dataset_id: str, asv_id: str) -> dict:
    _require_dataset(dataset_id)
    tr = semantics.asv_trait(_run, dataset_id, asv_id)
    if tr is None:
        raise ToolError(f"ASV {asv_id!r} in Datensatz {dataset_id!r} nicht gefunden")
    q = ("MATCH (a:ASV {id:$id, dataset_id:$d}) RETURN a.trait_function AS f, a.trait_source AS s, "
         "a.trait_rank AS r, a.trait_run_id AS run")
    genus = _run("MATCH (a:ASV {id:$id, dataset_id:$d}) RETURN a.genus AS g, a.species AS s",
                 d=dataset_id, id=asv_id)[0]
    data = {"asv_id": asv_id, "genus": genus["g"], "species": genus["s"], **tr,
            "annotation_run": semantics.trait_run(_run, dataset_id)}
    return _envelope("asv_function", q, {"dataset_id": dataset_id, "asv_id": asv_id}, data,
                     len(tr["functions"]))


def asv_seasonality(dataset_id: str, asv_id: str) -> dict:
    _require_dataset(dataset_id)
    axis = semantics.time_axis(_q, dataset_id)
    rows = semantics.series(_q, dataset_id, asv_id)
    if not rows:
        raise ToolError(f"ASV {asv_id!r} in Datensatz {dataset_id!r} nicht gefunden")

    present = [r for r in rows if (r["count"] or 0) > 0]
    peak = max(rows, key=lambda r: r["count"] or 0.0)
    base = {
        "asv_id": asv_id,
        "time_axis": axis,
        "n_samples": len(rows),
        "n_samples_present": len(present),
        "quantity": semantics.quantity(_q, dataset_id),
        "max_sample": {"sample": peak["sample"], "date": peak["date"],
                       "value": peak["count"], "share": peak["share"],
                       "rank": peak["rank"],
                       "rank_pool": _run("MATCH (a:ASV {dataset_id:$d}) RETURN count(a) AS n",
                                         d=dataset_id)[0]["n"]},
        "statement": semantics.frequency(_q, dataset_id, rows,
                                         with_rank=True)["summary"]["statement"],
    }
    if axis != semantics.TIME_AXIS_DATES:
        base["seasonality"] = None
        base["note"] = ("This dataset has NO real time axis (sample order only). Seasonality, peak "
                        "month and yearly trend cannot be determined here — the maximum above is "
                        "a sample, not a point in time.")
        return _envelope("asv_seasonality", "semantics.series (ordinal)",
                         {"dataset_id": dataset_id, "asv_id": asv_id}, base, len(rows))

    stats = semantics.seasonal_stats(rows, "share")
    months = [c for c in stats["climatology"] if c["mean"] is not None]
    strongest = max(months, key=lambda c: c["mean"]) if months else None

    otter_peak = _run("MATCH (a:ASV {dataset_id:$d, id:$i}) RETURN a.max_abundance_month AS m",
                      d=dataset_id, i=asv_id)
    otter_month = otter_peak[0]["m"] if otter_peak else None

    base["seasonality"] = {
        "peak_month_single_sample": otter_month,
        "peak_month_single_sample_label": (semantics.MONTHS[otter_month - 1]
                                           if otter_month else None),
        "peak_month_climatology": strongest["month"] if strongest else None,
        "peak_month_climatology_label": strongest["label"] if strongest else None,
        "peak_month_climatology_n": strongest["n"] if strongest else None,
        "peak_month_climatology_n_years": strongest["n_years"] if strongest else None,
        "climatology": [{"month": c["month"], "label": c["label"], "mean": c["mean"],
                         "n": c["n"], "n_years": c["n_years"]} for c in months],
        "trend_per_year": stats["trend_per_year"],
        "trend_method": stats["trend_method"],
        "full_years": stats["full_years"],
        "partial_years": stats["partial_years"],
        "peak_window": stats["peak_window"],
        "oscillation": semantics.oscillation(
            [{"date": r["date"], "share": r["share"]} for r in rows],
            int(semantics.thresholds(_q, dataset_id)["fft_coeffs"])),
    }
    base["note"] = (
        "There are TWO peak months and they can differ: 'peak_month_single_sample' is the month "
        "of the one largest sample (this is what the interface shows) — a single outlier is "
        "enough to set it. 'peak_month_climatology' is the strongest month averaged over all "
        "years. State which of the two you mean; do not claim there is only one. "
        "The TIMING is the defensible statement, not the height of the value.")
    return _envelope("asv_seasonality", "semantics.series + semantics.seasonal_stats",
                     {"dataset_id": dataset_id, "asv_id": asv_id}, base, len(rows))


def neighbors(dataset_id: str, asv_id: str, edge: str = "con", direction: str = "both",
              limit: int = 25) -> dict:
    _require_dataset(dataset_id)
    edge = (edge or "con").lower()
    if edge not in ("con", "ccm"):
        raise ToolError("edge muss 'con' oder 'ccm' sein")
    direction = (direction or "both").lower()
    if direction not in ("out", "in", "both"):
        raise ToolError("direction muss 'out', 'in' oder 'both' sein")
    limit = max(1, min(int(limit), MAX_LIMIT))
    if edge == "con":
        pattern = "-[r:CO_OCCURS_WITH {dataset_id:$d}]-"
        direction = "undirected"
    elif direction == "out":
        pattern = "-[r:INFLUENCES {dataset_id:$d}]->"
    elif direction == "in":
        pattern = "<-[r:INFLUENCES {dataset_id:$d}]-"
    else:
        pattern = "-[r:INFLUENCES {dataset_id:$d}]-"
    val = "corr" if edge == "con" else "nmi"
    q = f"""
    MATCH (a:ASV {{dataset_id:$d, id:$id}}){pattern}(b:ASV {{dataset_id:$d}})
    RETURN b.id AS asv_id, b.genus AS genus, b.louvain_label AS cluster,
           max(r.{val}) AS {val}, min(r.p_value) AS p_value
    ORDER BY {val} DESC, asv_id LIMIT $limit
    """
    q_total = f"""
    MATCH (a:ASV {{dataset_id:$d, id:$id}}){pattern}(b:ASV {{dataset_id:$d}})
    RETURN count(DISTINCT b) AS n
    """
    p = {"d": dataset_id, "id": asv_id, "limit": limit}
    rows = _run(q, **p)
    total = _run(q_total, d=dataset_id, id=asv_id)
    out = {"asv_id": asv_id, "edge": edge, "direction": direction,
           "neighbors": rows, "n_returned": len(rows),
           "n_neighbors_total": total[0]["n"] if total else None}
    if edge == "ccm":
        out["caveat"] = semantics.CCM_CAVEAT
    else:
        out["caveat"] = semantics.con_caveat(_q, dataset_id)
    return _envelope("neighbors", q, p, out, len(rows))


def edge(dataset_id: str, source: str, target: str) -> dict:
    _require_dataset(dataset_id)
    q = ("MATCH (a:ASV {dataset_id:$d, id:$s})-[r:CO_OCCURS_WITH {dataset_id:$d}]-(b:ASV {dataset_id:$d, id:$t}) "
         "RETURN r.corr AS corr, r.p_value AS p_value, r.p_adj_fdr AS p_adj_fdr, "
         "a.genus AS s_genus, a.louvain_label AS s_cluster, b.genus AS t_genus, b.louvain_label AS t_cluster")
    rows = _run(q, d=dataset_id, s=source, t=target)
    if not rows:
        raise ToolError(f"no co-occurrence link between {source!r} and {target!r} in dataset "
                        f"{dataset_id!r}. CCM is only tested on co-occurrence links, so there is "
                        f"no direction either. Check the ids with find_asv or neighbors.")
    r = rows[0]
    fwd = semantics.ccm_direction(_run, dataset_id, source, target)
    bwd = semantics.ccm_direction(_run, dataset_id, target, source)
    data = {
        "dataset_id": dataset_id,
        "source": {"asv_id": source, "genus": r["s_genus"], "cluster": r["s_cluster"]},
        "target": {"asv_id": target, "genus": r["t_genus"], "cluster": r["t_cluster"]},
        "link": {"corr": r["corr"], "p_value": r["p_value"], "p_adj_fdr": r["p_adj_fdr"],
                 "cross_cluster": (r["s_cluster"] is not None and r["s_cluster"] != r["t_cluster"])},
        "directions": {"forward": ({"from": source, "to": target, **fwd} if fwd else None),
                       "backward": ({"from": target, "to": source, **bwd} if bwd else None)},
        "ccm_tested_recorded": semantics.ccm_tested_recorded(_run, dataset_id),
        "decision_note": semantics.CCM_DECISION_NOTE,
        "thresholds": semantics.thresholds(_run, dataset_id),
        "caveats": [semantics.con_caveat(_run, dataset_id), semantics.CCM_CAVEAT,
                    semantics.ccm_permutation_caveat(_run, dataset_id),
                    semantics.cluster_partition_caveat(_q, dataset_id)],
    }
    return _envelope("edge", q, {"dataset_id": dataset_id, "source": source, "target": target},
                     data, 1)


def cluster_bridges(dataset_id: str, edge: str = "con", include_edges: bool = False,
                    limit: int = 25) -> dict:
    _require_dataset(dataset_id)
    edge = (edge or "con").lower()
    if edge not in ("con", "ccm"):
        raise ToolError("edge muss 'con' oder 'ccm' sein")
    limit = max(1, min(int(limit), MAX_LIMIT))
    rel = "CO_OCCURS_WITH" if edge == "con" else "INFLUENCES"
    base = f"""
    MATCH (a:ASV {{dataset_id:$d}})-[r:{rel} {{dataset_id:$d}}]->(b:ASV {{dataset_id:$d}})
    WHERE a.louvain_label <> b.louvain_label
    """
    q_count = base + "RETURN count(r) AS n"
    q_pairs = base + """
    WITH CASE WHEN a.louvain_label < b.louvain_label THEN a.louvain_label ELSE b.louvain_label END AS lo,
         CASE WHEN a.louvain_label < b.louvain_label THEN b.louvain_label ELSE a.louvain_label END AS hi,
         r
    RETURN lo AS cluster_a, hi AS cluster_b, count(r) AS n_edges
    ORDER BY n_edges DESC, cluster_a, cluster_b LIMIT $limit
    """
    total = _run(q_count, d=dataset_id)
    pairs = _run(q_pairs, d=dataset_id, limit=limit)
    n_total = total[0]["n"] if total else None
    out = {"edge": edge, "n_bridges_total": n_total, "by_cluster_pair": pairs}
    if include_edges:
        val = "corr" if edge == "con" else "nmi"
        q_edges = base + f"""
        RETURN a.id AS from_asv, a.louvain_label AS from_cluster, a.genus AS from_genus,
               b.id AS to_asv,   b.louvain_label AS to_cluster,   b.genus AS to_genus,
               r.{val} AS {val}, r.p_value AS p_value
        ORDER BY r.{val} DESC, from_asv, to_asv LIMIT $limit
        """
        out["bridges"] = _run(q_edges, d=dataset_id, limit=limit)
    out["cluster_caveat"] = semantics.cluster_partition_caveat(_q, dataset_id)
    return _envelope("cluster_bridges", q_pairs,
                     {"dataset_id": dataset_id, "edge": edge, "include_edges": include_edges,
                      "limit": limit}, out, len(pairs))


def cluster_network(dataset_id: str) -> dict:
    _require_dataset(dataset_id)
    data = semantics.cluster_network(_run, dataset_id)
    data.setdefault("caveats", []).append(semantics.cluster_partition_caveat(_q, dataset_id))
    q = ("MATCH (a:ASV {dataset_id:$d})-[i:INFLUENCES {dataset_id:$d}]->(b:ASV {dataset_id:$d}) "
         "WITH i.from_clu AS von, i.to_clu AS nach, avg(i.nmi) AS mean_nmi, count(*) AS kanten "
         "RETURN von, nach, mean_nmi, kanten ORDER BY kanten DESC, von, nach")
    return _envelope("cluster_network", q, {"dataset_id": dataset_id}, data,
                     data["n_cluster_pairs"])


def cluster_interannual_variability(dataset_id: str, metric: str = "jaccard") -> dict:
    _require_dataset(dataset_id)
    if metric not in semantics.INTERANNUAL_METRICS:
        raise ToolError(f"metric muss eines von {sorted(semantics.INTERANNUAL_METRICS)} sein, "
                        f"nicht {metric!r}.")
    data = semantics.interannual_variability(_run, dataset_id, metric)
    q = ("MATCH (s:Sample {dataset_id:$d})-[r:HAS_ABUNDANCE]->(a:ASV {dataset_id:$d}) "
         "WHERE a.louvain_label IS NOT NULL AND r.count > 0 "
         "RETURN s.sample_id AS sample, s.date AS date, a.louvain_label AS cluster, a.id AS asv, "
         "r.count AS count ORDER BY a.louvain_label, s.sample_id, a.id")
    data["value_declaration"] = semantics.value_declaration(
        _q, dataset_id, "pairwise between samples of different years, computed within samples")
    data["cluster_caveat"] = semantics.cluster_partition_caveat(_q, dataset_id)
    return _envelope("cluster_interannual_variability", q, {"dataset_id": dataset_id, "metric": metric},
                     data, len(data["clusters"]))


def cluster_year_overview(dataset_id: str, metric: str = "jaccard") -> dict:
    _require_dataset(dataset_id)
    if metric not in semantics.INTERANNUAL_METRICS:
        raise ToolError(f"metric muss eines von {sorted(semantics.INTERANNUAL_METRICS)} sein, "
                        f"nicht {metric!r}.")
    data = semantics.cluster_year_overview(_run, dataset_id, metric)
    data["value_declaration"] = semantics.value_declaration(
        _q, dataset_id, "within one sample, aggregated over the calendar year")
    data["cluster_caveat"] = semantics.cluster_partition_caveat(_q, dataset_id)
    return _envelope("cluster_year_overview",
                     "semantics.cluster_series + frequency/activity + interannual_variability + "
                     "cluster_environment_profile + environment/seasonal_stats",
                     {"dataset_id": dataset_id, "metric": metric}, data, len(data["clusters"]))


def cluster_timeseries(dataset_id: str) -> dict:
    _require_dataset(dataset_id)
    data = semantics.cluster_timeseries(_run, dataset_id)
    if data is None:
        raise ToolError(f"Datensatz {dataset_id!r} hat kein Netz (keine Module).")
    return _envelope("cluster_timeseries", semantics.CLUSTER_TIMESERIES_QUERY, {"dataset_id": dataset_id},
                     data, len(data["samples"]))


def cluster_detail(dataset_id: str, cluster: int) -> dict:
    _require_dataset(dataset_id)
    members = _run("""
        MATCH (a:ASV {dataset_id:$d}) WHERE a.louvain_label = $l
        RETURN a.id AS asv_id, a.genus AS genus, a.family AS family,
               a.read_count_total AS read_count_total,
               COUNT { (a)<-[:HAS_ABUNDANCE]-(:Sample) } AS n_samples_present
        ORDER BY coalesce(a.read_count_total, 0) DESC, a.id
        """, d=dataset_id, l=cluster)
    if not members:
        known = _run("MATCH (a:ASV {dataset_id:$d}) WHERE a.louvain_label IS NOT NULL "
                     "RETURN DISTINCT a.louvain_label AS l ORDER BY l", d=dataset_id)
        raise ToolError(f"kein Cluster {cluster} in {dataset_id!r}. "
                        f"Vorhanden: {[r['l'] for r in known]}")

    coh = _run("""
        MATCH (a:ASV {dataset_id:$d})-[r:CO_OCCURS_WITH {dataset_id:$d}]->(b:ASV {dataset_id:$d})
        WHERE a.louvain_label = $l OR b.louvain_label = $l
        RETURN sum(CASE WHEN a.louvain_label = $l AND b.louvain_label = $l THEN 1 ELSE 0 END) AS innen,
               sum(CASE WHEN a.louvain_label = $l AND b.louvain_label = $l THEN 0 ELSE 1 END) AS aussen
        """, d=dataset_id, l=cluster)
    cohesion = coh[0] if coh else {"innen": 0, "aussen": 0}

    partners = _run("""
        MATCH (a:ASV {dataset_id:$d})-[r:CO_OCCURS_WITH {dataset_id:$d}]->(b:ASV {dataset_id:$d})
        WHERE (a.louvain_label = $l) <> (b.louvain_label = $l)
        WITH CASE WHEN a.louvain_label = $l THEN b.louvain_label ELSE a.louvain_label END AS partner,
             count(*) AS n_edges
        RETURN partner, n_edges ORDER BY n_edges DESC, partner LIMIT 10
        """, d=dataset_id, l=cluster)

    genus_b: dict[str, int] = {}
    for m in members:
        g = m["genus"] or "unbestimmt"
        genus_b[g] = genus_b.get(g, 0) + 1
    top_genera = sorted(genus_b.items(), key=lambda kv: (-kv[1], kv[0]))[:10]

    out = {
        "cluster": cluster,
        "n_members": len(members),
        "top_genera": [{"genus": g, "n_asv": n} for g, n in top_genera],
        "largest_members": members[:10],
        "cohesion": {
            "con_edges_inside": cohesion["innen"],
            "con_edges_outside": cohesion["aussen"],
            "note": ("No link leaves this cluster — it is a network component of its own. "
                     "Here 'cluster' only means 'disconnected part', not 'densely connected module'."
                     if not cohesion["aussen"] else
                     "Links inward versus links outward: the larger the ratio, the more the word "
                     "'module' is justified."),
        },
        "connected_clusters": partners,
        "environment_profile": semantics.cluster_environment_profile(_q, dataset_id, cluster),
        "seasonal": semantics.frequency(
            _q, dataset_id, semantics.cluster_series(_q, dataset_id, cluster),
            with_rank=False)["seasonal"],
        "quantity": semantics.quantity(_q, dataset_id),
        "value_declaration": {
            **semantics.value_declaration(_q, dataset_id, semantics.frame_summed(_q, dataset_id)),
            "applies_to": "largest_members[].read_count_total",
        },
        "cluster_caveat": semantics.cluster_partition_caveat(_q, dataset_id),
        "cluster_name": (semantics.module_label(_q, dataset_id, cluster)["name"] or ""),
        "cluster_display": semantics.module_label(_q, dataset_id, cluster)["display"],
    }
    return _envelope("cluster_detail", "cluster_detail (Mitglieder + Zusammenhalt + Partner)",
                     {"dataset_id": dataset_id, "cluster": cluster}, out, len(members))


def cluster_functions(dataset_id: str, cluster: int) -> dict:
    _require_dataset(dataset_id)
    cf = semantics.cluster_functions(_run, dataset_id, cluster)
    if cf["n_members"] == 0:
        known = _run("MATCH (a:ASV {dataset_id:$d}) WHERE a.louvain_label IS NOT NULL "
                     "RETURN DISTINCT a.louvain_label AS l ORDER BY l", d=dataset_id)
        raise ToolError(f"kein Cluster {cluster} in {dataset_id!r}. "
                        f"Vorhanden: {[r['l'] for r in known]}")
    q = ("MATCH (a:ASV {dataset_id:$d}) WHERE a.louvain_label = $l "
         "RETURN a.id AS id, a.trait_function AS f ORDER BY a.id")
    data = {"cluster": cluster, "cluster_display": semantics.module_label(_q, dataset_id, cluster)["display"],
            **cf, "annotation_run": semantics.trait_run(_run, dataset_id)}
    return _envelope("cluster_functions", q, {"dataset_id": dataset_id, "cluster": cluster}, data,
                     cf["n_members"])


def taxa_composition(dataset_id: str, rank: str = "genus", limit: int = 15,
                     network_only: bool = False) -> dict:
    _require_dataset(dataset_id)
    allowed = tuple(semantics.TAXONOMY_RANKS)
    rank = (rank or "genus").lower()
    if rank not in allowed:
        raise ToolError(f"rank muss einer von {list(allowed)} sein")
    limit = max(1, min(int(limit), MAX_LIMIT_TAXA))
    net = "AND a.louvain_label IS NOT NULL" if network_only else ""
    reads = semantics.value_kind(_q, dataset_id) == "reads"
    if reads:
        q = f"""
    MATCH (a:ASV {{dataset_id:$d}})
    WHERE a.{rank} IS NOT NULL {net}
    RETURN a.{rank} AS taxon, count(a) AS n_asv,
           sum(coalesce(a.read_count_total, 0.0)) AS read_count_total
    ORDER BY n_asv DESC, read_count_total DESC, taxon
    LIMIT $limit
    """
    else:
        q = f"""
    MATCH (a:ASV {{dataset_id:$d}})
    WHERE a.{rank} IS NOT NULL {net}
    RETURN a.{rank} AS taxon, count(a) AS n_asv, null AS read_count_total
    ORDER BY n_asv DESC, taxon
    LIMIT $limit
    """
    rows = _run(q, d=dataset_id, limit=limit)
    q_tot = f"MATCH (a:ASV {{dataset_id:$d}}) WHERE a.{rank} IS NOT NULL {net} " \
            f"RETURN count(DISTINCT a.{rank}) AS n_taxa, count(a) AS n_asv"
    tot = _run(q_tot, d=dataset_id)
    out = {
        "rank": rank,
        "network_only": network_only,
        "top": rows,
        "n_distinct_taxa": tot[0]["n_taxa"] if tot else None,
        "n_asv_considered": tot[0]["n_asv"] if tot else None,
        "value_declaration": {
            **semantics.value_declaration(_q, dataset_id, semantics.frame_summed(_q, dataset_id)),
            "applies_to": "top[].read_count_total",
        },
        "note": ("'n_asv' = how many distinct ASVs this taxon has. 'read_count_total' = their "
                 "summed read count across the whole dataset — a ranking aid, NOT a percentage "
                 "and NOT a share, and only comparable within this dataset."),
    }
    if not reads:
        out["read_count_total_absent_reason"] = (
            "This dataset's values are a transform of unknown form — summing them would "
            "assume additivity nobody has established, so no sum is computed.")
    return _envelope("taxa_composition", q, {"dataset_id": dataset_id, "rank": rank,
                                             "limit": limit, "network_only": network_only},
                     out, len(rows))


def summarize_by_taxon(dataset_id: str, rank: str = "genus", name: str | None = None) -> dict:
    _require_dataset(dataset_id)
    allowed = tuple(semantics.TAXONOMY_RANKS)
    rank = (rank or "genus").lower()
    if rank not in allowed:
        raise ToolError(f"rank muss einer von {list(allowed)} sein")
    name = name or None
    idx = allowed.index(rank)
    child_rank = allowed[idx + 1] if (name is not None and idx + 1 < len(allowed)) else None
    group = child_rank or rank
    where = f"coalesce(a.`{rank}`, 'unassigned') = $name" if name else "true"
    reads = semantics.value_kind(_q, dataset_id) == "reads"
    summe = "sum(coalesce(a.read_count_total, 0.0))" if reads else "null"

    q = f"""
    MATCH (a:ASV {{dataset_id:$d}}) WHERE {where}
    RETURN coalesce(a.`{group}`, 'unassigned') AS taxon, count(a) AS n_asv,
           {summe} AS read_count_total,
           collect(a.louvain_label) AS labels
    ORDER BY n_asv DESC, taxon
    """
    rows = _run(q, d=dataset_id, name=name)
    if name is not None and not rows:
        raise ToolError(f"kein Taxon {name!r} auf Rang {rank!r} in {dataset_id!r} — "
                        f"taxa_composition(rank={rank!r}) listet die bekannten Namen")
    det = {r["taxon"]: r["n"] for r in _run(
        f"MATCH (a:ASV {{dataset_id:$d}}) WHERE {where} "
        f"MATCH (s:Sample {{dataset_id:$d}})-[:HAS_ABUNDANCE]->(a) "
        f"RETURN coalesce(a.`{group}`, 'unassigned') AS taxon, count(DISTINCT s.sample_id) AS n",
        d=dataset_id, name=name)}
    n_samples_total = _run("MATCH (s:Sample {dataset_id:$d}) RETURN count(s) AS n",
                           d=dataset_id)[0]["n"]

    benannt, unassigned_row = [], None
    for r in rows:
        hist: dict[str, int] = {}
        for lbl in r["labels"]:
            if lbl is not None:
                hist[str(lbl)] = hist.get(str(lbl), 0) + 1
        row = {
            "taxon": r["taxon"],
            "is_unassigned": r["taxon"] == "unassigned",
            "n_asv": r["n_asv"],
            "n_samples_present": det.get(r["taxon"], 0),
            "n_samples_total": n_samples_total,
            "read_count_total": r["read_count_total"],
            "cluster_histogram": hist,
        }
        if row["is_unassigned"]:
            row["taxon_note"] = ("no assignment, not a taxon — kept as its own row, "
                                 "never merged with named taxa")
            unassigned_row = row
        else:
            benannt.append(row)
    if unassigned_row is not None:
        benannt.append(unassigned_row)

    out = {
        "rank": rank,
        "name": name,
        "grouped_by": group,
        "rows": benannt,
        "n_asv_total": sum(r["n_asv"] for r in benannt),
        "n_samples_total": n_samples_total,
        "value_declaration": {
            **semantics.value_declaration(_q, dataset_id, semantics.frame_summed(_q, dataset_id)),
            "applies_to": "rows[].read_count_total",
        },
        "note": ("The sum runs across DIFFERENT sequence variants (ASVs) that share a name — "
                 "the name only says which reference entry is closest, it does not make them "
                 "one organism. Aggregation happens in this view, never in the graph and "
                 "never before the network run."),
    }
    if not reads:
        out["read_count_total_absent_reason"] = (
            "This dataset's values are a transform of unknown form — summing them would "
            "assume additivity nobody has established, so no sum is computed.")
    if name is not None:
        mitglieder = [r["id"] for r in _run(
            f"MATCH (a:ASV {{dataset_id:$d}}) WHERE {where} RETURN a.id AS id ORDER BY a.id",
            d=dataset_id, name=name)]
        reihe = semantics.taxon_series(_q, dataset_id, mitglieder)
        out["series"] = reihe["rows"]
        out["series_absent_reason"] = reihe["absent_reason"]
        out["series_members"] = mitglieder
    return _envelope("summarize_by_taxon", q,
                     {"dataset_id": dataset_id, "rank": rank, "name": name},
                     out, len(benannt))




def environment(dataset_id: str) -> dict:
    _require_dataset(dataset_id)
    env = semantics.environment(_q, dataset_id)

    if not env["variables"]:
        out = {
            "available": False,
            "reason": env["absent_reason"],
            "variables": [],
            "instruction": ("Say plainly that this dataset carries no environmental measurements. "
                            "Do NOT state, estimate or infer any temperature, salinity or depth "
                            "for it — there is none to report."),
        }
        return _envelope("environment", "semantics.environment", {"dataset_id": dataset_id}, out, 0)

    out = {
        "available": True,
        "n_samples": env["n_sample"],
        "time_axis": env["time_axis"],
        "provenance": env["provenance"],
        "units_note": env["units_note"],
        "variables": [
            {"key": v["key"], "label": v["label"], "unit": v["unit"],
             **({"unit_caveat": v["unit_note"]} if v.get("unit_note") else {}),
             "min": v["min"], "max": v["max"], "mean": v["mean"],
             "coverage": f"{v['n']} of {v['total']} samples",
             "n_missing": v["total"] - v["n"],
             **({"by_month": v["monthly"]} if v.get("monthly") else {})}
            for v in env["variables"]
        ],
        "not_measured": [a["label"] for a in env["absent"]],
    }
    if env["time_axis"] != semantics.TIME_AXIS_DATES:
        out["time_axis_note"] = ("No real sampling dates — no monthly or seasonal statement is "
                                 "possible for this dataset.")
    out["caveat"] = ("These values were measured next to the samples; they are context, not a "
                     "result of the sequencing. This tool reports no relationship between an ASV "
                     "and any environmental variable; the only such figure MANTA offers is the "
                     "rank correlation of environment_correlation — do not claim any other.")
    return _envelope("environment", "semantics.environment", {"dataset_id": dataset_id},
                     out, len(out["variables"]))



_WRITE_WORDS = re.compile(
    r"\b(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|FOREACH|LOAD\s+CSV)\b"
    r"|\bapoc\.(create|merge|refactor|trigger|periodic)"
    r"|\bdbms\.|\bdb\.(index|constraint)",
    re.IGNORECASE,
)
_LABEL_RE = re.compile(r":\s*([A-Za-z_][A-Za-z0-9_]*)")
_PROP_RE = re.compile(r"(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)")
_LIMIT_RE = re.compile(r"\bLIMIT\s+(\d+)", re.IGNORECASE)

NICHT_ABFRAGBAR = {"Star", "Reference"}

_NODE_RE = re.compile(
    r"(?<![A-Za-z0-9_.])\(\s*([A-Za-z_][A-Za-z0-9_]*)?\s*"
    r"((?::\s*[A-Za-z_][A-Za-z0-9_]*\s*)+)"
    r"(\{[^{}]*\})?\s*\)")
_ANON_NODE_RE = re.compile(
    r"(?<![A-Za-z0-9_.])\(\s*([A-Za-z_][A-Za-z0-9_]*)?\s*"
    r"(\{[^{}]*\})?\s*\)")
_WHERE_BIND_RE = re.compile(
    r"(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*dataset_id\s*=\s*['\"]")


def _ungebundene_knoten(q: str) -> list[str]:
    gebunden_per_where = set(_WHERE_BIND_RE.findall(q))
    offen = []
    sicher: set[str] = set(gebunden_per_where)
    for var, labels, props in _NODE_RE.findall(q):
        gebunden = bool(props and _DATASET_TOKEN_RE.search(props)) or (var in gebunden_per_where)
        if gebunden:
            if var:
                sicher.add(var)
            continue
        lab = ":".join(x.strip() for x in labels.split(":") if x.strip())
        offen.append(f"({var or ''}:{lab})")

    for var, props in _ANON_NODE_RE.findall(q):
        if props and _DATASET_TOKEN_RE.search(props):
            continue
        if var and var in sicher:
            continue
        offen.append(f"({var or ''})")
    return offen


def validate_cypher(query: str, dataset_id: str) -> tuple[bool, str, str]:
    if not query or not query.strip():
        return False, "leere Query", ""
    q = query.strip().rstrip(";").strip()

    if ";" in q:
        return False, "mehrere Statements sind nicht erlaubt", ""

    m = _WRITE_WORDS.search(q)
    if m:
        return False, f"nur lesende Queries erlaubt — verbotenes Schluesselwort {m.group(0)!r}", ""

    sch = schema()
    known_labels = set(sch["labels"])
    known_rels = set(sch["relationship_types"])
    known_props = set(sch["property_keys"])

    for lab in _LABEL_RE.findall(q):
        if lab in NICHT_ABFRAGBAR:
            return False, (f"{lab!r} ist fuer freie Abfragen gesperrt: der Knoten gehoert nicht "
                           f"zur Bestandskette und faellt deshalb auch nicht unter die "
                           f"Sichtbarkeitsgrenze. Gesperrt: {sorted(NICHT_ABFRAGBAR)}."), ""
        if lab not in (known_labels | known_rels):
            return False, (f"unbekanntes Label/Beziehungstyp {lab!r}. "
                           f"Labels: {sorted(known_labels)}; Beziehungen: {sorted(known_rels)}"), ""

    for _var, prop in _PROP_RE.findall(q):
        if prop not in known_props:
            return False, f"unbekannte Property {prop!r}. Bekannte Properties: {sorted(known_props)}", ""

    literals = _DATASET_LITERAL_RE.findall(q)
    mentions = len(_DATASET_TOKEN_RE.findall(q))
    if mentions == 0:
        return False, ("Query muss auf einen Datensatz gescopt sein: 'dataset_id' fehlt. "
                       f"Beispiel: MATCH (a:ASV {{dataset_id:'{dataset_id}'}}) RETURN a.id LIMIT 10"), ""
    if len(literals) != mentions:
        return False, ("jedes 'dataset_id' muss direkt auf einen Text gesetzt werden, damit der "
                       f"Bezug pruefbar ist. Erlaubt: dataset_id:'{dataset_id}' oder "
                       f"a.dataset_id = '{dataset_id}'. Nicht erlaubt: Parameter, Vergleich mit "
                       "einer Variablen, STARTS WITH."), ""
    fremd = sorted({v for _q0, v in literals if v != dataset_id})
    if fremd:
        return False, (f"die Query fragt {fremd} ab, autorisiert ist aber nur {dataset_id!r}. "
                       "Eine Query darf nur den Datensatz lesen, fuer den sie gestellt wurde."), ""
    offen = _ungebundene_knoten(q)
    if offen:
        return False, (
            f"nicht auf den Bestand gescopt: {', '.join(offen[:4])}"
            + (f" und {len(offen) - 4} weitere" if len(offen) > 4 else "")
            + ". JEDES Knotenmuster braucht ein Label UND eine dataset_id-Bindung — sonst "
            "liest die Abfrage an der Sichtbarkeitsgrenze vorbei. So binden: "
            f"(b:ASV {{dataset_id:'{dataset_id}'}}) oder WHERE b.dataset_id = '{dataset_id}'. "
            "Ein Muster ohne Label wie (b) ist gegen das Schema nicht pruefbar und nur "
            "erlaubt, wenn dieselbe Variable vorher labelbehaftet gebunden wurde."), ""
    lm = _LIMIT_RE.search(q)
    if not lm:
        safe = f"{q}\nLIMIT {MAX_LIMIT}"
    elif int(lm.group(1)) > MAX_LIMIT:
        safe = _LIMIT_RE.sub(f"LIMIT {MAX_LIMIT}", q, count=1)
    else:
        safe = q

    return True, "ok", safe


def run_validated_cypher(dataset_id: str, query: str) -> dict:
    _require_dataset(dataset_id)
    ok, reason, safe = validate_cypher(query, dataset_id)
    if not ok:
        raise ToolError(f"Query abgelehnt: {reason}")
    try:
        rows = _run(safe)
    except Neo4jError as e:
        if "AccessMode" in (e.code or ""):
            raise ToolError(
                "Die Datenbank hat diese Query als Schreibzugriff abgelehnt (Lesemodus). "
                "Das ist ein BEFUND: der Validator haette sie vorher abweisen muessen. "
                "Bitte melden. Nur lesende Abfragen sind hier moeglich.") from e
        raise ToolError(f"Die Datenbank hat die Query abgelehnt: {e.message} "
                        f"({e.code}). Formuliere sie neu; get_schema nennt die gueltigen "
                        f"Namen.") from e
    env = _envelope("run_validated_cypher", safe, {"dataset_id": dataset_id}, rows, len(rows))
    env["provenance"]["validated"] = True
    env["provenance"]["original_query"] = " ".join(query.split())
    env["value_declaration"] = {
        **semantics.value_declaration(
            _q, dataset_id,
            "as stored on this dataset — any count-derived value in these rows is of this kind"),
        "applies_to": "every value derived from HAS_ABUNDANCE.count in the returned rows",
    }
    return env


def get_schema() -> dict:
    sch = live_schema()
    return _envelope("get_schema", "CALL db.labels() / db.relationshipTypes() / db.propertyKeys()",
                     {}, sch, len(sch["labels"]))



def _stat_subject(dataset_id: str, asv_id: str | None, cluster: int | None) -> tuple[list[dict], dict]:
    if (asv_id is None) == (cluster is None):
        raise ToolError("give exactly one of asv_id or cluster")
    if asv_id is not None:
        rows = semantics.series(_q, dataset_id, asv_id)
        if not rows or not any((r["count"] or 0) > 0 for r in rows):
            raise ToolError(f"ASV {asv_id!r} in Datensatz {dataset_id!r} nicht gefunden oder nie nachgewiesen")
        return rows, {"asv_id": asv_id}
    rows = semantics.cluster_series(_q, dataset_id, int(cluster))
    if not rows or not any((r["sum_count"] or 0) > 0 for r in rows):
        raise ToolError(f"Cluster {cluster!r} in Datensatz {dataset_id!r} nicht gefunden oder leer")
    return rows, {"cluster": int(cluster)}


def _stat_caveats(dataset_id: str) -> list[str]:
    c = [statistik.CAVEAT_NOT_NETWORK, statistik.CAVEAT_INDEPENDENCE, statistik.CAVEAT_COMPOSITIONAL]
    if semantics.value_kind(_q, dataset_id) == "transformed":
        c.append(statistik.CAVEAT_TRANSFORMED)
    return c


_NO_DATES = ("This dataset has NO real time axis (sample order only) — calendar months and "
             "years do not exist here, so this test cannot be run.")


def seasonality_test(dataset_id: str, asv_id: str | None = None, cluster: int | None = None) -> dict:
    _require_dataset(dataset_id)
    rows, subject = _stat_subject(dataset_id, asv_id, cluster)
    params = {"dataset_id": dataset_id, **subject}
    if semantics.time_axis(_q, dataset_id) != semantics.TIME_AXIS_DATES:
        return _envelope("seasonality_test", "semantics.series (ordinal)", params,
                         {**subject, "result": None, "note": _NO_DATES}, len(rows))
    data = {**subject, "quantity": "share", "result": statistik.seasonality_test(rows, "share"),
            "caveats": _stat_caveats(dataset_id)}
    return _envelope("seasonality_test", "semantics.series + statistik.seasonality_test",
                     params, data, len(rows))


def trend_test(dataset_id: str, asv_id: str | None = None, cluster: int | None = None) -> dict:
    _require_dataset(dataset_id)
    rows, subject = _stat_subject(dataset_id, asv_id, cluster)
    params = {"dataset_id": dataset_id, **subject}
    if semantics.time_axis(_q, dataset_id) != semantics.TIME_AXIS_DATES:
        return _envelope("trend_test", "semantics.series (ordinal)", params,
                         {**subject, "result": None, "note": _NO_DATES}, len(rows))
    data = {**subject, "quantity": "share", "result": statistik.trend_test(rows, "share"),
            "caveats": _stat_caveats(dataset_id)}
    return _envelope("trend_test", "semantics.series + statistik.trend_test", params, data, len(rows))


def pair_proportionality(dataset_id: str, asv_a: str, asv_b: str) -> dict:
    _require_dataset(dataset_id)
    if asv_a == asv_b:
        raise ToolError("asv_a and asv_b must differ")
    ra, _ = _stat_subject(dataset_id, asv_a, None)
    rb, _ = _stat_subject(dataset_id, asv_b, None)
    con = _run("MATCH (a:ASV {dataset_id:$d, id:$x})-[e:CO_OCCURS_WITH]-(b:ASV {dataset_id:$d, id:$y}) "
               "RETURN e.corr AS corr LIMIT 1", d=dataset_id, x=asv_a, y=asv_b)
    con_link = {"exists": bool(con), "corr": con[0]["corr"] if con else None,
                "note": "CON correlates Fourier features of the two series; rho_p asks "
                        "whether their RATIO stays constant across samples. Different "
                        "questions — agreement is not required."}

    if semantics.value_kind(_q, dataset_id) == "transformed":
        data = {"asv_a": asv_a, "asv_b": asv_b, "result": None,
                "absent_reason": statistik.REFUSE_PROPORTIONALITY_TRANSFORMED,
                "con_link": con_link, "caveats": _stat_caveats(dataset_id)}
        return _envelope("pair_proportionality", "semantics.series x2 (verweigert: transformed)",
                         {"dataset_id": dataset_id, "asv_a": asv_a, "asv_b": asv_b},
                         data, len(ra))

    b_count = {r["sample"]: r["count"] for r in rb}
    b_share = {r["sample"]: r["share"] for r in rb}
    roh = statistik.proportionality([r["count"] for r in ra],
                                    [b_count.get(r["sample"]) for r in ra])
    anteil = statistik.proportionality([r["share"] for r in ra],
                                       [b_share.get(r["sample"]) for r in ra])
    data = {"asv_a": asv_a, "asv_b": asv_b,
            "result": {**roh, "on": "count (raw stored values)",
                       "rho_p_on_share": anteil["rho_p"],
                       "scale_note": statistik.CAVEAT_PROPORTIONALITY_SCALE},
            "con_link": con_link,
            "caveats": _stat_caveats(dataset_id)}
    return _envelope("pair_proportionality", "semantics.series x2 + statistik.proportionality",
                     {"dataset_id": dataset_id, "asv_a": asv_a, "asv_b": asv_b}, data, len(ra))


def group_comparison_test(dataset_id: str, by: str, group_a: list[int], group_b: list[int],
                          asv_id: str | None = None, cluster: int | None = None) -> dict:
    _require_dataset(dataset_id)
    rows, subject = _stat_subject(dataset_id, asv_id, cluster)
    params = {"dataset_id": dataset_id, **subject, "by": by, "group_a": list(group_a), "group_b": list(group_b)}
    if semantics.time_axis(_q, dataset_id) != semantics.TIME_AXIS_DATES:
        return _envelope("group_comparison_test", "semantics.series (ordinal)", params,
                         {**subject, "result": None, "note": _NO_DATES}, len(rows))
    try:
        result = statistik.group_comparison(rows, "share", by, [int(g) for g in group_a],
                                            [int(g) for g in group_b])
    except ValueError as e:
        raise ToolError(str(e)) from e
    data = {**subject, "quantity": "share", "result": result, "caveats": _stat_caveats(dataset_id)}
    return _envelope("group_comparison_test", "semantics.series + statistik.group_comparison",
                     params, data, len(rows))


def asv_drivers(dataset_id: str, asv_id: str) -> dict:
    _require_dataset(dataset_id)
    if not _run("MATCH (a:ASV {id:$id, dataset_id:$d}) RETURN a.id", d=dataset_id, id=asv_id):
        raise ToolError(f"ASV {asv_id!r} in Datensatz {dataset_id!r} nicht gefunden")
    dr = semantics.asv_drivers(_run, dataset_id, asv_id)
    q = ("MATCH (v:EnvVariable {dataset_id:$d})-[c:COVARIES_WITH {dataset_id:$d}]->(a:ASV {id:$id, dataset_id:$d}) "
         "RETURN v.name, c.lag, c.r, c.r0, c.p, c.p_adj, c.n ORDER BY abs(c.r) DESC, v.name")
    data = {"asv_id": asv_id, **dr,
            "caveats": _stat_caveats(dataset_id) + [semantics.ENV_LINK_NOTE]}
    return _envelope("asv_drivers", q, {"dataset_id": dataset_id, "asv_id": asv_id}, data, len(dr["drivers"]))


def env_variable_links(dataset_id: str, name: str) -> dict:
    _require_dataset(dataset_id)
    if name not in semantics.ENVIRONMENT_KEYS:
        raise ToolError(f"unknown variable {name!r}. Known: {semantics.ENVIRONMENT_KEYS}")
    ev = semantics.env_variable_links(_run, dataset_id, name)
    q = ("MATCH (v:EnvVariable {dataset_id:$d, name:$n})-[c:COVARIES_WITH {dataset_id:$d}]->(a:ASV {dataset_id:$d}) "
         "RETURN a.id, a.genus, a.louvain_label, c.lag, c.r, c.r0, c.p_adj, c.n ORDER BY abs(c.r) DESC, a.id")
    if not ev["run"]["available"]:
        ev["absent_reason"] = ev["run"]["absent_reason"]
    elif not ev["known"]:
        ev["absent_reason"] = f"variable {name!r} was not measured in this dataset"
    data = {**ev, "caveats": _stat_caveats(dataset_id) + [semantics.ENV_LINK_NOTE]}
    return _envelope("env_variable_links", q, {"dataset_id": dataset_id, "name": name}, data, ev["n_links"])


def cluster_env_links(dataset_id: str, cluster: int) -> dict:
    _require_dataset(dataset_id)
    ce = semantics.cluster_env_links(_run, dataset_id, cluster)
    if ce["n_members"] == 0:
        known = _run("MATCH (a:ASV {dataset_id:$d}) WHERE a.louvain_label IS NOT NULL "
                     "RETURN DISTINCT a.louvain_label AS l ORDER BY l", d=dataset_id)
        raise ToolError(f"kein Cluster {cluster} in {dataset_id!r}. "
                        f"Vorhanden: {[r['l'] for r in known]}")
    q = ("MATCH (v:EnvVariable {dataset_id:$d})-[c:COVARIES_WITH {dataset_id:$d}]->(a:ASV {dataset_id:$d}) "
         "WHERE a.louvain_label = $l RETURN v.name, count(a), avg(c.r), collect(a.id) ORDER BY count(a) DESC, v.name")
    data = {"cluster": cluster, "cluster_display": semantics.module_label(_q, dataset_id, cluster)["display"],
            **ce, "caveats": _stat_caveats(dataset_id) + [semantics.ENV_LINK_NOTE]}
    return _envelope("cluster_env_links", q, {"dataset_id": dataset_id, "cluster": cluster}, data, len(ce["links"]))


def environment_correlation(dataset_id: str, asv_id: str, variable: str) -> dict:
    _require_dataset(dataset_id)
    var = next((v for v in semantics.ENVIRONMENT_VARS if v["key"] == variable), None)
    if var is None:
        raise ToolError(f"unknown variable {variable!r}. Known: {semantics.ENVIRONMENT_KEYS}")
    rows, _ = _stat_subject(dataset_id, asv_id, None)
    env_rows = _run(f"MATCH (s:Sample {{dataset_id:$d}}) RETURN s.sample_id AS sample, "
                    f"s.`{var['key']}` AS v ORDER BY s.date, s.sample_id", d=dataset_id)
    by_sample = {r["sample"]: r["v"] for r in env_rows}
    values = [r["share"] for r in rows]
    env = [by_sample.get(r["sample"]) for r in rows]
    result = statistik.rank_correlation(values, env)
    data = {"asv_id": asv_id, "quantity": "share",
            "variable": {"key": var["key"], "label": var["label"], "unit": var["unit"],
                         **({"unit_note": var["unit_note"]} if var.get("unit_note") else {})},
            "result": result,
            "caveats": _stat_caveats(dataset_id) + [
                "A rank correlation with a measured variable is NOT a niche, an optimum or a "
                "response: shares shift when other taxa shift, and the variable was measured "
                "next to the sample, not manipulated."]}
    return _envelope("environment_correlation", "semantics.series + Sample env + statistik.rank_correlation",
                     {"dataset_id": dataset_id, "asv_id": asv_id, "variable": variable}, data,
                     result.get("n_samples") or 0)
