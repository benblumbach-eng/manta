#!/usr/bin/env python3
"""Compute the first N ASVs of a saved import twice, once the way MANTA calls OTTER
(tools/otter_runner/run_otter.py) and once with OTTER's own terminal entry
(run_on_terminal_main.main), and compare the tables cell by cell.

Run with OTTER's venv:
  ~/manta/submodules/otter/.venv/bin/python vergleiche_mit_otter.py --ordner ~/otter_sicherung
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import pandas as pd

TOL = 1e-9


def tabelle(ordner: Path, muster: str, ohne: tuple[str, ...] = ()) -> pd.DataFrame:
    treffer = sorted(f for f in ordner.glob(muster) if not any(x in f.name for x in ohne))
    if len(treffer) != 1:
        raise SystemExit(f"{muster}: {len(treffer)} Dateien in {ordner} gefunden, erwartet 1")
    return pd.read_csv(treffer[0], sep=";")


def vergleiche(name: str, a: pd.DataFrame, b: pd.DataFrame, schluessel: list[str], spalten: list[str]) -> bool:
    a = a[schluessel + spalten].set_index(schluessel).sort_index()
    b = b[schluessel + spalten].set_index(schluessel).sort_index()
    nur_a, nur_b = a.index.difference(b.index), b.index.difference(a.index)
    gemeinsam = a.index.intersection(b.index)
    abw = []
    for s in spalten:
        x, y = a.loc[gemeinsam, s].astype(float), b.loc[gemeinsam, s].astype(float)
        diff = (x - y).abs() > TOL * x.abs().clip(lower=1.0)
        diff &= ~(x.isna() & y.isna())
        abw += [f"{k} {s}: MANTA {x[k]!r}, OTTER {y[k]!r}" for k in diff[diff].index[:5]]
    ok = not len(nur_a) and not len(nur_b) and not abw
    print(f"  {'✓ stimmt     ' if ok else '✗ WEICHT AB  '} {name}: {len(a)} Zeilen über MANTA, {len(b)} mit OTTER allein")
    if len(nur_a):
        print(f"                nur über MANTA: {list(nur_a[:5])}")
    if len(nur_b):
        print(f"                nur mit OTTER allein: {list(nur_b[:5])}")
    for z in abw:
        print(f"                {z}")
    return ok


def vergleiche_module(a: pd.DataFrame, b: pd.DataFrame) -> bool:
    # Module numbers are arbitrary; the two entry points number the same modules differently.
    gruppen = lambda t: {frozenset(g["Nodes"]) for _, g in t.groupby("LouvainLabelD")}
    ga, gb = gruppen(a), gruppen(b)
    ok = ga == gb
    print(f"  {'✓ stimmt     ' if ok else '✗ WEICHT AB  '} Module (Louvain): {len(ga)} über MANTA, {len(gb)} mit "
          f"OTTER allein, {'dieselben ASVs in denselben Modulen' if ok else 'andere Aufteilung der ASVs'} "
          f"(die Modulnummern selbst dürfen sich unterscheiden)")
    if not ok:
        for g in list(ga - gb)[:5]:
            print(f"                nur über MANTA: Modul mit {sorted(g)[:6]}")
    return ok


def main() -> int:
    ap = argparse.ArgumentParser(description="Rechnet einen Ausschnitt über MANTA und mit OTTER allein und vergleicht.")
    ap.add_argument("--ordner", required=True, type=Path, help="gesicherter Arbeitsordner mit csv/ und otter/")
    ap.add_argument("--asvs", type=int, default=200, help="so viele ASVs (die ersten der Tabelle) rechnen (Standard: %(default)s)")
    ap.add_argument("--manta", type=Path, default=Path.home() / "manta",
                    help="MANTA-Ordner mit submodules/otter (Standard: %(default)s)")
    a = ap.parse_args()
    REPO = a.manta.expanduser().resolve()
    OTTER = REPO / "submodules" / "otter"
    ordner = a.ordner.expanduser()
    p = json.loads((ordner / "otter" / "manta_manifest.json").read_text(encoding="utf-8")).get("params", {})
    perm, samp = int(p.get("num_permutations", 999)), int(p.get("num_samples", 10))

    arbeit = Path(tempfile.mkdtemp(prefix="manta_vergleich_"))
    ab = pd.read_csv(ordner / "csv" / "abundance.csv", sep=";", index_col=0)
    ab.iloc[:, :a.asvs].to_csv(arbeit / "abundance.csv", sep=";")
    taxa, env = ordner / "csv" / "taxa_info.csv", ordner / "csv" / "environment_info.csv"
    print(f"Rechne die ersten {min(a.asvs, ab.shape[1])} von {ab.shape[1]} ASVs zweimal "
          f"({perm} Wiederholungen). Das dauert einige Minuten. Arbeitsordner: {arbeit}", flush=True)

    py = sys.executable
    (arbeit / "manta").mkdir()
    (arbeit / "otter").mkdir()
    print("\n1/2 über MANTA (run_otter.py) …", flush=True)
    subprocess.run([py, str(REPO / "tools/otter_runner/run_otter.py"), "--otter-root", str(OTTER),
                    "--abundance", str(arbeit / "abundance.csv"), "--taxa", str(taxa),
                    "--environment", str(env), "--out", str(arbeit / "manta"), "--run-id", "Check",
                    "--con-tr", str(p.get("con_tr", 0.7)), "--con-alpha", str(p.get("con_alpha", 0.05)),
                    "--fft-coeffs", str(p.get("fft_coeffs", 14)),
                    "--num-permutations", str(perm), "--num-samples", str(samp)],
                   cwd=OTTER, check=True, stdout=open(arbeit / "manta.log", "w"), stderr=subprocess.STDOUT)
    print("2/2 mit OTTER allein (run_on_terminal_main.py) …", flush=True)
    # Call main() directly: started as a script, run_on_terminal_main.py first rebuilds .venv with
    # python3.11 and pip-installs requirements.txt into it, which would break MANTA's OTTER venv.
    # main() imports save_dict_to_json from a module that needs plotly, which MANTA's OTTER venv
    # does not have; it only writes a log file, so a stand-in replaces that one module.
    ersatz = ("import json, sys, types; e = types.ModuleType('gui.gui_ai_umap_embedding'); "
              "e.save_dict_to_json = lambda d, p: open(p, 'w').write(json.dumps(d, default=str)); "
              "sys.modules['gui.gui_ai_umap_embedding'] = e; "
              "import run_on_terminal_main as m; sys.argv[0] = m.__file__; m.main()")
    subprocess.run([py, "-c", ersatz,
                    "--prefix", str(arbeit / "otter"), "--run_id", "Check",
                    "--abundance_csv", str(arbeit / "abundance.csv"), "--taxa_csv", str(taxa),
                    "--environment_csv", str(env), "--num_cores", "1",
                    "--con_threshold", str(p.get("con_tr", 0.7)), "--con_alpha", str(p.get("con_alpha", 0.05)),
                    "--fft_coeffs", str(p.get("fft_coeffs", 14)),
                    "--num_permutations", str(perm), "--num_samples", str(samp)],
                   cwd=OTTER, check=True, stdout=open(arbeit / "otter.log", "w"), stderr=subprocess.STDOUT)

    m, o = arbeit / "manta", arbeit / "otter"
    print("\nVergleich:")
    ok = [
        vergleiche("Gemeinsam-Verbindungen (CON)", tabelle(m, "*_Pearson_FFT__complete_network_table_0*"),
                   tabelle(o, "*_Pearson_FFT__complete_network_table_0*"), ["from", "to"],
                   ["corr", "p-value", "p-value_adj_fdr_bh"]),
        vergleiche_module(tabelle(m, "*_Louvain_*_meta_*"), tabelle(o, "*_Louvain_*_meta_*")),
        vergleiche("Einfluss-Stärke aller ASV-Paare (CCM, alle Richtungen)",
                   tabelle(m, "*_NMI__complete_network_table_0*[!a].csv"),
                   tabelle(o, "*_NMI__complete_network_table_0*[!a].csv"), ["from", "to"], ["corr"]),
        vergleiche("Einfluss-Richtungen auf den Verbindungen (CCM)", tabelle(m, "*_CCM_CON_MAP_Network.csv", ("_PV_", "_Pruned_")),
                   tabelle(o, "*_CCM_CON_MAP_Network.csv", ("_PV_", "_Pruned_")), ["from", "to"], ["corr"]),
        vergleiche("p-Werte aller getesteten Richtungen", tabelle(m, "*_PV_CCM_CON_MAP_Network.csv"),
                   tabelle(o, "*_PV_CCM_CON_MAP_Network.csv"), ["from", "to"], ["corr", "p-value"]),
        vergleiche("Richtungen, die den Test bestanden haben", tabelle(m, "*_Pruned_CCM_CON_MAP_Network.csv"),
                   tabelle(o, "*_Pruned_CCM_CON_MAP_Network.csv"), ["from", "to"], ["corr", "p-value"]),
    ]
    print("\nErgebnis: " + ("ALLES STIMMT. MANTA ruft OTTER so auf, dass dasselbe herauskommt wie mit OTTER allein."
                            if all(ok) else "Es gibt Abweichungen, siehe oben. Protokolle: "
                            f"{arbeit / 'manta.log'} und {arbeit / 'otter.log'}"))
    return 0 if all(ok) else 1


if __name__ == "__main__":
    sys.exit(main())
