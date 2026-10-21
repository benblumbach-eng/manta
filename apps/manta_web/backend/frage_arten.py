from __future__ import annotations

import re

import registry

ANDERE = "andere"

# The question kinds that run on a fixed plan. Each one names the tools that answer it, in
# order, with their arguments built from the understood form; the model never picks them.
GEPLANT: dict[str, dict] = {
    "dataset_summary": {
        "needs": "dataset",
        "synonyme": ("overview", "summary", "what is this dataset", "what kind of series",
                     "how long", "how many samples", "überblick", "zusammenfassung"),
        "plan": lambda f: [("dataset_summary", {"dataset_id": f["datensatz"]})],
    },
    "taxa_composition": {
        "needs": "dataset",
        "synonyme": ("dominate", "dominant", "most common", "most abundant taxa", "which genera",
                     "which families", "composition", "dominieren", "häufigste gattungen"),
        "plan": lambda f: [("taxa_composition", {"dataset_id": f["datensatz"],
                                                 "rank": f.get("rang") or "genus", "limit": 15}),
                           ("dataset_summary", {"dataset_id": f["datensatz"]})],
    },
    "find_asv": {
        "needs": "dataset",
        "synonyme": ("largest asvs", "biggest asvs", "top asvs", "most abundant asvs",
                     "größte asvs", "häufigste asvs"),
        "plan": lambda f: [("find_asv", {"dataset_id": f["datensatz"], "limit": 10})],
    },
    "cluster_bridges": {
        "needs": "dataset",
        "synonyme": ("modules linked", "clusters linked", "connected to each other",
                     "links between modules", "bridges", "module verbunden",
                     "verbindungen zwischen"),
        "plan": lambda f: [("cluster_bridges", {"dataset_id": f["datensatz"], "edge": "con"}),
                           ("dataset_summary", {"dataset_id": f["datensatz"]})],
    },
    "cluster_network": {
        "needs": "dataset",
        "synonyme": ("module predicts", "which module drives", "ccm between modules",
                     "directed links between modules", "modul sagt vorher"),
        "plan": lambda f: [("cluster_network", {"dataset_id": f["datensatz"]}),
                           ("dataset_summary", {"dataset_id": f["datensatz"]})],
    },
}

# What the words in a question mean in the graph. Shown to the model when it fills the form.
BEGRIFFE = ("module = community = group = cluster (a Louvain cluster of the network)",
            "organism = sequence = ASV",
            "linked = connected = edges between ASVs of different clusters")

RAENGE = ("kingdom", "phylum", "class", "order", "family", "genus", "species")


def beispiel(art: str) -> str:
    return (registry.QUESTIONS.get(art) or ("", ""))[1]


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9äöüß ]+", "", " ".join((text or "").lower().split()))


def aus_vorschlag(frage: str) -> str | None:
    n = _norm(frage)
    for name, (_, satz) in registry.QUESTIONS.items():
        if n == _norm(satz):
            return name
    return None


def ist_geplant(art: str | None) -> bool:
    return art in GEPLANT


def plan(art: str, formular: dict) -> list[tuple[str, dict]]:
    return GEPLANT[art]["plan"](formular)
