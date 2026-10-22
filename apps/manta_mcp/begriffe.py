from __future__ import annotations

import json
from pathlib import Path

import semantics
import statistik
import tageslicht

_TERMS = Path(__file__).resolve().parents[2] / "tools" / "ontology" / "terms.json"
TERMS_ABSENT = ("This installation includes no mapping to standard vocabularies, so "
                "standard_term is empty for every concept. That says nothing about whether a "
                "published term exists. The definitions are unaffected.")


def _standardbegriffe() -> tuple[dict, "str | None"]:
    try:
        d = json.loads(_TERMS.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}, TERMS_ABSENT
    aus: dict[str, dict] = {}
    for e in d.get("graph", []) + d.get("properties", []):
        if e.get("standard"):
            s = e["standard"][0]
            aus[e["name"]] = {"curie": s["curie"], "uri": s["uri"], "match": s["match"]}
    for v in d.get("env_variables", []):
        if v.get("term_uri"):
            aus[v["name"]] = {"curie": None, "uri": v["term_uri"], "match": v["term_status"],
                              "label": v.get("term_label")}
    return aus, None


_STANDARD, TERMS_NOTE = _standardbegriffe()

KINDS = ("klasse", "beziehung", "kennzahl", "umweltgroesse")

KIND_NAMES: dict[str, str] = {"klasse": "class", "beziehung": "relationship",
                              "kennzahl": "metric", "umweltgroesse": "environmental_variable"}
_KIND_INTERN = {**{k: k for k in KINDS}, **{v: k for k, v in KIND_NAMES.items()}}


def _art(kind: "str | None") -> "str | None":
    if kind is None or kind == "":
        return None
    if kind not in _KIND_INTERN:
        raise ValueError(f"unknown kind {kind!r}. Known: {list(KIND_NAMES.values())}")
    return _KIND_INTERN[kind]


def _b(key, label, kind, definition, *, source=None, caveats=(), formula=None, unit=None,
       inputs=(), tools_=(), standard=None, note=None) -> dict:
    return {"key": key, "label": label, "kind": kind, "definition": definition,
            "source": source, "caveats": list(caveats), "formula": formula, "unit": unit,
            "inputs": list(inputs), "tools": list(tools_),
            "standard_term": _STANDARD.get(standard or key), "note": note}


CAVEATS: dict[str, str] = {
    "compositional": statistik.CAVEAT_COMPOSITIONAL,
    "not_network": statistik.CAVEAT_NOT_NETWORK,
    "independence": statistik.CAVEAT_INDEPENDENCE,
    "transformed": statistik.CAVEAT_TRANSFORMED,
    "ccm": semantics.CCM_CAVEAT,
    "ccm_decision": semantics.CCM_DECISION_NOTE,
    "env_link": semantics.ENV_LINK_NOTE,
    "trend": semantics.TREND_CAVEAT,
    "interannual": semantics.INTERANNUAL_CAVEAT,
    "cluster_year": semantics.CLUSTER_YEAR_CAVEAT,
    "spectrum": semantics.SPECTRUM_CAVEAT,
    "cluster_timeseries": semantics.CLUSTER_TIMESERIES_CAVEAT,
    "criterion2_not_keystone": semantics.CRITERION2_NOT_KEYSTONE,
    "criterion2_selection": semantics.CRITERION2_SELECTION,
    "light_not_ecology": tageslicht.NOT_ECOLOGY,
    "sampler_depth": semantics.SAMPLER_NOTE,
    "jaccard_depth": statistik.CAVEAT_JACCARD,
    "peak_single_sample": statistik.CAVEAT_PEAK_SINGLE_SAMPLE,
    "rank_order_only": statistik.CAVEAT_RANK_DISSIMILARITY,
    "share": "A share going up does not mean there was more of it",
    "rank_free": ("The rank survives any order-preserving rescaling of the values, so it carries "
                  "none of the compositional caveat the share carries."),
}

PUB = semantics.SOURCE_PUBLICATION

_KLASSEN = [
    _b("ASV", "Amplicon Sequence Variant", "klasse",
       "A sequence-defined operational unit from DADA2. Its identity IS its sequence "
       "(`seq_hash`) — not a name: one genus name can cover many ASVs, and the same ASV can "
       "appear in two datasets under different local ids.",
       source="DADA2", tools_=("find_asv", "asv_detail")),
    _b("Sample", "Sample", "klasse",
       "One water sample. Carries its date (or, on an ordinal axis, only its position), its "
       "station, and the measured environment. Its key is `sample_id`.",
       tools_=("asv_abundance_series",)),
    _b("Station", "Station", "klasse",
       "A place with a coordinate in WGS-84, shared by every dataset sampled there. Datasets "
       "without a stated place have none — a placeholder 0/0 is not a location.",
       tools_=("dataset_capabilities",)),
    _b("Dataset", "Dataset", "klasse",
       "One matrix of sample x ASV plus the run computed on it. Two datasets are never "
       "compared by MANTA: the values are compositional and the runs are separate.",
       tools_=("list_datasets", "dataset_summary")),
    _b("Cluster", "Community cluster (module)", "klasse",
       "A Louvain partition of the co-occurrence network at the run's resolution. A RESULT of "
       "one run, not a property of the organisms: a different resolution gives a different "
       "partition, and membership says nothing about relatedness.",
       source=PUB, tools_=("cluster_detail", "cluster_network")),
    _b("EnvVariable", "Environmental variable", "klasse",
       "One measured property of the water body, recorded alongside the samples — measured, "
       "never derived from the sequences. `depth` is the exception: it is a coordinate of the "
       "sample, not an answer of the environment.",
       tools_=("environment", "env_variable_links")),
    _b("Run", "Computation run", "klasse",
       "One OTTER run with its thresholds. Every network number in MANTA belongs to exactly one "
       "run; re-computing REPLACES it, which is why the run id travels with every answer."),
]

_BEZIEHUNGEN = [
    _b("HAS_ABUNDANCE", "Abundance of one ASV in one sample", "beziehung",
       "The stored value of one ASV in one sample. What kind of number that is differs per "
       "dataset (`value_kind`): sequencing reads, or an undocumented transform of them.",
       caveats=("compositional", "share"), tools_=("asv_abundance_series",)),
    _b("CO_OCCURS_WITH", "Co-occurrence link (CON)", "beziehung",
       "A Pearson correlation of the Fourier features of two time series, above the run's "
       "threshold and below its alpha. NOT an observed interaction, not co-living, not "
       "causality. Undirected in meaning; stored once as a directed edge.",
       source=PUB, tools_=("neighbors", "edge", "cluster_bridges")),
    _b("INFLUENCES", "Kept CCM direction", "beziehung",
       "A CCM direction on a co-occurrence link that OTTER's permutation test kept (p < 0.05). "
       "No NMI threshold decides it: the run records a CCM NMI threshold (ccmn_tr), but OTTER "
       "does not apply it. The name is misleading and is never read that way: it measures "
       "directed predictive skill.",
       caveats=("ccm", "ccm_decision"), tools_=("edge", "cluster_network")),
    _b("CCM_REJECTED", "Tested and rejected CCM direction", "beziehung",
       "A direction that WAS tested and did not hold (p >= 0.05). It exists as its own edge kind "
       "so that 'not tested' stays distinguishable from 'tested and rejected'.",
       caveats=("ccm",), tools_=("edge",)),
    _b("COVARIES_WITH", "Environment link", "beziehung",
       "A Spearman rank correlation between an environmental variable and an ASV's share at the "
       "best shift in samples, Benjamini-Hochberg corrected per variable.",
       caveats=("env_link", "compositional"),
       tools_=("asv_drivers", "env_variable_links", "cluster_env_links")),
    _b("MEMBER_OF", "Cluster membership", "beziehung",
       "Which module the Louvain partition of this run put an ASV in.", source=PUB),
    _b("AT_STATION", "Sample taken at station", "beziehung",
       "Which place a sample was taken at. Datasets without a stated place have no such link."),
]

_KENNZAHLEN = [
    _b("share", "Share within one sample", "kennzahl",
       "The stored value of one ASV divided by the sum over the ASVs kept in this dataset for "
       "that sample. NOT a share of the sample: the denominator is the analysed ASVs only.",
       formula="count / analysed_reads_total (or the live sum where that is not stored)",
       unit="fraction of 1", inputs=("HAS_ABUNDANCE.count", "Sample.analysed_reads_total"),
       caveats=("compositional", "share"), tools_=("asv_seasonality",)),
    _b("rank", "Position within one sample", "kennzahl",
       "1 = the most abundant ASV of that sample. The only quantity here that survives an "
       "unknown preprocessing intact: any strictly monotone conversion leaves the order within "
       "a sample unchanged.",
       formula="1 + number of ASVs in that sample with a strictly larger value",
       unit="position", caveats=("rank_free",), tools_=("asv_seasonality",)),
    _b("read_count_total", "Summed value over all samples", "kennzahl",
       "The sum of one ASV's stored values across the samples of its dataset. Only formed where "
       "`value_kind` is 'reads' — summing an unknown transform would be arithmetic on unknowns.",
       formula="sum over samples of HAS_ABUNDANCE.count", unit="reads",
       caveats=("compositional",),
       tools_=("summarize_by_taxon", "taxa_composition", "find_asv", "asv_detail",
               "cluster_detail")),
    *[_b(k, v, "kennzahl",
         f"A centrality of the co-occurrence network: {v}. It is a property of THIS run's "
         f"network — a different correlation threshold changes it. No view and no tool of "
         f"MANTA marks ASVs by it; the marking everywhere is criterion 2 (`criterion2`), "
         f"computed by MANTA itself.",
         formula=("number of CON edges at this node" if k == "con_degree"
                  else f"OTTER's {k} on the co-occurrence graph"),
         unit="count" if k == "con_degree" else "centrality",
         inputs=("CO_OCCURS_WITH",),
         caveats=(), note=semantics.CENTRALITY_CAVEATS.get(k),
         tools_=())
      for k, v in semantics.CENTRALITY_MEASURES.items()],
    _b("criterion2", semantics.CRITERION2_LABEL, "kennzahl", semantics.CRITERION2_METHOD,
       formula=semantics.CRITERION2_FORMULA, unit="met / not met / not testable",
       inputs=("INFLUENCES",),
       caveats=("criterion2_not_keystone", "criterion2_selection"),
       source=semantics.CRITERION2_SOURCE,
       note=(f'The paper\'s words: "{semantics.CRITERION2_PAPER_WORDING}" '
             f'({semantics.CRITERION2_SOURCE_LOCATION}). Not testable, with the reason stated: '
             + "; ".join(semantics.CRITERION2_REASONS[k] for k in
                         ("no_ccm_link", "outside_main_part", "graph_too_small",
                          "zero_variance")) + "."),
       tools_=("dataset_summary", "asv_detail", "cluster_detail")),
    _b("closeness", "Closeness in the network of significant CCM links (criterion 2)", "kennzahl",
       "How close one ASV lies to all other ASVs of the largest part of the network of "
       "significant CCM links (p < 0.05), along paths in either direction, each link counted "
       "as 1 − NMI. The quantity criterion 2 tests; computed by MANTA as in the authors' "
       "code, not taken from the values stored with the run.",
       formula="(n - 1) / sum of shortest-path lengths (1 − NMI) to the other n - 1 ASVs",
       unit="inverse mean path length", inputs=("INFLUENCES",),
       source=semantics.CRITERION2_SOURCE, tools_=("asv_detail",)),
    _b("hub", "Hub", "kennzahl",
       "Not a measure of its own. Wherever MANTA marks ASVs as central — the glow in the "
       "network view, the ASV and module windows, the legend, the image export and the "
       "assistant — it is criterion 2 of the keystone definition of Oldenburg et al. 2024 "
       "(`criterion2`), one computation for all of them. The word has no single published "
       "definition.",
       formula=semantics.CRITERION2_FORMULA,
       inputs=("INFLUENCES",),
       caveats=("criterion2_not_keystone", "criterion2_selection"),
       source=semantics.CRITERION2_SOURCE,
       note=f"See `criterion2` for the declared computation: {semantics.CRITERION2_LABEL}.",
       tools_=()),
    _b("peak_window", "Peak window", "kennzahl", semantics.PEAK_WINDOW_DEFINITION,
       formula=f"{semantics.PEAK_WINDOW_DAYS}-day window of the calendar holding the most "
               f"yearly peak dates", unit="day of year",
       source=semantics.PEAK_WINDOW_REFERENCE, note=semantics.PEAK_WINDOW_NOTE,
       tools_=("asv_seasonality", "cluster_detail")),
    _b("oscillation", "Annually oscillating", "kennzahl", semantics.OSCILLATION_METHOD,
       formula="local maxima per calendar year of the reconstruction from OTTER's Fourier slice",
       unit="peaks per year", source=semantics.OSCILLATION_REFERENCE,
       tools_=("asv_seasonality",)),
    _b("bridge", "Bridge between modules", "kennzahl",
       "An edge whose two ends sit in DIFFERENT Louvain modules. Louvain minimises exactly "
       "these edges, which is why the ones that remain are the interesting ones. Counted per "
       "module pair; `n_bridges_total` is the count over the whole network, not a sample.",
       formula="count of edges with a.louvain_label <> b.louvain_label",
       unit="edges", inputs=("CO_OCCURS_WITH", "INFLUENCES", "MEMBER_OF"),
       source=PUB, tools_=("cluster_bridges",)),
    _b("nmi", "Normalised mutual information (CCM)", "kennzahl",
       "The directed predictive skill OTTER's CCM reports for one direction.",
       unit="NMI", caveats=("ccm",), tools_=("edge",)),
    _b("corr", "Correlation of the Fourier features (CON)", "kennzahl",
       "The Pearson correlation behind a co-occurrence edge.", unit="r",
       source=PUB, tools_=("edge", "neighbors")),
    _b("interannual_variability", "Interannual variability", "kennzahl",
       semantics.INTERANNUAL_DEFINITION, source=semantics.INTERANNUAL_REFERENCE,
       caveats=("interannual",), tools_=("cluster_interannual_variability",)),
    _b("fft_amplitudes", "Rhythm spectrum", "kennzahl", semantics.SPECTRUM_METHOD,
       formula="|c_k| for k = 1 .. fft_coeffs-1 of OTTER's own Fourier slice",
       unit="amplitude", source=PUB, caveats=("spectrum",), tools_=("asv_spectrum",)),
    _b("cluster_series", "Collective curve of a module", "kennzahl",
       semantics.CLUSTER_SERIES_DEFINITION,
       formula="sum over the member ASVs of their value in that sample (equal weights)",
       unit="same as the stored values", source=PUB, caveats=("cluster_timeseries",),
       tools_=("cluster_timeseries",)),
    _b("seasonality_p", "Seasonality test (Kruskal-Wallis)", "kennzahl",
       "Does the calendar month make a difference to the share? Kruskal-Wallis over the months "
       f"with at least {statistik.MIN_PER_GROUP} samples; the p-value comes from a permutation "
       f"of the month labels, not from the chi-square approximation. Only run when at least two "
       f"months carry {statistik.MIN_PER_GROUP} detections.",
       unit="p-value", caveats=("not_network", "independence", "compositional"),
       tools_=("seasonality_test",)),
    _b("trend_p", "Trend test (Mann-Kendall)", "kennzahl",
       "Mann-Kendall on the season-adjusted yearly anomalies, plus a Theil-Sen slope.",
       unit="p-value", caveats=("not_network", "independence", "trend"),
       tools_=("trend_test",)),
    _b("rho_p", "Proportionality (Lovell 2015)", "kennzahl",
       "Does the RATIO of two ASVs stay constant across samples? Computed on shares (stored value "
       "/ sample total) over the samples where both are detected; the raw-value variant beside it "
       "is inflated by sequencing depth. A different question from CON, which correlates Fourier "
       "features — agreement is not required.",
       formula="1 - var(log x - log y) / (var(log x) + var(log y)), x and y shares",
       unit="rho_p", caveats=("compositional", "transformed"),
       tools_=("pair_proportionality",)),
    _b("vargha_delaney_a", "Vargha-Delaney A (group comparison)", "kennzahl",
       "The probability that a random sample of group A has a larger share than a random sample "
       "of group B, counting a tie as one half: P(A>B) + 0.5·P(A=B). With many tied zeros it is "
       "far from P(A>B) — frac_a_greater and frac_tie stand beside it.",
       formula="U / (n_a · n_b) = frac_a_greater + 0.5 · frac_tie", unit="probability 0-1",
       caveats=("compositional",), tools_=("group_comparison_test",)),
    _b("frac_a_greater", "Pairs with A larger", "kennzahl",
       "The fraction of all (A sample, B sample) pairs in which the A share is strictly larger.",
       formula="count(a > b) / (n_a · n_b)", unit="fraction 0-1",
       tools_=("group_comparison_test",)),
    _b("frac_tie", "Tied pairs", "kennzahl",
       "The fraction of all (A sample, B sample) pairs with exactly equal shares — mostly pairs of "
       "two non-detections.",
       formula="count(a == b) / (n_a · n_b)", unit="fraction 0-1",
       tools_=("group_comparison_test",)),
    _b("frac_b_greater", "Pairs with B larger", "kennzahl",
       "The fraction of all (A sample, B sample) pairs in which the B share is strictly larger.",
       formula="count(a < b) / (n_a · n_b)", unit="fraction 0-1",
       tools_=("group_comparison_test",)),
    _b("peak_month_single_sample", "Peak month (largest raw value, OTTER)", "kennzahl",
       "The calendar month of the ONE sample with the largest RAW stored value of this ASV "
       "(OTTER's max_abundance_month, drawn on the seasonal wheel). Depends on sequencing depth: "
       "it can name a different sample than the highest share, and it can differ from the peak "
       "of the typical-year curve.",
       formula="month of argmax over all samples of the raw stored value", unit="month 1-12",
       caveats=("compositional",), tools_=("asv_seasonality",)),
    _b("peak_month_max_share", "Peak month (highest share)", "kennzahl",
       "The calendar month of the sample in which this ASV made up the largest share of the "
       "analysed values — the same sample as max_sample, the highest point of the interface's "
       "share curve.",
       formula="month of argmax over all samples of the share", unit="month 1-12",
       caveats=("compositional",), tools_=("asv_seasonality",)),
    _b("peak_month_climatology", "Peak month (typical year)", "kennzahl",
       "The month with the largest MEAN across years. Answers a different question from the "
       "single-sample peak: where the series usually is highest, not where its record is.",
       formula="argmax over months of the mean share of that month across years",
       unit="month 1-12", caveats=("compositional",), tools_=("asv_seasonality",)),
    _b("weighted_mean", "Share-weighted environmental mean", "kennzahl",
       "The mean of a measured variable over the samples where this ASV was detected, weighted "
       "by its SHARE of each of those samples (stored value / sample total), so sequencing depth "
       "does not set the weight. NOT a niche and NOT an optimum: the variable was measured next "
       "to the sample, not manipulated.",
       formula="sum(value * share) / sum(share) over samples with a detection AND a measurement",
       unit="unit of the variable", caveats=("compositional",), tools_=("asv_detail",)),
    _b("p10", "10th percentile (weighted)", "kennzahl",
       "The smallest value whose cumulative weight reaches 10 % of the total. Samples without a "
       "measurement are excluded, never filled.",
       unit="unit of the variable", inputs=("weighted_mean",), tools_=("asv_detail",)),
    _b("p90", "90th percentile (weighted)", "kennzahl",
       "The smallest value whose cumulative weight reaches 90 % of the total.",
       unit="unit of the variable", inputs=("weighted_mean",), tools_=("asv_detail",)),
    _b("p25", "25th percentile (weighted)", "kennzahl",
       "The smallest value whose cumulative weight reaches 25 % of the total — the lower edge of "
       "the box in the environment box plot.",
       unit="unit of the variable", inputs=("weighted_mean",), tools_=("asv_detail",)),
    _b("median", "Median (weighted)", "kennzahl",
       "The smallest value whose cumulative weight reaches 50 % of the total — the line inside "
       "the box. Can differ from the weighted mean when the conditions are skewed.",
       unit="unit of the variable", inputs=("weighted_mean",), tools_=("asv_detail",)),
    _b("p75", "75th percentile (weighted)", "kennzahl",
       "The smallest value whose cumulative weight reaches 75 % of the total — the upper edge of "
       "the box in the environment box plot.",
       unit="unit of the variable", inputs=("weighted_mean",), tools_=("asv_detail",)),
    _b("dataset_min", "Smallest measured value in the dataset", "kennzahl",
       "The smallest measured value of the variable over ALL samples of the dataset — the left "
       "end of the box plot's axis, the same for every ASV and module of the dataset.",
       formula="min over all samples of the dataset with a measurement",
       unit="unit of the variable", tools_=("asv_detail",)),
    _b("dataset_max", "Largest measured value in the dataset", "kennzahl",
       "The largest measured value of the variable over ALL samples of the dataset — the right "
       "end of the box plot's axis.",
       formula="max over all samples of the dataset with a measurement",
       unit="unit of the variable", tools_=("asv_detail",)),
    _b("mean_nmi", "Mean NMI between two modules", "kennzahl",
       semantics.CLUSTER_NETWORK_DEFINITION, unit="NMI", caveats=("ccm",),
       tools_=("cluster_network",)),
    _b("mean_dissimilarity", "Mean dissimilarity between years", "kennzahl",
       semantics.INTERANNUAL_DEFINITION,
       unit="dissimilarity 0-1", caveats=("interannual",),
       tools_=("cluster_interannual_variability",)),
    _b("trend_per_year", "Trend per year (least squares on yearly anomalies)", "kennzahl",
       "The least-squares slope of the per-year mean seasonal anomaly against the calendar year "
       "(anomaly = value minus the mean of its calendar month over all years). A description of "
       "these few years, not a forecast — and a different number from trend_test's Theil-Sen "
       "slope.",
       formula="OLS slope of the yearly mean anomaly against the year",
       unit="share per year", caveats=("trend",),
       tools_=("asv_seasonality", "cluster_detail", "cluster_year_overview")),
    _b("theil_sen_slope_per_year", "Theil-Sen slope per year (trend test)", "kennzahl",
       "The median of all pairwise slopes of the per-sample seasonal anomalies against the "
       "decimal year, with a 95 % interval — the size of the trend that trend_test tests. "
       "Robust against single outliers; it differs from trend_per_year, which is a "
       "least-squares slope over yearly means.",
       formula="median over sample pairs of (anomaly_j - anomaly_i) / (t_j - t_i)",
       unit="share per year", caveats=("trend", "independence"), tools_=("trend_test",)),
    _b("rho_p_on_raw_counts", "Proportionality on raw values (check only)", "kennzahl",
       "The same formula as rho_p, applied to the raw stored values instead of the shares. Its "
       "denominator also carries the variance of the log sample totals, so varying sequencing "
       "depth pushes it toward 1 — shown beside rho_p as a check, never as the answer.",
       formula="1 - var(log x - log y) / (var(log x) + var(log y)), x and y raw values",
       unit="rho_p", caveats=("compositional",), tools_=("pair_proportionality",)),
    _b("weighted_sd", "Weighted spread of an environmental variable", "kennzahl",
       "The share-weighted standard deviation of a measured variable around its weighted mean, "
       "over the samples where the subject was detected: how far the conditions scattered, not "
       "how precise the mean is. None for a single sample.",
       formula="sqrt(sum(share * (value - weighted_mean)^2) / sum(share))",
       unit="unit of the variable", inputs=("weighted_mean",), tools_=("asv_detail",)),
    _b("rho", "Spearman rank correlation", "kennzahl",
       "The rank correlation between two series. A rank correlation with a measured variable is "
       "NOT a niche, an optimum or a response.",
       unit="rho -1..1", caveats=("compositional", "independence", "not_network"),
       tools_=("environment_correlation",)),
    _b("n_peaks", "Peaks per year", "kennzahl",
       "Local maxima per calendar year of the reconstruction from OTTER's Fourier slice.",
       unit="peaks", inputs=("oscillation",), source=semantics.OSCILLATION_REFERENCE,
       tools_=("asv_seasonality",)),
    _b("coverage", "Annotation coverage", "kennzahl",
       "How many ASVs of this dataset the literature lookup could annotate, out of those that "
       "carry a lineage at all. A property of the NAMES, not of the sequences.",
       unit="fraction", note=semantics.TRAIT_LITERATURE_NOTE,
       tools_=("asv_function", "cluster_functions")),
    _b("cohesion", "Edges inside vs. outside a module", "kennzahl",
       "How many co-occurrence edges of a module stay inside it and how many leave. Louvain "
       "minimises the leaving ones, so a module with none is a disconnected part of the "
       "network rather than a densely connected one.",
       formula="count of edges with both ends in the module vs. exactly one end",
       unit="edges", inputs=("CO_OCCURS_WITH", "MEMBER_OF"), source=PUB,
       tools_=("cluster_detail",)),

    _b("day_length_h", "Day length", "kennzahl", tageslicht.METHOD,
       formula="sunrise hour angle at zenith 90.833 degrees from the solar declination",
       unit="hours", inputs=("Station.location.latitude", "Sample.date"),
       source=tageslicht.REFERENCE, caveats=("light_not_ecology",)),
    _b("polar_night", "Polar night", "kennzahl",
       "Day length is exactly 0 h at this latitude and date. An ASTRONOMICAL statement.",
       unit="boolean", inputs=("day_length_h",), source=tageslicht.REFERENCE,
       caveats=("light_not_ecology",)),
    _b("polar_day", "Polar day", "kennzahl",
       "Day length is exactly 24 h at this latitude and date. An ASTRONOMICAL statement.",
       unit="boolean", inputs=("day_length_h",), source=tageslicht.REFERENCE,
       caveats=("light_not_ecology",)),
    _b("days_since_sun_return", "Days since the sun returned", "kennzahl",
       "Days since the last end of a polar night. `null` at latitudes that have none.",
       unit="days", inputs=("polar_night",), source=tageslicht.REFERENCE,
       caveats=("light_not_ecology",)),
    _b("sampler_position", "Sampler position (within / below the mixed layer)", "kennzahl",
       "For one sample: 'within' if its sampling depth is at or above the mixed layer depth "
       "measured on that date, 'below' if deeper, 'unknown' if no MLD value exists. Two stored "
       "measurements and one comparison — no model.",
       source=PUB, caveats=("sampler_depth",), formula="depth <= mld -> within, else below",
       unit="category", inputs=["Sample.depth", "Sample.mld"], tools_=["environment"]),
]

_UMWELT = [
    _b(v["key"], v["label"], "umweltgroesse",
       f"Measured alongside the samples and carried through unchanged — "
       f"{'a coordinate of the sample, not an answer of the environment'
          if v.get('role') == 'coordinate' else 'measured, never derived from the sequences'}. "
       f"Samples without a value stay empty; nothing is interpolated.",
       unit=v["unit"], note=v.get("unit_note"), source=semantics.ENVIRONMENT_UNITS_SOURCE,
       tools_=("environment", "env_variable_links"))
    for v in semantics.ENVIRONMENT_VARS
]

BEGRIFFE: list[dict] = _KLASSEN + _BEZIEHUNGEN + _KENNZAHLEN + _UMWELT
_NACH_KEY = {b["key"]: b for b in BEGRIFFE}

VERSION = "1.4.0"


def aufloesen(b: dict) -> dict:
    return {**b, "caveats": [CAVEATS[c] for c in b["caveats"] if c in CAVEATS]}


def alle(kind: "str | None" = None) -> list[dict]:
    kind = _art(kind)
    return [aufloesen(b) for b in BEGRIFFE if kind is None or b["kind"] == kind]


def eines(key: str) -> "dict | None":
    b = _NACH_KEY.get(key)
    return aufloesen(b) if b else None


def schluessel(kind: "str | None" = None) -> list[str]:
    kind = _art(kind)
    return [b["key"] for b in BEGRIFFE if kind is None or b["kind"] == kind]
