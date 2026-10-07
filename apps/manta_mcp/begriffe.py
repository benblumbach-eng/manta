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
    "hub_not_keystone": semantics.HUB_WHY_NOT_KEYSTONE,
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
       source=PUB, caveats=("hub_not_keystone",),
       tools_=("cluster_detail", "cluster_network")),
    _b("EnvVariable", "Environmental variable", "klasse",
       "One measured property of the water body, recorded alongside the samples — measured, "
       "never derived from the sequences. `depth` is the exception: it is a coordinate of the "
       "sample, not an answer of the environment.",
       tools_=("environment", "env_variable_links")),
    _b("StableState", "Stable state (energy landscape)", "klasse",
       "A local energy minimum of the fitted pairwise maximum-entropy model. A MODEL quantity — "
       "nothing about it was observed.",
       source="Suzuki et al. 2021, Ecological Monographs 91(3):e01469"),
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
       "A CCM direction whose NMI cleared the run's threshold and whose p-value held. The name "
       "is misleading and is never read that way: it measures directed predictive skill.",
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
       caveats=("compositional", "share"), tools_=("asv_abundance_series", "asv_seasonality")),
    _b("rank", "Position within one sample", "kennzahl",
       "1 = the most abundant ASV of that sample. The only quantity here that survives an "
       "unknown preprocessing intact: any strictly monotone conversion leaves the order within "
       "a sample unchanged.",
       formula="1 + number of ASVs in that sample with a strictly larger value",
       unit="position", caveats=("rank_free",), tools_=("asv_detail",)),
    _b("read_count_total", "Summed value over all samples", "kennzahl",
       "The sum of one ASV's stored values across the samples of its dataset. Only formed where "
       "`value_kind` is 'reads' — summing an unknown transform would be arithmetic on unknowns.",
       formula="sum over samples of HAS_ABUNDANCE.count", unit="reads",
       caveats=("compositional",), tools_=("summarize_by_taxon", "taxa_composition")),
    *[_b(k, v, "kennzahl",
         f"A centrality of the co-occurrence network: {v}. It is a property of THIS run's "
         f"network — a different correlation threshold changes it.",
         formula=("number of CON edges at this node" if k == "con_degree"
                  else f"OTTER's {k} on the co-occurrence graph"),
         unit="count" if k == "con_degree" else "centrality",
         inputs=("CO_OCCURS_WITH",),
         caveats=(), note=semantics.HUB_MEASURE_CAVEATS.get(k),
         tools_=("dataset_summary", "asv_detail"))
      for k, v in semantics.HUB_MEASURES.items()],
    _b("hub", "Hub", "kennzahl",
       "Nothing more than: highest rank by the CHOSEN centrality measure, above mu + k*sigma "
       "over the nodes that have a value. Which measure was chosen travels with every answer — "
       "the word alone means nothing without it.",
       formula="value > mean + k * sd (sample sd, n-1) over nodes with a value",
       inputs=tuple(semantics.HUB_MEASURES), caveats=("hub_not_keystone",),
       source=semantics.HUB_SOURCE, tools_=("dataset_summary",)),
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
       unit="NMI", caveats=("ccm",), tools_=("edge", "cluster_network")),
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
       tools_=("cluster_timeseries", "cluster_detail")),
    _b("seasonality_p", "Seasonality test (Kruskal-Wallis)", "kennzahl",
       "Does the calendar month make a difference to the share? Kruskal-Wallis over the months "
       f"with at least {statistik.MIN_PER_GROUP} samples.",
       unit="p-value", caveats=("not_network", "independence", "compositional"),
       tools_=("seasonality_test",)),
    _b("trend_p", "Trend test (Mann-Kendall)", "kennzahl",
       "Mann-Kendall on the season-adjusted yearly anomalies, plus a Theil-Sen slope.",
       unit="p-value", caveats=("not_network", "independence", "trend"),
       tools_=("trend_test",)),
    _b("rho_p", "Proportionality (Lovell 2015)", "kennzahl",
       "Does the RATIO of two ASVs stay constant across samples? A different question from CON, "
       "which correlates Fourier features — agreement is not required.",
       unit="rho_p", caveats=("compositional", "transformed"),
       tools_=("pair_proportionality",)),
    _b("peak_month_single_sample", "Peak month (single sample)", "kennzahl",
       "The calendar month of the ONE largest sample of this series. A single observation, "
       "not a summary — it can differ from the peak of the typical-year curve, and for many "
       "network ASVs it does.",
       formula="month of argmax over all samples", unit="month 1-12",
       caveats=("compositional",), tools_=("asv_seasonality",)),
    _b("peak_month_climatology", "Peak month (typical year)", "kennzahl",
       "The month with the largest MEAN across years. Answers a different question from the "
       "single-sample peak: where the series usually is highest, not where its record is.",
       formula="argmax over months of the mean share of that month across years",
       unit="month 1-12", caveats=("compositional",), tools_=("asv_seasonality",)),
    _b("weighted_mean", "Abundance-weighted environmental mean", "kennzahl",
       "The mean of a measured variable over the samples where this ASV was detected, weighted "
       "by its value there. NOT a niche and NOT an optimum: the variable was measured next to "
       "the sample, not manipulated.",
       formula="sum(value * weight) / sum(weight) over samples with a detection AND a measurement",
       unit="unit of the variable", caveats=("compositional",), tools_=("asv_detail",)),
    _b("p10", "10th percentile (weighted)", "kennzahl",
       "The smallest value whose cumulative weight reaches 10 % of the total. Samples without a "
       "measurement are excluded, never filled.",
       unit="unit of the variable", inputs=("weighted_mean",), tools_=("asv_detail",)),
    _b("p90", "90th percentile (weighted)", "kennzahl",
       "The smallest value whose cumulative weight reaches 90 % of the total.",
       unit="unit of the variable", inputs=("weighted_mean",), tools_=("asv_detail",)),
    _b("mean_nmi", "Mean NMI between two modules", "kennzahl",
       semantics.CLUSTER_NETWORK_DEFINITION, unit="NMI", caveats=("ccm",),
       tools_=("cluster_network",)),
    _b("mean_dissimilarity", "Mean dissimilarity between years", "kennzahl",
       "The mean pairwise dissimilarity between the yearly profiles of a module.",
       unit="dissimilarity 0-1", caveats=("interannual",),
       tools_=("cluster_interannual_variability",)),
    _b("trend_per_year", "Theil-Sen slope per year", "kennzahl",
       "The median of all pairwise slopes between yearly anomalies. Robust against outliers; "
       "it is a description of these years, not a forecast.",
       unit="share per year", caveats=("trend", "independence"), tools_=("trend_test",)),
    _b("rho", "Spearman rank correlation", "kennzahl",
       "The rank correlation between two series. A rank correlation with a measured variable is "
       "NOT a niche, an optimum or a response.",
       unit="rho -1..1", caveats=("compositional", "independence", "not_network"),
       tools_=("environment_correlation", "asv_drivers")),
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
       source=tageslicht.REFERENCE, caveats=("light_not_ecology",),
       tools_=("dataset_capabilities",)),
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

VERSION = "1.0.1"


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
