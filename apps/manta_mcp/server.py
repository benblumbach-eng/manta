from __future__ import annotations

import asyncio
import os

from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations

import access
import registry
import tools

access.set_scope(access.Scope(
    can_see_internal=os.environ.get("MANTA_MCP_SCOPE", "internal") != "public",
    username="mcp-server"))

app = MCPServer(
    name="manta",
    version=tools.TOOLS_VERSION,
    instructions=(
        "MANTA provides deterministic retrieval over marine amplicon time series "
        "(ASV networks from OTTER in Neo4j).\n"
        "Rules of use:\n"
        "1. ALWAYS call list_datasets first — every other tool needs a valid dataset_id.\n"
        "2. Prefer the typed tools. They filter completely; do NOT recompute their results "
        "and do not filter them again locally.\n"
        "3. run_validated_cypher is the last resort. Call get_schema before it.\n"
        "4. Every answer carries a provenance manifest with the executed query. "
        "State numbers only as the tools returned them, and invent nothing.\n"
        "5. Respect the caveats in the answers: abundances are compositional (the scaling is "
        "undetermined), CCM measures directed predictive skill without a convergence test and "
        "proves NO causality."
    ),
)

_DESCRIPTIONS = {s["name"]: s["description"] for s in registry.TOOL_SPECS}

_ANNOTATIONS = {s["name"]: ToolAnnotations(**s["annotations"]) for s in registry.TOOL_SPECS}

_EXPOSED = [
    ("list_datasets", tools.list_datasets),
    ("dataset_summary", tools.dataset_summary),
    ("taxa_composition", tools.taxa_composition),
    ("summarize_by_taxon", tools.summarize_by_taxon),
    ("environment", tools.environment),
    ("find_asv", tools.find_asv),
    ("asv_detail", tools.asv_detail),
    ("asv_seasonality", tools.asv_seasonality),
    ("asv_abundance_series", tools.asv_abundance_series),
    ("asv_spectrum", tools.asv_spectrum),
    ("neighbors", tools.neighbors),
    ("edge", tools.edge),
    ("cluster_detail", tools.cluster_detail),
    ("cluster_timeseries", tools.cluster_timeseries),
    ("cluster_bridges", tools.cluster_bridges),
    ("cluster_network", tools.cluster_network),
    ("cluster_interannual_variability", tools.cluster_interannual_variability),
    ("cluster_year_overview", tools.cluster_year_overview),
    ("get_schema", tools.get_schema),
    ("run_validated_cypher", tools.run_validated_cypher),
    ("seasonality_test", tools.seasonality_test),
    ("trend_test", tools.trend_test),
    ("pair_proportionality", tools.pair_proportionality),
    ("group_comparison_test", tools.group_comparison_test),
    ("environment_correlation", tools.environment_correlation),
    ("asv_drivers", tools.asv_drivers),
    ("env_variable_links", tools.env_variable_links),
    ("cluster_env_links", tools.cluster_env_links),
    ("describe_concepts", tools.describe_concepts),
    ("describe_metric", tools.describe_metric),
    ("dataset_capabilities", tools.dataset_capabilities),
]

assert {n for n, _ in _EXPOSED} == {s["name"] for s in registry.TOOL_SPECS}, \
    "MCP server and registry have drifted apart"

for _name, _fn in _EXPOSED:
    app.add_tool(tools.mit_abfrageprotokoll(_fn), name=_name,
                 description=_DESCRIPTIONS[_name], annotations=_ANNOTATIONS[_name])



def _schema_drift() -> list[str]:
    mcp = {t.name: t.parameters for t in app._tool_manager.list_tools()}
    abweichend = []
    for spec in registry.TOOL_SPECS:
        eigenschaften = (mcp.get(spec["name"]) or {}).get("properties", {})
        for feld, regel in spec["parameters"].get("properties", {}).items():
            for schluessel in ("enum", "minimum", "maximum"):
                if schluessel in regel and eigenschaften.get(feld, {}).get(schluessel) != regel[schluessel]:
                    abweichend.append(f"{spec['name']}.{feld}.{schluessel}")
    return abweichend


assert not _schema_drift(), f"MCP schema and registry disagree: {_schema_drift()}"


if __name__ == "__main__":
    asyncio.run(app.run_stdio_async())
