from __future__ import annotations

import math
import statistics
import warnings

import numpy as np
from scipy import stats

CAVEAT_INDEPENDENCE = (
    "Samples are treated as independent observations; consecutive samples of a time series are "
    "not, so the p-value is optimistic. Read it as an ordering of evidence, not as an exact "
    "error rate.")
CAVEAT_COMPOSITIONAL = (
    "Shares are compositional: a share can move because OTHER taxa moved. A test on shares "
    "detects a change in the share, not in the amount of the organism.")
CAVEAT_TRANSFORMED = (
    "The values of this dataset were converted upstream by an undocumented method. The test runs "
    "on shares of the converted values; even an order-preserving conversion can reorder one "
    "ASV's shares ACROSS samples, so the result describes the converted shares and need not "
    "carry over to the original abundances. Whether it does cannot be checked here.")
CAVEAT_NOT_NETWORK = (
    "This is a test computed by MANTA on the stored time series. It is not part of OTTER's "
    "network (CON/CCM) and does not change any link.")

CAVEAT_PROPORTIONALITY_SCALE = (
    "rho_p is computed on shares (stored value / sample total), the quantity the other tests "
    "use: the sample total cancels in the log-ratio. rho_p_on_raw_counts applies the same formula "
    "to the raw stored values. Its numerator is identical, but its denominator var(log x) + "
    "var(log y) also carries the variance of the log sample totals twice (plus covariance "
    "terms), so whenever sequencing depth varies — here by orders of magnitude — it is pushed "
    "toward 1 for ASVs that merely share the depth. It is shown as a check, not as the answer. "
    "A pair whose ratio is exactly constant gives 1.0 on both. Neither is the CLR-based rho_p of "
    "propr: no zero handling is done here; samples where either ASV is absent are left out.")

REFUSE_PROPORTIONALITY_TRANSFORMED = (
    "Not computed: rho_p is a variance of log RATIOS and needs values on a ratio scale. This "
    "dataset's values were converted upstream by an undocumented method, and the only property "
    "that conversion is assumed to keep is the ORDER within a sample — an order-preserving "
    "conversion may change every ratio. A number here would rest on an assumption nobody has "
    "established.")

MIN_PER_GROUP = 3
MIN_SERIES = 8
PERMUTATIONS = 9999
PERMUTATION_SEED = 20261007
P_METHOD_PERMUTATION = (f"permutation of the group labels ({PERMUTATIONS} shuffles, fixed seed) "
                        f"— exact under ties, unlike the asymptotic approximation")


def _n_detected(vals) -> int:
    return sum(1 for v in vals if v is not None and v > 0)


def _ranks(werte: "np.ndarray") -> "tuple[np.ndarray, float]":
    r = stats.rankdata(werte)
    _, t = np.unique(werte, return_counts=True)
    n = len(werte)
    c = 1.0 - float(np.sum(t.astype(float) ** 3 - t)) / float(n ** 3 - n) if n > 1 else 0.0
    return r, c


def _perm_p(statistik_je_label, labels: "np.ndarray", beobachtet: float) -> float:
    rng = np.random.default_rng(PERMUTATION_SEED)
    perms = rng.permuted(np.tile(labels, (PERMUTATIONS, 1)), axis=1)
    werte = statistik_je_label(perms)
    toleranz = 1e-12 * max(1.0, abs(beobachtet))
    return float((1 + np.sum(werte >= beobachtet - toleranz)) / (1 + PERMUTATIONS))


def _kruskal_h(ranks: "np.ndarray", labels: "np.ndarray", k: int, c: float) -> "np.ndarray":
    lab = np.atleast_2d(labels)
    n = lab.shape[1]
    summe = np.zeros(lab.shape[0])
    for g in range(k):
        maske = lab == g
        n_g = maske[0].sum()
        summe += (ranks * maske).sum(axis=1) ** 2 / n_g
    return (12.0 / (n * (n + 1)) * summe - 3.0 * (n + 1)) / c


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
    n_det = sum(_n_detected(g) for g in groups.values())
    if len(used) < 2:
        return {"test": "Kruskal-Wallis over calendar months", "statistic": None, "p_value": None,
                "n_samples": sum(len(g) for g in groups.values()), "n_months_used": len(used),
                "n_detected": n_det, "months_skipped": skipped,
                "note": f"fewer than two months with at least {MIN_PER_GROUP} samples — no test"}
    if sum(1 for g in used.values() if _n_detected(g) >= MIN_PER_GROUP) < 2:
        return {"test": "Kruskal-Wallis over calendar months", "statistic": None, "p_value": None,
                "n_samples": sum(len(g) for g in used.values()), "n_months_used": len(used),
                "n_detected": n_det, "months_skipped": skipped,
                "note": (f"fewer than two calendar months with at least {MIN_PER_GROUP} "
                         f"detections of this subject ({n_det} detections in all) — no test: a "
                         f"p-value over months that are almost all zeros says nothing")}
    monate = sorted(used)
    werte = np.array([v for m in monate for v in used[m]], dtype=float)
    labels = np.array([i for i, m in enumerate(monate) for _ in used[m]])
    ranks, c = _ranks(werte)
    k, n = len(monate), len(werte)
    if c <= 0:
        return {"test": "Kruskal-Wallis over calendar months", "statistic": None, "p_value": None,
                "n_samples": n, "n_months_used": k, "n_detected": n_det,
                "months_skipped": skipped, "note": "all values are identical — no test"}
    h = float(_kruskal_h(ranks, labels, k, c)[0])
    p = _perm_p(lambda perms: _kruskal_h(ranks, perms, k, c), labels, h)
    eps2 = h / (n - 1) if n > 1 else None
    return {
        "test": "Kruskal-Wallis over calendar months",
        "statistic": h, "df": k - 1, "p_value": p, "p_method": P_METHOD_PERMUTATION,
        "effect_size_epsilon2": eps2,
        "n_samples": n, "n_months_used": k, "n_detected": n_det, "months_skipped": skipped,
        "medians_by_month": {m: statistics.median(g) for m, g in sorted(used.items())},
        "min_per_month": MIN_PER_GROUP,
    }



def _mann_kendall(values: list[float], times: "list[float] | None" = None) -> dict:
    n = len(values)
    if times is None:
        times = list(range(n))
    s = 0
    for i in range(n - 1):
        for j in range(i + 1, n):
            if times[j] == times[i]:
                continue
            d = values[j] - values[i]
            s += (d > 0) - (d < 0)

    def gruppen(xs):
        c: dict[float, int] = {}
        for x in xs:
            c[x] = c.get(x, 0) + 1
        return [t for t in c.values() if t > 1]

    u, v = gruppen(times), gruppen(values)
    var = (n * (n - 1) * (2 * n + 5)
           - sum(t * (t - 1) * (2 * t + 5) for t in u)
           - sum(t * (t - 1) * (2 * t + 5) for t in v)) / 18.0
    if n > 2:
        var += (sum(t * (t - 1) * (t - 2) for t in u) * sum(t * (t - 1) * (t - 2) for t in v)
                / (9.0 * n * (n - 1) * (n - 2)))
    if n > 1:
        var += (sum(t * (t - 1) for t in u) * sum(t * (t - 1) for t in v)) / (2.0 * n * (n - 1))
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
    n_det = _n_detected(v for _, v in pairs)
    if len(ys) < MIN_SERIES or n_det < MIN_SERIES:
        return {"test": "Mann-Kendall on seasonal anomalies", "S": None, "p_value": None,
                "n_samples": len(ys), "n_detected": n_det,
                "note": (f"fewer than {MIN_SERIES} samples with a detection of this subject "
                         f"({n_det}) — no test")}
    mk = _mann_kendall(ys, xs)
    slope, intercept, lo, hi = stats.theilslopes(ys, xs)
    return {
        "test": "Mann-Kendall on seasonal anomalies",
        **mk,
        "n_samples": len(ys),
        "n_detected": n_det,
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
            "n_a": len(ga), "n_b": len(gb),
            "n_detected_a": _n_detected(ga), "n_detected_b": _n_detected(gb)}
    if len(ga) < MIN_PER_GROUP or len(gb) < MIN_PER_GROUP:
        return {**base, "statistic": None, "p_value": None,
                "note": f"fewer than {MIN_PER_GROUP} samples in a group — no test"}
    if base["n_detected_a"] < MIN_PER_GROUP or base["n_detected_b"] < MIN_PER_GROUP:
        return {**base, "statistic": None, "p_value": None,
                "note": f"fewer than {MIN_PER_GROUP} detections of this subject in a group — no test"}
    u, _p_asymptotisch = stats.mannwhitneyu(ga, gb, alternative="two-sided")
    werte = np.array(ga + gb, dtype=float)
    labels = np.array([0] * len(ga) + [1] * len(gb))
    ranks, _c = _ranks(werte)
    n_a, n_b = len(ga), len(gb)
    mitte = n_a * n_b / 2.0

    def abstand(lab):
        lab = np.atleast_2d(lab)
        r_a = (ranks * (lab == 0)).sum(axis=1)
        return np.abs(r_a - n_a * (n_a + 1) / 2.0 - mitte)

    p = _perm_p(abstand, labels, float(abstand(labels)[0]))
    return {**base, "statistic": float(u), "p_value": p, "p_method": P_METHOD_PERMUTATION,
            **paaranteile(ga, gb),
            "median_a": statistics.median(ga), "median_b": statistics.median(gb)}


def paaranteile(ga: list[float], gb: list[float]) -> dict:
    n = len(ga) * len(gb)
    groesser = sum(1 for x in ga for y in gb if x > y)
    gleich = sum(1 for x in ga for y in gb if x == y)
    return {"vargha_delaney_a": (groesser + 0.5 * gleich) / n,
            "frac_a_greater": groesser / n, "frac_tie": gleich / n,
            "frac_b_greater": (n - groesser - gleich) / n}



def rank_correlation(values: list[float], env: list[float]) -> dict:
    pairs = [(float(v), float(e)) for v, e in zip(values, env) if v is not None and e is not None]
    n_det = _n_detected(v for v, _ in pairs)
    if len(pairs) < MIN_SERIES:
        return {"measure": "Spearman rank correlation", "rho": None, "p_value": None,
                "n_samples": len(pairs), "n_detected": n_det,
                "note": f"fewer than {MIN_SERIES} samples with a measurement — no value"}
    if n_det < MIN_SERIES:
        return {"measure": "Spearman rank correlation", "rho": None, "p_value": None,
                "n_samples": len(pairs), "n_detected": n_det,
                "note": (f"fewer than {MIN_SERIES} samples with both a detection of this ASV and "
                         f"a measurement ({n_det}) — no value")}
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        rho, p = stats.spearmanr([v for v, _ in pairs], [e for _, e in pairs])
    if rho is None or math.isnan(float(rho)):
        return {"measure": "Spearman rank correlation", "rho": None, "p_value": None,
                "n_samples": len(pairs), "n_detected": n_det,
                "note": ("one of the two series is constant over the measured samples — no rank "
                         "correlation is defined")}
    return {"measure": "Spearman rank correlation", "rho": float(rho), "p_value": float(p),
            "n_samples": len(pairs), "n_detected": n_det,
            "n_samples_without_measurement": len(values) - len(pairs)}



CAVEAT_JACCARD = (
    "Jaccard dissimilarity on presence/absence: which ASVs occur in one sample and not in the "
    "other. Whether a rare ASV is 'present' depends on how much of a sample was sequenced, so "
    "part of the dissimilarity is sequencing depth, not community. No amounts enter — the "
    "values of this dataset need not be comparable across samples for this to hold.")



CAVEAT_RANK_DISSIMILARITY = (
    "Rank dissimilarity: (1 - Spearman rho) / 2 between the two samples' rank ORDER of all ASVs "
    "(absent ASVs tie at the bottom). It uses only the order within each sample — the one "
    "property the undocumented transformation of this dataset is assumed to keep — never the "
    "amounts. 0 = the same order, 1 = the reverse order.")



CAVEAT_PEAK_SINGLE_SAMPLE = (
    "A year's peak is the SINGLE sample with the largest share in that year — no smoothing. It "
    "can only fall on a sampled day, and a year sampled every 16 days cannot place a peak more "
    "precisely than that. Shares, not amounts: a peak is the day this ASV made up the most of "
    "its sample, not the day there was most of it in the water.")
