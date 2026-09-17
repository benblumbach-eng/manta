from __future__ import annotations

from typing import Any, Callable

import semantics
import statistik
import tools


RULE_CAVEATS = (
    "Respect the caveats: values are compositional (the absolute scaling is undetermined); CON "
    "is a correlation, not an observed interaction; CCM measures directed predictive skill "
    "WITHOUT a convergence test. Never claim causality and never claim absolute growth.")
RULE_NOT_IN_DATA = (
    "Some things are not in these data at all: ecological function, metabolism, role in the "
    "food web, pathogenicity, and any mechanism. When asked for one, write a plain sentence "
    "saying it cannot be derived from amplicon data, and stop there — do not answer with a "
    "single word, and do not infer it from the taxonomy. The same applies when a question is "
    "phrased as \"causes\", \"drives\" or \"leads to\".")
RULE_NO_DIVERSITY = (
    "Diversity indices (richness, Shannon, Simpson and the like) are NOT computed by this "
    "platform: the otter framework's chain does not produce them here, and MANTA does not "
    "substitute its own arithmetic for them (its former self-computed diversity view was "
    "removed). When asked how diverse the community is, say plainly that "
    "diversity indices are not available on this platform — never derive them from abundance "
    "values yourself, and never invent sample or ASV names such as 'summer' or 'winter'.")
RULE_NO_INVENTED_UNITS = (
    "Never attach a unit, a time span or a year to a number the tool did not supply. No \"over "
    "the past four years\", no date, no percent sign unless the result says so. When a tool "
    "returns two similar quantities (such as two peak months), state explicitly which one you "
    "mean.")

TOOL_SPECS: list[dict] = [
    {
        "name": "list_datasets",
        "description": (
            "Lists every dataset: dataset_id, region, marker, size, time axis and kind of values. "
            "Use this when it is unclear WHICH datasets exist or what they are called."
        ),
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "dataset_summary",
        "description": (
            "THE NUMBERS OF A DATASET. Use this for EVERY 'how many' question about a whole "
            "dataset: HOW MANY CLUSTERS, how many ASVs, how many of those are in the network, "
            "how many samples, how many CON links, how many CCM links, how many hubs (with "
            "the operational hub definition sentence — quote it with the number), and what "
            "period it covers. One call answers all of it. "
            "'How many clusters does X have?' belongs HERE, not to cluster_detail."
        ),
        "parameters": {
            "type": "object",
            "properties": {"dataset_id": {"type": "string", "description": "id from list_datasets"}},
            "required": ["dataset_id"],
        },
    },
    {
        "name": "taxa_composition",
        "description": (
            "WHICH TAXA DOMINATE. For 'which genera are most common', 'which families are there', "
            "'what is there most of'. Returns the top taxa with their ASV count and summed size. "
            "Do not query single ASVs and count them up yourself."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "dataset_id": {"type": "string"},
                "rank": {"type": "string", "enum": list(semantics.TAXONOMY_RANKS),
                         "description": "taxonomic rank, default genus"},
                "limit": {"type": "integer", "minimum": 1,
                          "maximum": tools.MAX_LIMIT_TAXA, "default": 15},
                "network_only": {"type": "boolean",
                                 "description": "only ASVs in the network (default false)"},
            },
            "required": ["dataset_id"],
        },
    },
    {
        "name": "summarize_by_taxon",
        "description": (
            "ONE TAXON OR ONE RANK, SUMMARISED: ASV count, samples with a detection, summed "
            "read count (only where values are reads) and the spread across clusters as a "
            "histogram. With `name`, breaks down by the next finer rank — genus 'Gyrodinium' "
            "returns its species plus a separate 'unassigned' row that is never merged. The "
            "sum runs across different sequence variants sharing a name. NO centralities, NO "
            "diversity indices, NO single cluster label — those belong to one ASV, not a name."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "dataset_id": {"type": "string"},
                "rank": {"type": "string", "enum": list(semantics.TAXONOMY_RANKS),
                         "description": "taxonomic rank, default genus"},
                "name": {"type": "string",
                         "description": "one taxon at this rank; breakdown by the next rank"},
            },
            "required": ["dataset_id"],
        },
    },
    {
        "name": "environment",
        "description": (
            "THE MEASURED ENVIRONMENT of a dataset: water temperature, salinity, depth, mixed "
            "layer depth, chlorophyll, light (PAR), Polar Water fraction, oxygen. Use it for "
            "every question about temperature, salt, light, ice, oxygen or 'the conditions', and "
            "whenever an ASV is asked about IN RELATION to the environment — you then report the "
            "two side by side. Returns range, mean, coverage and, on a real time axis, monthly "
            "means; do not average anything yourself. It computes NO correlation itself; for one "
            "ASV against one variable use environment_correlation, never your own arithmetic. "
            "A dataset without environmental data says so."
        ),
        "parameters": {
            "type": "object",
            "properties": {"dataset_id": {"type": "string"}},
            "required": ["dataset_id"],
        },
    },
    {
        "name": "find_asv",
        "description": (
            "Finds ASVs by genus (substring), exact asv_id or cluster number, sorted by size. "
            "WITH NO FILTER it returns the LARGEST ASVs of the dataset — use it exactly that way "
            "for 'what is the largest ASV' or 'show me the most important ones'. Also use it to "
            "get from a name to an asv_id."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "dataset_id": {"type": "string"},
                "genus": {"type": "string", "description": "genus name, substring match allowed"},
                "asv_id": {"type": "string", "description": "exact ASV id, e.g. euk_asv_000"},
                "cluster": {"type": "integer", "description": "Louvain cluster number"},
                "limit": {"type": "integer", "minimum": 1,
                          "maximum": tools.MAX_LIMIT, "default": 25},
            },
            "required": ["dataset_id"],
        },
    },
    {
        "name": "asv_detail",
        "description": (
            "Everything about ONE ASV: full taxonomy (kingdom to species), cluster, size and its "
            "bridging role in the network. Needs an exact asv_id from find_asv. Raw centrality "
            "numbers are deliberately not returned — only the interpreted statement."
        ),
        "parameters": {
            "type": "object",
            "properties": {"dataset_id": {"type": "string"}, "asv_id": {"type": "string"}},
            "required": ["dataset_id", "asv_id"],
        },
    },
    {
        "name": "asv_seasonality",
        "description": (
            "WHEN an ASV is present. For 'when does X peak', 'is X seasonal', 'in which month', "
            "'does X increase over the years'. Returns TWO different peak months (the month of "
            "the single largest sample, and the strongest month on average) — say which one you "
            "mean. USE THIS TOOL instead of asv_abundance_series whenever the question is about "
            "timing, season or trend; evaluating the raw series is not your job."
        ),
        "parameters": {
            "type": "object",
            "properties": {"dataset_id": {"type": "string"}, "asv_id": {"type": "string"}},
            "required": ["dataset_id", "asv_id"],
        },
    },
    {
        "name": "asv_spectrum",
        "description": (
            "THE FOURIER SPECTRUM of one ASV: amplitudes of the coefficients k = 1…FFT_COEFFS−1 "
            "that OTTER computes for the co-occurrence network (harmonics over the whole series, "
            "constant offset excluded) — exactly what CON correlates. For 'what rhythm does this "
            "ASV have', 'do these two ASVs share a spectrum'. NOT a seasonality test "
            "(asv_seasonality, seasonality_test)."
        ),
        "parameters": {
            "type": "object",
            "properties": {"dataset_id": {"type": "string"}, "asv_id": {"type": "string"}},
            "required": ["dataset_id", "asv_id"],
        },
    },
    {
        "name": "asv_function",
        "description": (
            "The LITERATURE-ANNOTATED function of one ASV, looked up by its taxon name in pinned "
            "tables (18S: Mixoplankton Database via PR2, Trophic Mode Database; 16S: FAPROTAX) — "
            "with source and rank (species/genus/family) per entry, or 'not annotated'. A property "
            "of the NAME, not a result of this dataset; metabolism itself is still not derivable "
            "from amplicon data. For 'is this ASV a mixotroph / heterotroph', 'what is known about "
            "this genus'."
        ),
        "parameters": {
            "type": "object",
            "properties": {"dataset_id": {"type": "string"}, "asv_id": {"type": "string"}},
            "required": ["dataset_id", "asv_id"],
        },
    },
    {
        "name": "asv_drivers",
        "description": (
            "ENVIRONMENT LINKS of one ASV: for every measured variable that covaries with it "
            "(Benjamini-Hochberg p_adj < alpha per variable) the best shift in SAMPLES (k > 0: the "
            "ASV follows the variable by k samples), the rank correlation r at that shift, r at "
            "shift 0, and n — sorted by |r|. Stored results of tools/env_links (no computation "
            "here). Covariation with a delay, not a response and not a cause. For 'which "
            "variables track this ASV', 'does temperature lead it'. Empty with a reason when the "
            "dataset has no time axis, no variables or no link."
        ),
        "parameters": {
            "type": "object",
            "properties": {"dataset_id": {"type": "string"}, "asv_id": {"type": "string"}},
            "required": ["dataset_id", "asv_id"],
        },
    },
    {
        "name": "env_variable_links",
        "description": (
            "All ASVs linked to ONE environmental variable (same lagged rank correlation as "
            "asv_drivers, p_adj < alpha), sorted by |r|, each with shift, r, r0, p_adj, n, genus "
            "and cluster. For 'which ASVs follow salinity', 'how many links does temperature "
            "have'. Variable keys: temp, sal, depth, mld, chl_sens, par_satellite, pw_frac, o2_conc."
        ),
        "parameters": {
            "type": "object",
            "properties": {"dataset_id": {"type": "string"},
                           "name": {"type": "string", "description": "variable key, e.g. temp"}},
            "required": ["dataset_id", "name"],
        },
    },
    {
        "name": "cluster_env_links",
        "description": (
            "Per environmental variable, how many members of ONE cluster it is linked to "
            "('temperature → 12 ASVs, salinity → 3 ASVs'), with the member ids and the mean r. "
            "For 'is module 2 tied to temperature'. Not for a single ASV (asv_drivers)."
        ),
        "parameters": {
            "type": "object",
            "properties": {"dataset_id": {"type": "string"}, "cluster": {"type": "integer"}},
            "required": ["dataset_id", "cluster"],
        },
    },
    {
        "name": "asv_abundance_series",
        "description": (
            "The RAW time series of an ASV, one value per sample. Only request it when the "
            "individual values are genuinely needed. For maximum, season or trend, "
            "asv_seasonality is the right tool."
        ),
        "parameters": {
            "type": "object",
            "properties": {"dataset_id": {"type": "string"}, "asv_id": {"type": "string"}},
            "required": ["dataset_id", "asv_id"],
        },
    },
    {
        "name": "neighbors",
        "description": (
            "Who an ASV is linked to in the network. "
            "edge='con' = undirected co-occurrence (Pearson on Fourier coefficients at the "
            "run's own threshold, BH-corrected, positive only; the exact thresholds are in the "
            "result's caveat) — a correlation, NOT an observed interaction. "
            "edge='ccm' = directed predictive skill, WITHOUT a convergence test, so NOT "
            "causality; direction='out' (this ASV predicts others), 'in' (others predict this)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "dataset_id": {"type": "string"},
                "asv_id": {"type": "string"},
                "edge": {"type": "string", "enum": ["con", "ccm"]},
                "direction": {"type": "string", "enum": ["out", "in", "both"],
                              "description": "ccm only, default both"},
                "limit": {"type": "integer", "minimum": 1,
                          "maximum": tools.MAX_LIMIT, "default": 25},
            },
            "required": ["dataset_id", "asv_id"],
        },
    },
    {
        "name": "edge",
        "description": (
            "ONE LINK between two ASVs: the co-occurrence strength r with its BH-adjusted p, "
            "and BOTH tested CCM directions with NMI, p-value and decision — 'kept' "
            "(significant in the permutation test, drawn as an arrow) or 'rejected' (tested, "
            "not significant, no arrow). For 'is A linked to B', 'which way does it point', "
            "'why is there no arrow'. Not for neighbour lists (neighbors) or counts "
            "(dataset_summary)."
        ),
        "parameters": {
            "type": "object",
            "properties": {"dataset_id": {"type": "string"},
                           "source": {"type": "string", "description": "ASV id"},
                           "target": {"type": "string", "description": "ASV id"}},
            "required": ["dataset_id", "source", "target"],
        },
    },
    {
        "name": "cluster_timeseries",
        "description": (
            "ALL MODULES OVER ALL SAMPLES: per sample the summed value of each module's member "
            "ASVs (plus the sample total and the part outside the network) — the numbers behind "
            "the stacked area in the cluster view. Sums of stored values only. For 'which module "
            "dominates when', 'how do the modules succeed each other'. One cluster at one sample: "
            "cluster_detail."
        ),
        "parameters": {"type": "object", "properties": {"dataset_id": {"type": "string"}},
                       "required": ["dataset_id"]},
    },
    {
        "name": "cluster_detail",
        "description": (
            "What ONE SPECIFIC cluster consists of, when its number is already known: size, "
            "dominant genera, largest members, cohesion, neighbouring clusters, and its year "
            "course (`seasonal`: the average year AND every single year's monthly distribution, "
            "incomplete years marked). For 'what is in cluster 3', 'what characterises cluster "
            "0', 'how is cluster 2 distributed in 2015'. NOT for 'how many clusters are "
            "there' — dataset_summary answers that. The cluster number is MANDATORY; without it "
            "this is the wrong tool."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "dataset_id": {"type": "string"},
                "cluster": {"type": "integer", "description": "Louvain cluster number"},
            },
            "required": ["dataset_id", "cluster"],
        },
    },
    {
        "name": "cluster_functions",
        "description": (
            "Members of ONE cluster by literature-annotated function: share of the cluster per "
            "function label, and the share 'not annotated' (never dropped). Same lookup as "
            "asv_function, aggregated. For 'is cluster 3 mostly heterotrophs', 'how much of this "
            "module has any annotation at all'. Not for taxa (cluster_detail)."
        ),
        "parameters": {
            "type": "object",
            "properties": {"dataset_id": {"type": "string"}, "cluster": {"type": "integer"}},
            "required": ["dataset_id", "cluster"],
        },
    },
    {
        "name": "cluster_bridges",
        "description": (
            "HOW MANY links connect DIFFERENT clusters — the bridges between the modules. "
            "Returns the total and the breakdown per cluster pair. This is the answer to 'how "
            "many bridges are there'; do not count anything yourself. Individual links only with "
            "include_edges=true, and only when concrete links are actually asked for."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "dataset_id": {"type": "string"},
                "edge": {"type": "string", "enum": ["con", "ccm"]},
                "include_edges": {"type": "boolean",
                                  "description": "include individual links (default false)"},
                "limit": {"type": "integer", "minimum": 1,
                          "maximum": tools.MAX_LIMIT, "default": 25},
            },
            "required": ["dataset_id"],
        },
    },
    {
        "name": "cluster_network",
        "description": (
            "THE CLUSTER-LEVEL CCM NETWORK: one directed edge per cluster pair, weighted with "
            "the ARITHMETIC MEAN of the NMI of all CCM links between their members (definition "
            "after the source publication, delivered with the result). Use it for 'which "
            "cluster influences which', 'how do the modules relate'. It is an aggregation of "
            "stored values — CCM still has no convergence test, so still NO causality."
        ),
        "parameters": {
            "type": "object",
            "properties": {"dataset_id": {"type": "string"}},
            "required": ["dataset_id"],
        },
    },
    {
        "name": "cluster_interannual_variability",
        "description": (
            "BETWEEN-YEAR DISSIMILARITY per cluster and calendar month: mean pairwise "
            "dissimilarity between samples of DIFFERENT years in the same month, over the "
            "cluster's members (definition, reference and caveat come with the result). Small = "
            "alike every year. For 'does cluster 3 look the same every August'. metric 'jaccard' "
            "(default) or 'bray_curtis' (only where values are reads). No ordination, NO "
            "statement about threat or resilience."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "dataset_id": {"type": "string"},
                "metric": {"type": "string", "enum": ["jaccard", "bray_curtis"],
                           "description": "default jaccard"},
            },
            "required": ["dataset_id"],
        },
    },
    {
        "name": "cluster_year_overview",
        "description": (
            "ALL CLUSTERS THROUGH THE YEAR, one row each: activity window (months above the "
            "cluster's own annual mean), between-year dissimilarity per month, environmental "
            "envelope (weighted mean, 10-90 % range); plus each environmental variable by month "
            "with its season-adjusted trend (a hint, not evidence). For 'which cluster is active "
            "when and under which conditions'. Descriptive only — NOTHING about threat, "
            "vulnerability or resilience."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "dataset_id": {"type": "string"},
                "metric": {"type": "string", "enum": ["jaccard", "bray_curtis"],
                           "description": "default jaccard"},
            },
            "required": ["dataset_id"],
        },
    },
    {
        "name": "get_schema",
        "description": (
            "Labels, relationship types and property names of the graph. "
            "Call before run_validated_cypher to know the valid names."
        ),
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "run_validated_cypher",
        "description": (
            "LAST RESORT for questions no other tool covers: your own Cypher query. It is "
            "checked against the schema and only executed if it ONLY reads, all labels and "
            "properties exist, it is scoped to a dataset_id and it has a LIMIT. On rejection the "
            "error states the reason. FIRST check whether one of the typed tools answers the "
            "question — it almost always does."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "dataset_id": {"type": "string"},
                "query": {"type": "string", "description": "read-only Cypher, scoped to dataset_id"},
            },
            "required": ["dataset_id", "query"],
        },
    },
    {
        "name": "seasonality_test",
        "description": (
            "STATISTICAL TEST whether the calendar month makes a difference for one ASV or one "
            "cluster (Kruskal-Wallis on shares). For 'is X significantly seasonal', 'does the "
            "month matter'. Give exactly one of asv_id or cluster. Not for WHEN the peak is — "
            "that is asv_seasonality. Needs real sampling dates; otherwise it says so. "
            + statistik.CAVEAT_NOT_NETWORK
        ),
        "parameters": {
            "type": "object",
            "properties": {"dataset_id": {"type": "string"}, "asv_id": {"type": "string"},
                           "cluster": {"type": "integer"}},
            "required": ["dataset_id"],
        },
    },
    {
        "name": "trend_test",
        "description": (
            "STATISTICAL TEST for a monotonic trend over the years in one ASV or one cluster "
            "(Mann-Kendall on season-adjusted anomalies, Theil-Sen slope per year). For 'is X "
            "significantly increasing/decreasing'. Give exactly one of asv_id or cluster. Needs "
            "real sampling dates. " + statistik.CAVEAT_NOT_NETWORK
        ),
        "parameters": {
            "type": "object",
            "properties": {"dataset_id": {"type": "string"}, "asv_id": {"type": "string"},
                           "cluster": {"type": "integer"}},
            "required": ["dataset_id"],
        },
    },
    {
        "name": "pair_proportionality",
        "description": (
            "PROPORTIONALITY rho_p (Lovell 2015) of two ASVs: does their RATIO stay constant "
            "across samples? The compositional counterpart of a correlation; 1 = proportional, "
            "0 = none. Has no p-value. Use for 'do X and Y vary together' when a CON link is "
            "questioned or absent. Reports the CON link next to it — the two measure different "
            "things. Returns rho_p on raw values AND on shares (they differ; the answer says "
            "why). Refuses on converted values, with a reason. " + statistik.CAVEAT_NOT_NETWORK
        ),
        "parameters": {
            "type": "object",
            "properties": {"dataset_id": {"type": "string"}, "asv_a": {"type": "string"},
                           "asv_b": {"type": "string"}},
            "required": ["dataset_id", "asv_a", "asv_b"],
        },
    },
    {
        "name": "group_comparison_test",
        "description": (
            "STATISTICAL TEST whether the share of one ASV or one cluster differs between two "
            "groups of samples (Mann-Whitney U): by='year' with years, or by='month' with "
            "calendar months 1-12. For 'was X higher in 2018 than in 2019', 'winter vs summer'. "
            "Give exactly one of asv_id or cluster. Needs real sampling dates. "
            + statistik.CAVEAT_NOT_NETWORK
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "dataset_id": {"type": "string"},
                "by": {"type": "string", "enum": ["year", "month"]},
                "group_a": {"type": "array", "items": {"type": "integer"}},
                "group_b": {"type": "array", "items": {"type": "integer"}},
                "asv_id": {"type": "string"}, "cluster": {"type": "integer"},
            },
            "required": ["dataset_id", "by", "group_a", "group_b"],
        },
    },
    {
        "name": "environment_correlation",
        "description": (
            "SPEARMAN RANK CORRELATION between the share of one ASV and ONE measured variable "
            "(temp, sal, depth, mld, chl_sens, par_satellite, pw_frac, o2_conc — the keys "
            "from `environment`). The ONLY permitted way to relate an ASV to the environment; "
            "never compute one yourself. " + statistik.CAVEAT_COMPOSITIONAL + " "
            + statistik.CAVEAT_NOT_NETWORK
        ),
        "parameters": {
            "type": "object",
            "properties": {"dataset_id": {"type": "string"}, "asv_id": {"type": "string"},
                           "variable": {"type": "string"}},
            "required": ["dataset_id", "asv_id", "variable"],
        },
    },
]

_TAXON_TOOLS = {"find_asv", "asv_detail", "taxa_composition", "summarize_by_taxon",
                "cluster_detail", "neighbors", "edge",
                "cluster_network", "cluster_bridges"}
for _spec in TOOL_SPECS:
    if _spec["name"] == "get_schema":
        continue
    _spec["description"] += (" RULES for using this result (they decide correctness, not "
                             "tone): " + RULE_CAVEATS + " " + RULE_NO_INVENTED_UNITS)
    if _spec["name"] in _TAXON_TOOLS:
        _spec["description"] += " " + RULE_NOT_IN_DATA

READ_ONLY_ANNOTATIONS: dict[str, bool] = {
    "read_only_hint": True,
    "destructive_hint": False,
    "idempotent_hint": True,
    "open_world_hint": False,
}

for _spec in TOOL_SPECS:
    _spec["annotations"] = dict(READ_ONLY_ANNOTATIONS)

_DISPATCH: dict[str, Callable[..., Any]] = {
    "list_datasets": tools.list_datasets,
    "dataset_summary": tools.dataset_summary,
    "taxa_composition": tools.taxa_composition,
    "summarize_by_taxon": tools.summarize_by_taxon,
    "environment": tools.environment,
    "find_asv": tools.find_asv,
    "asv_detail": tools.asv_detail,
    "asv_seasonality": tools.asv_seasonality,
    "asv_abundance_series": tools.asv_abundance_series,
    "asv_spectrum": tools.asv_spectrum,
    "asv_function": tools.asv_function,
    "neighbors": tools.neighbors,
    "edge": tools.edge,
    "cluster_detail": tools.cluster_detail,
    "cluster_functions": tools.cluster_functions,
    "cluster_timeseries": tools.cluster_timeseries,
    "cluster_bridges": tools.cluster_bridges,
    "cluster_network": tools.cluster_network,
    "cluster_interannual_variability": tools.cluster_interannual_variability,
    "cluster_year_overview": tools.cluster_year_overview,
    "get_schema": tools.get_schema,
    "run_validated_cypher": tools.run_validated_cypher,
    "seasonality_test": tools.seasonality_test,
    "trend_test": tools.trend_test,
    "pair_proportionality": tools.pair_proportionality,
    "group_comparison_test": tools.group_comparison_test,
    "environment_correlation": tools.environment_correlation,
    "asv_drivers": tools.asv_drivers,
    "env_variable_links": tools.env_variable_links,
    "cluster_env_links": tools.cluster_env_links,
}

_DISPATCH = {n: tools.mit_abfrageprotokoll(f) for n, f in _DISPATCH.items()}


def call(name: str, args: dict | None = None) -> dict:
    args = args or {}
    fn = _DISPATCH.get(name)
    if fn is None:
        return {"error": f"unbekanntes Tool {name!r}. Verfuegbar: {sorted(_DISPATCH)}"}
    try:
        return fn(**args)
    except tools.ToolError as e:
        return {"error": str(e)}
    except ValueError as e:
        return {"error": f"unbrauchbarer Parameterwert fuer {name}: {e}. Zahlenfelder brauchen "
                         f"Zahlen; rufe das Tool mit korrigierten Werten erneut auf."}
    except TypeError as e:
        spec = next((s for s in TOOL_SPECS if s["name"] == name), None)
        required = (spec or {}).get("parameters", {}).get("required", [])
        return {"error": (f"falsche Parameter fuer {name}: {e}. "
                          f"Pflichtfelder: {required}. Rufe das Tool mit allen Pflichtfeldern "
                          f"erneut auf — oder waehle ein Tool, das ohne sie auskommt.")}
    except Exception as e:
        return {"error": f"{name} ist gescheitert: {type(e).__name__}: {str(e)[:300]}. "
                         f"Das ist kein Ergebnis — sage, dass die Abfrage nicht lief."}


def openai_tools() -> list[dict]:
    return [{"type": "function", "function": {k: v for k, v in s.items() if k != "annotations"}}
            for s in TOOL_SPECS]
