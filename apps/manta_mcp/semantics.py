from __future__ import annotations

import math
import re
import statistics
from typing import Callable

TIME_AXIS_DATES = "dates"
TIME_AXIS_ORDINAL = "ordinal"
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

Runner = Callable[..., list[dict]]

SOURCE_PUBLICATION = "Oldenburg et al. 2024, Beyond blooms, Commun Earth Environ 5:643"
SOURCE_PUBLICATION_DOI = "10.1038/s43247-024-01782-0"


def ym(date_str):
    if not date_str or len(date_str) < 7:
        return None, None
    try:
        return date_str[:4], int(date_str[5:7])
    except (ValueError, TypeError):
        return None, None



def value_kind(q: Runner, dataset_id: str) -> str:
    rows = q("MATCH (d:Dataset {dataset_id:$d}) RETURN d.value_kind AS vk", d=dataset_id)
    return (rows[0]["vk"] if rows and rows[0]["vk"] else "unknown")


def time_axis(q: Runner, dataset_id: str) -> str:
    rows = q("MATCH (d:Dataset {dataset_id:$d}) RETURN d.time_axis AS ta", d=dataset_id)
    return rows[0]["ta"] if rows and rows[0]["ta"] == TIME_AXIS_DATES else TIME_AXIS_ORDINAL


def quantity(q: Runner, dataset_id: str) -> dict:
    kind = value_kind(q, dataset_id)
    n_asv = q("MATCH (a:ASV {dataset_id:$d}) RETURN count(a) AS n", d=dataset_id)
    n = n_asv[0]["n"] if n_asv else 0
    out_min = None
    if kind == "transformed":
        r = q("MATCH (:Sample {dataset_id:$d})-[r:HAS_ABUNDANCE]->() RETURN min(r.count) AS m", d=dataset_id)
        out_min = r[0]["m"] if r else None
    basis = ("the analysed reads of one sample" if kind == "reads"
             else "the analysed values of one sample")
    return {
        "value_kind": kind,
        "min_value": out_min,
        "basis": basis,
        "unit": f"share of {basis}",
        "denominator": f"sum over the {n} analysed ASVs of this sample",
        "numerator": ("number of sequencing reads of this ASV (DADA2)" if kind == "reads"
                      else "undocumented preprocessing, not raw reads"),
        "frame": "within one sample",
        "share_caveat": "A share going up does not mean there was more of it",
        "not": "not a cell count, not biomass, not comparable between datasets",
    }


def _ganzzahl(v) -> str:
    return f"{int(v):,}" if float(v).is_integer() else f"{v:,}"


def trio_statement(summary: dict, qty: dict) -> str:
    pool = summary.get("rank_pool")
    teile = []
    if summary.get("max_rank") is not None and pool:
        satz = f"rank {summary['max_rank']} of {pool} in its largest sample"
        med = summary.get("median_rank_when_detected")
        if med is not None:
            med_txt = str(int(med)) if float(med).is_integer() else f"{med:.1f}"
            satz += f" (usually {med_txt} of {pool})"
        teile.append(satz)
    else:
        teile.append("no rank — not detected in any sample")
    teile.append(f"detected in {summary.get('n_detected')} of {summary.get('n_samples')} samples")
    if qty.get("value_kind") == "transformed":
        teile.append("no relative abundance — this dataset's values are a transform of unknown form")
    elif (summary.get("max_share") is not None and summary.get("max_count") is not None
          and summary.get("max_sample_total")):
        teile.append(f"{100 * summary['max_share']:.1f} % of {qty['basis']} "
                     f"({_ganzzahl(summary['max_count'])} / {_ganzzahl(summary['max_sample_total'])}, "
                     f"over {pool} ASVs)")
    else:
        teile.append("no share — not detected in any sample")
    return " · ".join(teile)


def value_declaration(q: Runner, dataset_id: str, frame: str) -> dict:
    kind = value_kind(q, dataset_id)
    return {
        "value_kind": kind,
        "unit": "reads" if kind == "reads" else "unknown transform of reads",
        "frame": frame,
    }


def frame_summed(q: Runner, dataset_id: str) -> str:
    rows = q("MATCH (s:Sample {dataset_id:$d}) RETURN count(s) AS n", d=dataset_id)
    n = rows[0]["n"] if rows else 0
    return f"summed over {n} samples of this dataset"


def series(q: Runner, dataset_id: str, asv_id: str) -> list[dict]:
    rows = q(
        """
        MATCH (s:Sample {dataset_id:$d})
        OPTIONAL MATCH (s)-[own:HAS_ABUNDANCE]->(:ASV {id:$id, dataset_id:$d})
        WITH s, coalesce(own.count, 0.0) AS own_count
        OPTIONAL MATCH (s)-[ha:HAS_ABUNDANCE]->(:ASV {dataset_id:$d})
        WITH s, own_count, coalesce(sum(ha.count), 0.0) AS live_total,
             count(ha) AS n_present,
             sum(CASE WHEN ha.count > own_count THEN 1 ELSE 0 END) AS n_greater
        RETURN s.sample_id AS sample, s.date AS date, own_count AS count,
               coalesce(s.analysed_reads_total, live_total) AS sample_total,
               n_present AS n_present, n_greater AS n_greater
        ORDER BY s.date, s.sample_id
        """,
        d=dataset_id, id=asv_id,
    )
    for r in rows:
        tot = r["sample_total"] or 0.0
        r["share"] = (r["count"] / tot) if tot > 0 else None
        r["rank"] = (r.pop("n_greater") + 1) if r["count"] > 0 else None
    return rows



def seasonal_stats(rows, key):
    per_month: dict[int, list[float]] = {}
    per_year: dict[str, list[tuple[int, float]]] = {}
    for row in rows:
        year, month = ym(row["date"])
        val = row.get(key)
        if month is None or val is None:
            continue
        per_month.setdefault(month, []).append(val)
        per_year.setdefault(year, []).append((month, val))

    month_year: dict[int, dict[str, list[float]]] = {}
    for y, pairs in per_year.items():
        for m, v in pairs:
            month_year.setdefault(m, {}).setdefault(y, []).append(v)

    climatology = []
    for m in range(1, 13):
        vals = per_month.get(m, [])
        ymeans = [sum(v) / len(v) for v in month_year.get(m, {}).values()]
        mean = (sum(vals) / len(vals)) if vals else None
        std = statistics.pstdev(ymeans) if len(ymeans) > 1 else 0.0
        band = mean is not None and len(ymeans) > 1
        climatology.append({
            "month": m, "label": MONTHS[m - 1],
            "mean": mean,
            "std": std,
            "lo": max(0.0, mean - std) if band else None,
            "hi": (mean + std) if band else None,
            "lo_clipped": bool(band and mean - std < 0.0),
            "n": len(vals),
            "n_years": len(ymeans),
        })
    climo_mean = {m: sum(v) / len(v) for m, v in per_month.items()}

    years = []
    for y, pairs in sorted(per_year.items()):
        vals = [v for _, v in pairs]
        months = sorted({m for m, _ in pairs})
        years.append({
            "year": y, "n": len(vals), "months_covered": len(months), "months": months,
            "note": (f"incomplete: {len(months)} of 12 months sampled"
                     if len(months) < 12 else None),
            "mean": sum(vals) / len(vals),
            "std": statistics.pstdev(vals) if len(vals) > 1 else 0.0,
            "anomaly": sum(v - climo_mean[m] for m, v in pairs) / len(pairs),
            "by_month": [{"month": m, "label": MONTHS[m - 1],
                          "mean": sum(x for mm, x in pairs if mm == m) / sum(1 for mm, _ in pairs if mm == m)}
                         for m in months],
        })

    def _slope(xs, ys):
        if len(xs) < 2:
            return None
        mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
        den = sum((x - mx) ** 2 for x in xs) or 1.0
        return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den

    full = [y for y in years if y["months_covered"] == 12]
    return {
        "climatology": climatology,
        "years": years,
        "peak_window": peak_window(rows, key),
        "trend_per_year": _slope([int(y["year"]) for y in years], [y["anomaly"] for y in years]),
        "trend_method": "seasonal anomaly (value minus the climatology of its calendar month)",
        "full_years": [y["year"] for y in full],
        "partial_years": [y["year"] for y in years if y["months_covered"] < 12],
    }


def sample_years(q: Runner, dataset_id: str) -> list[dict]:
    rows = q("MATCH (s:Sample {dataset_id:$d}) RETURN s.date AS date "
             "ORDER BY s.date, s.sample_id", d=dataset_id)
    months: dict[str, set] = {}
    counts: dict[str, int] = {}
    for r in rows:
        y, m = ym(r["date"])
        if m is None:
            continue
        months.setdefault(y, set()).add(m)
        counts[y] = counts.get(y, 0) + 1
    return [{"year": y, "n": counts[y], "months_covered": len(ms),
             "note": (f"incomplete: {len(ms)} of 12 months sampled" if len(ms) < 12 else None)}
            for y, ms in sorted(months.items())]


PEAK_WINDOW_DAYS = 30
PEAK_WINDOW_DEFINITION = (
    "For each year with a detection, the date of this series' largest value; then the 30-day "
    "window of the calendar (wrapping over the year end) that holds the most of those peak dates. "
    "'n of m years' = how many of the years that sampled inside that window at all peaked inside it.")
PEAK_WINDOW_REFERENCE = (
    "Priest et al. 2025, Nat Commun 16:1326 (doi:10.1038/s41467-025-56203-3) report that 51 % of "
    "prokaryotic ASVs reached their peak within the same 30-day window each year. Named as the "
    "origin of the question; not a result of this dataset.")
PEAK_WINDOW_NOTE = (
    "The TIMING of a maximum survives any order-preserving rescaling of the values; its height does "
    "not — so this count holds also where the value kind is unknown. Pure counting on stored values.")


_MONTH_DAYS = (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
_CUM_DAYS = [0]
for _d in _MONTH_DAYS:
    _CUM_DAYS.append(_CUM_DAYS[-1] + _d)


def _doy(date_str: str) -> "int | None":
    year, month = ym(date_str)
    if year is None or len(date_str) < 10:
        return None
    try:
        day = int(date_str[8:10])
    except ValueError:
        return None
    return _CUM_DAYS[month - 1] + day


def _doy_label(doy: int) -> str:
    m = max(i for i in range(12) if _CUM_DAYS[i] < doy)
    return f"{MONTHS[m]} {doy - _CUM_DAYS[m]}"


def peak_window(rows, key, window_days: int = PEAK_WINDOW_DAYS) -> dict:
    per_year: dict[str, list[tuple[int, float, str]]] = {}
    for row in rows:
        year, _ = ym(row.get("date"))
        val = row.get(key)
        doy = _doy(row.get("date") or "")
        if year is None or doy is None or val is None:
            continue
        per_year.setdefault(year, []).append((doy, val, row["date"]))
    years = []
    for y in sorted(per_year):
        pts = per_year[y]
        detected = [p for p in pts if p[1] > 0]
        if not detected:
            years.append({"year": y, "peak_date": None, "peak_doy": None, "detected": False,
                          "covers_window": False, "in_window": False})
            continue
        best = max(detected, key=lambda p: (p[1], -p[0]))
        years.append({"year": y, "peak_date": best[2], "peak_doy": best[0], "detected": True,
                      "covers_window": False, "in_window": False, "_doys": sorted({p[0] for p in pts})})

    def _inside(doy: int, start: int) -> bool:
        return ((doy - start) % 365) < window_days

    peaks = [yy for yy in years if yy["detected"]]
    best_start, best_n = None, -1
    for cand in sorted({yy["peak_doy"] for yy in peaks}):
        n = sum(1 for yy in peaks if _inside(yy["peak_doy"], cand))
        if n > best_n:
            best_start, best_n = cand, n
    for yy in years:
        doys = yy.pop("_doys", [])
        if best_start is not None and yy["detected"]:
            yy["covers_window"] = any(_inside(d, best_start) for d in doys)
            yy["in_window"] = _inside(yy["peak_doy"], best_start)
    considered = [yy for yy in years if yy["covers_window"]]
    end = ((best_start + window_days - 2) % 365) + 1 if best_start is not None else None
    return {
        "window_days": window_days,
        "window": (None if best_start is None else
                   {"start_doy": best_start, "end_doy": end,
                    "label": f"{_doy_label(best_start)} – {_doy_label(end)}"}),
        "n_years_in_window": sum(1 for yy in considered if yy["in_window"]),
        "n_years_considered": len(considered),
        "n_years_detected": len(peaks),
        "n_years_sampled": len(years),
        "years": years,
        "definition": PEAK_WINDOW_DEFINITION,
        "reference": PEAK_WINDOW_REFERENCE,
        "note": PEAK_WINDOW_NOTE,
    }


def climatology(rows, key="count"):
    per_month: dict[int, list[float]] = {}
    per_year_month: dict[str, dict[int, list[float]]] = {}
    for row in rows:
        year, month = ym(row["date"])
        if month is None:
            continue
        val = row.get(key)
        if val is None:
            continue
        per_month.setdefault(month, []).append(val)
        per_year_month.setdefault(year, {}).setdefault(month, []).append(val)

    climo = []
    for m in range(1, 13):
        vals = per_month.get(m, [])
        climo.append({
            "month": m,
            "label": MONTHS[m - 1],
            "mean": (sum(vals) / len(vals)) if vals else None,
            "std": statistics.pstdev(vals) if len(vals) > 1 else 0.0,
            "n": len(vals),
        })

    by_year = {}
    for year, months in sorted(per_year_month.items()):
        by_year[year] = [{"month": m, "label": MONTHS[m - 1],
                          "mean": sum(v) / len(v), "n": len(v)}
                         for m, v in sorted(months.items())]

    annual = {y: sum(sum(v) for v in months.values()) / sum(len(v) for v in months.values())
              for y, months in sorted(per_year_month.items())}
    trend_per_year = None
    if len(annual) >= 2:
        ys = [int(y) for y in annual]
        vs = list(annual.values())
        mx, my = sum(ys) / len(ys), sum(vs) / len(vs)
        denom = sum((x - mx) ** 2 for x in ys) or 1.0
        trend_per_year = sum((x - mx) * (v - my) for x, v in zip(ys, vs)) / denom
    return {"climatology": climo, "by_year": by_year,
            "annual_mean": annual, "trend_per_year": trend_per_year}


def frequency(q: Runner, dataset_id: str, rows: list[dict], *, with_rank: bool = False) -> dict:
    axis = time_axis(q, dataset_id)
    shares = [(r.get("share"), r) for r in rows if r.get("share") is not None]
    present = [(s, r) for s, r in shares if s > 0]
    ranked = [(r["rank"], r) for r in rows if r.get("rank") is not None] if with_rank else []

    def _median(vals):
        return statistics.median(vals) if vals else None

    n_pool = None
    if with_rank:
        got = q("MATCH (a:ASV {dataset_id:$d}) RETURN count(a) AS n", d=dataset_id)
        n_pool = got[0]["n"] if got else None

    best_share = max(shares, default=(None, None), key=lambda t: t[0])
    best_rank = min(ranked, default=(None, None), key=lambda t: t[0])
    order = {id(r): i + 1 for i, r in enumerate(rows)}

    def _where(row):
        if row is None:
            return {"date": None, "index": None}
        return {"date": row.get("date") if axis == TIME_AXIS_DATES else None,
                "index": order.get(id(row))}

    qty = quantity(q, dataset_id)
    out = {
        "time_axis": axis,
        "quantity": qty,
        "points": [{"sample": r.get("sample"), "date": r.get("date"), "share": r.get("share"),
                    "sample_total": r.get("sample_total"),
                    "rank": r.get("rank"), "n_present": r.get("n_present")} for r in rows],
        "summary": {
            "n_samples": len(rows),
            "n_detected": len(present),
            "max_share": best_share[0],
            "max_at": _where(best_share[1]),
            "max_count": best_share[1].get("count") if best_share[1] else None,
            "max_sample_total": best_share[1].get("sample_total") if best_share[1] else None,
            "max_rank": best_share[1].get("rank") if best_share[1] else None,
            "median_share_when_detected": _median([s for s, _ in present]),
            "best_rank": best_rank[0],
            "best_rank_at": _where(best_rank[1]),
            "median_rank_when_detected": _median([r for r, _ in ranked]),
            "rank_pool": n_pool,
        },
        "seasonal": seasonal_stats(rows, "share") if axis == TIME_AXIS_DATES else None,
        "oscillation": (oscillation([{"date": r.get("date"), "share": r.get("share")} for r in rows],
                                    int(thresholds(q, dataset_id)["fft_coeffs"]))
                        if axis == TIME_AXIS_DATES else None),
    }
    if with_rank:
        out["summary"]["statement"] = trio_statement(out["summary"], qty)
    return out



def bray_curtis(x: dict, y: dict) -> "float | None":
    sx, sy = sum(x.values()), sum(y.values())
    if sx <= 0 or sy <= 0:
        return None
    px = {k: v / sx for k, v in x.items()}
    py = {k: v / sy for k, v in y.items()}
    return 1.0 - sum(min(v, py.get(k, 0.0)) for k, v in px.items())


OTTER_DEFAULTS = {"con_tr": 0.70, "con_alpha": 0.05, "ccmn_tr": 0.00, "ccmn_alpha": "no",
                  "num_permutations": 2, "num_samples": 10, "louvain_res": 1, "fft_coeffs": 14}
THRESHOLD_KEYS = tuple(OTTER_DEFAULTS)

PRODUCTION_DEFAULTS = {**OTTER_DEFAULTS, "num_permutations": 999}


def thresholds(q: Runner, dataset_id: str) -> dict:
    rows = q("MATCH (r:Run {dataset_id:$d}) WHERE r.con_tr IS NOT NULL "
             "RETURN " + ", ".join(f"r.{k} AS {k}" for k in THRESHOLD_KEYS) +
             ", r.run_id AS run_id, r.computed_at AS computed_at "
             "ORDER BY coalesce(r.computed_at, '') DESC, r.run_id LIMIT 1", d=dataset_id)
    if rows:
        return {**dict(rows[0]), "recorded": True}
    return {**OTTER_DEFAULTS, "run_id": None, "computed_at": None, "recorded": False}


def con_caveat(q: Runner, dataset_id: str) -> str:
    t = thresholds(q, dataset_id)
    hedge = ("" if t["recorded"] else
             " — this threshold is OTTER's default, not recorded for this dataset, so it is not "
             "proven to be the value this network was built with")
    return (f"CON is a correlation (Pearson >= {t['con_tr']} on FFT features), NOT an observed "
            f"interaction between organisms{hedge}.")


def fourier_pattern(values: list[float], num_coefficients: int) -> list[float]:
    n = len(values)
    if n == 0:
        return []
    kept: set[int] = set()
    for k in range(1, max(0, int(num_coefficients) - 1) + 1):
        kept.add(k % n)
        kept.add((n - k) % n)
    kept.discard(0)
    coeffs = []
    for k in kept:
        re = sum(v * math.cos(2 * math.pi * k * t / n) for t, v in enumerate(values))
        im = sum(-v * math.sin(2 * math.pi * k * t / n) for t, v in enumerate(values))
        coeffs.append((k, re, im))
    out = []
    for t in range(n):
        acc = 0.0
        for k, re, im in coeffs:
            ang = 2 * math.pi * k * t / n
            acc += re * math.cos(ang) - im * math.sin(ang)
        out.append(acc / n)
    return out


OSCILLATION_METHOD = (
    "Peaks per calendar year in MANTA's own reconstruction of the series from OTTER's Fourier "
    "slice (coefficients 1..fft_coeffs-1 over the whole series, the part CON compared; "
    "semantics.fourier_pattern) — a local maximum of that curve, assigned to the year of its "
    "sample. This is NOT Priest et al.'s method: they keep only statistically significant Fourier "
    "components; OTTER emits no coefficients and MANTA runs no significance test on them. Years "
    "with fewer than six samples are listed but not counted.")
OSCILLATION_REFERENCE = (
    "Priest et al. 2025, Nat Commun 16:1326 (doi:10.1038/s41467-025-56203-3) count a series as "
    "annually oscillating when it shows one peak and one trough per annual cycle, and report this "
    "for 15 % of their microeukaryotic ASVs. Named as the origin of "
    "the question; the count here follows a different, declared recipe and is not comparable "
    "one-to-one.")
OSCILLATION_MIN_SAMPLES = 6


def oscillation(points: list[dict], fft_coeffs: int) -> dict:
    rows = [p for p in points if p.get("share") is not None and p.get("date")]
    values = [p["share"] for p in rows]
    rec = fourier_pattern(values, fft_coeffs) if len(values) >= 3 else []
    per_year: dict[str, dict] = {}
    for i, p in enumerate(rows):
        year, _ = ym(p["date"])
        if year is None:
            continue
        y = per_year.setdefault(year, {"year": year, "n_samples": 0, "n_peaks": 0})
        y["n_samples"] += 1
        if rec and 0 < i < len(rec) - 1 and rec[i] > rec[i - 1] and rec[i] >= rec[i + 1]:
            y["n_peaks"] += 1
    years = [dict(v, counted=v["n_samples"] >= OSCILLATION_MIN_SAMPLES) for _, v in sorted(per_year.items())]
    counted = [y for y in years if y["counted"]]
    return {
        "years": years,
        "n_years_counted": len(counted),
        "modal_peaks": (statistics.mode([y["n_peaks"] for y in counted]) if counted else None),
        "annually_oscillating": (all(y["n_peaks"] == 1 for y in counted) if counted else None),
        "fft_coeffs": fft_coeffs,
        "min_samples_per_year": OSCILLATION_MIN_SAMPLES,
        "method": OSCILLATION_METHOD,
        "reference": OSCILLATION_REFERENCE,
    }


CCM_CAVEAT = ("CCM measures directed predictive skill (NMI) WITHOUT a convergence "
              "test — no evidence of causality.")

CCM_DECISION_NOTE = (
    "OTTER tests a CCM direction on every co-occurrence link, both ways. 'kept' = p < 0.05 in "
    "its permutation test (the pruned CCM table; drawn as an arrow). 'rejected' = tested, "
    "p >= 0.05 (no arrow). Where rejected directions are not recorded for a dataset, a missing "
    "direction cannot be told apart from a rejected one.")


CLUSTER_TIMESERIES_QUERY = (
    "MATCH (s:Sample {dataset_id:$d}) "
    "OPTIONAL MATCH (s)-[all:HAS_ABUNDANCE]->(:ASV {dataset_id:$d}) "
    "WITH s, sum(all.count) AS live_total "
    "WITH s, coalesce(s.analysed_reads_total, live_total) AS sample_total "
    "OPTIONAL MATCH (s)-[r:HAS_ABUNDANCE]->(a:ASV {dataset_id:$d}) WHERE a.louvain_label IS NOT NULL "
    "WITH s, sample_total, a.louvain_label AS l, sum(r.count) AS v "
    "RETURN s.sample_id AS sample, s.date AS date, sample_total AS sample_total, "
    "collect({label: l, value: v}) AS per_module "
    "ORDER BY s.date, s.sample_id")
CLUSTER_TIMESERIES_METHOD = (
    "Per sample, the sum of the stored values of each module's member ASVs — the same quantity "
    "cluster_at_sample returns for one sample, here for every sample and every module; a Cypher "
    "aggregate over stored values, nothing recomputed. 'outside' is the sample total minus the "
    "modules' sum: the ASVs of this sample that carry no module (not in the network run, or "
    "below the network thresholds). Sums only — no mean, no normalisation.")
CLUSTER_TIMESERIES_CAVEAT = (
    "Values are compositional: a module's sum rises or falls with the sample's depth and with "
    "the other modules; compare shapes, not heights. On a dataset of transformed values the sum "
    "adds numbers of an undocumented preprocessing.")


def cluster_timeseries(q: Runner, dataset_id: str) -> dict | None:
    labels = [r["l"] for r in q("MATCH (c:Cluster {dataset_id:$d}) RETURN c.louvain_label AS l "
                                "ORDER BY c.louvain_label", d=dataset_id)]
    if not labels:
        return None
    rows = q(CLUSTER_TIMESERIES_QUERY, d=dataset_id)
    axis = time_axis(q, dataset_id)
    samples = []
    for r in rows:
        vals = {str(l): 0.0 for l in labels}
        for pm in r["per_module"] or []:
            if pm.get("label") is not None:
                vals[str(int(pm["label"]))] = float(pm["value"] or 0.0)
        in_modules = sum(vals.values())
        total = float(r["sample_total"] or 0.0)
        samples.append({"sample": r["sample"], "date": r["date"] if axis == TIME_AXIS_DATES else None,
                        "sample_total": total, "in_modules": in_modules,
                        "outside": max(0.0, total - in_modules), "values": vals})
    return {"dataset_id": dataset_id, "time_axis": axis, "clusters": labels, "samples": samples,
            "value_declaration": {**value_declaration(q, dataset_id, "summed over the member ASVs of one module, per sample"),
                                  "applies_to": "samples[].values, in_modules, outside, sample_total"},
            "method": CLUSTER_TIMESERIES_METHOD, "caveat": CLUSTER_TIMESERIES_CAVEAT,
            "cluster_caveat": cluster_partition_caveat(q, dataset_id)}


SPECTRUM_METHOD = (
    "Amplitudes |c_k| of the Fourier coefficients k = 1 … FFT_COEFFS−1 that OTTER computes for "
    "the co-occurrence network (lutra/con.py, np.fft.fft over the series in sample order; the "
    "constant offset k = 0 is excluded, as in OTTER). Computed in the OTTER runner from the run's "
    "own input (Hellinger applied exactly when the run applied it), one value per harmonic, for "
    "every ASV that entered the run. This is the slice CON correlates — not a separate spectral "
    "analysis and not a seasonality test.")
SPECTRUM_CAVEAT = (
    "Harmonic k means k cycles over the whole series, not per year; the FFT assumes equally "
    "spaced samples and the real gaps are uneven. On short series (n ≤ 2·(FFT_COEFFS−1)) the slice "
    "passes the Nyquist frequency and higher harmonics mirror lower ones — shown as CON sees them. "
    "Amplitudes are on the run's input scale (compositional values; comparable between ASVs of "
    "the same run only in shape, not in absolute size).")


def spectrum(q: Runner, dataset_id: str, asv_id: str) -> dict | None:
    rows = q("MATCH (a:ASV {id:$id, dataset_id:$d}) "
             "OPTIONAL MATCH (r:Run {dataset_id:$d}) "
             "RETURN a.fft_amplitudes AS amps, r.fft_harmonics AS ks, r.hellinger AS hellinger "
             "ORDER BY coalesce(r.computed_at, '') DESC, r.run_id LIMIT 1", d=dataset_id, id=asv_id)
    if not rows:
        return None
    amps, ks, hellinger = rows[0]["amps"], rows[0]["ks"], rows[0]["hellinger"]
    t = thresholds(q, dataset_id)
    base = {"fft_coeffs": t["fft_coeffs"], "params_recorded": t["recorded"],
            "hellinger": hellinger, "method": SPECTRUM_METHOD, "caveat": SPECTRUM_CAVEAT}
    if amps is None:
        reason = ("No spectra were recorded for this dataset: its run left no FFT table "
                  "(older runs). Recomputing the network brings them."
                  if ks is None else
                  "This ASV was not part of the network run, so OTTER computed no Fourier "
                  "coefficients for it.")
        return {"available": False, "absent_reason": reason, "harmonics": None, "amplitudes": None,
                "n": 0, **base}
    harmonics = [int(k) for k in ks] if ks else list(range(1, len(amps) + 1))
    return {"available": True, "harmonics": harmonics, "amplitudes": [float(x) for x in amps],
            "n": len(amps), **base}


def ccm_tested_recorded(q: Runner, dataset_id: str) -> bool:
    rows = q("MATCH (r:Run {dataset_id:$d}) WHERE r.ccm_tested_directions IS NOT NULL "
             "RETURN r.ccm_tested_directions AS n "
             "ORDER BY coalesce(r.computed_at, '') DESC, r.run_id LIMIT 1", d=dataset_id)
    return bool(rows)


def ccm_direction(q: Runner, dataset_id: str, von: str, nach: str) -> dict | None:
    for rel, decision in (("INFLUENCES", "kept"), ("CCM_REJECTED", "rejected")):
        rows = q(f"MATCH (:ASV {{id:$x, dataset_id:$d}})-[r:{rel} {{dataset_id:$d}}]->"
                 f"(:ASV {{id:$y, dataset_id:$d}}) RETURN r.nmi AS nmi, r.p_value AS p_value "
                 f"ORDER BY r.nmi DESC, r.run_id LIMIT 1", d=dataset_id, x=von, y=nach)
        if rows:
            return {**rows[0], "decision": decision}
    return None


MODULE_NAME_MAX = 40


def clean_module_name(text: str | None) -> str | None:
    if text is None:
        return None
    s = "".join(" " if ch < " " else ch for ch in str(text)).strip()
    return s[:MODULE_NAME_MAX].strip() or None


def module_display(label: int, name: str | None) -> str:
    n = (name or "").strip()
    return f"M{label} · {n}" if n else f"M{label}"


def module_labels(q: Runner, dataset_id: str) -> dict[int, dict]:
    rows = q("MATCH (c:Cluster {dataset_id:$d}) "
             "RETURN c.louvain_label AS label, c.name AS name, c.color AS color "
             "ORDER BY c.louvain_label", d=dataset_id)
    return {r["label"]: {"louvain_label": r["label"], "name": r["name"], "color": r["color"],
                         "display": module_display(r["label"], r["name"])}
            for r in rows if r["label"] is not None}


def module_label(q: Runner, dataset_id: str, label: int) -> dict:
    return module_labels(q, dataset_id).get(
        label, {"louvain_label": label, "name": None, "color": None,
                "display": module_display(label, None)})


def cluster_partition_caveat(q: Runner, dataset_id: str) -> str:
    t = thresholds(q, dataset_id)
    hedge = ("" if t["recorded"] else
             " — this resolution is OTTER's default, not recorded for this dataset, so it is not "
             "proven to be the value this partition was built with")
    return (f"Clusters are ONE partition of the co-occurrence network, computed by Louvain at "
            f"resolution {t['louvain_res']}{hedge}. A different resolution yields a different "
            f"partition, so cluster identity is a property of this run, not of the organisms: "
            f"membership is not a taxonomic trait and says nothing about relatedness.")


CCM_PRUNE_ALPHA_DENOM = 20


def _ccm_null_size(num_permutations, num_samples) -> "int | None":
    try:
        n = int(num_permutations) * int(num_samples) * 2
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def ccm_permutation_caveat(q: Runner, dataset_id: str) -> str:
    t = thresholds(q, dataset_id)
    hedge = "" if t["recorded"] else " (OTTER's default; not recorded for this dataset)"
    satz = (f"The CCM p-values come from a permutation null with {t['num_permutations']} "
            f"permutations{hedge}")
    n_null = _ccm_null_size(t.get("num_permutations"), t.get("num_samples"))
    if n_null is None:
        return satz + "."
    n_below = -(-n_null // CCM_PRUNE_ALPHA_DENOM)
    satz += (f" — at most {n_null} null values ({t['num_permutations']} permutations x "
             f"{t['num_samples']} sampled pairs, both directions), so p is a multiple of "
             f"1/{n_null}; coarser in practice, because OTTER caps the null at the number of "
             f"edges tested")
    if n_below <= 3:
        werte = " and ".join("0.0" if k == 0 else f"{k / n_null:g}" for k in range(n_below))
        satz += f". Below the p < 0.05 cut only {werte} can occur at all"
    return satz + "."


CLUSTER_NETWORK_DEFINITION = (
    "Weight of a directed edge between two clusters: the arithmetic mean NMI over all directed "
    "CCM links that run from a member ASV of the first cluster to a member ASV of the second.")


def cluster_network(q: Runner, dataset_id: str) -> dict:
    rows = q(
        "MATCH (a:ASV {dataset_id:$d})-[i:INFLUENCES {dataset_id:$d}]->(b:ASV {dataset_id:$d}) "
        "WHERE i.from_clu IS NOT NULL AND i.to_clu IS NOT NULL "
        "WITH i.from_clu AS from_cluster, i.to_clu AS to_cluster, "
        "avg(i.nmi) AS mean_nmi, count(*) AS n_edges "
        "RETURN from_cluster, to_cluster, mean_nmi, n_edges "
        "ORDER BY n_edges DESC, from_cluster, to_cluster", d=dataset_id)
    return {
        "edges": rows,
        "n_cluster_pairs": len(rows),
        "definition": CLUSTER_NETWORK_DEFINITION,
        "source_publication": {"citation": SOURCE_PUBLICATION, "doi": SOURCE_PUBLICATION_DOI},
        "caveats": [CCM_CAVEAT, ccm_permutation_caveat(q, dataset_id)],
    }



INTERANNUAL_DEFINITION = (
    "For one cluster and one calendar month: the mean pairwise dissimilarity between samples of "
    "DIFFERENT years that fall into that month, computed over the cluster's member ASVs only. "
    "Small = the cluster's composition looks alike in this month every year; large = it looks "
    "different every year.")
INTERANNUAL_REFERENCE = (
    "Priest et al. 2025, Nat Commun 16:1326 (doi:10.1038/s41467-025-56203-3) ask the same question "
    "through convex hulls in NMDS space and report microeukaryotes as more cohesive in August and "
    "more variable in January-March, with maximal inter-annual differences in April. Named here as "
    "the origin of the question — it is not a result of this dataset.")
INTERANNUAL_CAVEAT = (
    "This shows how much a cluster's composition varied between years within the same calendar "
    "month. It does NOT show what would happen under conditions that were not observed, and it "
    "carries no statement about threat, vulnerability or resilience.")
INTERANNUAL_METRICS = {
    "jaccard": ("Jaccard distance on presence/absence (detected = value > 0): 1 − |A∩B| / |A∪B| "
                "over the cluster's members. Immune to any monotone rescaling of the values, so "
                "valid also where the value kind is unknown."),
    "bray_curtis": ("Bray-Curtis dissimilarity on the members' shares of the cluster's total in "
                    "each sample (1 − Σ min). Only where the stored values are sequencing reads."),
}
INTERANNUAL_NO_DATES = (
    "This dataset has no sampling dates — only the order of the samples. Without calendar months "
    "there is no 'same month in different years'.")


def _jaccard_distance(x: dict, y: dict) -> "float | None":
    a, b = set(x), set(y)
    u = a | b
    return None if not u else 1.0 - len(a & b) / len(u)


def interannual_variability(q: Runner, dataset_id: str, metric: str = "jaccard") -> dict:
    if metric not in INTERANNUAL_METRICS:
        raise ValueError(f"unknown metric {metric!r}; one of {sorted(INTERANNUAL_METRICS)}")
    vk = value_kind(q, dataset_id)
    metrics = {
        "jaccard": {"description": INTERANNUAL_METRICS["jaccard"], "available": True, "reason": None},
        "bray_curtis": {"description": INTERANNUAL_METRICS["bray_curtis"],
                        "available": vk == "reads",
                        "reason": None if vk == "reads" else (
                            f"Values in this dataset are '{vk}', not sequencing reads — Bray-Curtis "
                            "on them would measure an unknown transformation. Jaccard is unaffected.")},
    }
    base = {"metric": metric, "window": "month", "definition": INTERANNUAL_DEFINITION,
            "metrics": metrics, "reference": INTERANNUAL_REFERENCE, "caveat": INTERANNUAL_CAVEAT}
    if time_axis(q, dataset_id) != TIME_AXIS_DATES:
        return {**base, "clusters": [], "absent_reason": INTERANNUAL_NO_DATES}
    if not metrics[metric]["available"]:
        return {**base, "clusters": [], "absent_reason": metrics[metric]["reason"]}

    samples = q("MATCH (s:Sample {dataset_id:$d}) RETURN s.sample_id AS sample, s.date AS date "
                "ORDER BY s.date, s.sample_id", d=dataset_id)
    rows = q("MATCH (s:Sample {dataset_id:$d})-[r:HAS_ABUNDANCE]->(a:ASV {dataset_id:$d}) "
             "WHERE a.louvain_label IS NOT NULL AND r.count > 0 "
             "RETURN s.sample_id AS sample, a.louvain_label AS cluster, a.id AS asv, r.count AS count "
             "ORDER BY a.louvain_label, s.sample_id, a.id", d=dataset_id)
    members: dict[int, set] = {}
    for r in q("MATCH (a:ASV {dataset_id:$d}) WHERE a.louvain_label IS NOT NULL "
               "RETURN a.louvain_label AS cluster, a.id AS asv ORDER BY a.louvain_label, a.id", d=dataset_id):
        members.setdefault(r["cluster"], set()).add(r["asv"])
    by_cluster: dict[int, dict[str, dict]] = {c: {} for c in members}
    for r in rows:
        by_cluster[r["cluster"]].setdefault(r["sample"], {})[r["asv"]] = r["count"]
    by_month: dict[int, list] = {}
    for s in samples:
        year, month = ym(s["date"])
        if year is not None:
            by_month.setdefault(month, []).append((year, s["sample"]))
    dist = _jaccard_distance if metric == "jaccard" else bray_curtis

    clusters = []
    for c in sorted(members):
        vecs = by_cluster[c]
        windows = []
        for m in range(1, 13):
            ss = by_month.get(m, [])
            years = sorted({y for y, _ in ss})
            vals, undefined = [], 0
            for i in range(len(ss)):
                for j in range(i + 1, len(ss)):
                    if ss[i][0] == ss[j][0]:
                        continue
                    d = dist(vecs.get(ss[i][1], {}), vecs.get(ss[j][1], {}))
                    if d is None:
                        undefined += 1
                    else:
                        vals.append(d)
            windows.append({"month": m, "mean_dissimilarity": (sum(vals) / len(vals)) if vals else None,
                            "n_pairs": len(vals), "n_undefined": undefined,
                            "n_samples": len(ss), "n_years": len(years)})
        clusters.append({"cluster": c, "n_members": len(members[c]), "windows": windows})
    return {**base, "clusters": clusters, "n_samples": len(samples), "absent_reason": None}



CLUSTER_YEAR_CAVEAT = (
    "This shows how much a cluster's composition varied between years, and the range of "
    "conditions under which it was observed. It does NOT show what would happen under conditions "
    "that were not observed — and it says nothing about threat, vulnerability or resilience; the "
    "three figures stand side by side, the reading belongs to the reader.")
TREND_CAVEAT = ("Season-adjusted slope across the yearly anomalies — resting on a handful of "
                "yearly points this is a hint, not evidence.")


def cluster_series(q: Runner, dataset_id: str, louvain_label: int) -> list[dict]:
    rows = q(
        "MATCH (s:Sample {dataset_id:$d}) "
        "OPTIONAL MATCH (s)-[all:HAS_ABUNDANCE]->(:ASV {dataset_id:$d}) "
        "WITH s, sum(all.count) AS live_total "
        "WITH s, coalesce(s.analysed_reads_total, live_total) AS sample_total "
        "OPTIONAL MATCH (s)-[r:HAS_ABUNDANCE]->(a:ASV {dataset_id:$d}) WHERE a.louvain_label = $l "
        "RETURN s.sample_id AS sample, s.date AS date, sum(coalesce(r.count, 0.0)) AS sum_count, "
        "coalesce(sample_total, 0.0) AS sample_total ORDER BY s.date, s.sample_id",
        d=dataset_id, l=louvain_label)
    for r in rows:
        tot = r["sample_total"] or 0.0
        r["share"] = (r["sum_count"] / tot) if tot > 0 else None
    return rows



TAXON_SUM_ABSENT = "summed abundance not available for converted values"


def taxon_path(node: dict) -> dict[str, str | None]:
    return {r: node.get(r) for r in TAXONOMY_RANKS}


def taxon_groupable(path: dict) -> bool:
    if not (path.get("genus") or "").strip():
        return False
    return not any((path.get(r) or "") in TAXONOMY_PLACEHOLDERS for r in TAXONOMY_RANKS)


def taxon_label(path: dict) -> str:
    genus = (path.get("genus") or "").strip()
    roh = (path.get("species") or "").strip()
    if not genus:
        return "unassigned"
    if not roh or roh in TAXONOMY_PLACEHOLDERS:
        return genus
    art = roh.replace("_", " ").strip()
    if art in (genus, f"{genus} sp.", f"{genus} sp"):
        return genus
    if art.startswith(genus + " "):
        return art
    return f"{genus} {art}"


def taxon_group(q: Runner, dataset_id: str, asv_id: str) -> dict | None:
    ranks = ", ".join(f"a.`{r}` AS {r}" for r in TAXONOMY_RANKS)
    rows = q(f"MATCH (a:ASV {{id:$id, dataset_id:$d}}) RETURN {ranks}", d=dataset_id, id=asv_id)
    if not rows:
        return None
    path = taxon_path(rows[0])
    if not taxon_groupable(path):
        return {"asv_id": asv_id, "path": path, "label": taxon_label(path), "groupable": False,
                "members": [], "n_asv": 0,
                "reason": ("This ASV carries a placeholder in its taxonomy, or no genus at all — "
                           "no assignment is not a taxon, and two of them are not the same one.")}
    where = " AND ".join(f"coalesce(a.`{r}`, '') = ${r}" for r in TAXONOMY_RANKS)
    params = {r: (path[r] or "") for r in TAXONOMY_RANKS}
    members = q(f"MATCH (a:ASV {{dataset_id:$d}}) WHERE {where} "
                f"RETURN a.id AS id, a.louvain_label AS cluster, "
                f"a.read_count_total AS read_count_total, "
                f"COUNT {{ (a)<-[:HAS_ABUNDANCE]-(:Sample) }} AS n_samples_present "
                f"ORDER BY a.id", d=dataset_id, **params)
    return {"asv_id": asv_id, "path": path, "label": taxon_label(path), "groupable": True,
            "members": members, "n_asv": len(members),
            "clusters": sorted({m["cluster"] for m in members if m["cluster"] is not None}),
            "reason": None}


def taxon_series(q: Runner, dataset_id: str, member_ids: list[str]) -> dict:
    if not member_ids:
        return {"rows": [], "absent_reason": None, "value_kind": value_kind(q, dataset_id)}
    kind = value_kind(q, dataset_id)
    if kind != "reads":
        rows = q("MATCH (s:Sample {dataset_id:$d}) "
                 "OPTIONAL MATCH (s)-[r:HAS_ABUNDANCE]->(a:ASV {dataset_id:$d}) "
                 "WHERE a.id IN $ids AND r.count > 0 "
                 "RETURN s.sample_id AS sample, s.date AS date, count(r) AS n_members_present "
                 "ORDER BY s.date, s.sample_id", d=dataset_id, ids=member_ids)
        return {"rows": rows, "absent_reason": TAXON_SUM_ABSENT, "value_kind": kind}
    rows = q("MATCH (s:Sample {dataset_id:$d}) "
             "OPTIONAL MATCH (s)-[all:HAS_ABUNDANCE]->(:ASV {dataset_id:$d}) "
             "WITH s, sum(all.count) AS live_total "
             "WITH s, coalesce(s.analysed_reads_total, live_total) AS sample_total "
             "OPTIONAL MATCH (s)-[r:HAS_ABUNDANCE]->(a:ASV {dataset_id:$d}) WHERE a.id IN $ids "
             "RETURN s.sample_id AS sample, s.date AS date, "
             "sum(coalesce(r.count, 0.0)) AS sum_count, "
             "sum(CASE WHEN r.count > 0 THEN 1 ELSE 0 END) AS n_members_present, "
             "coalesce(sample_total, 0.0) AS sample_total ORDER BY s.date, s.sample_id",
             d=dataset_id, ids=member_ids)
    for r in rows:
        tot = r["sample_total"] or 0.0
        r["share"] = (r["sum_count"] / tot) if tot > 0 else None
    return {"rows": rows, "absent_reason": None, "value_kind": kind}


def cluster_year_overview(q: Runner, dataset_id: str, metric: str = "jaccard") -> dict:
    ia = interannual_variability(q, dataset_id, metric)
    meta = {k: ia[k] for k in ("metric", "metrics", "definition", "reference", "caveat")}
    base = {"interannual": meta, "caveat": CLUSTER_YEAR_CAVEAT, "months": MONTHS}
    if time_axis(q, dataset_id) != TIME_AXIS_DATES:
        return {**base, "clusters": [], "environment": None, "absent_reason": INTERANNUAL_NO_DATES}
    ia_by = {c["cluster"]: c for c in ia["clusters"]}
    month_no = {m: i + 1 for i, m in enumerate(MONTHS)}
    labels = [r["l"] for r in q("MATCH (a:ASV {dataset_id:$d}) WHERE a.louvain_label IS NOT NULL "
                                "RETURN DISTINCT a.louvain_label AS l ORDER BY l", d=dataset_id)]
    clusters = []
    for l in labels:
        act = activity(frequency(q, dataset_id, cluster_series(q, dataset_id, l), with_rank=False))
        clusters.append({
            "cluster": l,
            "n_members": ia_by[l]["n_members"] if l in ia_by else None,
            "activity": {"window_months": [month_no[m] for m in act["window"]],
                         "peak_month": month_no.get(act["peak"]), "n_min": act["n_min"],
                         "statement": act["statement"]},
            "interannual": ia_by[l]["windows"] if l in ia_by else [],
            "environment_profile": cluster_environment_profile(q, dataset_id, l),
        })
    env = environment(q, dataset_id)
    variables = []
    for v in env["variables"]:
        rows = [{"date": p["date"], "value": p["value"]} for p in v["points"] if p["value"] is not None]
        st = seasonal_stats(rows, "value")
        variables.append({"key": v["key"], "label": v["label"], "unit": v["unit"], "n": v["n"],
                          "total": v["total"], "monthly": v.get("monthly", []),
                          "trend_per_year": st["trend_per_year"], "trend_method": st["trend_method"],
                          "n_years": len(st["years"]), "full_years": st["full_years"],
                          "partial_years": st["partial_years"], "trend_caveat": TREND_CAVEAT})
    return {**base, "clusters": clusters,
            "environment": {"variables": variables, "absent_reason": env["absent_reason"],
                            "provenance": env["provenance"], "units_note": env["units_note"]},
            "absent_reason": ia["absent_reason"]}


TAXONOMY_RANKS = ["kingdom", "phylum", "class", "order", "family", "genus", "species"]

TAXONOMY_PLACEHOLDERS = ["unassigned", "NA", "", "Environment_Condition", "uncultured"]

_PLACEHOLDER_SHAPE = re.compile(r"(_X+|\s+uc|\s*uc_sp\.|_sp\.?|\s+sp\.)$", re.IGNORECASE)


def is_taxon_placeholder(name) -> bool:
    if name is None:
        return True
    s = str(name).strip()
    return s in TAXONOMY_PLACEHOLDERS or bool(_PLACEHOLDER_SHAPE.search(s))



TRAIT_LITERATURE_NOTE = (
    "Looked up in the literature by the taxon name — a property of the name, not a result of "
    "this dataset. Ecological function itself cannot be derived from amplicon data.")
TRAIT_NOT_ANNOTATED = "not annotated"
TRAIT_NOT_DERIVABLE = "Ecological function — not derivable from amplicon data"
TRAIT_MDB_CATEGORIES = {
    "CM": "constitutive mixoplankton",
    "GNCM": "generalist non-constitutive mixoplankton",
    "pSNCM": "plastidic specialist non-constitutive mixoplankton",
    "eSNCM": "endosymbiotic specialist non-constitutive mixoplankton",
}
TRAIT_RANK_ORDER = ("species", "genus", "family")


def mdb_label(category: str) -> str:
    return f"mixoplankton ({category})"


def trait_group_label(functions) -> str:
    fs = sorted({str(f) for f in (functions or [])})
    return " + ".join(fs) if fs else TRAIT_NOT_ANNOTATED


def trait_run(q: Runner, dataset_id: str) -> dict:
    rows = q("MATCH (r:TraitRun {dataset_id:$d}) RETURN r AS t ORDER BY r.run_id LIMIT 1", d=dataset_id)
    if not rows:
        return {"available": False, "run_id": None, "sources": [], "coverage": None,
                "n_annotated": 0, "n_with_lineage": 0, "n_asv": 0,
                "absent_reason": ("No literature annotation has been run for this dataset "
                                  "(tools/traits/annotate.py)."),
                "statement": None, "note": TRAIT_LITERATURE_NOTE}
    t = dict(rows[0]["t"])
    n_lin = int(t.get("n_with_lineage") or 0)
    n_ann = int(t.get("n_annotated") or 0)
    ranks_used = [r for r in TRAIT_RANK_ORDER if int(t.get(f"n_rank_{r}") or 0) > 0]
    coarsest = ranks_used[-1] if ranks_used else None
    sources = list(t.get("sources") or [])
    if t.get("absent_reason"):
        statement = t["absent_reason"]
    elif n_lin == 0:
        statement = "annotated: no ASV of this dataset carries a lineage to look up"
    else:
        pct = 100.0 * n_ann / n_lin
        statement = (f"annotated: {pct:.0f} % of the {n_lin} ASVs with a lineage ({n_ann}), "
                     + (f"{coarsest} level or finer" if coarsest else "no hit")
                     + f"; sources: {', '.join(sources) if sources else 'none'}")
    return {"available": True, "run_id": t.get("run_id"), "computed_by": t.get("computed_by"),
            "method": t.get("method"), "marker": t.get("marker"),
            "sources": sources, "source_citations": list(t.get("source_citations") or []),
            "coverage": t.get("coverage"), "n_annotated": n_ann, "n_with_lineage": n_lin,
            "n_asv": int(t.get("n_asv") or 0),
            "n_by_rank": {r: int(t.get(f"n_rank_{r}") or 0) for r in TRAIT_RANK_ORDER},
            "absent_reason": t.get("absent_reason"),
            "statement": statement, "note": TRAIT_LITERATURE_NOTE,
            "mdb_categories": TRAIT_MDB_CATEGORIES}


def asv_trait(q: Runner, dataset_id: str, asv_id: str) -> dict | None:
    rows = q("MATCH (a:ASV {id:$id, dataset_id:$d}) RETURN a.trait_function AS f, "
             "a.trait_source AS s, a.trait_rank AS r, a.trait_run_id AS run",
             d=dataset_id, id=asv_id)
    if not rows:
        return None
    r = rows[0]
    fs = list(r["f"] or [])
    return {"annotated": bool(fs), "functions": fs, "sources": list(r["s"] or []),
            "rank": r["r"], "group": trait_group_label(fs), "run_id": r["run"],
            "note": TRAIT_LITERATURE_NOTE}



ENV_LINK_NOTE = (
    "A lagged rank correlation between a measured variable and the ASV's share of the sample — "
    "shifts are counted in samples, not time units (sampling intervals are irregular). A link "
    "is covariation with a delay, not a response and not a cause; shares move when other taxa "
    "move. The best of 2L+1 shifts was chosen; the correction (Benjamini-Hochberg) runs across "
    "the pairs of one variable, not across the shifts.")
ENV_LINK_ABSENT_NO_RUN = ("No environment links have been computed for this dataset "
                          "(tools/env_links/compute.py).")


def env_link_run(q: Runner, dataset_id: str) -> dict:
    rows = q("MATCH (r:EnvLinkRun {dataset_id:$d}) RETURN r AS x ORDER BY r.run_id LIMIT 1", d=dataset_id)
    if not rows:
        return {"available": False, "run_id": None, "absent_reason": ENV_LINK_ABSENT_NO_RUN,
                "statement": None, "note": ENV_LINK_NOTE, "n_links": 0, "n_variables": 0,
                "variables": [], "max_lag": None, "alpha": None}
    x = dict(rows[0]["x"])
    absent = x.get("absent_reason")
    out = {"available": not absent, "run_id": x.get("run_id"), "computed_by": x.get("computed_by"),
           "method": x.get("method"), "measure": x.get("measure"), "quantity": x.get("quantity"),
           "max_lag": x.get("max_lag"), "lag_unit": x.get("lag_unit"), "alpha": x.get("alpha"),
           "min_pairs": x.get("min_pairs"), "correction": x.get("correction"),
           "n_samples": x.get("n_samples"), "n_variables": int(x.get("n_variables") or 0),
           "variables": list(x.get("variables") or []), "n_asv": x.get("n_asv"),
           "n_pairs": x.get("n_pairs"), "n_links": int(x.get("n_links") or 0),
           "absent_reason": absent, "note": ENV_LINK_NOTE}
    if absent:
        out["statement"] = absent
    else:
        out["statement"] = (f"{out['n_links']} environment links from {out['n_pairs']} variable–ASV pairs "
                            f"({out['n_variables']} variables), rank correlation at the best shift within "
                            f"±{out['max_lag']} samples, Benjamini-Hochberg p < {out['alpha']:g} per variable")
    return out


def _env_label(key: str) -> dict:
    spec = next((v for v in ENVIRONMENT_VARS if v["key"] == key), None)
    return {"variable": key, "label": spec["label"] if spec else key,
            "unit": spec["unit"] if spec else None}


def asv_drivers(q: Runner, dataset_id: str, asv_id: str) -> dict:
    run = env_link_run(q, dataset_id)
    rows = q("MATCH (v:EnvVariable {dataset_id:$d})-[c:COVARIES_WITH {dataset_id:$d}]->(a:ASV {id:$id, dataset_id:$d}) "
             "RETURN v.name AS variable, c.lag AS lag, c.r AS r, c.r0 AS r0, c.p AS p, c.p_adj AS p_adj, c.n AS n "
             "ORDER BY abs(c.r) DESC, v.name", d=dataset_id, id=asv_id)
    drivers = [{**_env_label(r["variable"]), "lag": int(r["lag"]), "r": r["r"], "r0": r["r0"],
                "p": r["p"], "p_adj": r["p_adj"], "n": int(r["n"]),
                "shift_text": (f"shifted by {int(r['lag'])} sample{'' if abs(int(r['lag'])) == 1 else 's'}"
                               if int(r["lag"]) != 0 else "no shift")}
               for r in rows]
    absent = None
    if not run["available"]:
        absent = run["absent_reason"]
    elif not drivers:
        absent = (f"No environment variable covaries with this ASV at p_adj < {run['alpha']:g} "
                  f"within ±{run['max_lag']} samples.")
    return {"available": bool(drivers), "drivers": drivers, "absent_reason": absent,
            "note": ENV_LINK_NOTE, "run": run}


def env_variable_links(q: Runner, dataset_id: str, name: str) -> dict:
    run = env_link_run(q, dataset_id)
    var = q("MATCH (v:EnvVariable {dataset_id:$d, name:$n}) RETURN v.name AS name, v.label AS label, "
            "v.unit AS unit, v.n_values AS n_values ORDER BY v.name LIMIT 1", d=dataset_id, n=name)
    rows = q("MATCH (v:EnvVariable {dataset_id:$d, name:$n})-[c:COVARIES_WITH {dataset_id:$d}]->(a:ASV {dataset_id:$d}) "
             "RETURN a.id AS asv_id, a.genus AS genus, a.louvain_label AS cluster, c.lag AS lag, c.r AS r, "
             "c.r0 AS r0, c.p_adj AS p_adj, c.n AS n ORDER BY abs(c.r) DESC, a.id", d=dataset_id, n=name)
    return {"variable": (dict(var[0]) if var else {**_env_label(name), "name": name}),
            "known": bool(var), "links": [dict(r) for r in rows], "n_links": len(rows),
            "n_in_network": sum(1 for r in rows if r["cluster"] is not None),
            "note": ENV_LINK_NOTE, "run": run}


def cluster_env_links(q: Runner, dataset_id: str, louvain_label: int) -> dict:
    run = env_link_run(q, dataset_id)
    rows = q("MATCH (v:EnvVariable {dataset_id:$d})-[c:COVARIES_WITH {dataset_id:$d}]->(a:ASV {dataset_id:$d}) "
             "WHERE a.louvain_label = $l "
             "RETURN v.name AS variable, count(a) AS n_asv, avg(c.r) AS mean_r, collect(a.id) AS asv_ids "
             "ORDER BY n_asv DESC, v.name", d=dataset_id, l=louvain_label)
    n_members = q("MATCH (a:ASV {dataset_id:$d}) WHERE a.louvain_label = $l RETURN count(a) AS n",
                  d=dataset_id, l=louvain_label)
    items = [{**_env_label(r["variable"]), "n_asv": int(r["n_asv"]), "mean_r": r["mean_r"],
              "asv_ids": sorted(r["asv_ids"])} for r in rows]
    n = int(n_members[0]["n"]) if n_members else 0
    return {"n_members": n, "links": items,
            "statement": (run["absent_reason"] if not run["available"]
                          else ("environment links: " + ", ".join(f"{it['label']} → {it['n_asv']} ASVs" for it in items)
                                if items else "environment links: none in this cluster")),
            "note": ENV_LINK_NOTE, "run": run}


def cluster_functions(q: Runner, dataset_id: str, louvain_label: int) -> dict:
    rows = q("MATCH (a:ASV {dataset_id:$d}) WHERE a.louvain_label = $l "
             "RETURN a.id AS id, a.trait_function AS f ORDER BY a.id", d=dataset_id, l=louvain_label)
    counts: dict[str, int] = {}
    n_ann = 0
    for r in rows:
        fs = list(r["f"] or [])
        if fs:
            n_ann += 1
        for f in sorted(set(fs)):
            counts[f] = counts.get(f, 0) + 1
    items = [{"label": k, "n_asv": v} for k, v in counts.items()]
    items.sort(key=lambda it: (-it["n_asv"], it["label"]))
    items.append({"label": TRAIT_NOT_ANNOTATED, "n_asv": len(rows) - n_ann})
    n = len(rows)
    for it in items:
        it["share"] = (it["n_asv"] / n) if n else None
    return {"n_members": n, "n_annotated": n_ann, "functions": items,
            "note": TRAIT_LITERATURE_NOTE}



def activity(freq: dict) -> dict:
    axis = freq.get("time_axis")
    pts = freq.get("points") or []
    if axis == TIME_AXIS_DATES and (freq.get("seasonal") or {}).get("climatology"):
        climo = [c for c in freq["seasonal"]["climatology"] if c.get("mean") is not None]
        if not climo:
            return {"axis": axis, "window": [], "peak": None, "n_min": 0, "statement": None}
        overall = sum(c["mean"] for c in climo) / len(climo)
        above = [c for c in climo if c["mean"] > overall]
        peak = max(climo, key=lambda c: c["mean"])
        months = sorted(c["month"] for c in above)

        def _runs(ms):
            if not ms:
                return []
            out = [[ms[0]]]
            for m in ms[1:]:
                if m == out[-1][-1] + 1:
                    out[-1].append(m)
                else:
                    out.append([m])
            if len(out) > 1 and out[0][0] == 1 and out[-1][-1] == 12:
                out[-1] = out[-1] + out.pop(0)
            return out

        runs = _runs(months)
        best = max(runs, key=len) if runs else [peak["month"]]
        label = (MONTHS[best[0] - 1] if len(best) == 1
                 else f"{MONTHS[best[0] - 1]}–{MONTHS[best[-1] - 1]}")
        n_min = min((c["n"] for c in above), default=0)
        return {
            "axis": axis, "window": [MONTHS[m - 1] for m in best],
            "peak": MONTHS[peak["month"] - 1], "n_min": n_min,
            "statement": (f"strongest in {label}" + (
                f", peaking in {MONTHS[peak['month'] - 1]}"
                if len(best) > 1 and sum(
                    1 for c in climo if c["month"] in best and c["mean"] == peak["mean"]) == 1
                else "")),
        }

    shares = [(p.get("share"), i + 1) for i, p in enumerate(pts) if p.get("share") is not None]
    if not shares:
        return {"axis": axis, "window": [], "peak": None, "n_min": 0, "statement": None}
    best_share, best_i = max(shares)
    return {
        "axis": axis, "window": [], "peak": f"sample {best_i}", "n_min": 1,
        "statement": f"strongest at sample {best_i} of {len(pts)} — this dataset has no calendar "
                     f"dates, so the position is the answer, not a season",
    }



ENVIRONMENT_UNITS_SOURCE = f"{SOURCE_PUBLICATION} (Methods) — the publication for this dataset"

ENVIRONMENT_VARS: list[dict] = [
    {"key": "temp", "source_column": "temp", "label": "Water temperature",
     "unit": "°C", "unit_note": None},
    {"key": "sal", "source_column": "sal", "label": "Salinity",
     "unit": "PSU", "unit_note": None},
    {"key": "depth", "source_column": "depth", "label": "Sampling depth",
     "unit": "m", "unit_note": None},
    {"key": "mld", "source_column": "MLD", "label": "Mixed Layer Depth (MLD)",
     "unit": "m", "unit_note": None},
    {"key": "chl_sens", "source_column": "chl_sens",
     "label": "Chlorophyll concentration (in situ sensor)",
     "unit": "μg l⁻¹", "unit_note": None},
    {"key": "par_satellite", "source_column": "PAR_satellite",
     "label": "Photosynthetically Active Radiation (PAR)",
     "unit": "μmol photons m⁻² d⁻¹",
     "unit_note": ("The publication states μmol photons m⁻² d⁻¹. The values in this dataset run "
                   "from 0 to 24, which is the usual magnitude of a polar summer day in MOL "
                   "photons m⁻² d⁻¹, not μmol. The values are shown unchanged; the unit is the "
                   "published one and the mismatch is left visible rather than corrected here.")},
    {"key": "pw_frac", "source_column": "PW_frac", "label": "Polar Water Fraction",
     "unit": "%",
     "unit_note": ("The publication states %. Every value in this dataset lies between 0 and "
                   "0.68, so the column holds a fraction of one, not a percentage. Shown "
                   "unchanged — multiplying by 100 would be our arithmetic, not the measurement.")},
    {"key": "o2_conc", "source_column": "O2_conc", "label": "Oxygen concentration",
     "unit": "μmol l⁻¹", "unit_note": None},
]

ENVIRONMENT_KEYS = [v["key"] for v in ENVIRONMENT_VARS]

ENVIRONMENT_PROVENANCE = (
    "The eight environmental parameters recorded alongside the samples at mooring site F4, "
    "carried through unchanged — measured, not derived from the sequences and not modelled. "
    "Where a sample has no value the curve has a hole; nothing is interpolated."
)

ENVIRONMENT_UNITS_NOTE = (
    f"Parameter names and units follow {ENVIRONMENT_UNITS_SOURCE}. The source table itself "
    f"carries no units. Two of them do not match the values in this dataset; that is stated at "
    f"the parameter instead of being corrected."
)


def environment_profile(q: Runner, dataset_id: str, asv_id: str) -> dict:
    props = ", ".join(f"s.`{v['key']}` AS `{v['key']}`" for v in ENVIRONMENT_VARS)
    rows = q(f"MATCH (s:Sample {{dataset_id:$d}})-[h:HAS_ABUNDANCE]->"
             f"(a:ASV {{id:$a, dataset_id:$d}}) WHERE h.count > 0 "
             f"RETURN h.count AS w, {props} ORDER BY s.sample_id", d=dataset_id, a=asv_id)
    return _weighted_env_profile(rows)


CLUSTER_SERIES_DEFINITION = (
    "A cluster's time series is the weighted sum of the abundance values of its member ASVs "
    "per sample.")


def cluster_environment_profile(q: Runner, dataset_id: str, louvain_label: int) -> dict:
    props = ", ".join(f"s.`{v['key']}` AS `{v['key']}`" for v in ENVIRONMENT_VARS)
    rows = q(f"MATCH (s:Sample {{dataset_id:$d}})-[h:HAS_ABUNDANCE]->(a:ASV {{dataset_id:$d}}) "
             f"WHERE a.louvain_label = $l WITH s, sum(h.count) AS w WHERE w > 0 "
             f"RETURN w, {props}", d=dataset_id, l=louvain_label)
    out = _weighted_env_profile(rows)
    out["series_definition"] = CLUSTER_SERIES_DEFINITION
    out["series_note"] = ("Method after " + SOURCE_PUBLICATION + "; the publication does not name "
                          "the weights, MANTA uses equal weights (the plain sum of the members' "
                          "values per sample — the same collective curve the cluster panel draws).")
    return out


def _weighted_env_profile(rows: list[dict]) -> dict:
    n_present = len(rows)
    items = []
    for spec in ENVIRONMENT_VARS:
        key = spec["key"]
        pairs = sorted((r[key], r["w"]) for r in rows if r[key] is not None and (r["w"] or 0) > 0)
        if not pairs:
            continue
        wsum = sum(w for _, w in pairs)

        def pct(p, _pairs=pairs, _wsum=wsum):
            c = 0.0
            for x, w in _pairs:
                c += w
                if c >= p * _wsum:
                    return x
            return _pairs[-1][0]

        items.append({"key": key, "label": spec["label"], "unit": spec["unit"],
                      "unit_note": spec.get("unit_note"),
                      "weighted_mean": sum(x * w for x, w in pairs) / wsum,
                      "p10": pct(0.10), "p90": pct(0.90),
                      "n_samples_used": len(pairs), "n_samples_present": n_present})
    return {
        "items": items,
        "method": ("Weighted by this ASV's value in each sample, over all samples with a "
                   "detection (count > 0) and a measured value; the percentiles are the "
                   "smallest value whose cumulative weight reaches 10 % / 90 % of the total "
                   "weight. Samples without a measurement are excluded, never filled."),
        "caveat": ("A weighted summary of the conditions this ASV was found under — NOT a "
                   "niche model, NOT an optimum in the physiological sense, and NOT a "
                   "correlation: with compositional data such a correlation would partly "
                   "measure the shifts of the other taxa."),
    }


def environment(q: Runner, dataset_id: str) -> dict:
    axis = time_axis(q, dataset_id)
    props = ", ".join(f"s.`{v['key']}` AS `{v['key']}`" for v in ENVIRONMENT_VARS)
    rows = q(f"MATCH (s:Sample {{dataset_id:$d}}) RETURN s.sample_id AS sample, s.date AS date, "
             f"{props} ORDER BY s.date, s.sample_id", d=dataset_id)
    n_sample = len(rows)

    variables, absent = [], []
    for spec in ENVIRONMENT_VARS:
        key = spec["key"]
        vals = [r[key] for r in rows if r[key] is not None]
        if not vals:
            absent.append({"key": key, "label": spec["label"],
                           "source_column": spec["source_column"]})
            continue
        item = {
            **spec,
            "n": len(vals), "total": n_sample,
            "min": min(vals), "max": max(vals), "mean": sum(vals) / len(vals),
            "points": [{"sample": r["sample"],
                        "date": r["date"] if axis == TIME_AXIS_DATES else None,
                        "value": r[key]} for r in rows],
        }
        if axis == TIME_AXIS_DATES:
            per_month: dict[int, list[float]] = {}
            for r in rows:
                _, month = ym(r["date"])
                if month is not None and r[key] is not None:
                    per_month.setdefault(month, []).append(r[key])
            item["monthly"] = [{"month": m, "label": MONTHS[m - 1],
                                "mean": sum(per_month[m]) / len(per_month[m]),
                                "n": len(per_month[m])}
                               for m in sorted(per_month)]
        variables.append(item)

    return {
        "dataset_id": dataset_id,
        "time_axis": axis,
        "n_sample": n_sample,
        "variables": variables,
        "absent": absent,
        "provenance": ENVIRONMENT_PROVENANCE,
        "units_note": ENVIRONMENT_UNITS_NOTE,
        "absent_reason": (
            "" if variables else
            "No environmental values were supplied with this dataset. The chain carries "
            "environmental data end to end, but this import brought none, so there is nothing to "
            "show. Any temperature or salinity stated for this dataset would be invented."
        ),
    }




HUB_SOURCE = "Priest et al. 2025 (Nat Commun), criterion 2 of 3"

HUB_MEASURES: dict[str, str] = {
    "con_degree": "number of association partners",
    "con_cluster_closeness": "closeness within its own co-occurrence community",
    "con_closeness": "closeness in the whole co-occurrence network",
    "con_cluster_betweenness": "betweenness within its own co-occurrence community",
    "con_betweenness": "betweenness in the whole co-occurrence network",
}
HUB_MEASURE_DEFAULT = "con_degree"
HUB_K_DEFAULT = 1.0
HUB_K_MIN, HUB_K_MAX, HUB_K_STEP = 0.0, 3.0, 0.5

HUB_MEASURE_CAVEATS: dict[str, str] = {
    "con_degree": (
        "The degree counts the links that survived THIS run's thresholds — a lower correlation "
        "cut would give every ASV more partners, and a different set would clear the bar. The "
        "number is exact for this network, not a property of the organism."),
    "con_cluster_closeness": (
        "OTTER computes the intra-community centralities on the unweighted network — "
        "how strongly two ASVs correlate does not enter the measure, only whether they are "
        "linked at all."),
    "con_cluster_betweenness": (
        "OTTER computes the intra-community centralities on the unweighted network — "
        "how strongly two ASVs correlate does not enter the measure, only whether they are "
        "linked at all."),
    "con_closeness": (
        "Measured across two CPU architectures: con_closeness differed between "
        "CPU architectures for about one ASV in five in that run — a hub list based on it is "
        "machine-dependent."),
    "con_betweenness": (
        "Measured across two CPU architectures: only the top 10 betweenness "
        "positions were stable between architectures — a threshold that reaches below them "
        "marks nodes whose order the hardware picked."),
}

HUB_WHY_NOT_KEYSTONE = (
    "The word is deliberately \"hub\", never \"keystone\": Priest et al. 2025 identify "
    "keystones through three joint criteria — a significant NMI (CCM), closeness within the "
    "community above μ + 1·σ, and presence in a stable energy-landscape state. This view "
    "checks at most ONE of them, and the default measure — the number of association "
    "partners — is none of the three at all. A \"keystone\" label would claim more method "
    "than the data went through.")

HUB_NODE_TOOLTIP = "hub — meets the displayed hub criterion"
HUB_TITLE = "Hubs — not keystone species"

EDGE_WIDTH_LEGEND = {
    "con": ("Line width ∝ |corr| — {min} to {max} across the links now in view; "
            "relative to this view, it changes when filtering."),
    "ccm": ("Line width ∝ NMI (the larger of a link's directions) — {min} to {max} across "
            "the links now in view; relative to this view, it changes when filtering."),
    "rejected": ("Line width ∝ NMI of the rejected direction (the larger where both were "
                 "rejected) — {min} to {max} across the links now in view; relative to this "
                 "view, it changes when filtering."),
}


def hub_set(q: Runner, dataset_id: str, measure: str | None = None, k: float | None = None) -> dict:
    measure = measure or HUB_MEASURE_DEFAULT
    k = HUB_K_DEFAULT if k is None else float(k)
    if measure not in HUB_MEASURES:
        raise ValueError(f"unbekanntes Hub-Maß {measure!r} — erlaubt: {sorted(HUB_MEASURES)}")
    if not (HUB_K_MIN <= k <= HUB_K_MAX) or not (k / HUB_K_STEP).is_integer():
        raise ValueError(f"k muss zwischen {HUB_K_MIN:g} und {HUB_K_MAX:g} liegen, "
                         f"in Schritten von {HUB_K_STEP:g} — uebergeben: {k!r}")

    if measure == "con_degree":
        rows = q("MATCH (a:ASV {dataset_id:$d}) WHERE a.louvain_label IS NOT NULL "
                 "RETURN a.id AS id, "
                 "COUNT { (a)-[:CO_OCCURS_WITH {dataset_id:$d}]-(:ASV {dataset_id:$d}) } AS v "
                 "ORDER BY a.id", d=dataset_id)
    else:
        rows = q(f"MATCH (a:ASV {{dataset_id:$d}}) WHERE a.louvain_label IS NOT NULL "
                 f"RETURN a.id AS id, a.{measure} AS v ORDER BY a.id", d=dataset_id)
    vals = [r["v"] for r in rows if r["v"] is not None]
    n_network, n_with_value = len(rows), len(vals)
    label = HUB_MEASURES[measure]

    if n_with_value == 0:
        mu = sigma = threshold = None
        ids: list[str] = []
        statement = (f"No hub criterion possible — {label} is stored for none of the "
                     f"{n_network} network ASVs of this dataset.")
    else:
        mu = sum(vals) / n_with_value
        sigma = statistics.stdev(vals) if n_with_value > 1 else 0.0
        threshold = mu + k * sigma
        ids = [r["id"] for r in rows if r["v"] is not None and r["v"] > threshold]
        n_missing = n_network - n_with_value
        is_default_closeness = measure == "con_cluster_closeness" and k == HUB_K_DEFAULT
        if measure == "con_degree":
            herkunft = (f"This is MANTA's operational definition, not a criterion from "
                        f"{HUB_SOURCE}: that one is the closeness within the community. ")
        elif is_default_closeness:
            herkunft = f"After {HUB_SOURCE}. "
        else:
            herkunft = (f"Modified from {HUB_SOURCE} — the source uses closeness within the "
                        f"community at k = 1. ")
        statement = (
            f"Hub = node whose {label} lies above μ + {k:g}·σ of all {n_with_value} network "
            f"ASVs with a stored value (μ = {mu:.3f}, σ = {sigma:.3f}, threshold {threshold:.3f}; "
            f"{len(ids)} of {n_with_value} nodes qualify"
            + (f"; {n_missing} further network ASVs carry no stored value and can never qualify"
               if n_missing else "")
            + "). "
            + herkunft
            + "Criteria 1 (significant NMI) and 3 (a stable energy-landscape state) are "
              "not checked.")

    n_zero = sum(1 for v in vals if v == 0.0)
    return {
        "measure": measure, "measure_label": label, "k": k,
        "mu": mu, "sigma": sigma, "threshold": threshold,
        "sigma_kind": "sample SD (n−1)",
        "n_network": n_network, "n_with_value": n_with_value,
        "n_marked": len(ids), "n_zero": n_zero, "ids": ids,
        "statement": statement,
        "zero_caveat": (
            f"{n_zero} of {n_with_value} nodes have the stored value exactly 0 — among "
            f"themselves this measure separates nothing." if n_zero else None),
        "measure_caveat": HUB_MEASURE_CAVEATS[measure],
        "why_not_keystone": HUB_WHY_NOT_KEYSTONE,
        "node_tooltip": HUB_NODE_TOOLTIP,
        "title": HUB_TITLE,
        "source": (None if measure == "con_degree" else HUB_SOURCE),
        "controls": {
            "measures": [{"key": m, "label": lbl} for m, lbl in HUB_MEASURES.items()],
            "default_measure": HUB_MEASURE_DEFAULT, "default_k": HUB_K_DEFAULT,
            "k_min": HUB_K_MIN, "k_max": HUB_K_MAX, "k_step": HUB_K_STEP,
        },
    }
