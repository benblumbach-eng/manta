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


# Questions that no fixed plan answers, whatever the model sorting them says: they name one ASV
# or one cluster, or ask for a test, a trend or a measure the plans do not compute. A small model
# tends to push them into the nearest plan, which then answers a different question.
_EIN_ASV = re.compile(r"\b\w*asv\w*\d\w*\b|\b[0-9a-f]{16,}\b", re.I)
_EIN_MODUL = re.compile(r"\b(cluster|module?|modul|community|group|gruppe)\s*#?\d+\b|\bM\d+\b",
                        re.I)
_OFFEN = re.compile(
    r"\b(trend|rising|falling|increas\w*|decreas\w*|steig\w*|sink\w*|correlat\w*|korrel\w*|"
    r"season\w*|saison\w*|calendar month|monat\w*|signific\w*|signifikant\w*|p-value|test\w*|"
    r"compar\w*|vergleich\w*|divers\w*|shannon|keystone|function\w*|funktion\w*|"
    r"first half|second half|rise and fall|go together|move together)\b", re.I)


def nie_geplant(frage: str) -> bool:
    return bool(_EIN_ASV.search(frage or "") or _EIN_MODUL.search(frage or "")
                or _OFFEN.search(frage or ""))


# A rank the question names outright counts over the one the model filled in.
_RANG_WORTE = (("phylum", r"phylum|phyla"), ("class", r"class|classes|klassen?"),
               ("family", r"family|families|familien?"),
               ("genus", r"genus|genera|gattung|gattungen"), ("species", r"species|spezies"))


def rang_im_text(frage: str) -> str | None:
    treffer = [r for r, muster in _RANG_WORTE if re.search(rf"\b({muster})\b", frage or "", re.I)]
    return treffer[0] if len(treffer) == 1 else None


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
