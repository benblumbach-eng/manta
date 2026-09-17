from __future__ import annotations

INGEST = "ingest.ensure_constraints"
REFERENCE = "external"
SCHREIBDISZIPLIN = "nicht erzwungen — haengt am Schreibpfad"

SCHEMA: list[dict] = [
    {"label": "Dataset", "name": "dataset_key", "keys": ("dataset_id",),
     "angelegt_von": INGEST},
    {"label": "Run", "name": "run_key", "keys": ("dataset_id", "run_id"),
     "angelegt_von": INGEST,
     "warum": ""},
    {"label": "Dada2Run", "name": "dada2_run_key", "keys": ("dataset_id",),
     "angelegt_von": INGEST,
     "warum": ""},
    {"label": "ElaRun", "name": "ela_run_key", "keys": ("dataset_id",),
     "angelegt_von": INGEST,
     "warum": ""},
    {"label": "TraitRun", "name": "trait_run_key", "keys": ("dataset_id",),
     "angelegt_von": INGEST,
     "warum": ""},
    {"label": "EnvLinkRun", "name": "env_link_run_key", "keys": ("dataset_id",),
     "angelegt_von": INGEST,
     "warum": ""},
    {"label": "EnvVariable", "name": "env_variable_key", "keys": ("dataset_id", "name"),
     "angelegt_von": INGEST,
     "warum": ""},
    {"label": "ASV", "name": "asv_ds_key", "keys": ("id", "dataset_id"),
     "angelegt_von": INGEST,
     "warum": ""},
    {"label": "Cluster", "name": "cluster_ds_key",
     "keys": ("louvain_label", "dataset_id", "run_id"), "angelegt_von": INGEST},
    {"label": "Sample", "name": "sample_key", "keys": ("sample_id", "dataset_id"),
     "angelegt_von": INGEST},

    {"label": "StableState", "name": "stable_state_key",
     "keys": ("dataset_id", "ela_run_id", "state_id"), "angelegt_von": SCHREIBDISZIPLIN,
     "warum": ""},
    {"label": "Star", "name": "star_key",
     "keys": ("dataset_id", "username", "kind", "key"), "angelegt_von": SCHREIBDISZIPLIN,
     "warum": ""},
    {"label": "Reference", "name": "reference_key", "keys": ("source_doi", "ref_id"),
     "angelegt_von": REFERENCE,
     "warum": ""},
]

INDEXES: list[dict] = [
    {"label": "ASV", "name": "asv_genus", "property": "genus"},
    {"label": "ASV", "name": "asv_species", "property": "species"},
    {"label": "ASV", "name": "asv_louvain_label", "property": "louvain_label"},
    {"label": "Dataset", "name": "dataset_marker", "property": "marker"},
]

OBSOLET = ["asv_key", "cluster_key"]

UNIQUE_KEYS: dict[str, set[str]] = {e["label"]: set(e["keys"]) for e in SCHEMA}


def constraint_statements() -> list[str]:
    return ([f"DROP CONSTRAINT {n} IF EXISTS" for n in OBSOLET]
            + [f"CREATE CONSTRAINT {e['name']} IF NOT EXISTS FOR (x:{e['label']}) REQUIRE "
               + (f"x.{e['keys'][0]}" if len(e["keys"]) == 1
                  else "(" + ", ".join(f"x.{k}" for k in e["keys"]) + ")")
               + " IS UNIQUE"
               for e in SCHEMA if e["angelegt_von"] == INGEST])


def index_statements() -> list[str]:
    return [f"CREATE INDEX {i['name']} IF NOT EXISTS FOR (x:{i['label']}) ON (x.{i['property']})"
            for i in INDEXES]


def duplikat_abfragen() -> list[tuple[str, str]]:
    out = []
    for e in SCHEMA:
        keys = ", ".join(f"x.{k} AS k{i}" for i, k in enumerate(e["keys"]))
        gruppe = ", ".join(f"k{i}" for i in range(len(e["keys"])))
        out.append((e["label"],
                    f"MATCH (x:{e['label']}) WITH {keys} WITH {gruppe}, count(*) AS n "
                    f"WHERE n > 1 RETURN count(*) AS doppelt"))
    return out
