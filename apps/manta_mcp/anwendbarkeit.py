from __future__ import annotations

import semantics
import statistik


JA = "yes"
NEIN = "no"
SUBJEKT = "subject"


def _dates(q, d):
    ok = semantics.time_axis(q, d) == semantics.TIME_AXIS_DATES
    return ok, None if ok else semantics.NO_DATES


def _dates_jahre(q, d):
    ok = semantics.time_axis(q, d) == semantics.TIME_AXIS_DATES
    return ok, None if ok else semantics.INTERANNUAL_NO_DATES


def _reads(q, d):
    ok = semantics.value_kind(q, d) == "reads"
    return ok, None if ok else statistik.REFUSE_PROPORTIONALITY_TRANSFORMED


def _env_links(q, d):
    run = semantics.env_link_run(q, d)
    return bool(run["available"]), None if run["available"] else run["absent_reason"]


def _traits(q, d):
    run = semantics.trait_run(q, d)
    return bool(run["available"]), None if run["available"] else run["absent_reason"]


def _env_variables(q, d):
    rows = q("MATCH (s:Sample {dataset_id:$d}) WHERE any(k IN $keys WHERE s[k] IS NOT NULL) "
             "RETURN count(s) AS n", d=d, keys=semantics.ENVIRONMENT_KEYS)
    n = rows[0]["n"] if rows else 0
    return n > 0, None if n else semantics.ENV_NOT_MEASURED


def _network(q, d):
    rows = q("MATCH (a:ASV {dataset_id:$d}) WHERE a.louvain_label IS NOT NULL "
             "RETURN count(a) AS n", d=d)
    n = rows[0]["n"] if rows else 0
    return n > 0, None if n else (
        "No ASV of this dataset is in a network run, so there are no clusters, no links and no "
        "centralities to report.")


def _spectrum(q, d):
    rows = q("MATCH (a:ASV {dataset_id:$d}) WHERE a.fft_amplitudes IS NOT NULL "
             "RETURN count(a) AS n", d=d)
    n = rows[0]["n"] if rows else 0
    return n > 0, None if n else semantics.SPECTRUM_ABSENT_NO_TABLE


def _station(q, d):
    grund = semantics.station_absent_reason(q, d)
    return grund is None, grund


BEDINGUNGEN = {
    "time_axis=dates": _dates,
    "time_axis=dates/years": _dates_jahre,
    "value_kind=reads": _reads,
    "env_links": _env_links,
    "env_variables": _env_variables,
    "traits": _traits,
    "network": _network,
    "spectrum": _spectrum,
    "station": _station,
}

SUBJEKTABHAENGIG = {
    "seasonality_test": f"needs at least two calendar months with {statistik.MIN_PER_GROUP} "
                        f"detections of THIS subject (months with fewer than "
                        f"{statistik.MIN_PER_GROUP} samples are left out)",
    "trend_test": f"needs at least {statistik.MIN_SERIES} samples with a detection of THIS subject",
    "pair_proportionality": f"needs at least {statistik.MIN_PER_GROUP + 1} samples in which "
                            f"BOTH ASVs were detected",
    "group_comparison_test": f"needs at least {statistik.MIN_PER_GROUP} detections of THIS "
                             f"subject in each of the two groups",
    "environment_correlation": f"needs at least {statistik.MIN_SERIES} samples with both a "
                               f"detection and a measurement",
}


def pruefen(q, dataset_id: str, requires) -> tuple[bool, "str | None"]:
    for name in requires or ():
        pruefer = BEDINGUNGEN.get(name)
        if pruefer is None:
            raise ValueError(f"unknown requirement {name!r}. Known: {sorted(BEDINGUNGEN)}")
        ok, grund = pruefer(q, dataset_id)
        if not ok:
            return False, grund
    return True, None


def zeitstruktur(q, dataset_id: str) -> dict:
    axis = semantics.time_axis(q, dataset_id)
    rows = q("MATCH (s:Sample {dataset_id:$d}) RETURN count(s) AS n", d=dataset_id)
    n = rows[0]["n"] if rows else 0
    if axis != semantics.TIME_AXIS_DATES:
        return {"time_axis": axis, "n_samples": n, "first": None, "last": None,
                "median_gap_days": None, "largest_gap_days": None, "years": [],
                "sample_dates": [], "note": semantics.NO_DATES}
    tage = [r["d"] for r in q(
        "MATCH (s:Sample {dataset_id:$d}) WHERE s.date IS NOT NULL "
        "RETURN toString(s.date) AS d ORDER BY d", d=dataset_id)]
    import datetime as _dt
    ds = sorted({_dt.date.fromisoformat(x) for x in tage})
    luecken = sorted((ds[i + 1] - ds[i]).days for i in range(len(ds) - 1))
    median = (luecken[len(luecken) // 2] if len(luecken) % 2
              else (luecken[len(luecken) // 2 - 1] + luecken[len(luecken) // 2]) / 2) if luecken else None
    jahre: dict[str, int] = {}
    for x in tage:
        jahre[x[:4]] = jahre.get(x[:4], 0) + 1
    return {"time_axis": axis, "n_samples": n,
            "first": tage[0] if tage else None, "last": tage[-1] if tage else None,
            "n_distinct_days": len(ds),
            "median_gap_days": median, "largest_gap_days": luecken[-1] if luecken else None,
            "years": [{"year": y, "n_samples": c} for y, c in sorted(jahre.items())],
            "sample_dates": tage,
            "note": None}


def applicability(q, dataset_id: str, specs) -> dict:
    aus = {}
    for spec in specs:
        req = spec.get("requires") or []
        ok, grund = pruefen(q, dataset_id, req)
        subjekt = SUBJEKTABHAENGIG.get(spec["name"])
        aus[spec["name"]] = {
            "applicable": (JA if not subjekt else SUBJEKT) if ok else NEIN,
            "reason": grund,
            "requires": list(req),
            "subject_condition": subjekt if ok else None,
        }
    return aus
