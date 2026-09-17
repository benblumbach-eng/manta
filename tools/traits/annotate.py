#!/usr/bin/env python3
from __future__ import annotations

import csv
import gzip
import hashlib
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "apps" / "manta_mcp"))
sys.path.insert(0, str(ROOT / "tools" / "neo4j_ingest"))

import semantics

VENDOR = HERE / "vendor"
OUT_DIR = HERE / "out"
RANKS = semantics.TAXONOMY_RANKS
FINE_TO_COARSE = ("species", "genus", "family")

SOURCES = {
    "mdb": {
        "id": "mdb-pr2-5.1.0",
        "label": "MDB via PR2 v5.1.0",
        "file": "pr2_version_5.1.0_mixoplankton.tsv",
        "citation": ("Mixoplankton Database (Mitra et al. 2023, doi:10.1111/jeu.12972) as "
                     "integrated in PR2 v5.1.0 (pr2-database.org, release 2025-04-02)"),
    },
    "tmd": {
        "id": "tmd-1.1",
        "label": "TMD v1.1",
        "file": "TMDv1.1_Jones.csv",
        "citation": ("Trophic Mode Database for Dinoflagellate and Ciliate Species v1.1 "
                     "(Jones, Rynearson, Menden-Deuer 2025, doi:10.5281/zenodo.15149453, CC BY 4.0)"),
    },
    "faprotax": {
        "id": "faprotax-1.2.12",
        "label": "FAPROTAX 1.2.12",
        "file": "FAPROTAX_1.2.12.txt.gz",
        "citation": ("FAPROTAX 1.2.12 (Louca, Parfrey, Doebeli 2016, Science 353:1272, "
                     "doi:10.1126/science.aaf4507)"),
    },
}
MARKER_SOURCES = {"18S": ("mdb", "tmd"), "16S": ("faprotax",)}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _norm_species(name: str) -> str:
    return " ".join(name.replace("\xa0", " ").replace("_", " ").split()).lower()



def load_mdb(path: Path = VENDOR / SOURCES["mdb"]["file"]) -> dict:
    by_species: dict[str, set[str]] = {}
    by_genus: dict[str, set[str]] = {}
    with path.open(encoding="utf-8", newline="") as fh:
        for r in csv.DictReader(fh, delimiter="\t"):
            cat = r["mixoplankton"].strip()
            if not cat:
                continue
            if r["species"] and not semantics.is_taxon_placeholder(r["species"]):
                by_species.setdefault(_norm_species(r["species"]), set()).add(cat)
            if r["genus"] and not semantics.is_taxon_placeholder(r["genus"]):
                by_genus.setdefault(r["genus"].strip().lower(), set()).add(cat)
    return {"species": by_species, "genus": by_genus}


def join_mdb(mdb: dict, genus: str | None, species: str | None) -> list[dict]:
    label = SOURCES["mdb"]["label"]
    if species and not semantics.is_taxon_placeholder(species):
        cats = mdb["species"].get(_norm_species(species))
        if cats:
            return [{"function": semantics.mdb_label(c), "source": f"{label}, species",
                     "rank": "species"} for c in sorted(cats)]
    if genus and not semantics.is_taxon_placeholder(genus):
        cats = mdb["genus"].get(genus.strip().lower())
        if cats:
            return [{"function": semantics.mdb_label(c), "source": f"{label}, genus",
                     "rank": "genus"} for c in sorted(cats)]
    return []



def load_tmd(path: Path = VENDOR / SOURCES["tmd"]["file"]) -> dict:
    by_species: dict[str, set[str]] = {}
    by_genus: dict[str, set[str]] = {}
    with path.open(encoding="utf-8-sig", newline="") as fh:
        for r in csv.DictReader(fh):
            taxon = (r.get("Grazer Taxonomic ID") or "").replace("\xa0", " ").strip()
            mode = (r.get("Feeding Mode") or "").strip().lower()
            if not taxon or not mode:
                continue
            by_species.setdefault(_norm_species(taxon), set()).add(mode)
            for syn in re.split(r"[,;]", (r.get("Synonym/Basionym") or "").replace("\xa0", " ")):
                syn = syn.strip()
                if syn and not syn.split(" ")[0].endswith("."):
                    by_species.setdefault(_norm_species(syn), set()).add(mode)
            genus = taxon.split(" ")[0]
            if genus and not semantics.is_taxon_placeholder(genus):
                by_genus.setdefault(genus.lower(), set()).add(mode)
    return {"species": by_species, "genus": by_genus}


def join_tmd(tmd: dict, genus: str | None, species: str | None) -> list[dict]:
    label = SOURCES["tmd"]["label"]
    if species and not semantics.is_taxon_placeholder(species):
        modes = tmd["species"].get(_norm_species(species))
        if modes:
            return [{"function": m, "source": f"{label}, species", "rank": "species"}
                    for m in sorted(modes)]
    if genus and not semantics.is_taxon_placeholder(genus):
        modes = tmd["genus"].get(genus.strip().lower())
        if modes:
            return [{"function": m, "source": f"{label}, genus", "rank": "genus"}
                    for m in sorted(modes)]
    return []



def parse_faprotax(text: str) -> dict[str, list[str]]:
    groups: dict[str, list[str]] = {}
    cur = None
    expect_header = True
    for raw in text.split("\n"):
        if raw.strip() == "":
            expect_header = True
            continue
        s = raw.split("#", 1)[0].strip()
        if not s:
            continue
        if expect_header:
            cur = s.split()[0]
            groups[cur] = []
            expect_header = False
            continue
        groups[cur].append(s.strip('"').strip("'"))
    return groups


def load_faprotax(path: Path = VENDOR / SOURCES["faprotax"]["file"]) -> dict[str, list[str]]:
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        return parse_faprotax(fh.read())


def _pattern_re(pattern: str) -> re.Pattern:
    return re.compile("^" + ".*".join(re.escape(p) for p in pattern.split("*")) + "$", re.IGNORECASE)


_RE_CACHE: dict[str, re.Pattern] = {}


def _match_rank(pattern: str, strings: dict[str, str]) -> str | None:
    rx = _RE_CACHE.get(pattern)
    if rx is None:
        rx = _RE_CACHE[pattern] = _pattern_re(pattern)
    if rx.match(strings["order"]):
        return None
    for rank in ("family", "genus", "species"):
        s = strings.get(rank)
        if s is not None and rx.match(s):
            return rank
    return None


def _finer(a: str | None, b: str | None) -> str | None:
    if a is None:
        return b
    if b is None:
        return a
    return a if FINE_TO_COARSE.index(a) <= FINE_TO_COARSE.index(b) else b


def lineage_strings(lineage: dict) -> dict[str, str]:
    parts = []
    for rank in RANKS[:4]:
        v = lineage.get(rank)
        parts.append("" if v is None or semantics.is_taxon_placeholder(v) else str(v))
    out = {"order": ";".join(parts)}
    for rank in ("family", "genus", "species"):
        v = lineage.get(rank)
        if v is None or semantics.is_taxon_placeholder(v):
            break
        parts.append(str(v))
        out[rank] = ";".join(parts)
    return out


def join_faprotax(groups: dict[str, list[str]], lineage: dict) -> list[dict]:
    strings = lineage_strings(lineage)
    memo: dict[str, str | None] = {}
    active: set[str] = set()

    def rank_of(group: str) -> str | None:
        if group in memo:
            return memo[group]
        if group in active or group not in groups:
            return None
        active.add(group)
        best: str | None = None
        for item in groups[group]:
            op, _, arg = item.partition(":")
            if op == "add_group":
                best = _finer(best, rank_of(arg))
            elif op == "subtract_group":
                if rank_of(arg) is not None:
                    best = None
            elif op == "intersect_group":
                if rank_of(arg) is None:
                    best = None
            else:
                best = _finer(best, _match_rank(item, strings))
        active.discard(group)
        memo[group] = best
        return best

    label = SOURCES["faprotax"]["label"]
    return [{"function": g, "source": f"{label}, {rank_of(g)}", "rank": rank_of(g)}
            for g in groups if rank_of(g) is not None]



def load_sources(marker: str | None) -> dict:
    keys = MARKER_SOURCES.get((marker or "").strip().upper(), ())
    loaded = {}
    for k in keys:
        loaded[k] = {"mdb": load_mdb, "tmd": load_tmd, "faprotax": load_faprotax}[k]()
    return loaded


def annotate_lineage(sources: dict, lineage: dict) -> dict | None:
    hits: list[dict] = []
    if "mdb" in sources:
        hits += join_mdb(sources["mdb"], lineage.get("genus"), lineage.get("species"))
    if "tmd" in sources:
        hits += join_tmd(sources["tmd"], lineage.get("genus"), lineage.get("species"))
    if "faprotax" in sources:
        hits += join_faprotax(sources["faprotax"], lineage)
    if not hits:
        return None
    pairs = sorted({(h["function"], h["source"]) for h in hits})
    rank = None
    for h in hits:
        rank = _finer(rank, h["rank"])
    return {"functions": [p[0] for p in pairs], "sources": [p[1] for p in pairs], "rank": rank}


def has_lineage(lineage: dict) -> bool:
    return any(lineage.get(r) is not None and not semantics.is_taxon_placeholder(lineage[r])
               for r in FINE_TO_COARSE)


def run_id_for(marker: str | None) -> str:
    keys = MARKER_SOURCES.get((marker or "").strip().upper(), ())
    return "traits_" + ("+".join(SOURCES[k]["id"] for k in keys) if keys else "none")


def write_tsv(dataset_id: str, rows: list[dict], out_dir: Path = OUT_DIR) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    p = out_dir / f"{dataset_id}.traits.tsv"
    with p.open("w", encoding="utf-8", newline="\n") as fh:
        w = csv.writer(fh, delimiter="\t", lineterminator="\n")
        w.writerow(["asv_id", "trait_rank", "trait_function", "trait_source"])
        for r in rows:
            t = r["trait"]
            w.writerow([r["id"], t["rank"] if t else "", "|".join(t["functions"]) if t else "",
                        "|".join(t["sources"]) if t else ""])
    return p


def annotate_dataset(driver, dataset_id: str) -> dict:
    with driver.session() as s:
        ds = s.run("MATCH (d:Dataset {dataset_id:$d}) RETURN d.marker AS marker", d=dataset_id).single()
        if not ds:
            raise SystemExit(f"Dataset {dataset_id!r} gibt es im Graphen nicht.")
        marker = ds["marker"]
        asvs = [dict(r) for r in s.run(
            "MATCH (a:ASV {dataset_id:$d}) RETURN a.id AS id, "
            + ", ".join(f"a.{t} AS {t}" for t in RANKS) + " ORDER BY a.id", d=dataset_id)]
    sources = load_sources(marker)
    rows = []
    for a in asvs:
        lineage = {t: a[t] for t in RANKS}
        if not has_lineage(lineage):
            continue
        rows.append({"id": a["id"], "trait": annotate_lineage(sources, lineage)})
    annotated = [r for r in rows if r["trait"]]
    n_lin, n_ann = len(rows), len(annotated)
    by_rank = {r: sum(1 for x in annotated if x["trait"]["rank"] == r) for r in FINE_TO_COARSE}
    run_id = run_id_for(marker)
    keys = MARKER_SOURCES.get((marker or "").strip().upper(), ())
    props = {
        "dataset_id": dataset_id, "run_id": run_id, "computed_by": "manta",
        "method": ("exact name join of the ASV lineage against literature tables: species first, "
                   "then genus (18S: MDB via PR2, TMD); FAPROTAX patterns on the lineage string at "
                   "species, genus or family (16S). No hit above family, placeholders never joined, "
                   "no hit -> no property. Deterministic, no random component."),
        "marker": marker,
        "sources": [SOURCES[k]["label"] for k in keys],
        "source_citations": [SOURCES[k]["citation"] for k in keys],
        "source_files": [SOURCES[k]["file"] for k in keys],
        "source_sha256": [sha256(VENDOR / SOURCES[k]["file"]) for k in keys],
        "absent_reason": (None if keys else
                          f"no literature source is configured for marker {marker!r} "
                          f"(18S: MDB via PR2, TMD; 16S: FAPROTAX)"),
        "n_asv": len(asvs), "n_with_lineage": n_lin, "n_annotated": n_ann,
        "coverage": (n_ann / n_lin) if n_lin else 0.0,
        "n_rank_species": by_rank["species"], "n_rank_genus": by_rank["genus"],
        "n_rank_family": by_rank["family"],
    }
    with driver.session() as s:
        s.run("MATCH (t:TraitRun {dataset_id:$d}) DETACH DELETE t", d=dataset_id)
        s.run("MATCH (a:ASV {dataset_id:$d}) REMOVE a.trait_function, a.trait_source, "
              "a.trait_rank, a.trait_run_id", d=dataset_id)
        s.run("UNWIND $rows AS row MATCH (a:ASV {id: row.id, dataset_id:$d}) "
              "SET a.trait_function = row.functions, a.trait_source = row.sources, "
              "a.trait_rank = row.rank, a.trait_run_id = $run",
              d=dataset_id, run=run_id,
              rows=[{"id": r["id"], **r["trait"]} for r in annotated])
        s.run("MATCH (d:Dataset {dataset_id:$d}) CREATE (t:TraitRun $props) CREATE (t)-[:OF_DATASET]->(d)",
              d=dataset_id, props={k: v for k, v in props.items() if v is not None})
    props["tsv"] = str(write_tsv(dataset_id, rows))
    return props


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("Aufruf: annotate.py <dataset_id>", file=sys.stderr)
        return 2
    import ingest

    driver = ingest.connect()
    try:
        ingest.ensure_constraints(driver)
        p = annotate_dataset(driver, argv[1])
    finally:
        driver.close()
    print(f"{p['dataset_id']}: {p['n_annotated']} von {p['n_with_lineage']} ASVs mit Lineage "
          f"annotiert (coverage {p['coverage']:.3f}; species {p['n_rank_species']}, genus "
          f"{p['n_rank_genus']}, family {p['n_rank_family']}); Quellen: "
          f"{', '.join(p['sources']) or '—'}; Lauf {p['run_id']} -> {p['tsv']}")
    if p.get("absent_reason"):
        print(f"  HINWEIS: {p['absent_reason']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
