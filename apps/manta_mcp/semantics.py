from __future__ import annotations

import math
import re
import statistics
from typing import Callable

import tageslicht

TIME_AXIS_DATES = "dates"
TIME_AXIS_ORDINAL = "ordinal"
NO_DATES = ("This dataset has NO real time axis (sample order only) — calendar months and "
            "years do not exist here, so this test cannot be run.")
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

Runner = Callable[..., list[dict]]

SAMPLE_ORDER_BY = "ORDER BY s.date, s.same_day_index, s.ordinal_index, s.sample_id"

SOURCE_PUBLICATION = "Oldenburg et al. 2024, Beyond blooms, Commun Earth Environ 5:643"
SOURCE_PUBLICATION_DOI = "10.1038/s43247-024-01782-0"

_DOI_PREFIXES = ("https://doi.org/", "http://doi.org/", "https://dx.doi.org/",
                 "http://dx.doi.org/", "doi:")


def is_source_publication(doi: "str | None") -> bool:
    d = str(doi or "").strip().lower()
    for p in _DOI_PREFIXES:
        if d.startswith(p):
            d = d[len(p):]
    return d == SOURCE_PUBLICATION_DOI.lower()


def is_publication_dataset(q: Runner, dataset_id: str) -> bool:
    rows = q("MATCH (d:Dataset {dataset_id:$d}) RETURN d.source_doi AS doi", d=dataset_id)
    return bool(rows) and is_source_publication(rows[0].get("doi"))


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


def taxon_statement(rank: str, name: "str | None", grouped_by: str, rows: list[dict],
                    n_asv_total: int) -> str:
    benannt = [r for r in rows if not r.get("is_unassigned")]
    ohne = next((r for r in rows if r.get("is_unassigned")), None)
    wer = f"{name} ({rank})" if name else f"All ASVs by {rank}"
    k = len(benannt)
    teile = [f"{wer}: {n_asv_total} ASVs in total",
             f"in {k} named {grouped_by} group{'' if k == 1 else 's'}"]
    if ohne is not None:
        teile.append(f"plus {ohne['n_asv']} without a {grouped_by} assignment "
                     f"(kept apart — no assignment is not a taxon)")
    satz = ", ".join(teile)
    if 1 < len(rows) <= 6:
        satz += " (" + " + ".join(str(r["n_asv"]) for r in rows) + f" = {n_asv_total})"
    elif len(rows) > 6:
        top = ", ".join(f"{r['taxon']} {r['n_asv']}" for r in benannt[:3])
        satz += f"; largest: {top}"
    return satz + "."


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
        RETURN s.sample_id AS sample, toString(s.date) AS date, own_count AS count,
               coalesce(s.analysed_reads_total, live_total) AS sample_total,
               n_present AS n_present, n_greater AS n_greater
        ORDER BY s.date, s.same_day_index, s.ordinal_index, s.sample_id
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
    rows = q("MATCH (s:Sample {dataset_id:$d}) RETURN toString(s.date) AS date "
             "ORDER BY s.date, s.same_day_index, s.ordinal_index, s.sample_id", d=dataset_id)
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
    "The TIMING of a maximum survives any order-preserving rescaling of this series itself; its "
    "height does not. Where the values were converted upstream by an undocumented method, that "
    "conversion acts on whole samples and can move the peak to another sample — the window then "
    "describes the converted values, which cannot be checked here. Pure counting on stored values.")


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
            return {"date": None, "index": None, "sample": None}
        return {"date": row.get("date") if axis == TIME_AXIS_DATES else None,
                "index": order.get(id(row)), "sample": row.get("sample")}

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
        "oscillation": (share_oscillation(q, dataset_id, rows)
                        if axis == TIME_AXIS_DATES else None),
    }
    if with_rank:
        out["summary"]["statement"] = trio_statement(out["summary"], qty)
    return out



def bray_curtis(x: dict, y: dict) -> "float | None":
    sx, sy = sum(x.values()), sum(y.values())
    if sx <= 0 and sy <= 0:
        return None
    if sx <= 0 or sy <= 0:
        return 1.0
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
    "Peaks per calendar year in MANTA's own reconstruction of this series' SHARES (stored value / "
    "sample total) from the same Fourier slice OTTER uses for co-occurrence (coefficients "
    "1..fft_coeffs-1 over the whole series; semantics.fourier_pattern) — a local maximum of that "
    "curve, assigned to the year of its sample. It is applied to the shares, not to the input "
    "CON correlated (the run's raw or Hellinger-transformed values), so the counts are not what "
    "CON saw. This is NOT Priest et al.'s method: they keep only statistically significant Fourier "
    "components; OTTER emits no coefficients and MANTA runs no significance test on them. Years "
    "with fewer than six samples are listed but not counted.")
OSCILLATION_REFERENCE = (
    "Priest et al. 2025, Nat Commun 16:1326 (doi:10.1038/s41467-025-56203-3) count a series as "
    "annually oscillating when it shows one peak and one trough per annual cycle, and report this "
    "for 15 % of their microeukaryotic ASVs. Named as the origin of "
    "the question; the count here follows a different, declared recipe and is not comparable "
    "one-to-one.")
OSCILLATION_MIN_SAMPLES = 6


def share_oscillation(q: Runner, dataset_id: str, rows: list[dict]) -> dict:
    return oscillation([{"date": r.get("date"), "share": r.get("share")} for r in rows],
                       int(thresholds(q, dataset_id)["fft_coeffs"]))


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
    "WITH s, sample_total, collect({label: l, value: v}) AS per_module "
    "RETURN s.sample_id AS sample, toString(s.date) AS date, sample_total AS sample_total, "
    "per_module "
    "ORDER BY s.date, s.same_day_index, s.ordinal_index, s.sample_id")
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


SPECTRUM_ABSENT_NO_TABLE = ("No spectra were recorded for this dataset: its run left no FFT "
                            "table (older runs). Recomputing the network brings them.")

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


NETWORK_SCOPE_UNRECORDED = (
    "It is not recorded how many ASVs went into the network run for this dataset. So it cannot "
    "be said whether an ASV outside the network was tested and failed the threshold, or was never "
    "part of the run.")


def network_run_scope(q: Runner, dataset_id: str, asv_id: "str | None" = None) -> dict:
    n_asv = q("MATCH (a:ASV {dataset_id:$d}) RETURN count(a) AS n", d=dataset_id)
    total = n_asv[0]["n"] if n_asv else 0
    lauf = q("MATCH (r:Run {dataset_id:$d}) WHERE r.n_asv_in_network_run IS NOT NULL "
             "RETURN r.n_asv_in_network_run AS n_in, r.run_id AS run_id "
             "ORDER BY coalesce(r.computed_at, '') DESC, r.run_id LIMIT 1", d=dataset_id)
    fft = q("MATCH (r:Run {dataset_id:$d}) WHERE r.fft_harmonics IS NOT NULL "
            "RETURN r.run_id AS run_id, "
            "COUNT { MATCH (a:ASV {dataset_id:$d}) WHERE a.fft_amplitudes IS NOT NULL } AS n_in "
            "ORDER BY coalesce(r.computed_at, '') DESC, r.run_id LIMIT 1", d=dataset_id)
    if lauf:
        basis, n_in, run_id = "run_record", lauf[0]["n_in"], lauf[0]["run_id"]
    elif fft:
        basis, n_in, run_id = "fft_table", fft[0]["n_in"], fft[0]["run_id"]
    else:
        out = {"recorded": False, "basis": None, "n_in_run": None, "n_dataset": total,
               "subset": None, "note": NETWORK_SCOPE_UNRECORDED}
        if asv_id is not None:
            netz = q("MATCH (a:ASV {dataset_id:$d, id:$a}) RETURN a.louvain_label AS l",
                     d=dataset_id, a=asv_id)
            out["in_run"] = True if (netz and netz[0]["l"] is not None) else None
        return out
    subset = n_in < total
    quelle = ("" if basis == "run_record" else
              " (counted from the run's own FFT table, which lists every ASV that entered it)")
    out = {"recorded": True, "basis": basis, "n_in_run": n_in, "n_dataset": total,
           "subset": subset, "run_id": run_id,
           "note": (f"The network was computed on {n_in} of the {total} ASVs of this dataset"
                    f"{quelle}. The other {total - n_in} were not part of the run and were "
                    f"therefore never tested for a correlation." if subset else
                    f"All {total} ASVs of this dataset were part of the network run{quelle}.")}
    if asv_id is not None:
        a = q("MATCH (a:ASV {dataset_id:$d, id:$a}) "
              "RETURN a.louvain_label AS l, a.fft_amplitudes IS NOT NULL AS fft",
              d=dataset_id, a=asv_id)
        if not a:
            out["in_run"] = None
        elif a[0]["l"] is not None or not subset:
            out["in_run"] = True
        elif fft:
            out["in_run"] = bool(a[0]["fft"])
        else:
            out["in_run"] = None
    return out


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
        reason = (SPECTRUM_ABSENT_NO_TABLE
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


def ccm_tested_directions(q: Runner, dataset_id: str) -> "int | None":
    rows = q("MATCH (r:Run {dataset_id:$d}) WHERE r.ccm_tested_directions IS NOT NULL "
             "RETURN r.ccm_tested_directions AS n "
             "ORDER BY coalesce(r.computed_at, '') DESC, r.run_id LIMIT 1", d=dataset_id)
    n = rows[0].get("n") if rows else None
    try:
        return int(n) if n is not None else None
    except (TypeError, ValueError):
        return None


def ccm_direction(q: Runner, dataset_id: str, von: str, nach: str) -> dict | None:
    for rel, decision in (("INFLUENCES", "kept"), ("CCM_REJECTED", "rejected")):
        rows = q(f"MATCH (:ASV {{id:$x, dataset_id:$d}})-[r:{rel} {{dataset_id:$d}}]->"
                 f"(:ASV {{id:$y, dataset_id:$d}}) RETURN r.nmi AS nmi, r.p_value AS p_value "
                 f"ORDER BY r.nmi DESC, r.run_id LIMIT 1", d=dataset_id, x=von, y=nach)
        if rows:
            return {**rows[0], "decision": decision}
    return None


MODULE_NAME_MAX = 40
MODULE_NAME_FORBIDDEN = frozenset("<>\"'&`")


def clean_module_name(text: str | None) -> str | None:
    if text is None:
        return None
    s = "".join(" " if ch < " " else ch for ch in str(text) if ch not in MODULE_NAME_FORBIDDEN)
    s = " ".join(s.split())
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
    getestet = ccm_tested_directions(q, dataset_id)
    satz += (f" — at most {n_null} null values ({t['num_permutations']} permutations x "
             f"{t['num_samples']} sampled pairs, both directions)")
    if getestet is None or getestet <= 0:
        return satz + (f", fewer if fewer directions were tested (not recorded for this "
                       f"dataset), so p can be no finer than 1/{n_null}.")
    n_eff = min(n_null, getestet)
    satz += (f", and OTTER caps the null at the {getestet} directions tested, so p is a multiple "
             f"of 1/{n_eff}")
    n_below = -(-n_eff // CCM_PRUNE_ALPHA_DENOM)
    if n_below <= 3:
        werte = " and ".join("0.0" if k == 0 else f"{k / n_eff:g}" for k in range(n_below))
        satz += f". Below the p < 0.05 cut only {werte} can occur at all"
    return satz + "."


def ccm_p_resolution(q: Runner, dataset_id: str) -> dict:
    t = thresholds(q, dataset_id)
    n_null = _ccm_null_size(t.get("num_permutations"), t.get("num_samples"))
    getestet = ccm_tested_directions(q, dataset_id)
    hedge = "" if t["recorded"] else ", OTTER's default — not recorded for this dataset"
    if n_null is None:
        return {"denominator": None, "exact": False,
                "short": "CCM p resolution not recorded for this dataset",
                "statement": ccm_permutation_caveat(q, dataset_id)}
    exakt = getestet is not None and getestet > 0
    nenner = min(n_null, getestet) if exakt else n_null
    kurz = (f"CCM p in steps of 1/{nenner}{'' if exakt else ' or coarser'} "
            f"({t['num_permutations']} permutations{hedge})")
    return {"denominator": nenner, "exact": exakt, "short": kurz,
            "statement": ccm_permutation_caveat(q, dataset_id)}


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

    samples = q("MATCH (s:Sample {dataset_id:$d}) RETURN s.sample_id AS sample, toString(s.date) AS date "
                "ORDER BY s.date, s.same_day_index, s.ordinal_index, s.sample_id", d=dataset_id)
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
        "WITH s, sample_total, sum(coalesce(r.count, 0.0)) AS sum_count "
        "RETURN s.sample_id AS sample, toString(s.date) AS date, sum_count AS sum_count, "
        "coalesce(sample_total, 0.0) AS sample_total "
        "ORDER BY s.date, s.same_day_index, s.ordinal_index, s.sample_id",
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
    params["reads"] = value_kind(q, dataset_id) == "reads"
    members = q(f"MATCH (a:ASV {{dataset_id:$d}}) WHERE {where} "
                f"OPTIONAL MATCH (a)<-[h:HAS_ABUNDANCE]-(:Sample {{dataset_id:$d}}) "
                f"WITH a, sum(h.count) AS summe, count(h) AS n_present "
                f"RETURN a.id AS id, a.louvain_label AS cluster, "
                f"CASE WHEN $reads THEN summe ELSE null END AS read_count_total, "
                f"n_present AS n_samples_present "
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
                 "WITH s, count(r) AS n_members_present "
                 "RETURN s.sample_id AS sample, toString(s.date) AS date, "
                 "n_members_present AS n_members_present "
                 "ORDER BY s.date, s.same_day_index, s.ordinal_index, s.sample_id",
                 d=dataset_id, ids=member_ids)
        return {"rows": rows, "absent_reason": TAXON_SUM_ABSENT, "value_kind": kind}
    rows = q("MATCH (s:Sample {dataset_id:$d}) "
             "OPTIONAL MATCH (s)-[all:HAS_ABUNDANCE]->(:ASV {dataset_id:$d}) "
             "WITH s, sum(all.count) AS live_total "
             "WITH s, coalesce(s.analysed_reads_total, live_total) AS sample_total "
             "OPTIONAL MATCH (s)-[r:HAS_ABUNDANCE]->(a:ASV {dataset_id:$d}) WHERE a.id IN $ids "
             "WITH s, sample_total, sum(coalesce(r.count, 0.0)) AS sum_count, "
             "sum(CASE WHEN r.count > 0 THEN 1 ELSE 0 END) AS n_members_present "
             "RETURN s.sample_id AS sample, toString(s.date) AS date, "
             "sum_count AS sum_count, n_members_present AS n_members_present, "
             "coalesce(sample_total, 0.0) AS sample_total "
             "ORDER BY s.date, s.same_day_index, s.ordinal_index, s.sample_id",
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



ENV_LINK_NOTE = (
    "A lagged rank correlation between a measured variable and the ASV's share of the sample — "
    "shifts are counted in samples, not time units (sampling intervals are irregular). A link "
    "is covariation with a delay, not a response and not a cause; shares move when other taxa "
    "move. The best of 2L+1 shifts was chosen; the correction (Benjamini-Hochberg) runs across "
    "the pairs of one variable, not across the shifts.")
ENV_LINK_ABSENT_NO_RUN = ("No environment links are stored for this dataset "
                          "(removed by a rebuild or not yet computed).")


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


ACTIVITY_SECOND_RUN_RATIO = 2 / 3


def activity(freq: dict) -> dict:
    axis = freq.get("time_axis")
    pts = freq.get("points") or []
    if axis == TIME_AXIS_DATES and (freq.get("seasonal") or {}).get("climatology"):
        climo = [c for c in freq["seasonal"]["climatology"] if c.get("mean") is not None]
        if not climo:
            return {"axis": axis, "window": [], "windows": [], "peak": None, "n_min": 0,
                    "statement": None}
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
        mittel = {c["month"]: c["mean"] for c in climo}
        ueber = {tuple(r): sum(mittel[m] - overall for m in r) for r in runs}
        reihe = sorted(runs, key=lambda r: (-ueber[tuple(r)], r[0]))
        if reihe:
            best = reihe[0]
            fenster = [best] + [r for r in reihe[1:2]
                                if ueber[tuple(r)] >= ACTIVITY_SECOND_RUN_RATIO * ueber[tuple(best)]]
        else:
            best = [peak["month"]]
            fenster = [best]

        def _label(r):
            return (MONTHS[r[0] - 1] if len(r) == 1
                    else f"{MONTHS[r[0] - 1]}–{MONTHS[r[-1] - 1]}")

        im_fenster = {m for r in fenster for m in r}
        n_min = min((c["n"] for c in climo if c["month"] in im_fenster), default=0)
        spitze = MONTHS[peak["month"] - 1]
        peak_lauf = next((r for r in fenster if peak["month"] in r), None)
        satz = "strongest in " + " and ".join(_label(r) for r in fenster)
        if peak_lauf is not None:
            if (len(im_fenster) > 1 and sum(
                    1 for c in climo if c["month"] in im_fenster and c["mean"] == peak["mean"]) == 1):
                satz += f", peaking in {spitze}"
        else:
            satz += f"; the single highest month, {spitze}, lies outside this window"
        return {
            "axis": axis, "window": [MONTHS[m - 1] for m in best],
            "windows": [[MONTHS[m - 1] for m in r] for r in fenster],
            "peak": spitze, "n_min": n_min,
            "statement": satz,
        }

    shares = [(p.get("share"), i + 1) for i, p in enumerate(pts) if p.get("share") is not None]
    if not shares:
        return {"axis": axis, "window": [], "windows": [], "peak": None, "n_min": 0,
                "statement": None}
    best_share, best_i = max(shares)
    return {
        "axis": axis, "window": [], "windows": [], "peak": f"sample {best_i}", "n_min": 1,
        "statement": f"strongest at sample {best_i} of {len(pts)} — this dataset has no calendar "
                     f"dates, so the position is the answer, not a season",
    }



ENVIRONMENT_UNITS_SOURCE = (f"{SOURCE_PUBLICATION} (Methods) — the labels and units MANTA "
                            f"declares for these column names are taken from it")

ENVIRONMENT_VARS: list[dict] = [
    {"key": "temp", "source_column": "temp", "label": "Water temperature",
     "unit": "°C", "unit_note": None, "role": "environment", "scale": "interval"},
    {"key": "sal", "source_column": "sal", "label": "Salinity",
     "unit": "PSU", "unit_note": None, "role": "environment", "scale": "ratio"},
    {"key": "depth", "source_column": "depth", "label": "Sampling depth",
     "unit": "m", "unit_note": None, "role": "coordinate", "scale": "ratio"},
    {"key": "mld", "source_column": "MLD", "label": "Mixed Layer Depth (MLD)",
     "unit": "m", "unit_note": None, "role": "environment", "scale": "ratio"},
    {"key": "chl_sens", "source_column": "chl_sens",
     "label": "Chlorophyll concentration (in situ sensor)",
     "unit": "μg l⁻¹", "unit_note": None, "role": "environment", "scale": "ratio"},
    {"key": "par_satellite", "source_column": "PAR_satellite",
     "label": "Photosynthetically Active Radiation (PAR)",
     "unit": "μmol photons m⁻² d⁻¹", "unit_note": None, "role": "environment", "scale": "ratio"},
    {"key": "pw_frac", "source_column": "PW_frac", "label": "Polar Water Fraction",
     "unit": "%", "unit_note": None, "role": "environment", "scale": "ratio"},
    {"key": "o2_conc", "source_column": "O2_conc", "label": "Oxygen concentration",
     "unit": "μmol l⁻¹", "unit_note": None, "role": "environment", "scale": "ratio"},
]

ENVIRONMENT_KEYS = [v["key"] for v in ENVIRONMENT_VARS]

ENV_NOT_MEASURED = (
    "No environmental variable was measured on any sample of this dataset, so there is nothing "
    "to relate an ASV to.")


def env_variable_not_measured(variable: str) -> str:
    return (f"Variable {variable!r} was not measured on any sample of this dataset, so there is "
            f"nothing to relate an ASV to.")

_PUBLICATION_UNIT_NOTES: dict[str, str] = {
    "par_satellite": ("The publication states μmol photons m⁻² d⁻¹. The values in this dataset "
                      "run from 0 to 24, which is the usual magnitude of a polar summer day in "
                      "MOL photons m⁻² d⁻¹, not μmol. The values are shown unchanged; the unit "
                      "is the published one and the mismatch is left visible rather than "
                      "corrected here."),
    "pw_frac": ("The publication states %. Every value in this dataset lies between 0 and 0.68, "
                "so the column holds a fraction of one, not a percentage. Shown unchanged — "
                "multiplying by 100 would be our arithmetic, not the measurement."),
}

ENVIRONMENT_PROVENANCE = (
    "Environmental parameters supplied with this dataset's metadata, carried through unchanged "
    "— not derived from the sequences and not modelled by MANTA. Where a sample has no value "
    "the curve has a hole; nothing is interpolated."
)

ENVIRONMENT_PROVENANCE_PUBLICATION = (
    "The eight environmental parameters recorded alongside the samples at mooring site F4, "
    "carried through unchanged — measured, not derived from the sequences and not modelled. "
    "Where a sample has no value the curve has a hole; nothing is interpolated."
)

ENVIRONMENT_UNITS_NOTE = (
    "Units are as declared for the column names; MANTA does not convert them. The source table "
    "itself carries no units."
)

ENVIRONMENT_UNITS_NOTE_PUBLICATION = (
    f"Parameter names and units follow {SOURCE_PUBLICATION} (Methods) — the publication for "
    f"this dataset. The source table itself carries no units. Two of them do not match the "
    f"values in this dataset; that is stated at the parameter instead of being corrected."
)


def _environment_specs(publication: bool) -> list[dict]:
    return [{**v, "unit_note": (_PUBLICATION_UNIT_NOTES.get(v["key"], v["unit_note"])
                                if publication else v["unit_note"])}
            for v in ENVIRONMENT_VARS]


def environment_vars(q: Runner, dataset_id: str) -> list[dict]:
    return _environment_specs(is_publication_dataset(q, dataset_id))


def environment_units_note(q: Runner, dataset_id: str) -> str:
    return (ENVIRONMENT_UNITS_NOTE_PUBLICATION if is_publication_dataset(q, dataset_id)
            else ENVIRONMENT_UNITS_NOTE)




def environment_profile(q: Runner, dataset_id: str, asv_id: str) -> dict:
    props = ", ".join(f"s.`{v['key']}` AS `{v['key']}`" for v in ENVIRONMENT_VARS)
    rows = q(f"MATCH (s:Sample {{dataset_id:$d}})-[h:HAS_ABUNDANCE]->"
             f"(a:ASV {{id:$a, dataset_id:$d}}) WHERE h.count > 0 "
             f"WITH s, h.count AS eigen "
             f"MATCH (s)-[x:HAS_ABUNDANCE]->(:ASV {{dataset_id:$d}}) "
             f"WITH s, eigen, sum(x.count) AS live "
             f"RETURN toFloat(eigen) / coalesce(s.analysed_reads_total, live) AS w, {props} "
             f"ORDER BY s.date, s.same_day_index, s.ordinal_index, s.sample_id",
             d=dataset_id, a=asv_id)
    specs = environment_vars(q, dataset_id)
    return _weighted_env_profile(rows, specs, environment_ranges(q, dataset_id, specs))


def environment_ranges(q: Runner, dataset_id: str,
                       specs: "list[dict] | None" = None) -> dict[str, tuple[float, float]]:
    specs = ENVIRONMENT_VARS if specs is None else specs
    if not specs:
        return {}
    props = ", ".join(f"min(s.`{v['key']}`) AS `lo_{v['key']}`, max(s.`{v['key']}`) AS `hi_{v['key']}`"
                      for v in specs)
    rows = q(f"MATCH (s:Sample {{dataset_id:$d}}) RETURN {props}", d=dataset_id)
    if not rows:
        return {}
    r = rows[0]
    out: dict[str, tuple[float, float]] = {}
    for v in specs:
        lo, hi = r.get(f"lo_{v['key']}"), r.get(f"hi_{v['key']}")
        if isinstance(lo, (int, float)) and isinstance(hi, (int, float)):
            out[v["key"]] = (float(lo), float(hi))
    return out


CLUSTER_SERIES_DEFINITION = (
    "A cluster's time series is the weighted sum of the abundance values of its member ASVs "
    "per sample.")


def cluster_environment_profile(q: Runner, dataset_id: str, louvain_label: int) -> dict:
    props = ", ".join(f"s.`{v['key']}` AS `{v['key']}`" for v in ENVIRONMENT_VARS)
    rows = q(f"MATCH (s:Sample {{dataset_id:$d}})-[h:HAS_ABUNDANCE]->(a:ASV {{dataset_id:$d}}) "
             f"WHERE a.louvain_label = $l WITH s, sum(h.count) AS eigen WHERE eigen > 0 "
             f"MATCH (s)-[x:HAS_ABUNDANCE]->(:ASV {{dataset_id:$d}}) "
             f"WITH s, eigen, sum(x.count) AS live "
             f"RETURN toFloat(eigen) / coalesce(s.analysed_reads_total, live) AS w, {props} "
             f"ORDER BY s.date, s.same_day_index, s.ordinal_index, s.sample_id",
             d=dataset_id, l=louvain_label)
    specs = environment_vars(q, dataset_id)
    out = _weighted_env_profile(rows, specs, environment_ranges(q, dataset_id, specs))
    out["series_definition"] = CLUSTER_SERIES_DEFINITION
    out["series_note"] = ("Method after " + SOURCE_PUBLICATION + "; the publication does not name "
                          "the weights, MANTA uses equal weights (the plain sum of the members' "
                          "values per sample — the same collective curve the cluster panel draws).")
    return out


def _weighted_env_profile(rows: list[dict], specs: "list[dict] | None" = None,
                          ranges: "dict[str, tuple[float, float]] | None" = None) -> dict:
    n_present = len(rows)
    items = []
    for spec in (ENVIRONMENT_VARS if specs is None else specs):
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

        mittel = sum(x * w for x, w in pairs) / wsum
        sd = ((sum(w * (x - mittel) ** 2 for x, w in pairs) / wsum) ** 0.5
              if len(pairs) > 1 else None)
        spanne = (ranges or {}).get(key)
        items.append({"key": key, "label": spec["label"], "unit": spec["unit"],
                      "unit_note": spec.get("unit_note"),
                      "weighted_mean": mittel, "weighted_sd": sd,
                      "p10": pct(0.10), "p25": pct(0.25), "median": pct(0.50),
                      "p75": pct(0.75), "p90": pct(0.90),
                      "dataset_min": spanne[0] if spanne else None,
                      "dataset_max": spanne[1] if spanne else None,
                      "n_samples_used": len(pairs), "n_samples_present": n_present})
    return {
        "items": items,
        "method": ("Weighted by the subject's SHARE of each sample (its stored value divided "
                   "by the sample total — the share the curves show, so sequencing depth does "
                   "not set the weight), over all samples with a "
                   "detection (count > 0) and a measured value; the percentiles (10th, 25th, "
                   "median, 75th, 90th) are each the smallest value whose cumulative weight "
                   "reaches that fraction of the total weight. The axis range is the smallest "
                   "and largest measured value over ALL samples of the dataset. The spread is "
                   "the weighted standard deviation around that mean — "
                   "how far the conditions scattered, not how precise the mean is. Samples "
                   "without a measurement are excluded, never filled."),
        "caveat": ("A weighted summary of the conditions this ASV was found under — NOT a "
                   "niche model, NOT an optimum in the physiological sense, and NOT a "
                   "correlation: with compositional data such a correlation would partly "
                   "measure the shifts of the other taxa."),
    }


SAMPLER_NOTE = (
    "Sampling depth is the depth stored with each sample. A sample below the mixed layer depth "
    "(MLD) comes from a different water body than one above it on the same date; where the "
    "sampling depth changes over time, a seasonal pattern can therefore come from where the "
    "sample was taken, not from the organism.")

SAMPLER_NOTE_PUBLICATION = (
    "Sampling depth is where the sampler hung on that day — a drifting mooring, not a chosen "
    "depth. A sample below the mixed layer depth (MLD) comes from a different water body than "
    "one above it on the same date; a seasonal pattern can therefore be the sampler's, not the "
    "organism's.")


def sampler_position(rows: list[dict], note: str = SAMPLER_NOTE) -> "dict | None":
    mit_tiefe = [r for r in rows if r.get("depth") is not None]
    if not mit_tiefe:
        return None
    samples, n = [], {"within": 0, "below": 0, "unknown": 0}
    for r in mit_tiefe:
        if r.get("mld") is None:
            lage = "unknown"
        elif r["depth"] <= r["mld"]:
            lage = "within"
        else:
            lage = "below"
        n[lage] += 1
        samples.append({"sample": r["sample"], "date": r.get("date"), "depth": r["depth"],
                        "mld": r.get("mld"), "position": lage})
    tiefen = [r["depth"] for r in mit_tiefe]
    mlds = [r["mld"] for r in mit_tiefe if r.get("mld") is not None]
    satz = f"{n['within']} of {len(mit_tiefe)} samples within the mixed layer, {n['below']} below it"
    if n["unknown"]:
        satz += f", {n['unknown']} unknown"
    satz += f" · sampling depth {min(tiefen):.0f}–{max(tiefen):.0f} m"
    return {"n_within": n["within"], "n_below": n["below"], "n_unknown": n["unknown"],
            "n_total": len(mit_tiefe), "samples": samples, "statement": satz + ".",
            "note": note}


def _solar_marks(lat: float, lon: float, jahr: int) -> list[dict]:
    import datetime as _dt
    anfang = _dt.date(jahr, 1, 1)
    dek = [(d, tageslicht.declination(anfang + _dt.timedelta(days=d - 1), lon))
           for d in range(1, 366)]
    nord = lat >= 0
    marks: list[dict] = []
    for (_, a), (d1, b) in zip(dek, dek[1:]):
        if a < 0 <= b:
            marks.append({"doy": d1, "label": "spring equinox" if nord else "autumn equinox"})
        elif a > 0 >= b:
            marks.append({"doy": d1, "label": "autumn equinox" if nord else "spring equinox"})
    hoch = max(dek, key=lambda x: x[1])[0]
    tief = min(dek, key=lambda x: x[1])[0]
    marks.append({"doy": hoch, "label": "summer solstice" if nord else "winter solstice"})
    marks.append({"doy": tief, "label": "winter solstice" if nord else "summer solstice"})
    return sorted(marks, key=lambda m: m["doy"])


SEASON_METHOD = ("Three readings of one year: the sun's own dates, the light at this latitude, "
                 "and the mixing of the water column.")
SEASON_CAVEAT = ("Sun and light are computed for the station's latitude in the reference year; "
                 "the water marks are monthly means of the MEASURED mixed layer depth, no model.")


def seasons(q: Runner, dataset_id: str) -> dict:
    if time_axis(q, dataset_id) != TIME_AXIS_DATES:
        return {"dataset_id": dataset_id, "available": False,
                "absent_reason": ("No seasons: this dataset has no calendar dates, only an "
                                  "order of samples."),
                "astronomical": [], "light": [], "water": [], "water_note": "",
                "method": SEASON_METHOD, "caveat": SEASON_CAVEAT}
    ly = light_year(q, dataset_id)
    out = {"dataset_id": dataset_id, "available": bool(ly.get("available")),
           "absent_reason": ly.get("absent_reason"),
           "astronomical": ly.get("solar_marks", []), "light": [], "water": [],
           "water_note": "", "method": SEASON_METHOD, "caveat": SEASON_CAVEAT}
    for b in ly.get("bands", []):
        anfang = "polar night begins" if b["kind"] == "polar_night" else "midnight sun begins"
        ende = "the sun returns" if b["kind"] == "polar_night" else "midnight sun ends"
        if b["start_doy"] > 1:
            out["light"].append({"doy": b["start_doy"], "label": anfang})
        if b["end_doy"] < 365:
            out["light"].append({"doy": b["end_doy"] + 1, "label": ende})
    out["light"].sort(key=lambda m: m["doy"])

    mld = next((v for v in environment(q, dataset_id).get("variables", []) if v["key"] == "mld"),
               None)
    monate = {m["month"]: m["mean"] for m in (mld or {}).get("monthly", [])}
    if len(monate) < 6:
        out["water_note"] = ("No water marks: mixed layer depth missing, or fewer than six "
                             "months of the year carry one.")
        return out
    mittel = sum(monate.values()) / len(monate)
    reihe = sorted(monate)
    for a, b in zip(reihe, reihe[1:] + reihe[:1]):
        va, vb = monate[a], monate[b]
        if va > mittel >= vb:
            out["water"].append({"doy": _CUM_DAYS[b - 1] + 1, "label": "stratification begins"})
        elif va <= mittel < vb:
            out["water"].append({"doy": _CUM_DAYS[b - 1] + 1, "label": "mixing begins"})
    out["water"].sort(key=lambda m: m["doy"])
    out["water_note"] = (f"Mixed layer depth crosses its annual mean of {mittel:.0f} m; "
                         f"{len(monate)} of 12 months carry a measurement.")
    return out


def light_year(q: Runner, dataset_id: str) -> dict:
    st = _station(q, dataset_id)
    if not st or st.get("lat") is None:
        return {"available": False,
                "absent_reason": station_absent_reason(q, dataset_id) or LIGHT_ABSENT_NO_STATION,
                "bands": [], "shortest_day_doy": None, "lat": None}
    import datetime as _dt
    jahr = 2019
    b = tageslicht.bands(st["lat"], _dt.date(jahr, 1, 1), _dt.date(jahr, 12, 31), st.get("lon") or 0.0)
    baender = [{"kind": x["kind"],
                "start_doy": _dt.date.fromisoformat(x["start"]).timetuple().tm_yday,
                "end_doy": _dt.date.fromisoformat(x["end"]).timetuple().tm_yday} for x in b]
    kuerzester = 355 if st["lat"] >= 0 else 172
    rueckkehr = None
    for x in baender:
        if x["kind"] == "polar_night" and x["start_doy"] == 1:
            rueckkehr = x["end_doy"] + 1
    lon = st.get("lon") or 0.0
    laengen = [round(tageslicht.daylength_hours(st["lat"], _dt.date(jahr, 1, 1) + _dt.timedelta(days=i), lon), 2)
               for i in range(365)]
    return {"available": True, "bands": baender, "shortest_day_doy": kuerzester,
            "sun_return_doy": rueckkehr, "lat": st["lat"], "reference_year": jahr,
            "day_length_doy": laengen, "solar_marks": _solar_marks(st["lat"], lon, jahr),
            "legend": LIGHT_LEGEND}


def environment(q: Runner, dataset_id: str) -> dict:
    axis = time_axis(q, dataset_id)
    props = ", ".join(f"s.`{v['key']}` AS `{v['key']}`" for v in ENVIRONMENT_VARS)
    rows = q(f"MATCH (s:Sample {{dataset_id:$d}}) RETURN s.sample_id AS sample, toString(s.date) AS date, "
             f"{props} ORDER BY s.date, s.same_day_index, s.ordinal_index, s.sample_id", d=dataset_id)
    n_sample = len(rows)
    pub = is_publication_dataset(q, dataset_id)

    variables, absent = [], []
    for spec in _environment_specs(pub):
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
            per_year_month: dict[str, dict[int, list[float]]] = {}
            for r in rows:
                year, month = ym(r["date"])
                if month is not None and r[key] is not None:
                    per_month.setdefault(month, []).append(r[key])
                    if year:
                        per_year_month.setdefault(year, {}).setdefault(month, []).append(r[key])
            item["monthly"] = [{"month": m, "label": MONTHS[m - 1],
                                "mean": sum(per_month[m]) / len(per_month[m]),
                                "n": len(per_month[m])}
                               for m in sorted(per_month)]
            item["monthly_by_year"] = {
                y: [{"month": m, "label": MONTHS[m - 1],
                     "mean": sum(vals[m]) / len(vals[m]), "n": len(vals[m])}
                    for m in sorted(vals)]
                for y, vals in sorted(per_year_month.items())}
        variables.append(item)

    sampler = sampler_position([{"sample": r["sample"],
                                 "date": r["date"] if axis == TIME_AXIS_DATES else None,
                                 "depth": r.get("depth"), "mld": r.get("mld")} for r in rows],
                               note=SAMPLER_NOTE_PUBLICATION if pub else SAMPLER_NOTE)
    return {
        "dataset_id": dataset_id,
        "time_axis": axis,
        "n_sample": n_sample,
        "variables": variables,
        "absent": absent,
        "sampler": sampler,
        "provenance": ENVIRONMENT_PROVENANCE_PUBLICATION if pub else ENVIRONMENT_PROVENANCE,
        "units_note": ENVIRONMENT_UNITS_NOTE_PUBLICATION if pub else ENVIRONMENT_UNITS_NOTE,
        "absent_reason": (
            "" if variables else
            "No environmental values were supplied with this dataset. The chain carries "
            "environmental data end to end, but this import brought none, so there is nothing to "
            "show. Any temperature or salinity stated for this dataset would be invented."
        ),
    }



LIGHT_LEGEND = ("polar night (day length 0 h) · polar day (24 h) — astronomical, "
                "from latitude and date")

LIGHT_ABSENT_NO_STATION = (
    "No light bands: this dataset has no station, so there is no latitude to compute them from. "
    "The synthetic test datasets are the case this is built for — a placeholder 0/0 is not a "
    "place at the equator.")
LIGHT_ABSENT_SEVERAL_STATIONS = (
    "No light bands: this dataset's samples point to more than one station, so there is no "
    "single latitude to compute them from. That is a data error to repair, not a place.")
LIGHT_ABSENT_ORDINAL = (
    "No light bands: this dataset's samples carry an order, not calendar dates. Day length needs "
    "a real date; the placeholder dates would produce a band that means nothing.")


def _station(q: Runner, dataset_id: str) -> "dict | None":
    rows = q("MATCH (:Sample {dataset_id:$d})-[:AT_STATION]->(st:Station) "
             "RETURN DISTINCT st.station_id AS station_id, st.location.latitude AS lat, "
             "st.location.longitude AS lon ORDER BY lat, lon, station_id", d=dataset_id)
    return rows[0] if len(rows) == 1 else None


def station_absent_reason(q: Runner, dataset_id: str) -> "str | None":
    rows = q("MATCH (:Sample {dataset_id:$d})-[:AT_STATION]->(st:Station) "
             "RETURN count(DISTINCT st) AS n", d=dataset_id)
    n = rows[0]["n"] if rows else 0
    if n == 1:
        return None
    return LIGHT_ABSENT_SEVERAL_STATIONS if n > 1 else LIGHT_ABSENT_NO_STATION


def sample_light(q: Runner, dataset_id: str) -> dict:
    import datetime as _dt

    st = _station(q, dataset_id)
    axis = time_axis(q, dataset_id)
    if st is None:
        return {"available": False,
                "absent_reason": station_absent_reason(q, dataset_id) or LIGHT_ABSENT_NO_STATION,
                "samples": []}
    if axis != TIME_AXIS_DATES:
        return {"available": False, "absent_reason": LIGHT_ABSENT_ORDINAL, "samples": []}
    rows = q("MATCH (s:Sample {dataset_id:$d}) WHERE s.date IS NOT NULL "
             "RETURN s.sample_id AS sample, toString(s.date) AS date "
             "ORDER BY s.date, s.same_day_index, s.ordinal_index, s.sample_id", d=dataset_id)
    aus = []
    for r in rows:
        d = _dt.date.fromisoformat(r["date"])
        aus.append({"sample": r["sample"], "date": r["date"],
                    **{k: v for k, v in
                       tageslicht.light(st["lat"], d, st["lon"]).items()
                       if k not in ("available", "absent_reason")}})
    return {"available": True, "absent_reason": None, "station": st,
            "method": tageslicht.METHOD, "reference": tageslicht.REFERENCE,
            "caveat": tageslicht.NOT_ECOLOGY, "samples": aus}


def light_bands(q: Runner, dataset_id: str) -> dict:
    import datetime as _dt

    st = _station(q, dataset_id)
    axis = time_axis(q, dataset_id)
    leer = {"available": False, "bands": [], "per_sample": [], "year": None, "station": None, "from": None, "to": None,
            "legend": LIGHT_LEGEND, "method": tageslicht.METHOD,
            "reference": tageslicht.REFERENCE, "caveat": tageslicht.NOT_ECOLOGY}
    if st is None:
        return {**leer,
                "absent_reason": station_absent_reason(q, dataset_id) or LIGHT_ABSENT_NO_STATION}
    if axis != TIME_AXIS_DATES:
        return {**leer, "absent_reason": LIGHT_ABSENT_ORDINAL}
    spanne = q("MATCH (s:Sample {dataset_id:$d}) WHERE s.date IS NOT NULL "
               "RETURN toString(min(s.date)) AS von, toString(max(s.date)) AS bis", d=dataset_id)
    if not spanne or not spanne[0]["von"]:
        return {**leer, "absent_reason": LIGHT_ABSENT_ORDINAL}
    von, bis = spanne[0]["von"], spanne[0]["bis"]
    b = tageslicht.bands(st["lat"], _dt.date.fromisoformat(von), _dt.date.fromisoformat(bis),
                         st["lon"])
    proben = q("MATCH (s:Sample {dataset_id:$d}) WHERE s.date IS NOT NULL "
               "RETURN s.sample_id AS sample, toString(s.date) AS date "
               "ORDER BY s.date, s.same_day_index, s.ordinal_index, s.sample_id",
               d=dataset_id)
    per_sample = []
    for r in proben:
        l = tageslicht.light(st["lat"], _dt.date.fromisoformat(r["date"][:10]), st["lon"])
        per_sample.append({"sample": r["sample"], "date": r["date"][:10],
                           "day_length_h": l["day_length_h"], "polar_night": l["polar_night"],
                           "polar_day": l["polar_day"]})
    return {**leer, "available": True, "absent_reason": None, "station": st,
            "from": von, "to": bis, "bands": b, "per_sample": per_sample,
            "year": light_year(q, dataset_id)}



CHAIN_NOT_RECORDED = "not recorded"
CHAIN_NOTE = (
    "Every link below is something already stored — from the graph or from the provenance "
    "manifest of the answer. Nothing here was collected for this view, and a missing link says "
    "so instead of being bridged.")


def provenance_chain(q: Runner, dataset_id: str) -> dict:
    st = _station(q, dataset_id)
    ds = q("MATCH (d:Dataset {dataset_id:$d}) RETURN d.region AS region, d.marker AS marker, "
           "d.dada2_provenance AS dada2, d.citation AS citation, d.source_doi AS doi, "
           "d.value_kind AS value_kind, coalesce(d.time_axis,'ordinal') AS time_axis",
           d=dataset_id)
    d0 = ds[0] if ds else {}
    smp = q("MATCH (s:Sample {dataset_id:$d}) RETURN count(s) AS n, "
            "toString(min(s.date)) AS von, toString(max(s.date)) AS bis", d=dataset_id)
    s0 = smp[0] if smp else {}
    thr = thresholds(q, dataset_id)

    LAUF_ABFRAGE = {
        "EnvLinkRun": ("MATCH (r:EnvLinkRun {dataset_id:$d}) RETURN properties(r) AS p "
                       "ORDER BY r.run_id LIMIT 1"),
    }

    def lauf(label: str, schluessel: str) -> dict:
        rows = q(LAUF_ABFRAGE[label], d=dataset_id)
        if not rows:
            return {"present": False, "detail": CHAIN_NOT_RECORDED, "params": {}}
        p = {k: v for k, v in rows[0]["p"].items() if k != "dataset_id"}
        return {"present": True, "detail": p.get(schluessel), "params": p}

    glieder = [
        {"step": "station", "label": "Station",
         "present": st is not None,
         "detail": (f"{st['station_id']} at {st['lat']:.4f}, {st['lon']:.4f}" if st
                    else CHAIN_NOT_RECORDED),
         "params": dict(st) if st else {}},
        {"step": "samples", "label": "Samples",
         "present": bool(s0.get("n")),
         "detail": (f"{s0.get('n')} samples"
                    + (f", {s0.get('von')} to {s0.get('bis')}" if s0.get("von") else
                       " (order only, no calendar)")),
         "params": {"n": s0.get("n"), "time_axis": d0.get("time_axis"),
                    "value_kind": d0.get("value_kind")}},
        {"step": "dada2", "label": "DADA2 provenance",
         "present": bool(d0.get("dada2")) and d0.get("dada2") not in ("unknown", "absent"),
         "detail": d0.get("dada2") or CHAIN_NOT_RECORDED, "params": {}},
        {"step": "run", "label": "Network run (OTTER)",
         "present": bool(thr.get("recorded")),
         "detail": (f"{thr.get('run_id')}" + (f", computed {thr['computed_at']}"
                                              if thr.get("computed_at") else "")
                    if thr.get("run_id") else CHAIN_NOT_RECORDED),
         "params": {k: thr.get(k) for k in THRESHOLD_KEYS if thr.get(k) is not None}},
        {**lauf("EnvLinkRun", "run_id"), "step": "env_links", "label": "Environment links"},
        {"step": "source", "label": "Source publication",
         "present": bool(d0.get("citation") or d0.get("doi")),
         "detail": (d0.get("citation") or d0.get("doi") or CHAIN_NOT_RECORDED),
         "params": {"doi": d0.get("doi")} if d0.get("doi") else {}},
    ]
    for g in glieder:
        g.setdefault("params", {})
        if not g["present"] and not g.get("detail"):
            g["detail"] = CHAIN_NOT_RECORDED
    return {"dataset_id": dataset_id, "note": CHAIN_NOTE,
            "n_recorded": sum(1 for g in glieder if g["present"]),
            "n_links": len(glieder), "chain": glieder}



CENTRALITY_MEASURES: dict[str, str] = {
    "con_degree": "number of association partners",
    "con_cluster_closeness": "closeness within its own co-occurrence community",
    "con_closeness": "closeness in the whole co-occurrence network",
    "con_cluster_betweenness": "betweenness within its own co-occurrence community",
    "con_betweenness": "betweenness in the whole co-occurrence network",
}

CENTRALITY_CAVEATS: dict[str, str] = {
    "con_degree": (
        "The degree counts the links that survived THIS run's thresholds — a lower correlation "
        "cut would give every ASV more partners. The number is exact for this network, not a "
        "property of the organism."),
    "con_cluster_closeness": (
        "OTTER computes the intra-community centralities on the unweighted network — "
        "how strongly two ASVs correlate does not enter the measure, only whether they are "
        "linked at all. In addition, the module subgraph it uses leaves out every member that "
        "appears only as the second end of its links, together with those links: the stored "
        "value is not the closeness within the full module, and such members carry none. "
        "Criterion 2 (`criterion2`) is computed by MANTA itself instead."),
    "con_cluster_betweenness": (
        "OTTER computes the intra-community centralities on the unweighted network — "
        "how strongly two ASVs correlate does not enter the measure, only whether they are "
        "linked at all. In addition, the module subgraph it uses leaves out every member that "
        "appears only as the second end of its links, together with those links: the stored "
        "value is not the betweenness within the full module, and such members carry none."),
    "con_closeness": (
        "The stored whole-network closeness was computed on a DIRECTED version of the "
        "co-occurrence network whose arrows only follow the column order of the ASVs at import "
        "— it is not the closeness of the undirected network, and an ASV with many partners can "
        "carry 0. Unlike the betweenness, it does not differ between CPU architectures."),
    "con_betweenness": (
        "The stored whole-network betweenness was computed on a DIRECTED version of the "
        "co-occurrence network whose arrows only follow the column order of the ASVs at import "
        "— it is not the betweenness of the undirected network. "
        "Measured across two CPU architectures: only the top 10 betweenness "
        "positions were stable between architectures — a threshold that reaches below them "
        "marks nodes whose order the hardware picked."),
}

EDGE_WIDTH_LEGEND = {
    "con": ("Line width ∝ r (only positive correlations at or above the threshold are links) — "
            "fixed scale from {min} (the run's threshold) to {max}, the same in every filter."),
    "ccm": ("Line width ∝ NMI (the larger of a link's directions) — fixed scale from {min} to "
            "{max}, the same in every filter."),
    "rejected": ("Line width ∝ NMI of the rejected direction (the larger where both were "
                 "rejected) — fixed scale from {min} to {max}, the same in every filter."),
}


def edge_width_scale(t: dict) -> dict:
    con_tr = t.get("con_tr")
    lo = float(con_tr) if isinstance(con_tr, (int, float)) and 0 <= con_tr < 1 else 0.0
    return {"con": [lo, 1.0], "ccm": [0.0, 1.0], "rejected": [0.0, 1.0]}



CRITERION2_ALPHA = 0.05
CRITERION2_MIN_MODULE = 3

CRITERION2_LABEL = ("high closeness centrality within its co-occurrence community — criterion 2 "
                    "of the keystone definition (Oldenburg et al. 2024)")
CRITERION2_PAPER_WORDING = ("a high centrality (closeness) value within its co-occurrence "
                            "community")
CRITERION2_SOURCE_DOI = SOURCE_PUBLICATION_DOI
CRITERION2_SOURCE_LOCATION = 'Methods, "Keystone species definition"'
CRITERION2_SOURCE = (f"{SOURCE_PUBLICATION}, doi:{SOURCE_PUBLICATION_DOI} — "
                     f"{CRITERION2_SOURCE_LOCATION}")
CRITERION2_METHOD = (
    "Computed by MANTA from the stored links (the centrality values stored with the network run "
    "are not used), on the undirected co-occurrence (CON) network of this dataset. For each "
    "module (Louvain label): the subgraph of all its members and all links with both ends in "
    "the module. Closeness of each member within that subgraph, unweighted: "
    "c_i = (n − 1) / Σ d(i, j), with n the number of members and d the number of links on the "
    "shortest path (breadth-first search). For each ASV i: a one-sided one-sample t-test of the "
    "closeness values of all members of its module against c_i — "
    "scipy.stats.ttest_1samp(module closeness values, popmean=c_i, alternative='less'). "
    "Benjamini–Hochberg correction over all testable network ASVs of the dataset; the criterion "
    f"is met at q ≤ {CRITERION2_ALPHA:g}.")
CRITERION2_FORMULA = (
    "c_i = (n − 1) / Σ d(i, j) in the module subgraph; "
    "p_i = ttest_1samp(module closeness values, popmean=c_i, alternative='less'); "
    f"Benjamini–Hochberg over all testable network ASVs; met at q ≤ {CRITERION2_ALPHA:g}")
CRITERION2_NOT_KEYSTONE = (
    "Not a keystone on its own: criteria 1 and 3 are not tested — the paper also requires a "
    "significant NMI (at least one significant CCM link) and presence in at least one stable "
    "state of the energy landscape; only all three together define a keystone there.")
CRITERION2_TITLE = "Criterion 2 of the keystone definition (Oldenburg et al. 2024)"
CRITERION2_MARK = ("meets criterion 2 of the keystone definition (Oldenburg et al. 2024) — "
                   "not a keystone on its own")
CRITERION2_GLOW = ("central in its module: closeness significantly above the module mean "
                   f"(one-sided t-test, Benjamini–Hochberg q ≤ {CRITERION2_ALPHA:g}; "
                   "Oldenburg et al. 2024)")
CRITERION2_SELECTION = (
    "A selection step: about half of the nodes pass. The t-test compares c_i with the standard "
    "error of the module mean, not with the spread of the members — it marks the upper part of "
    "a module, not outliers, and says nothing about an ecological role.")
CRITERION2_REASONS: dict[str, str] = {
    "module_too_small": (f"its module has fewer than {CRITERION2_MIN_MODULE} members — too few "
                         f"closeness values for a t-test"),
    "module_disconnected": ("its module's subgraph is not connected — the closeness "
                            "(n − 1) / Σ d is undefined where members cannot reach each other, "
                            "and no substitute formula is used"),
    "zero_variance": ("all members of its module have the same closeness — without variance "
                      "the t-test is undefined"),
    "not_in_network": ("it is not in the co-occurrence network (no module) — criterion 2 does "
                       "not apply"),
}
_CRITERION2_MODULE_REASONS = ("module_too_small", "module_disconnected", "zero_variance")


def criterion2_compute(modules: dict, links, alpha: float = CRITERION2_ALPHA) -> dict:
    from collections import deque
    from scipy import stats as sp_stats

    adj: dict = {a: set() for a in modules}
    for a, b in links:
        if a == b or a not in modules or b not in modules or modules[a] != modules[b]:
            continue
        adj[a].add(b)
        adj[b].add(a)
    by_module: dict = {}
    for a in sorted(modules):
        by_module.setdefault(modules[a], []).append(a)

    nodes: dict[str, dict] = {}
    module_rows: list[dict] = []
    pvals: dict[str, float] = {}
    for label in sorted(by_module):
        members = by_module[label]
        n = len(members)
        dist_sum: dict[str, int] = {}
        connected = True
        for s in members:
            seen = {s: 0}
            queue = deque([s])
            while queue:
                x = queue.popleft()
                for y in adj[x]:
                    if y not in seen:
                        seen[y] = seen[x] + 1
                        queue.append(y)
            if len(seen) < n:
                connected = False
            dist_sum[s] = sum(seen.values())
        closeness = {s: ((n - 1) / dist_sum[s] if connected and n > 1 else None)
                     for s in members}
        if n < CRITERION2_MIN_MODULE:
            reason = "module_too_small"
        elif not connected:
            reason = "module_disconnected"
        elif len(set(dist_sum.values())) == 1:
            reason = "zero_variance"
        else:
            reason = None
        vals = [closeness[s] for s in members]
        if reason is None:
            for s in members:
                pvals[s] = float(sp_stats.ttest_1samp(vals, popmean=closeness[s],
                                                      alternative="less").pvalue)
        defined = all(v is not None for v in vals) and n > 1
        module_rows.append({
            "module": label, "module_size": n, "testable": reason is None,
            "reason": reason, "reason_text": CRITERION2_REASONS.get(reason) if reason else None,
            "mean_closeness": (sum(vals) / n) if defined else None,
            "sd_closeness": statistics.stdev(vals) if defined else None,
            "n_pass": 0,
        })
        for s in members:
            nodes[s] = {"module": label, "module_size": n, "closeness": closeness[s],
                        "p": None, "q": None, "passes": False, "testable": reason is None,
                        "reason": reason,
                        "reason_text": CRITERION2_REASONS.get(reason) if reason else None}

    tested = sorted(pvals)
    if tested:
        qs = sp_stats.false_discovery_control([pvals[s] for s in tested], method="bh")
        for s, qv in zip(tested, qs):
            nodes[s]["p"] = pvals[s]
            nodes[s]["q"] = float(qv)
            nodes[s]["passes"] = bool(float(qv) <= alpha)
    ids = sorted(s for s, v in nodes.items() if v["passes"])
    for row in module_rows:
        row["n_pass"] = sum(1 for s in ids if nodes[s]["module"] == row["module"])
    not_testable = []
    for code in _CRITERION2_MODULE_REASONS:
        mods = [m for m in module_rows if m["reason"] == code]
        if mods:
            not_testable.append({"reason": code, "reason_text": CRITERION2_REASONS[code],
                                 "n_asv": sum(m["module_size"] for m in mods),
                                 "n_modules": len(mods),
                                 "modules": [m["module"] for m in mods]})
    return {"alpha": alpha, "n_network": len(nodes), "n_modules": len(module_rows),
            "n_testable": len(tested), "n_pass": len(ids),
            "n_not_testable": len(nodes) - len(tested), "not_testable": not_testable,
            "modules": module_rows, "ids": ids, "nodes": nodes}


def criterion2_statement(res: dict) -> str:
    if not res["n_network"]:
        return (f'"{CRITERION2_LABEL}" cannot be computed: this dataset has no co-occurrence '
                f'network.')
    s = (f'{res["n_pass"]} of {res["n_testable"]} testable network ASVs meet '
         f'"{CRITERION2_LABEL}"')
    if res["n_not_testable"]:
        teile = [f'{r["n_asv"]} in {r["n_modules"]} module{"s" if r["n_modules"] != 1 else ""}: '
                 f'{r["reason_text"]}' for r in res["not_testable"]]
        s += (f'; {res["n_not_testable"]} further network ASVs cannot be tested '
              f'({"; ".join(teile)})')
    return s + "."


def _criterion2_texts(res: dict) -> dict:
    return {
        "label": CRITERION2_LABEL,
        "title": CRITERION2_TITLE,
        "mark": CRITERION2_MARK,
        "glow": CRITERION2_GLOW,
        "paper_wording": CRITERION2_PAPER_WORDING,
        "method": CRITERION2_METHOD,
        "formula": CRITERION2_FORMULA,
        "not_keystone": CRITERION2_NOT_KEYSTONE,
        "selection_note": (f"{CRITERION2_SELECTION} In this dataset {res['n_pass']} of "
                           f"{res['n_testable']} testable network ASVs pass."),
        "source": CRITERION2_SOURCE,
        "source_doi": CRITERION2_SOURCE_DOI,
        "source_location": CRITERION2_SOURCE_LOCATION,
        "statement": criterion2_statement(res),
    }


def criterion2(q: Runner, dataset_id: str) -> dict:
    rows = q("MATCH (a:ASV {dataset_id:$d}) WHERE a.louvain_label IS NOT NULL "
             "RETURN a.id AS id, a.louvain_label AS module ORDER BY a.id", d=dataset_id)
    links = q("MATCH (a:ASV {dataset_id:$d})-[:CO_OCCURS_WITH {dataset_id:$d}]-"
              "(b:ASV {dataset_id:$d}) "
              "WHERE a.id < b.id AND a.louvain_label IS NOT NULL "
              "AND a.louvain_label = b.louvain_label "
              "RETURN DISTINCT a.id AS asv, b.id AS partner ORDER BY asv, partner", d=dataset_id)
    res = criterion2_compute({r["id"]: r["module"] for r in rows},
                             [(r["asv"], r["partner"]) for r in links])
    return {**_criterion2_texts(res), **res}


def criterion2_summary(c2: dict) -> dict:
    return {k: v for k, v in c2.items() if k != "nodes"}


def _criterion2_shared(c2: dict) -> dict:
    return {k: c2[k] for k in ("label", "title", "mark", "glow", "method", "formula",
                               "not_keystone", "selection_note", "source", "source_doi",
                               "source_location")}


def criterion2_asv(c2: dict, asv_id: str) -> dict:
    node = c2["nodes"].get(asv_id)
    if node is None:
        node = {"module": None, "module_size": None, "closeness": None, "p": None, "q": None,
                "passes": False, "testable": False, "reason": "not_in_network",
                "reason_text": CRITERION2_REASONS["not_in_network"]}
    if node["testable"]:
        mod = next(m for m in c2["modules"] if m["module"] == node["module"])
        wie = (f'closeness {node["closeness"]:.3f} within module M{node["module"]} '
               f'({node["module_size"]} members, module mean {mod["mean_closeness"]:.3f}); '
               f'one-sided t-test p = {node["p"]:.3g}, Benjamini–Hochberg q = {node["q"]:.3g} '
               f'{"≤" if node["passes"] else ">"} {c2["alpha"]:g}')
        verdict = (f'{"Meets" if node["passes"] else "Does not meet"} '
                   f'"{CRITERION2_LABEL}": {wie}.')
        mean = mod["mean_closeness"]
    else:
        verdict = f'Not testable for "{CRITERION2_LABEL}": {node["reason_text"]}.'
        mean = None
    return {**node, "module_mean_closeness": mean, "verdict": verdict, **_criterion2_shared(c2)}


def criterion2_module(c2: dict, label: int) -> dict:
    row = next((m for m in c2["modules"] if m["module"] == label), None)
    if row is None:
        row = {"module": label, "module_size": 0, "testable": False, "reason": "not_in_network",
               "reason_text": CRITERION2_REASONS["not_in_network"], "mean_closeness": None,
               "sd_closeness": None, "n_pass": 0}
    meeting = sorted(({"asv_id": s, "closeness": v["closeness"], "p": v["p"], "q": v["q"]}
                      for s, v in c2["nodes"].items() if v["module"] == label and v["passes"]),
                     key=lambda m: (m["q"], -m["closeness"], m["asv_id"]))
    if row["testable"]:
        verdict = (f'{row["n_pass"]} of {row["module_size"]} members of module M{label} meet '
                   f'"{CRITERION2_LABEL}" (module mean closeness {row["mean_closeness"]:.3f}, '
                   f'sd {row["sd_closeness"]:.3f}); Benjamini–Hochberg over all '
                   f'{c2["n_testable"]} testable network ASVs of the dataset, '
                   f'q ≤ {c2["alpha"]:g}.')
    else:
        verdict = (f'Module M{label} ({row["module_size"]} members) cannot be tested for '
                   f'"{CRITERION2_LABEL}": {row["reason_text"]}.')
    return {**row, "members_meeting": meeting, "verdict": verdict, **_criterion2_shared(c2)}
