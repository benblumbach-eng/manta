from __future__ import annotations

import contextvars
import functools
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from typing import Annotated, Any

from neo4j import GraphDatabase, unit_of_work
from neo4j.exceptions import Neo4jError
from pydantic import Field

import access
import anwendbarkeit
import begriffe
import semantics
import statistik

SCHEMA_VERSION = "manta-graph-1"
TOOLS_VERSION = "0.16.0"
MAX_LIMIT = 500
MAX_LIMIT_TAXA = 100

LimitArg = Annotated[int, Field(json_schema_extra={"minimum": 1, "maximum": MAX_LIMIT})]
TaxaLimitArg = Annotated[int, Field(json_schema_extra={"minimum": 1, "maximum": MAX_LIMIT_TAXA})]
EdgeArg = Annotated[str, Field(json_schema_extra={"enum": ["con", "ccm"]})]
DirectionArg = Annotated[str, Field(json_schema_extra={"enum": ["out", "in", "both"]})]
RankArg = Annotated[str, Field(json_schema_extra={"enum": list(semantics.TAXONOMY_RANKS)})]
MetricArg = Annotated[str, Field(json_schema_extra={"enum": ["jaccard", "bray_curtis"]})]
ByArg = Annotated[str, Field(json_schema_extra={"enum": ["year", "month"]})]
KindArg = Annotated["str | None", Field(json_schema_extra={"enum": list(begriffe.KIND_NAMES.values())})]

_DATASET_LITERAL_RE = re.compile(r"""dataset_id\s*(?::|=)\s*(['"])(.*?)\1""")
_DATASET_TOKEN_RE = re.compile(r"\bdataset_id\b")

NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "")
QUERY_TIMEOUT_S = float(os.environ.get("MANTA_QUERY_TIMEOUT", "120"))
FREE_QUERY_TIMEOUT_S = float(os.environ.get("MANTA_FREE_QUERY_TIMEOUT", "15"))
_ZEITGRENZE: contextvars.ContextVar = contextvars.ContextVar("manta_query_timeout", default=None)

_driver = None


def driver():
    global _driver
    if _driver is None:
        if not NEO4J_PASSWORD:
            raise RuntimeError("NEO4J_PASSWORD is not set")
        _driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD),
                                       notifications_disabled_categories=["UNRECOGNIZED", "DEPRECATION"],
                                       max_transaction_retry_time=5)
    return _driver


class ToolError(Exception):
    pass



_QUERY_LOG: contextvars.ContextVar = contextvars.ContextVar("manta_query_log", default=None)


def mit_abfrageprotokoll(fn):
    @functools.wraps(fn)
    def wrapper(*a, **kw):
        token = _QUERY_LOG.set([])
        try:
            ergebnis = fn(*a, **kw)
            if isinstance(ergebnis, dict) and isinstance(ergebnis.get("provenance"), dict):
                voll = [e for e in (_QUERY_LOG.get() or []) if e["cypher"] != _SNAPSHOT_CYPHER]
                if voll:
                    ergebnis["provenance"]["cypher"] = voll
                ergebnis["provenance"].update(_kennung(ergebnis))
            return ergebnis
        finally:
            _QUERY_LOG.reset(token)
    return wrapper


def _run(query: str, **params) -> list[dict]:
    log = _QUERY_LOG.get()
    if log is None:
        log = []
        _QUERY_LOG.set(log)
    log.append({"cypher": " ".join(query.split()), "params": dict(params)})

    @unit_of_work(timeout=_ZEITGRENZE.get() or QUERY_TIMEOUT_S)
    def _lesen(tx):
        return [r.data() for r in tx.run(query, params)]

    with driver().session(default_access_mode="READ") as s:
        return s.execute_read(_lesen)


_SNAPSHOT_CYPHER = "MATCH (n) WHERE n:ASV OR n:Sample RETURN count(n) AS n"


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
        raise ToolError("dataset_id is missing. Call list_datasets first and choose a valid id.")
    rows = _run(f"MATCH (d:Dataset {{dataset_id:$d}}) WHERE {access.cypher_condition('d')} "
                "RETURN d.dataset_id AS id", d=dataset_id)
    if not rows:
        known = [r["dataset_id"] for r in _run(
            f"MATCH (d:Dataset) WHERE {access.cypher_condition('d')} "
            "RETURN d.dataset_id AS dataset_id ORDER BY d.dataset_id")]
        raise ToolError(f"unknown dataset_id {dataset_id!r}. Known: {known}")


NOT_IN_NETWORK_NOTE = ("This ASV is NOT in the network (no Louvain cluster, no links). "
                       "It only appeared in the abundance table.")


def _require_asv(dataset_id: str, asv_id: str) -> dict:
    rows = _run("MATCH (a:ASV {dataset_id:$d, id:$id}) RETURN a.louvain_label AS cluster",
                d=dataset_id, id=asv_id)
    if not rows:
        raise ToolError(f"ASV {asv_id!r} not found in dataset {dataset_id!r}")
    return rows[0]


def dataset_summary(dataset_id: str) -> dict:
    _require_dataset(dataset_id)
    q = """
    MATCH (d:Dataset {dataset_id:$d})
    OPTIONAL MATCH (s:Sample {dataset_id:$d})
    WITH d, count(s) AS n_samples, toString(min(s.date)) AS first_date, toString(max(s.date)) AS last_date
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
        out["criterion2"] = semantics.criterion2_summary(semantics.criterion2(_q, dataset_id))
        if out["time_axis"] != semantics.TIME_AXIS_DATES:
            out["first_date"] = out["last_date"] = None
            out["time_axis_note"] = ("No real time axis: the samples only have an order, not a "
                                     "calendar. No period can be given.")
        out["modules"] = list(semantics.module_labels(_q, dataset_id).values())
    return _envelope("dataset_summary", q, {"dataset_id": dataset_id}, out, len(rows))


def keystone_asvs(dataset_id: str) -> dict:
    _require_dataset(dataset_id)
    c2 = semantics.criterion2(_q, dataset_id)
    module = {a: v["module"] for a, v in c2["nodes"].items()}
    c1 = sorted(a for a, v in c2["nodes"].items() if v["reason"] != "no_ccm_link")
    beide = [a for a in c1 if a in set(c2["ids"])]
    out = {
        "criterion1": {"label": ("at least one significant CCM link "
                                 f"(permutation p < {semantics.CRITERION2_CCM_ALPHA:g})"),
                       "n": len(c1), "asvs": [{"asv_id": a, "module": module[a]} for a in c1]},
        "criterion2": {"label": semantics.CRITERION2_LABEL, "n": len(c2["ids"]),
                       "asvs": [{"asv_id": a, "module": module[a], "q": c2["nodes"][a]["q"]}
                                for a in c2["ids"]],
                       "statement": semantics.criterion2_statement(c2)},
        "both": beide,
        "n_network": c2["n_network"],
        "criterion3": ("not available: presence in a stable state of the energy landscape is "
                       "not computed in MANTA"),
        "not_keystone": semantics.CRITERION2_NOT_KEYSTONE,
        "source": semantics.CRITERION2_SOURCE,
    }
    return _envelope("keystone_asvs", "criterion2 (CCM directions + Louvain modules)",
                     {"dataset_id": dataset_id}, out, len(c2["nodes"]))


ORDERED_BY_READS = ("read_count_total: this ASV's reads summed over all samples of the dataset "
                    "(computed from the stored values, for network and non-network ASVs alike)")
TRANSFORMED_NO_SUM = (
    "This dataset's values are a transform of unknown form — summing them would "
    "assume additivity nobody has established, so no sum is computed.")
ORDERED_BY_DETECTIONS = ("n_samples_present: the number of samples with a detection. This "
                         "dataset's values are a transform of unknown form, so no summed size "
                         "exists and none is ranked by.")
UNDECLARED_NO_SUM = (
    "This dataset does not declare whether its values are reads or a transform — summing them "
    "would assume additivity nobody has established, so no sum is computed.")
ORDERED_BY_DETECTIONS_UNDECLARED = (
    "n_samples_present: the number of samples with a detection. This dataset does not declare "
    "whether its values are reads or a transform, so no summed size exists and none is ranked by.")


def _ohne_summe(kind: str) -> str:
    return TRANSFORMED_NO_SUM if kind == "transformed" else UNDECLARED_NO_SUM


def _nach_nachweisen(kind: str) -> str:
    return ORDERED_BY_DETECTIONS if kind == "transformed" else ORDERED_BY_DETECTIONS_UNDECLARED


def find_asv(dataset_id: str, genus: str | None = None, asv_id: str | None = None,
             cluster: int | None = None, limit: LimitArg = 25) -> dict:
    _require_dataset(dataset_id)
    limit = max(1, min(int(limit), MAX_LIMIT))
    genus = (genus or "").strip() or None
    asv_id = (asv_id or "").strip() or None
    kind = semantics.value_kind(_q, dataset_id)
    reads = kind == "reads"
    if reads:
        q = """
    MATCH (a:ASV {dataset_id:$d})
    WHERE ($genus   IS NULL OR toLower(a.genus) CONTAINS toLower($genus))
      AND ($asv_id  IS NULL OR a.id = $asv_id)
      AND ($cluster IS NULL OR a.louvain_label = $cluster)
    OPTIONAL MATCH (a)<-[h:HAS_ABUNDANCE]-(:Sample {dataset_id:$d})
    WITH a, sum(h.count) AS summe, count(h) AS n_present
    RETURN a.id AS asv_id, a.genus AS genus, a.family AS family, a.phylum AS phylum,
           a.louvain_label AS cluster, summe AS read_count_total,
           n_present AS n_samples_present
    ORDER BY summe DESC, a.id
    LIMIT $limit
    """
    else:
        q = """
    MATCH (a:ASV {dataset_id:$d})
    WHERE ($genus   IS NULL OR toLower(a.genus) CONTAINS toLower($genus))
      AND ($asv_id  IS NULL OR a.id = $asv_id)
      AND ($cluster IS NULL OR a.louvain_label = $cluster)
    OPTIONAL MATCH (a)<-[h:HAS_ABUNDANCE]-(:Sample {dataset_id:$d})
    WITH a, count(h) AS n_present
    RETURN a.id AS asv_id, a.genus AS genus, a.family AS family, a.phylum AS phylum,
           a.louvain_label AS cluster, null AS read_count_total,
           n_present AS n_samples_present
    ORDER BY n_present DESC, a.id
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
                     "n_matching_total": total[0]["n"] if total else None,
                     "ordered_by": ORDERED_BY_READS if reads else _nach_nachweisen(kind)},
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
    OPTIONAL MATCH (a)<-[h:HAS_ABUNDANCE]-(:Sample {dataset_id:$d})
    WITH a, sum(h.count) AS summe, count(h) AS n_present
    RETURN a.id AS asv_id, a.kingdom AS kingdom, a.phylum AS phylum, a.class AS class,
           a.order AS `order`, a.family AS family, a.genus AS genus, a.species AS species,
           a.louvain_label AS cluster, summe AS read_count_total,
           n_present AS n_samples_present,
           a.max_abundance_month AS peak_month
    """
    rows = _run(q, d=dataset_id, id=asv_id)
    if not rows:
        raise ToolError(f"ASV {asv_id!r} not found in dataset {dataset_id!r}")
    out = dict(rows[0])
    kind = semantics.value_kind(_q, dataset_id)
    if kind != "reads":
        out["read_count_total"] = None
        out["read_count_total_absent_reason"] = _ohne_summe(kind)
    axis = semantics.time_axis(_q, dataset_id)
    out["criterion2"] = semantics.criterion2_asv(semantics.criterion2(_q, dataset_id), asv_id)
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
        out["network_note"] = NOT_IN_NETWORK_NOTE
    out["funktion"] = ("Not measured in these data. A function well known for this taxon may be "
                       "named as general knowledge, not a result of this dataset; if the name "
                       "does not clearly determine it, it is unknown.")
    out["environment_profile"] = semantics.environment_profile(_q, dataset_id, asv_id)
    out["cluster_name"] = ((semantics.module_label(_q, dataset_id, out["cluster"])["name"] or "")
                           if out.get("cluster") is not None else "")
    return _envelope("asv_detail", q, {"dataset_id": dataset_id, "asv_id": asv_id}, out, 1)


def asv_abundance_series(dataset_id: str, asv_id: str) -> dict:
    _require_dataset(dataset_id)
    _require_asv(dataset_id, asv_id)
    q = """
    MATCH (s:Sample {dataset_id:$d})-[r:HAS_ABUNDANCE]->(a:ASV {dataset_id:$d, id:$id})
    RETURN s.sample_id AS sample_id, toString(s.date) AS date, r.count AS count
    ORDER BY s.date, s.same_day_index, s.ordinal_index, s.sample_id
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
        raise ToolError(f"ASV {asv_id!r} not found in dataset {dataset_id!r}")
    q = ("MATCH (a:ASV {id:$id, dataset_id:$d}) OPTIONAL MATCH (r:Run {dataset_id:$d}) "
         "RETURN a.fft_amplitudes AS amps, r.fft_harmonics AS ks, r.hellinger AS hellinger "
         "ORDER BY coalesce(r.computed_at, '') DESC, r.run_id LIMIT 1")
    data = {"asv_id": asv_id, **sp,
            "value_declaration": {**semantics.value_declaration(_q, dataset_id, "the whole series, in sample order"),
                                  "applies_to": "amplitudes (input scale of the run)"}}
    return _envelope("asv_spectrum", q, {"dataset_id": dataset_id, "asv_id": asv_id}, data, sp["n"])


def asv_seasonality(dataset_id: str, asv_id: str) -> dict:
    _require_dataset(dataset_id)
    axis = semantics.time_axis(_q, dataset_id)
    rows = semantics.series(_q, dataset_id, asv_id)
    if not rows:
        raise ToolError(f"ASV {asv_id!r} not found in dataset {dataset_id!r}")

    present = [r for r in rows if (r["count"] or 0) > 0]
    summary = semantics.frequency(_q, dataset_id, rows, with_rank=True)["summary"]
    base = {
        "asv_id": asv_id,
        "time_axis": axis,
        "n_samples": len(rows),
        "n_samples_present": len(present),
        "quantity": semantics.quantity(_q, dataset_id),
        "max_sample": {"sample": summary["max_at"]["sample"], "date": summary["max_at"]["date"],
                       "index": summary["max_at"]["index"],
                       "value": summary["max_count"], "sample_total": summary["max_sample_total"],
                       "share": summary["max_share"], "rank": summary["max_rank"],
                       "rank_pool": summary["rank_pool"],
                       "chosen_by": "largest share of its sample (not the largest raw value)"},
        "statement": summary["statement"],
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
    _j, share_month = semantics.ym(base["max_sample"]["date"])

    base["seasonality"] = {
        "peak_month_single_sample": otter_month,
        "peak_month_single_sample_label": (semantics.MONTHS[otter_month - 1]
                                           if otter_month else None),
        "peak_month_max_share": share_month,
        "peak_month_max_share_label": semantics.MONTHS[share_month - 1] if share_month else None,
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
        "oscillation": semantics.share_oscillation(_q, dataset_id, rows),
    }
    base["note"] = (
        "There are THREE peak months and they can differ. 'peak_month_max_share' is the month of "
        "max_sample, the sample in which this ASV made up the largest share (the highest point "
        "of the interface's share curve). 'peak_month_single_sample' is OTTER's month of the "
        "sample with the "
        "largest RAW stored value (drawn on the seasonal wheel) — it depends on sequencing depth "
        "and can name another sample. 'peak_month_climatology' is the strongest month averaged "
        "over all years. A single sample is enough to set the first two. State which one you "
        "mean; do not claim there is only one. The TIMING is the defensible statement, not the "
        "height of the value.")
    return _envelope("asv_seasonality", "semantics.series + semantics.seasonal_stats",
                     {"dataset_id": dataset_id, "asv_id": asv_id}, base, len(rows))


def neighbors(dataset_id: str, asv_id: str, edge: EdgeArg = "con", direction: DirectionArg = "both",
              limit: LimitArg = 25) -> dict:
    _require_dataset(dataset_id)
    eigen = _require_asv(dataset_id, asv_id)
    edge = (edge or "con").lower()
    if edge not in ("con", "ccm"):
        raise ToolError("edge must be 'con' or 'ccm'")
    direction = (direction or "both").lower()
    if direction not in ("out", "in", "both"):
        raise ToolError("direction must be 'out', 'in' or 'both'")
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
    if eigen["cluster"] is None:
        out["network_note"] = NOT_IN_NETWORK_NOTE
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


def cluster_bridges(dataset_id: str, edge: EdgeArg = "con", include_edges: bool = False,
                    limit: LimitArg = 25) -> dict:
    _require_dataset(dataset_id)
    edge = (edge or "con").lower()
    if edge not in ("con", "ccm"):
        raise ToolError("edge must be 'con' or 'ccm'")
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
        out["bridges_completeness"] = {"n_returned": len(out["bridges"]), "n_total": n_total,
                                       "truncated": (n_total is not None
                                                     and len(out["bridges"]) < n_total)}
    out["cluster_caveat"] = semantics.cluster_partition_caveat(_q, dataset_id)
    return _envelope("cluster_bridges", q_pairs,
                     {"dataset_id": dataset_id, "edge": edge, "include_edges": include_edges,
                      "limit": limit}, out,
                     max(len(pairs), len(out.get("bridges") or [])))


def cluster_network(dataset_id: str) -> dict:
    _require_dataset(dataset_id)
    data = semantics.cluster_network(_run, dataset_id)
    data.setdefault("caveats", []).append(semantics.cluster_partition_caveat(_q, dataset_id))
    q = ("MATCH (a:ASV {dataset_id:$d})-[i:INFLUENCES {dataset_id:$d}]->(b:ASV {dataset_id:$d}) "
         "WITH i.from_clu AS von, i.to_clu AS nach, avg(i.nmi) AS mean_nmi, count(*) AS kanten "
         "RETURN von, nach, mean_nmi, kanten ORDER BY kanten DESC, von, nach")
    return _envelope("cluster_network", q, {"dataset_id": dataset_id}, data,
                     data["n_cluster_pairs"])


def cluster_interannual_variability(dataset_id: str, metric: MetricArg = "jaccard") -> dict:
    _require_dataset(dataset_id)
    if metric not in semantics.INTERANNUAL_METRICS:
        raise ToolError(f"metric must be one of {sorted(semantics.INTERANNUAL_METRICS)}, "
                        f"not {metric!r}.")
    data = semantics.interannual_variability(_run, dataset_id, metric)
    q = ("MATCH (s:Sample {dataset_id:$d})-[r:HAS_ABUNDANCE]->(a:ASV {dataset_id:$d}) "
         "WHERE a.louvain_label IS NOT NULL AND r.count > 0 "
         "RETURN s.sample_id AS sample, toString(s.date) AS date, a.louvain_label AS cluster, a.id AS asv, "
         "r.count AS count ORDER BY a.louvain_label, s.sample_id, a.id")
    data["value_declaration"] = semantics.value_declaration(
        _q, dataset_id, "pairwise between samples of different years, computed within samples")
    data["cluster_caveat"] = semantics.cluster_partition_caveat(_q, dataset_id)
    return _envelope("cluster_interannual_variability", q, {"dataset_id": dataset_id, "metric": metric},
                     data, len(data["clusters"]))


def cluster_year_overview(dataset_id: str, metric: MetricArg = "jaccard") -> dict:
    _require_dataset(dataset_id)
    if metric not in semantics.INTERANNUAL_METRICS:
        raise ToolError(f"metric must be one of {sorted(semantics.INTERANNUAL_METRICS)}, "
                        f"not {metric!r}.")
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
        raise ToolError(f"dataset {dataset_id!r} has no network (no modules).")
    return _envelope("cluster_timeseries", semantics.CLUSTER_TIMESERIES_QUERY, {"dataset_id": dataset_id},
                     data, len(data["samples"]))


def cluster_detail(dataset_id: str, cluster: int) -> dict:
    _require_dataset(dataset_id)
    kind = semantics.value_kind(_q, dataset_id)
    reads = kind == "reads"
    if reads:
        members = _run("""
        MATCH (a:ASV {dataset_id:$d}) WHERE a.louvain_label = $l
        OPTIONAL MATCH (a)<-[h:HAS_ABUNDANCE]-(:Sample {dataset_id:$d})
        WITH a, sum(h.count) AS summe, count(h) AS n_present
        RETURN a.id AS asv_id, a.genus AS genus, a.family AS family,
               summe AS read_count_total, n_present AS n_samples_present
        ORDER BY summe DESC, a.id
        """, d=dataset_id, l=cluster)
    else:
        members = _run("""
        MATCH (a:ASV {dataset_id:$d}) WHERE a.louvain_label = $l
        OPTIONAL MATCH (a)<-[h:HAS_ABUNDANCE]-(:Sample {dataset_id:$d})
        WITH a, count(h) AS n_present
        RETURN a.id AS asv_id, a.genus AS genus, a.family AS family,
               null AS read_count_total, n_present AS n_samples_present
        ORDER BY n_present DESC, a.id
        """, d=dataset_id, l=cluster)
    if not members:
        known = _run("MATCH (a:ASV {dataset_id:$d}) WHERE a.louvain_label IS NOT NULL "
                     "RETURN DISTINCT a.louvain_label AS l ORDER BY l", d=dataset_id)
        raise ToolError(f"no cluster {cluster} in {dataset_id!r}. "
                        f"Present: {[r['l'] for r in known]}")

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
        "largest_members_ordered_by": ORDERED_BY_READS if reads else _nach_nachweisen(kind),
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
        "connected_clusters_note": ("n_edges = co-occurrence (CON) links to that cluster: "
                                    "undirected correlations, not CCM links."),
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
        "criterion2": semantics.criterion2_module(semantics.criterion2(_q, dataset_id), cluster),
    }
    return _envelope("cluster_detail", "cluster_detail (Mitglieder + Zusammenhalt + Partner)",
                     {"dataset_id": dataset_id, "cluster": cluster}, out, len(members))


def taxa_composition(dataset_id: str, rank: RankArg = "genus", limit: TaxaLimitArg = 15,
                     network_only: bool = False) -> dict:
    _require_dataset(dataset_id)
    allowed = tuple(semantics.TAXONOMY_RANKS)
    rank = (rank or "genus").lower()
    if rank not in allowed:
        raise ToolError(f"rank must be one of {list(allowed)}")
    limit = max(1, min(int(limit), MAX_LIMIT_TAXA))
    net = "AND a.louvain_label IS NOT NULL" if network_only else ""
    kind = semantics.value_kind(_q, dataset_id)
    reads = kind == "reads"
    if reads:
        q = f"""
    MATCH (a:ASV {{dataset_id:$d}})
    WHERE a.{rank} IS NOT NULL {net}
    OPTIONAL MATCH (a)<-[h:HAS_ABUNDANCE]-(:Sample {{dataset_id:$d}})
    WITH a, sum(h.count) AS summe
    RETURN a.{rank} AS taxon, count(a) AS n_asv,
           sum(summe) AS read_count_total
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
        out["read_count_total_absent_reason"] = _ohne_summe(kind)
    return _envelope("taxa_composition", q, {"dataset_id": dataset_id, "rank": rank,
                                             "limit": limit, "network_only": network_only},
                     out, len(rows))


def summarize_by_taxon(dataset_id: str, rank: RankArg = "genus", name: str | None = None) -> dict:
    _require_dataset(dataset_id)
    allowed = tuple(semantics.TAXONOMY_RANKS)
    rank = (rank or "genus").lower()
    if rank not in allowed:
        raise ToolError(f"rank must be one of {list(allowed)}")
    name = name or None
    idx = allowed.index(rank)
    child_rank = allowed[idx + 1] if (name is not None and idx + 1 < len(allowed)) else None
    group = child_rank or rank
    where = f"coalesce(a.`{rank}`, 'unassigned') = $name" if name else "true"
    kind = semantics.value_kind(_q, dataset_id)
    reads = kind == "reads"
    summe = "sum(summe)" if reads else "null"

    q = f"""
    MATCH (a:ASV {{dataset_id:$d}}) WHERE {where}
    OPTIONAL MATCH (a)<-[h:HAS_ABUNDANCE]-(:Sample {{dataset_id:$d}})
    WITH a, sum(h.count) AS summe
    RETURN coalesce(a.`{group}`, 'unassigned') AS taxon, count(a) AS n_asv,
           {summe} AS read_count_total,
           collect(a.louvain_label) AS labels
    ORDER BY n_asv DESC, taxon
    """
    rows = _run(q, d=dataset_id, name=name)
    if name is not None and not rows:
        raise ToolError(f"no taxon {name!r} at rank {rank!r} in {dataset_id!r} — "
                        f"taxa_composition(rank={rank!r}) lists the known names")
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

    n_asv_total = sum(r["n_asv"] for r in benannt)
    out = {
        "statement": semantics.taxon_statement(rank, name, group, benannt, n_asv_total),
        "n_asv_total": n_asv_total,
        "rank": rank,
        "name": name,
        "grouped_by": group,
        "rows": benannt,
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
        out["read_count_total_absent_reason"] = _ohne_summe(kind)
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
    if env.get("sampler"):
        sp = env["sampler"]
        out["sampler"] = {k: sp[k] for k in ("statement", "n_within", "n_below", "n_unknown",
                                             "n_total", "note")}
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
_ADMIN_WORDS = re.compile(
    r"\b(SHOW|TERMINATE|ALTER|GRANT|DENY|REVOKE|START|STOP|USE|ENABLE|RENAME|DEALLOCATE|"
    r"REALLOCATE|INSERT)\b", re.IGNORECASE)
_ERSTE_KLAUSEL_RE = re.compile(r"(?:OPTIONAL\s+)?MATCH\b", re.IGNORECASE)
_LABEL_RE = re.compile(r":\s*([A-Za-z_][A-Za-z0-9_]*)")
_PROP_RE = re.compile(r"(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)")
_LIMIT_RE = re.compile(r"\bLIMIT\s+(\d+)", re.IGNORECASE)

NICHT_ABFRAGBAR = {"Star", "Reference"}

FREI_ABFRAGBAR = {"ASV", "Sample", "Dataset", "Cluster", "Run", "EnvVariable",
                  "EnvLinkRun", "Dada2Run"}

_NODE_RE = re.compile(
    r"(?<![A-Za-z0-9_.])\(\s*([A-Za-z_][A-Za-z0-9_]*)?\s*"
    r"((?::\s*[A-Za-z_][A-Za-z0-9_]*\s*)+)"
    r"(\{[^{}]*\})?\s*\)")
_ANON_NODE_RE = re.compile(
    r"(?<![A-Za-z0-9_.])\(\s*([A-Za-z_][A-Za-z0-9_]*)?\s*"
    r"(\{[^{}]*\})?\s*\)")
_NODE_START_RE = re.compile(r"(?<![A-Za-z0-9_.])\(\s*(?:[A-Za-z_][A-Za-z0-9_]*)?\s*:")
_NODE_WHERE_RE = re.compile(
    r"(?<![A-Za-z0-9_.])\(\s*[A-Za-z_][A-Za-z0-9_]*(?:\s*:\s*[A-Za-z_][A-Za-z0-9_]*)*\s*"
    r"(?:\{[^{}]*\})?\s*WHERE\b", re.IGNORECASE)
_STRING_LITERAL_RE = re.compile(r"'(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\"")
_KLAUSEL_RE = re.compile(
    r"\b(OPTIONAL\s+MATCH|MATCH|WHERE|RETURN|ORDER\s+BY|SKIP|LIMIT|UNWIND|WITH|UNION|CALL)\b",
    re.IGNORECASE)
_SCOPE_WORDS_RE = re.compile(r"\b(WITH|UNION|CALL)\b", re.IGNORECASE)
_STRING_OPS_RE = re.compile(r"\b(STARTS|ENDS)\s+WITH\b", re.IGNORECASE)
_VERBOTENE_FUNKTIONEN_RE = re.compile(r"\b(labels|keys)\s*\(", re.IGNORECASE)
_NAMENSRAUM_RE = re.compile(r"\b(apoc|db|dbms|gds|genai)\s*\.\s*[A-Za-z_][\w.]*\s*\(", re.IGNORECASE)
_VARLAENGE_RE = re.compile(r"-\s*\[[^\]]*\*[^\]]*\]|[->]\s*[+*{]")
_GRUPPE_RE = re.compile(r"\(\s*\(\s*(?:[A-Za-z_][A-Za-z0-9_]*)?\s*[:){]")
_KLEBT_RE = re.compile(
    r"\b(MATCH|WHERE|AND|OR|XOR|NOT|WHEN|THEN|ELSE|RETURN|SHORTEST|GROUPS?|PATHS?)\("
    r"|(?<![A-Za-z0-9_.])(\d+)\("
    r"|\b(ANY|ALL)\((?=\s*(?:[A-Za-z_][A-Za-z0-9_]*)?\s*[:){])",
    re.IGNORECASE)


def _ohne_zeichenketten(q: str) -> str:
    return _STRING_LITERAL_RE.sub(lambda m: m.group(0)[0] + "_" * (len(m.group(0)) - 2)
                                  + m.group(0)[-1], q)


_IS_LABEL_RE = re.compile(
    r"(?<=\()(\s*(?:[A-Za-z_][A-Za-z0-9_]*\s+)?)IS(?=\s+(?!(?:NOT|NULL|TYPED|NORMALIZED|NFC|NFD|"
    r"NFKC|NFKD)\b|::))", re.IGNORECASE)


def _is_als_doppelpunkt(text: str) -> str:
    return _IS_LABEL_RE.sub(lambda m: m.group(1) + ": ", text)


def _tiefen(text: str) -> tuple[list[int], list[int]]:
    alle, eckig, a, e = [], [], 0, 0
    for ch in text:
        alle.append(a)
        eckig.append(e)
        if ch in "([{":
            a += 1
            e += ch != "("
        elif ch in ")]}":
            a -= 1
            e -= ch != ")"
    return alle, eckig


def _bindung_pruefen(roh: str, text: str, dataset_id: str) -> "str | None":
    tief_alle, tief_eckig = _tiefen(text)
    klauseln = [(m.start(), " ".join(m.group(1).upper().split()))
                for m in _KLAUSEL_RE.finditer(text) if tief_alle[m.start()] == 0]

    def klausel(pos: int) -> "str | None":
        vor = [k for p, k in klauseln if p < pos]
        return vor[-1] if vor else None

    bindung = re.compile(r"\bdataset_id\s*:\s*(['\"])" + re.escape(dataset_id) + r"\1")

    m = _NODE_WHERE_RE.search(text)
    if m:
        return (f"a WHERE inside a node pattern is not allowed in free queries: "
                f"{text[m.start():m.end()][:40]!r}. Bind the node inline, e.g. "
                f"(a:ASV {{dataset_id:'{dataset_id}'}}), and filter in the WHERE clause.")
    for m in re.finditer(r"\b(?:OPTIONAL\s+)?MATCH\b", text, re.IGNORECASE):
        tiefe, ende = tief_alle[m.start()], len(text)
        for k in re.finditer(r"\b(WHERE|RETURN|MATCH|OPTIONAL|WITH|UNWIND|ORDER|SKIP|LIMIT|"
                             r"UNION|CALL)\b", text[m.end():], re.IGNORECASE):
            if tief_alle[m.end() + k.start()] == tiefe:
                ende = m.end() + k.start()
                break
        for i in range(m.end(), ende):
            if tief_alle[i] < tiefe:
                ende = i
                break
            if text[i] == "(" and not re.match(r"[A-Za-z0-9_.]", text[i - 1] if i else " ") \
                    and not (_NODE_RE.match(text, i) or _ANON_NODE_RE.match(text, i)):
                return (f"only plain node patterns are allowed in MATCH: "
                        f"{text[i:text.find(')', i) + 1][:40]!r}. Write (variable:Label "
                        f"{{dataset_id:'{dataset_id}'}}), nothing else inside the parentheses.")

    for m in _NODE_START_RE.finditer(text):
        if not _NODE_RE.match(text, m.start()):
            ende = text.find(")", m.start())
            return (f"label expressions are not allowed in free queries: "
                    f"{text[m.start():ende + 1 if ende > 0 else None][:40]!r}. Name exactly one "
                    f"plain Label per node, e.g. (a:ASV {{dataset_id:'{dataset_id}'}}).")

    muster = []
    for m in _NODE_RE.finditer(text):
        labels = [x.strip() for x in m.group(2).split(":") if x.strip()]
        props = roh[m.start(3):m.end(3)] if m.group(3) else ""
        muster.append((m.start(), m.group(1), labels, bool(props and bindung.search(props))))
    for m in _ANON_NODE_RE.finditer(text):
        muster.append((m.start(), m.group(1), [], False))

    fremd = sorted({lab for _, _, labs, _ in muster for lab in labs if lab not in FREI_ABFRAGBAR})
    if fremd:
        return (f"Label {fremd} cannot be read by free queries: only labels of the dataset chain "
                f"are allowed ({sorted(FREI_ABFRAGBAR)}).")

    gebunden = {var for pos, var, labs, selbst in muster
                if var and labs and selbst and klausel(pos) == "MATCH" and tief_eckig[pos] == 0}
    offen = []
    for pos, var, labs, selbst in sorted(muster):
        if labs and selbst:
            continue
        if var and var in gebunden:
            continue
        offen.append(f"({var or ''}{':' + ':'.join(labs) if labs else ''})")
    if offen:
        return (f"not scoped to the dataset: {', '.join(offen[:4])}"
                + (f" and {len(offen) - 4} more" if len(offen) > 4 else "")
                + ". EVERY node pattern needs a Label AND an inline dataset_id binding — "
                  "otherwise the query reads past the visibility boundary. Bind it like this: "
                  f"(b:ASV {{dataset_id:'{dataset_id}'}}). A WHERE condition does not bind. A "
                  "pattern without a Label, such as (b), is only allowed if the same variable "
                  "was bound with a Label in a MATCH of this query.")
    if not any(labs and selbst and klausel(pos) in ("MATCH", "OPTIONAL MATCH")
               and tief_eckig[pos] == 0 for pos, _v, labs, selbst in muster):
        return ("not scoped to the dataset: the query has no node pattern with a Label and an "
                f"inline dataset_id binding, e.g. MATCH (a:ASV {{dataset_id:'{dataset_id}'}}).")
    return None


def _limit_pruefen(roh: str, text: str) -> "tuple[str | None, str, int | None, int]":
    tief_alle, _ = _tiefen(text)
    oben = [m for m in re.finditer(r"\bLIMIT\b", text, re.IGNORECASE) if tief_alle[m.start()] == 0]
    if not oben:
        return None, f"{roh}\nLIMIT {MAX_LIMIT}", None, MAX_LIMIT
    letzte = oben[-1]
    zahl = re.fullmatch(r"LIMIT\s+(\d+)\s*", text[letzte.start():], re.IGNORECASE)
    if len(oben) > 1 or not zahl:
        return ("LIMIT must be one plain number at the very end of the query, e.g. LIMIT 50.",
                "", None, MAX_LIMIT)
    verlangt = int(zahl.group(1))
    if verlangt <= MAX_LIMIT:
        return None, roh, verlangt, verlangt
    return None, roh[:letzte.start()] + f"LIMIT {MAX_LIMIT}", verlangt, MAX_LIMIT


def _schema_auffrischen() -> None:
    global _schema_cache
    try:
        _schema_cache = live_schema()
    except Exception:
        pass


def pruefe_cypher(query: str, dataset_id: str) -> dict:
    aus = {"ok": False, "reason": "", "safe": "", "requested_limit": None, "applied_limit": None}

    def nein(grund: str) -> dict:
        return {**aus, "reason": grund}

    if not query or not query.strip():
        return nein("empty query")
    q = query.strip().rstrip(";").strip()
    text = _is_als_doppelpunkt(_ohne_zeichenketten(q))

    if ";" in text:
        return nein("multiple statements are not allowed")
    if "//" in text or "/*" in text:
        return nein("comments are not allowed in free queries")
    if "`" in text:
        return nein("backtick-quoted names are not allowed in free queries — write labels, "
                    "properties, variables and aliases as plain names (letters, digits, _).")
    m = re.search(r"[^\x00-\x7f]", text)
    if m:
        return nein(f"the character {m.group(0)!r} is not allowed outside a quoted string — "
                    "write names, dashes and arrows in plain ASCII.")

    m = _WRITE_WORDS.search(text)
    if m:
        return nein(f"only read-only queries are allowed — forbidden keyword {m.group(0)!r}")
    m = _ADMIN_WORDS.search(text)
    if m:
        return nein(f"administration commands are not allowed in free queries — forbidden "
                    f"keyword {m.group(1).upper()!r}. The word is reserved here, also as a "
                    f"variable or alias name; rename it.")
    if not _ERSTE_KLAUSEL_RE.match(text):
        return nein("a free query must start with MATCH or OPTIONAL MATCH, e.g. "
                    f"MATCH (a:ASV {{dataset_id:'{dataset_id}'}}) RETURN a.id LIMIT 10")

    gesperrt = sorted({w for w in NICHT_ABFRAGBAR if re.search(rf"\b{w}\b", q)})
    if gesperrt:
        return nein(f"{gesperrt[0]!r} is blocked for free queries: the node is not part of the "
                    f"dataset chain and is therefore not covered by the visibility boundary. "
                    f"Blocked: {sorted(NICHT_ABFRAGBAR)}.")
    m = _VERBOTENE_FUNKTIONEN_RE.search(text)
    if m:
        return nein(f"{m.group(1)}() is not allowed in free queries — it reports labels or keys "
                    "of nodes instead of data; ask with get_schema instead.")
    m = _NAMENSRAUM_RE.search(text)
    if m:
        return nein(f"procedures and namespaced functions ({m.group(1)}.…) are not allowed in "
                    "free queries.")
    if _VARLAENGE_RE.search(text):
        return nein("variable-length paths and quantified relationships (`*`, `+`, `{1,3}`) "
                    "are not allowed in free queries — name each relationship.")
    if _GRUPPE_RE.search(text):
        return nein("parenthesised path patterns such as ((a)-[r]->(b)) are not allowed in free "
                    "queries — write the path once, every node with its own binding.")
    m = _KLEBT_RE.search(text)
    if m:
        wort = next(g for g in m.groups() if g)
        return nein(f"write a space between {wort!r} and '(' — the check reads a name directly "
                    "followed by '(' as a function call.")

    for runde in (0, 1):
        sch = schema()
        known_labels = set(sch["labels"])
        known_rels = set(sch["relationship_types"])
        known_props = set(sch["property_keys"])
        unbekannt_lab = [lab for lab in _LABEL_RE.findall(text) if lab not in (known_labels | known_rels)]
        unbekannt_prop = [p for _v, p in _PROP_RE.findall(text) if p not in known_props]
        if not (unbekannt_lab or unbekannt_prop) or runde == 1:
            break
        _schema_auffrischen()
    if unbekannt_lab:
        return nein(f"unknown Label/relationship type {unbekannt_lab[0]!r}. "
                    f"Labels: {sorted(known_labels)}; relationships: {sorted(known_rels)}")
    if unbekannt_prop:
        return nein(f"unknown property {unbekannt_prop[0]!r}. Known properties: {sorted(known_props)}")

    literals = [(m.group(1), q[m.start(2):m.end(2)]) for m in _DATASET_LITERAL_RE.finditer(text)]
    mentions = len(_DATASET_TOKEN_RE.findall(text))
    if mentions == 0:
        return nein("the query must be scoped to a dataset: 'dataset_id' is missing. "
                    f"Example: MATCH (a:ASV {{dataset_id:'{dataset_id}'}}) RETURN a.id LIMIT 10")
    if len(literals) != mentions:
        return nein("every 'dataset_id' must be set directly to a text literal, so that "
                    f"the scope can be checked. Allowed: dataset_id:'{dataset_id}' in the node "
                    "pattern. Not allowed: parameters, comparison with a variable, STARTS WITH.")
    fremd = sorted({v for _q0, v in literals if v != dataset_id})
    if fremd:
        return nein(f"the query reads {fremd}, but only {dataset_id!r} is authorised. "
                    "A query may only read the dataset it was asked for.")
    grund = _bindung_pruefen(q, text, dataset_id)
    if grund:
        return nein(grund)
    m = _SCOPE_WORDS_RE.search(_STRING_OPS_RE.sub(" ", text))
    if m:
        return nein(f"{m.group(1).upper()} is not allowed in free queries: it opens a new scope "
                    "in which a variable can be re-bound to ANY node, and that cannot be checked "
                    "here. Write one MATCH … RETURN query; the typed tools cover aggregations "
                    "over several stages.")

    grund, safe, verlangt, angewandt = _limit_pruefen(q, text)
    if grund:
        return nein(grund)
    return {"ok": True, "reason": "ok", "safe": safe,
            "requested_limit": verlangt, "applied_limit": angewandt}


def validate_cypher(query: str, dataset_id: str) -> tuple[bool, str, str]:
    r = pruefe_cypher(query, dataset_id)
    return r["ok"], r["reason"], r["safe"]


def run_validated_cypher(dataset_id: str, query: str) -> dict:
    _require_dataset(dataset_id)
    geprueft = pruefe_cypher(query, dataset_id)
    if not geprueft["ok"]:
        raise ToolError(f"query rejected: {geprueft['reason']}")
    safe = geprueft["safe"]
    grenze = _ZEITGRENZE.set(FREE_QUERY_TIMEOUT_S)
    try:
        rows = _run(safe)
    except Neo4jError as e:
        if "AccessMode" in (e.code or ""):
            raise ToolError(
                "The database rejected this query as a write (read-only mode). "
                "This is a BUG: the validator should have rejected it first. "
                "Please report it. Only read-only queries are possible here.") from e
        if "TransactionTimedOut" in (e.code or "") or "Timeout" in (e.code or ""):
            raise ToolError(
                f"The query ran longer than {FREE_QUERY_TIMEOUT_S:g} s and was stopped by the "
                "database. Narrow it (fewer patterns, no product of unrelated MATCHes) or use "
                "a typed tool.") from e
        raise ToolError(f"The database rejected the query: {e.message} "
                        f"({e.code}). Rephrase it; get_schema lists the valid "
                        f"names.") from e
    finally:
        _ZEITGRENZE.reset(grenze)
    deklaration = {
        **semantics.value_declaration(
            _q, dataset_id,
            "as stored on this dataset — any count-derived value in these rows is of this kind"),
        "applies_to": "every value derived from HAS_ABUNDANCE.count in the returned rows",
    }
    env = _envelope("run_validated_cypher", safe,
                    {"dataset_id": dataset_id, "limit": geprueft["applied_limit"]}, rows, len(rows))
    env["provenance"]["validated"] = True
    env["provenance"]["original_query"] = " ".join(query.split())
    if geprueft["requested_limit"] != geprueft["applied_limit"]:
        env["provenance"]["limit_applied"] = {"requested": geprueft["requested_limit"],
                                              "applied": geprueft["applied_limit"]}
    env["value_declaration"] = deklaration
    return env


def get_schema() -> dict:
    global _schema_cache
    sch = live_schema()
    _schema_cache = sch
    return _envelope("get_schema", "CALL db.labels() / db.relationshipTypes() / db.propertyKeys()",
                     {}, sch, len(sch["labels"]))



def _stat_subject(dataset_id: str, asv_id: str | None, cluster: int | None) -> tuple[list[dict], dict]:
    if (asv_id is None) == (cluster is None):
        raise ToolError("give exactly one of asv_id or cluster")
    if asv_id is not None:
        rows = semantics.series(_q, dataset_id, asv_id)
        if not rows or not any((r["count"] or 0) > 0 for r in rows):
            raise ToolError(f"ASV {asv_id!r} not found in dataset {dataset_id!r}, or never detected")
        return rows, {"asv_id": asv_id}
    rows = semantics.cluster_series(_q, dataset_id, int(cluster))
    if not rows or not any((r["sum_count"] or 0) > 0 for r in rows):
        raise ToolError(f"cluster {cluster!r} not found in dataset {dataset_id!r}, or empty")
    return rows, {"cluster": int(cluster)}


def _stat_caveats(dataset_id: str) -> list[str]:
    c = [statistik.CAVEAT_NOT_NETWORK, statistik.CAVEAT_INDEPENDENCE, statistik.CAVEAT_COMPOSITIONAL]
    if semantics.value_kind(_q, dataset_id) == "transformed":
        c.append(statistik.CAVEAT_TRANSFORMED)
    return c


_NO_DATES = semantics.NO_DATES


_REQUIRES: dict[str, list[str]] = {
    "seasonality_test": ["time_axis=dates"],
    "trend_test": ["time_axis=dates"],
    "group_comparison_test": ["time_axis=dates"],
    "pair_proportionality": ["value_kind=reads"],
    "environment_correlation": ["env_variables"],
}


def _requires(name: str) -> list[str]:
    return _REQUIRES.get(name, [])


def seasonality_test(dataset_id: str, asv_id: str | None = None, cluster: int | None = None) -> dict:
    _require_dataset(dataset_id)
    rows, subject = _stat_subject(dataset_id, asv_id, cluster)
    params = {"dataset_id": dataset_id, **subject}
    ok, grund = anwendbarkeit.pruefen(_q, dataset_id, _requires("seasonality_test"))
    if not ok:
        return _envelope("seasonality_test", "semantics.series (ordinal)", params,
                         {**subject, "result": None, "note": grund}, len(rows))
    data = {**subject, "quantity": "share", "result": statistik.seasonality_test(rows, "share"),
            "caveats": _stat_caveats(dataset_id)}
    return _envelope("seasonality_test", "semantics.series + statistik.seasonality_test",
                     params, data, len(rows))


def trend_test(dataset_id: str, asv_id: str | None = None, cluster: int | None = None) -> dict:
    _require_dataset(dataset_id)
    rows, subject = _stat_subject(dataset_id, asv_id, cluster)
    params = {"dataset_id": dataset_id, **subject}
    ok, grund = anwendbarkeit.pruefen(_q, dataset_id, _requires("trend_test"))
    if not ok:
        return _envelope("trend_test", "semantics.series (ordinal)", params,
                         {**subject, "result": None, "note": grund}, len(rows))
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

    ok, grund = anwendbarkeit.pruefen(_q, dataset_id, _requires("pair_proportionality"))
    if not ok:
        data = {"asv_a": asv_a, "asv_b": asv_b, "result": None,
                "absent_reason": grund,
                "con_link": con_link, "caveats": _stat_caveats(dataset_id)}
        return _envelope("pair_proportionality", "semantics.series x2 (refused: transformed)",
                         {"dataset_id": dataset_id, "asv_a": asv_a, "asv_b": asv_b},
                         data, len(ra))

    b_count = {r["sample"]: r["count"] for r in rb}
    b_share = {r["sample"]: r["share"] for r in rb}
    roh = statistik.proportionality([r["count"] for r in ra],
                                    [b_count.get(r["sample"]) for r in ra])
    anteil = statistik.proportionality([r["share"] for r in ra],
                                       [b_share.get(r["sample"]) for r in ra])
    data = {"asv_a": asv_a, "asv_b": asv_b,
            "result": {**anteil, "on": "share (stored value / sample total)",
                       "rho_p_on_share": anteil["rho_p"],
                       "rho_p_on_raw_counts": roh["rho_p"],
                       "scale_note": statistik.CAVEAT_PROPORTIONALITY_SCALE},
            "con_link": con_link,
            "caveats": _stat_caveats(dataset_id)}
    return _envelope("pair_proportionality", "semantics.series x2 + statistik.proportionality",
                     {"dataset_id": dataset_id, "asv_a": asv_a, "asv_b": asv_b}, data, len(ra))


def group_comparison_test(dataset_id: str, by: ByArg, group_a: list[int], group_b: list[int],
                          asv_id: str | None = None, cluster: int | None = None) -> dict:
    _require_dataset(dataset_id)
    rows, subject = _stat_subject(dataset_id, asv_id, cluster)
    params = {"dataset_id": dataset_id, **subject, "by": by, "group_a": list(group_a), "group_b": list(group_b)}
    ok, grund = anwendbarkeit.pruefen(_q, dataset_id, _requires("group_comparison_test"))
    if not ok:
        return _envelope("group_comparison_test", "semantics.series (ordinal)", params,
                         {**subject, "result": None, "note": grund}, len(rows))
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
        raise ToolError(f"ASV {asv_id!r} not found in dataset {dataset_id!r}")
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
        raise ToolError(f"no cluster {cluster} in {dataset_id!r}. "
                        f"Present: {[r['l'] for r in known]}")
    q = ("MATCH (v:EnvVariable {dataset_id:$d})-[c:COVARIES_WITH {dataset_id:$d}]->(a:ASV {dataset_id:$d}) "
         "WHERE a.louvain_label = $l RETURN v.name, count(a), avg(c.r), collect(a.id) ORDER BY count(a) DESC, v.name")
    data = {"cluster": cluster, "cluster_display": semantics.module_label(_q, dataset_id, cluster)["display"],
            **ce, "caveats": _stat_caveats(dataset_id) + [semantics.ENV_LINK_NOTE]}
    if not ce.get("run", {}).get("available", True):
        data["absent_reason"] = ce["run"]["absent_reason"]
    return _envelope("cluster_env_links", q, {"dataset_id": dataset_id, "cluster": cluster}, data, len(ce["links"]))


def environment_correlation(dataset_id: str, asv_id: str, variable: str) -> dict:
    _require_dataset(dataset_id)
    if variable not in semantics.ENVIRONMENT_KEYS:
        raise ToolError(f"unknown variable {variable!r}. Known: {semantics.ENVIRONMENT_KEYS}")
    params = {"dataset_id": dataset_id, "asv_id": asv_id, "variable": variable}
    rows, _ = _stat_subject(dataset_id, asv_id, None)
    ok, grund = anwendbarkeit.pruefen(_q, dataset_id, _requires("environment_correlation"))
    if ok:
        gemessen = _run(f"MATCH (s:Sample {{dataset_id:$d}}) WHERE s.`{variable}` IS NOT NULL "
                        f"RETURN count(s) AS n", d=dataset_id)
        if not (gemessen and gemessen[0]["n"]):
            ok, grund = False, semantics.env_variable_not_measured(variable)
    if not ok:
        return _envelope("environment_correlation", "Sample env (refused)", params,
                         {"asv_id": asv_id, "variable": {"key": variable}, "result": None,
                          "note": grund}, 0)
    var = next(v for v in semantics.environment_vars(_q, dataset_id) if v["key"] == variable)
    env_rows = _run(f"MATCH (s:Sample {{dataset_id:$d}}) RETURN s.sample_id AS sample, "
                    f"s.`{var['key']}` AS v ORDER BY s.date, s.same_day_index, s.ordinal_index, s.sample_id", d=dataset_id)
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



def describe_concepts(kind: KindArg = None) -> dict:
    try:
        eintraege = begriffe.alle(kind)
    except ValueError as e:
        raise ToolError(str(e)) from e
    eintraege = [{**b, "kind": begriffe.KIND_NAMES[b["kind"]]} for b in eintraege]
    data = {"concepts_version": begriffe.VERSION, "kind": kind,
            "kinds": list(begriffe.KIND_NAMES.values()),
            "n": len(eintraege), "concepts": eintraege}
    if begriffe.TERMS_NOTE:
        data["note"] = begriffe.TERMS_NOTE
    return _envelope("describe_concepts", "concepts.all (no database query)",
                     {"kind": kind}, data, len(eintraege))


def describe_metric(key: str) -> dict:
    b = begriffe.eines(key)
    if b is None:
        raise ToolError(f"unknown concept {key!r}. Use describe_concepts to see all "
                        f"{len(begriffe.BEGRIFFE)} of them.")
    data = {"concepts_version": begriffe.VERSION, **b, "kind": begriffe.KIND_NAMES[b["kind"]]}
    if b["kind"] != "kennzahl":
        art = begriffe.KIND_NAMES[b["kind"]].replace("_", " ")
        was = ("a measured quantity: it has a unit but no formula"
               if b["kind"] == "umweltgroesse" else "it has no formula and no unit")
        data["note"] = (f"This is {'an' if art[0] in 'aeiou' else 'a'} {art}, not a metric — "
                        f"{was}. The definition below is the whole answer.")
    return _envelope("describe_metric", "concepts.one (no database query)", {"key": key},
                     data, 1)


def dataset_capabilities(dataset_id: str) -> dict:
    _require_dataset(dataset_id)
    import registry as _registry
    app = anwendbarkeit.applicability(_q, dataset_id, _registry.TOOL_SPECS)
    zeit = anwendbarkeit.zeitstruktur(_q, dataset_id)
    bedingungen = {}
    for name, pruefer in sorted(anwendbarkeit.BEDINGUNGEN.items()):
        ok, grund = pruefer(_q, dataset_id)
        bedingungen[name] = {"met": ok, "reason": grund}
    data = {"dataset_id": dataset_id, "conditions": bedingungen, "time_structure": zeit,
            "tools": app,
            "n_applicable": sum(1 for v in app.values() if v["applicable"] != anwendbarkeit.NEIN),
            "n_tools": len(app)}
    return _envelope("dataset_capabilities", "applicability matrix + time structure",
                     {"dataset_id": dataset_id}, data, len(app))
