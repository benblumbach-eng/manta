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
        "MANTA liefert deterministisches Retrieval ueber marine Amplicon-Zeitreihen "
        "(ASV-Netzwerke aus OTTER in Neo4j).\n"
        "Regeln fuer die Nutzung:\n"
        "1. Rufe IMMER zuerst list_datasets auf — jedes andere Tool braucht eine gueltige dataset_id.\n"
        "2. Bevorzuge die typisierten Tools. Sie filtern vollstaendig; rechne ihre Ergebnisse "
        "NICHT nach und filtere sie nicht lokal nach.\n"
        "3. run_validated_cypher ist der letzte Ausweg. Hole vorher get_schema.\n"
        "4. Jede Antwort enthaelt ein Provenienz-Manifest mit der ausgefuehrten Query. "
        "Nenne Zahlen nur so, wie die Tools sie geliefert haben, und erfinde nichts dazu.\n"
        "5. Beachte die Caveats in den Antworten: Abundanzen sind kompositionell (Skalierung "
        "unbestimmt), CCM misst gerichtete Vorhersageguete ohne Konvergenztest und belegt "
        "KEINE Kausalitaet."
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
    ("asv_function", tools.asv_function),
    ("neighbors", tools.neighbors),
    ("edge", tools.edge),
    ("cluster_detail", tools.cluster_detail),
    ("cluster_functions", tools.cluster_functions),
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
]

assert {n for n, _ in _EXPOSED} == {s["name"] for s in registry.TOOL_SPECS}, \
    "MCP-Server und Registry sind auseinandergelaufen"

for _name, _fn in _EXPOSED:
    app.add_tool(tools.mit_abfrageprotokoll(_fn), name=_name,
                 description=_DESCRIPTIONS[_name], annotations=_ANNOTATIONS[_name])


if __name__ == "__main__":
    asyncio.run(app.run_stdio_async())
