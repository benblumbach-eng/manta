from __future__ import annotations

import math
import statistics

from scipy import stats

CAVEAT_INDEPENDENCE = (
    "Samples are treated as independent observations; consecutive samples of a time series are "
    "not, so the p-value is optimistic. Read it as an ordering of evidence, not as an exact "
    "error rate.")
CAVEAT_COMPOSITIONAL = (
    "Shares are compositional: a share can move because OTHER taxa moved. A test on shares "
    "detects a change in the share, not in the amount of the organism.")
CAVEAT_TRANSFORMED = (
    "The values of this dataset were converted upstream by an undocumented method; a test on "
    "them assumes only that the conversion kept the order within a sample.")
CAVEAT_NOT_NETWORK = (
    "This is a test computed by MANTA on the stored time series. It is not part of OTTER's "
    "network (CON/CCM) and does not change any link.")

CAVEAT_PROPORTIONALITY_SCALE = (
    "Two values, because the choice of scale changes the answer: rho_p on the raw values is "
    "insensitive to how much was sequenced in a sample, rho_p on shares is the same quantity "
    "the other tests use. The sample total cancels in the numerator of rho_p but not in its "
    "denominator, so the two differ whenever sample totals vary — they do, by orders of "
    "magnitude. A pair whose ratio is exactly constant gives 1.0 on both.")

REFUSE_PROPORTIONALITY_TRANSFORMED = (
    "Not computed: rho_p is a variance of log RATIOS and needs values on a ratio scale. This "
    "dataset's values were converted upstream by an undocumented method, and the only property "
    "that conversion is assumed to keep is the ORDER within a sample — an order-preserving "
    "conversion may change every ratio. A number here would rest on an assumption nobody has "
    "established.")

MIN_PER_GROUP = 3


def _month(date_str) -> "int | None":
    try:
        return int(str(date_str)[5:7])
    except (TypeError, ValueError):
        return None


def _year(date_str) -> "int | None":
    try:
        return int(str(date_str)[:4])
    except (TypeError, ValueError):
        return None


def _decimal_year(date_str) -> "float | None":
    y, m = _year(date_str), _month(date_str)
    if y is None or m is None:
        return None
    try:
        d = int(str(date_str)[8:10])
    except (TypeError, ValueError):
        d = 15
    return y + ((m - 1) * 30.4 + (d - 1)) / 365.0


def _pairs(rows, key):
    return [(r["date"], r[key]) for r in rows if r.get(key) is not None and r.get("date")]



def seasonality_test(rows, key="share") -> dict:
    groups: dict[int, list[float]] = {}
    for date, v in _pairs(rows, key):
        m = _month(date)
        if m is not None:
            groups.setdefault(m, []).append(float(v))
    used = {m: g for m, g in groups.items() if len(g) >= MIN_PER_GROUP}
    skipped = sorted(set(groups) - set(used))
    if len(used) < 2:
        return {"test": "Kruskal-Wallis over calendar months", "statistic": None, "p_value": None,
                "n_samples": sum(len(g) for g in groups.values()), "n_months_used": len(used),
                "months_skipped": skipped,
                "note": f"fewer than two months with at least {MIN_PER_GROUP} samples — no test"}
    h, p = stats.kruskal(*used.values())
    n = sum(len(g) for g in used.values())
    k = len(used)
    eps2 = float(h) / (n - 1) if n > 1 else None
    return {
        "test": "Kruskal-Wallis over calendar months",
        "statistic": float(h), "df": k - 1, "p_value": float(p),
        "effect_size_epsilon2": eps2,
        "n_samples": n, "n_months_used": k, "months_skipped": skipped,
        "medians_by_month": {m: statistics.median(g) for m, g in sorted(used.items())},
        "min_per_month": MIN_PER_GROUP,
    }



def _mann_kendall(values: list[float]) -> dict:
    n = len(values)
    s = 0
    for i in range(n - 1):
        for j in range(i + 1, n):
            d = values[j] - values[i]
            s += (d > 0) - (d < 0)
    counts: dict[float, int] = {}
    for v in values:
        counts[v] = counts.get(v, 0) + 1
    ties = sum(t * (t - 1) * (2 * t + 5) for t in counts.values() if t > 1)
    var = (n * (n - 1) * (2 * n + 5) - ties) / 18.0
    if var <= 0:
        return {"S": s, "z": None, "p_value": None}
    z = (s - 1) / math.sqrt(var) if s > 0 else (s + 1) / math.sqrt(var) if s < 0 else 0.0
    p = 2 * (1 - stats.norm.cdf(abs(z)))
    return {"S": s, "z": float(z), "p_value": float(p)}


def trend_test(rows, key="share") -> dict:
    pairs = [(d, float(v)) for d, v in _pairs(rows, key)]
    pairs.sort(key=lambda p: p[0])
    by_month: dict[int, list[float]] = {}
    for d, v in pairs:
        m = _month(d)
        if m is not None:
            by_month.setdefault(m, []).append(v)
    climo = {m: sum(v) / len(v) for m, v in by_month.items()}
    xs, ys = [], []
    for d, v in pairs:
        m, x = _month(d), _decimal_year(d)
        if m is None or x is None:
            continue
        xs.append(x)
        ys.append(v - climo[m])
    if len(ys) < 8:
        return {"test": "Mann-Kendall on seasonal anomalies", "S": None, "p_value": None,
                "n_samples": len(ys), "note": "fewer than 8 samples — no test"}
    mk = _mann_kendall(ys)
    slope, intercept, lo, hi = stats.theilslopes(ys, xs)
    return {
        "test": "Mann-Kendall on seasonal anomalies",
        **mk,
        "n_samples": len(ys),
        "years_covered": sorted({_year(d) for d, _ in pairs if _year(d) is not None}),
        "theil_sen_slope_per_year": float(slope),
        "theil_sen_slope_ci95": [float(lo), float(hi)],
        "anomaly_method": "value minus the mean of its calendar month (all years)",
    }



def proportionality(x: list[float], y: list[float]) -> dict:
    both = [(a, b) for a, b in zip(x, y) if a is not None and b is not None and a > 0 and b > 0]
    n_all = sum(1 for a, b in zip(x, y) if a is not None and b is not None)
    if len(both) < MIN_PER_GROUP + 1:
        return {"measure": "proportionality rho_p (Lovell 2015)", "rho_p": None,
                "n_samples_both_present": len(both), "n_samples": n_all,
                "note": "fewer than 4 samples with both ASVs detected — no value"}
    lx = [math.log(a) for a, _ in both]
    ly = [math.log(b) for _, b in both]
    vx, vy = statistics.variance(lx), statistics.variance(ly)
    vd = statistics.variance([a - b for a, b in zip(lx, ly)])
    rho = 1 - vd / (vx + vy) if (vx + vy) > 0 else None
    return {
        "measure": "proportionality rho_p (Lovell 2015)",
        "rho_p": float(rho) if rho is not None else None,
        "n_samples_both_present": len(both), "n_samples": n_all,
        "reference": "Lovell et al. 2015, PLoS Comput Biol 11:e1004075, doi:10.1371/journal.pcbi.1004075",
    }



def group_comparison(rows, key, by: str, a: list[int], b: list[int]) -> dict:
    if by not in ("year", "month"):
        raise ValueError("by must be 'year' or 'month'")
    if set(a) & set(b):
        raise ValueError(f"groups overlap: {sorted(set(a) & set(b))}")
    pick = _year if by == "year" else _month
    ga = [float(v) for d, v in _pairs(rows, key) if pick(d) in set(a)]
    gb = [float(v) for d, v in _pairs(rows, key) if pick(d) in set(b)]
    base = {"test": "Mann-Whitney U (two-sided)", "by": by, "group_a": sorted(a), "group_b": sorted(b),
            "n_a": len(ga), "n_b": len(gb)}
    if len(ga) < MIN_PER_GROUP or len(gb) < MIN_PER_GROUP:
        return {**base, "statistic": None, "p_value": None,
                "note": f"fewer than {MIN_PER_GROUP} samples in a group — no test"}
    u, p = stats.mannwhitneyu(ga, gb, alternative="two-sided")
    return {**base, "statistic": float(u), "p_value": float(p),
            "prob_a_greater_b": float(u) / (len(ga) * len(gb)),
            "median_a": statistics.median(ga), "median_b": statistics.median(gb)}



def rank_correlation(values: list[float], env: list[float]) -> dict:
    pairs = [(float(v), float(e)) for v, e in zip(values, env) if v is not None and e is not None]
    if len(pairs) < 8:
        return {"measure": "Spearman rank correlation", "rho": None, "p_value": None,
                "n_samples": len(pairs), "note": "fewer than 8 samples with a measurement — no value"}
    rho, p = stats.spearmanr([v for v, _ in pairs], [e for _, e in pairs])
    return {"measure": "Spearman rank correlation", "rho": float(rho), "p_value": float(p),
            "n_samples": len(pairs), "n_samples_without_measurement": len(values) - len(pairs)}
