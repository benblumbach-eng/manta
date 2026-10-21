#!/usr/bin/env python3
"""Check a finished MANTA import against a saved copy of its OTTER work folder.

The folder must hold csv/ (OTTER's input tables) and otter/ (OTTER's output with
manta_manifest.json), as in the import's temporary folder. Every CSV is read here
independently of ingest.py, so a reading error in the import shows up as a difference.

Run with the ingest venv, which has the neo4j driver:
  tools/neo4j_ingest/.venv/bin/python tools/checks/pruefe_import.py --ordner ~/otter_sicherung
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import os
import sys
from pathlib import Path

TOL = 1e-9
MAX_BEISPIELE = 5

# enriched table column -> ASV property, as stored by tools/neo4j_ingest/ingest.py
ENRICHED_ZAHLEN = {
    "CON_Betweenness_Centrality": "con_betweenness", "CON_Closeness Centrality": "con_closeness",
    "con_cluster_closseness_centrality": "con_cluster_closeness",
    "con_cluster_betweeness_centrality": "con_cluster_betweenness",
    "CCM_Betweenness_Centrality": "ccm_betweenness", "CCM_Closeness Centrality": "ccm_closeness",
    "ccm_cluster_closseness_centrality": "ccm_cluster_closeness",
    "ccm_cluster_betweeness_centrality": "ccm_cluster_betweenness",
}

ergebnisse: list[tuple[str, bool, str]] = []


def melde(name: str, ok: bool, text: str = "") -> None:
    ergebnisse.append((name, ok, text))
    print(f"  {'✓ stimmt     ' if ok else '✗ WEICHT AB  '} {name}" + (f"\n                {text}" if text else ""),
          flush=True)


def zahl(v):
    if v is None:
        return None
    v = str(v).strip()
    if v == "" or v.lower() in ("nan", "na", "none", "null"):
        return None
    try:
        f = float(v)
    except ValueError:
        return None
    return None if math.isnan(f) else f


def gleich(a, b) -> bool:
    if a is None or b is None:
        return a is None and b is None
    return abs(a - b) <= TOL * max(1.0, abs(a), abs(b))


def beispiele(items) -> str:
    items = list(items)
    s = ", ".join(str(x) for x in items[:MAX_BEISPIELE])
    return s + (f" … (insgesamt {len(items)})" if len(items) > MAX_BEISPIELE else "")


def env_datei(pfad: Path) -> dict:
    werte = {}
    if pfad.exists():
        for zeile in pfad.read_text(encoding="utf-8").splitlines():
            zeile = zeile.strip()
            if zeile and not zeile.startswith("#") and "=" in zeile:
                k, v = zeile.split("=", 1)
                werte[k.strip()] = v.strip().strip('"').strip("'")
    return werte


# ---------------------------------------------------------------- Teil 1: the saved folder

def tabelle_ok(pfad: Path, trenner: str) -> str | None:
    """None if the file looks complete, else a reason."""
    if not pfad.exists():
        return "fehlt"
    if pfad.stat().st_size == 0:
        return "ist leer"
    with open(pfad, "rb") as fh:
        fh.seek(-1, os.SEEK_END)
        if fh.read(1) != b"\n":
            return "endet mitten in einer Zeile (beim Kopieren abgeschnitten?)"
    with open(pfad, newline="", encoding="utf-8") as fh:
        rd = csv.reader(fh, delimiter=trenner)
        kopf = next(rd, None)
        if not kopf:
            return "hat keine Kopfzeile"
        for nr, zeile in enumerate(rd, start=2):
            if zeile and len(zeile) != len(kopf):
                return f"Zeile {nr} hat {len(zeile)} statt {len(kopf)} Spalten"
    return None


def pruefe_ordner(ordner: Path) -> dict | None:
    print("\nTeil 1: Ist die Sicherung vollständig?")
    csv_dir, out_dir = ordner / "csv", ordner / "otter"
    man_pfad = out_dir / "manta_manifest.json"
    if not man_pfad.exists():
        melde("OTTER ist fertig geworden (manta_manifest.json vorhanden)", False,
              f"{man_pfad} fehlt. OTTER schreibt die Datei als Letztes; ohne sie ist die "
              f"Sicherung unvollständig.")
        return None
    man = json.loads(man_pfad.read_text(encoding="utf-8"))
    melde("OTTER ist fertig geworden (manta_manifest.json vorhanden)", True)
    dateien = {"abundance": csv_dir / "abundance.csv", "taxa": csv_dir / "taxa_info.csv"}
    for key in ("enriched", "con", "pruned", "pv"):
        if man.get(key):
            dateien[key] = out_dir / Path(man[key]).name
    fehler = []
    for key, pfad in dateien.items():
        grund = tabelle_ok(pfad, "," if key == "enriched" else ";")
        if grund:
            fehler.append(f"{pfad.name} {grund}")
    melde("alle Tabellen da und vollständig", not fehler, "; ".join(fehler))
    if fehler:
        return None
    p = man.get("params", {})
    scope = man.get("network_scope", {})
    print(f"\n  Einstellungen des Laufs: Schwelle {p.get('con_tr')}, p {p.get('con_alpha')}, "
          f"{p.get('num_permutations')} Wiederholungen, {p.get('fft_coeffs')} Fourier-Koeffizienten, "
          f"Hellinger {p.get('hellinger')}, ASVs im Netzlauf {scope.get('n_asv_in_network_run')} "
          f"von {scope.get('n_asv_available')}")
    return dateien


# ---------------------------------------------------------------- reading OTTER's tables

def lies_abundanz(pfad: Path):
    with open(pfad, newline="", encoding="utf-8") as fh:
        rd = csv.reader(fh, delimiter=";")
        kopf = next(rd)
        asvs = [c.strip() for c in kopf[1:]]
        proben, zellen = [], {}
        for zeile in rd:
            sid = zeile[0].strip()
            if not sid:
                continue
            proben.append(sid)
            for aid, v in zip(asvs, zeile[1:]):
                f = zahl(v)
                if f is not None and f != 0.0:
                    zellen[(sid, aid)] = f
    return proben, asvs, zellen


def lies_kanten(pfad: Path, wert: str):
    out = {}
    with open(pfad, newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh, delimiter=";"):
            a, b = (r.get("from") or "").strip(), (r.get("to") or "").strip()
            if a and b:
                out[(a, b)] = {"wert": zahl(r.get(wert)), "p": zahl(r.get("p-value")),
                               "p_adj": zahl(r.get("p-value_adj_fdr_bh"))}
    return out


def lies_enriched(pfad: Path):
    out = {}
    with open(pfad, newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh, delimiter=","):
            aid = (r.get("Nodes") or "").strip()
            if aid:
                lbl = zahl(r.get("LouvainLabelD"))
                out[aid] = {"modul": None if lbl is None else int(round(lbl)),
                            **{prop: zahl(r.get(col)) for col, prop in ENRICHED_ZAHLEN.items()}}
    return out


def lies_taxa(pfad: Path):
    out = {}
    with open(pfad, newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh, delimiter=";"):
            aid = (r.get("ASV") or "").strip()
            if aid:
                out[aid] = (r.get("Genus") or "").strip() or None
    return out


# ---------------------------------------------------------------- Teil 2: tables vs database

def vergleiche_mengen(name, datei: set, db: set, was: str):
    nur_datei, nur_db = datei - db, db - datei
    text = []
    if nur_datei:
        text.append(f"{len(nur_datei)} {was} nur in OTTERs Tabelle, z. B. {beispiele(sorted(nur_datei))}")
    if nur_db:
        text.append(f"{len(nur_db)} {was} nur in der Datenbank, z. B. {beispiele(sorted(nur_db))}")
    melde(f"{name}: {len(datei)} in der Tabelle, {len(db)} in der Datenbank", not text, "; ".join(text))


def vergleiche_werte(name, paare):
    """paare: iterable of (key, value_file, value_db)."""
    falsch = [f"{k}: Tabelle {a!r}, Datenbank {b!r}" for k, a, b in paare if not gleich(a, b)]
    melde(name, not falsch, beispiele(falsch) if falsch else "")


def pruefe_datenbank(session, d: str, dateien: dict):
    print(f"\nTeil 2: Steht in der Datenbank genau das, was OTTER ausgegeben hat? (Datensatz {d})")
    q = lambda text, **kw: [r.data() for r in session.run(text, d=d, **kw)]

    proben, asvs, zellen = lies_abundanz(dateien["abundance"])
    vergleiche_mengen("Proben", set(proben),
                      {r["s"] for r in q("MATCH (s:Sample {dataset_id:$d}) RETURN s.sample_id AS s")}, "Proben")
    vergleiche_mengen("ASVs", set(asvs),
                      {r["a"] for r in q("MATCH (a:ASV {dataset_id:$d}) RETURN a.id AS a")}, "ASVs")
    db_zellen = {(r["s"], r["a"]): r["c"] for r in q(
        "MATCH (s:Sample {dataset_id:$d})-[r:HAS_ABUNDANCE]->(a:ASV {dataset_id:$d}) "
        "RETURN s.sample_id AS s, a.id AS a, r.count AS c")}
    vergleiche_mengen("Abundanzwerte ungleich 0", set(zellen), set(db_zellen), "Werte")
    vergleiche_werte("Abundanzwerte: jede Zahl gleich",
                     ((k, v, db_zellen[k]) for k, v in zellen.items() if k in db_zellen))

    taxa = lies_taxa(dateien["taxa"])
    # OTTER fills a missing rank with "Environment_Condition"; MANTA reads it as "no genus".
    db_gattung = {r["a"]: (None if r["g"] == "Environment_Condition" else r["g"])
                  for r in q("MATCH (a:ASV {dataset_id:$d}) RETURN a.id AS a, a.genus AS g")}
    falsch = [f"{a}: Tabelle {g!r}, Datenbank {db_gattung.get(a)!r}"
              for a, g in taxa.items() if a in db_gattung and g != db_gattung[a]]
    melde("Gattung jeder ASV", not falsch, beispiele(falsch) if falsch else "")

    enr = lies_enriched(dateien["enriched"])
    db_asv = {r["a"]: r for r in q(
        "MATCH (a:ASV {dataset_id:$d}) WHERE a.louvain_label IS NOT NULL "
        "OPTIONAL MATCH (a)-[:MEMBER_OF]->(c:Cluster {dataset_id:$d}) "
        "RETURN a.id AS a, a.louvain_label AS modul, collect(c.louvain_label) AS cl, "
        + ", ".join(f"a.{p} AS {p}" for p in ENRICHED_ZAHLEN.values()))}
    vergleiche_mengen("ASVs im Netz", set(enr), set(db_asv), "ASVs")
    gemeinsam = [a for a in enr if a in db_asv]
    falsch = [f"{a}: Tabelle Modul {enr[a]['modul']}, Datenbank {db_asv[a]['modul']}"
              for a in gemeinsam if enr[a]["modul"] != db_asv[a]["modul"]]
    falsch += [f"{a}: Modul {db_asv[a]['modul']}, aber Mitglied von {db_asv[a]['cl']}"
               for a in gemeinsam if db_asv[a]["cl"] != [db_asv[a]["modul"]]]
    melde(f"Modul jeder ASV ({len({e['modul'] for e in enr.values()})} Module)", not falsch,
          beispiele(falsch) if falsch else "")
    vergleiche_werte("Zentralitäten (Wichtigkeit im Netz und im Modul)",
                     ((f"{a} {p}", enr[a][p], db_asv[a][p]) for a in gemeinsam for p in ENRICHED_ZAHLEN.values()))

    con = lies_kanten(dateien["con"], "corr")
    con_ungerichtet = {}
    for (a, b), v in con.items():
        con_ungerichtet[tuple(sorted((a, b)))] = v
    db_con = {tuple(sorted((r["a"], r["b"]))): r for r in q(
        "MATCH (a:ASV {dataset_id:$d})-[r:CO_OCCURS_WITH {dataset_id:$d}]->(b:ASV {dataset_id:$d}) "
        "RETURN a.id AS a, b.id AS b, r.corr AS corr, r.p_value AS p, r.p_adj_fdr AS p_adj")}
    vergleiche_mengen("Gemeinsam-Verbindungen (CON)", set(con_ungerichtet), set(db_con), "Verbindungen")
    vergleiche_werte("CON: Korrelation und p-Werte jeder Verbindung",
                     ((f"{k} {f}", con_ungerichtet[k][w], db_con[k][f])
                      for k in con_ungerichtet if k in db_con
                      for w, f in (("wert", "corr"), ("p", "p"), ("p_adj", "p_adj"))))

    pruned = lies_kanten(dateien["pruned"], "corr")
    db_inf = {(r["a"], r["b"]): r for r in q(
        "MATCH (a:ASV {dataset_id:$d})-[r:INFLUENCES {dataset_id:$d}]->(b:ASV {dataset_id:$d}) "
        "RETURN a.id AS a, b.id AS b, r.nmi AS nmi, r.p_value AS p")}
    vergleiche_mengen("Einfluss-Richtungen, die den Test bestanden haben (CCM)", set(pruned), set(db_inf),
                      "Richtungen")
    vergleiche_werte("CCM: Stärke und p-Wert jeder Richtung",
                     ((f"{k} {f}", pruned[k][w], db_inf[k][f]) for k in pruned if k in db_inf
                      for w, f in (("wert", "nmi"), ("p", "p"))))

    if "pv" in dateien:
        pv = lies_kanten(dateien["pv"], "corr")
        verworfen = {k: v for k, v in pv.items() if k not in pruned}
        db_rej = {(r["a"], r["b"]): r for r in q(
            "MATCH (a:ASV {dataset_id:$d})-[r:CCM_REJECTED {dataset_id:$d}]->(b:ASV {dataset_id:$d}) "
            "RETURN a.id AS a, b.id AS b, r.nmi AS nmi, r.p_value AS p")}
        vergleiche_mengen("Einfluss-Richtungen, die durchgefallen sind", set(verworfen), set(db_rej),
                          "Richtungen")
        vergleiche_werte("Durchgefallene: Stärke und p-Wert",
                         ((f"{k} {f}", verworfen[k][w], db_rej[k][f]) for k in verworfen if k in db_rej
                          for w, f in (("wert", "nmi"), ("p", "p"))))


def finde_datensatz(session, proben: set) -> str | None:
    kandidaten = []
    for r in session.run("MATCH (ds:Dataset) OPTIONAL MATCH (s:Sample {dataset_id: ds.dataset_id}) "
                         "RETURN ds.dataset_id AS d, collect(s.sample_id) AS proben"):
        treffer = len(proben & set(r["proben"]))
        kandidaten.append((treffer, r["d"]))
    kandidaten.sort(reverse=True)
    passend = [d for t, d in kandidaten if t == len(proben)]
    if len(passend) == 1:
        return passend[0]
    print("\nWelcher Datensatz gehört zur Sicherung? Bitte mit --datensatz angeben. Datensätze "
          "(Zahl = gemeinsame Proben mit der Sicherung):")
    for t, d in kandidaten:
        print(f"  {d}: {t} von {len(proben)}")
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description="Prüft einen fertigen MANTA-Import gegen die gesicherten OTTER-Tabellen.")
    ap.add_argument("--ordner", required=True, type=Path, help="gesicherter Arbeitsordner mit csv/ und otter/")
    ap.add_argument("--datensatz", help="Name des Datensatzes in MANTA (ohne: wird über die Proben gesucht)")
    ap.add_argument("--env", type=Path, default=Path.home() / "manta/apps/manta_web/backend/.env",
                    help="Datei mit NEO4J_URI und NEO4J_PASSWORD (Standard: %(default)s)")
    a = ap.parse_args()

    dateien = pruefe_ordner(a.ordner.expanduser())
    if dateien is None:
        print("\nErgebnis: Die Sicherung ist unvollständig, Teil 2 entfällt.")
        return 2

    from neo4j import GraphDatabase
    env = {**env_datei(a.env), **{k: v for k, v in os.environ.items() if k.startswith("NEO4J_")}}
    if not env.get("NEO4J_PASSWORD"):
        print(f"Kein NEO4J_PASSWORD gefunden (gesucht in {a.env}). Mit --env auf die .env-Datei zeigen.")
        return 2
    drv = GraphDatabase.driver(env.get("NEO4J_URI", "bolt://localhost:7687"),
                               auth=(env.get("NEO4J_USER", "neo4j"), env["NEO4J_PASSWORD"]))
    try:
        with drv.session() as s:
            d = a.datensatz or finde_datensatz(s, set(lies_abundanz(dateien["abundance"])[0]))
            if d is None:
                return 2
            pruefe_datenbank(s, d, dateien)
    finally:
        drv.close()

    falsch = [n for n, ok, _ in ergebnisse if not ok]
    print("\nErgebnis: " + ("ALLES STIMMT. Die Datenbank enthält genau OTTERs Ergebnis."
                            if not falsch else f"{len(falsch)} Prüfung(en) weichen ab: " + "; ".join(falsch)))
    return 0 if not falsch else 1


if __name__ == "__main__":
    sys.exit(main())
