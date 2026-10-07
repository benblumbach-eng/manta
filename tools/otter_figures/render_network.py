#!/usr/bin/env python3
from __future__ import annotations

import argparse
import glob
import json
import os
import re

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
import networkx as nx
import pandas as pd


MANIFEST = "manta_manifest.json"
DESCRIPTION = """\
Draw the networks of one OTTER run as PNG, PDF and GraphML.

OTTER itself draws no node-link diagram; it tags the nodes for tools such as Cytoscape or
Gephi (cluster colour, size by Abundance4y, centralities). This script uses exactly those
tags; only the node positions are computed (spring layout), because OTTER defines none.

The tables are found through the run's manta_manifest.json, or by file name if there is
none. Run it with OTTER's venv (it has matplotlib and networkx):

  submodules/otter/.venv/bin/python tools/otter_figures/render_network.py \\
      --in <otter_out> --out <images>
"""


def load_manifest(folder: str) -> dict:
    try:
        with open(os.path.join(folder, MANIFEST), encoding="utf-8") as fh:
            m = json.load(fh)
    except (OSError, ValueError):
        return {}
    return m if isinstance(m, dict) else {}


def find_table(folder: str, manifest: dict, key: str, pattern: str, exclude: str = "") -> str:
    named = manifest.get(key)
    if named:
        if os.path.exists(named):
            return named
        local = os.path.join(folder, os.path.basename(named))
        if os.path.exists(local):
            return local
    hits = sorted(h for h in glob.glob(os.path.join(folder, pattern))
                  if not (exclude and exclude in os.path.basename(h)))
    if not hits:
        raise SystemExit(f"Missing in {folder}: no file matching '{pattern}' "
                         f"(and no usable {MANIFEST}). Is this the --out folder of run_otter.py?")
    if len(hits) > 1:
        names = ", ".join(os.path.basename(h) for h in hits)
        raise SystemExit(f"Ambiguous in {folder}: {len(hits)} files match '{pattern}' ({names}). "
                         f"Keep one run per folder, or keep the {MANIFEST} that run_otter.py wrote.")
    return hits[0]


def con_threshold(manifest: dict, con_path: str, corrs: list[float]) -> float:
    tr = (manifest.get("params") or {}).get("con_tr")
    if tr is not None:
        return float(tr)
    m = re.search(r"_complete_network_table_(-?[0-9.]+)_[0-9.]+\.csv$", os.path.basename(con_path))
    if m:
        try:
            return float(m.group(1))
        except ValueError:
            pass
    return min((abs(c) for c in corrs), default=0.0)


def main() -> None:
    ap = argparse.ArgumentParser(description=DESCRIPTION,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="src", metavar="DIR", required=True,
                    help="OTTER output folder (run_otter.py --out)")
    ap.add_argument("--out", dest="dst", metavar="DIR", required=True, help="folder for the images")
    ap.add_argument("--title", dest="title", default="",
                    help="text added to the figure titles, e.g. the dataset name")
    ap.add_argument("--titel", dest="title", default=argparse.SUPPRESS, help=argparse.SUPPRESS)
    a = ap.parse_args()
    os.makedirs(a.dst, exist_ok=True)
    zusatz = f" — {a.title}" if a.title else ""

    manifest = load_manifest(a.src)
    ENR = find_table(a.src, manifest, "enriched", "*_meta_CON_CCM.csv")
    CON = find_table(a.src, manifest, "con", "*_Pearson_FFT__complete_network_table_*_*.csv",
                     exclude="_complete_network_table_meta_")
    PRUNE = find_table(a.src, manifest, "pruned", "*_Pruned_CCM_CON_MAP_Network.csv")

    meta = pd.read_csv(ENR, sep=",")
    meta["Nodes"] = meta["Nodes"].astype(str)
    color = dict(zip(meta["Nodes"], meta["louvain_label_color"].astype(str)))
    genus = dict(zip(meta["Nodes"], meta["Genus"].astype(str)))
    clust = {r["Nodes"]: (int(float(r["LouvainLabelD"])) if not pd.isna(r["LouvainLabelD"]) else -1)
             for _, r in meta.iterrows()}
    ab = dict(zip(meta["Nodes"], pd.to_numeric(meta["Abundance4y"], errors="coerce").fillna(0.0)))
    amax = max(ab.values()) or 1.0

    TAXO = ["Kingdom", "Phylum", "Class", "Order", "Family", "Genus", "Species"]
    CENT = [c for c in meta.columns if "entrality" in c]

    attr = {}
    for _, r in meta.iterrows():
        n = r["Nodes"]
        d = {"label": str(r["Genus"]), "asv": n, "louvain_cluster": clust[n],
             "louvain_label_color": str(r["louvain_label_color"]),
             "Shape": str(r["Shape"]) if "Shape" in meta and not pd.isna(r["Shape"]) else "Diamond",
             "read_count_total": float(ab[n])}
        for c in TAXO:
            d[c] = "" if c not in meta or pd.isna(r[c]) else str(r[c])
        for c in CENT:
            v = pd.to_numeric(pd.Series([r[c]]), errors="coerce").iloc[0]
            d[c.replace(" ", "_")] = 0.0 if pd.isna(v) else float(v)
        attr[n] = d

    def nsize(n): return 150.0 + 1500.0 * (ab.get(n, 0.0) / amax)
    def ncol(n): return color.get(n, "#999999")

    def add_attrs(G):
        for n in G.nodes():
            G.nodes[n].update(attr.get(n, {"louvain_label_color": "#999999", "Shape": "Diamond",
                                           "louvain_cluster": -1, "label": n}))

    def draw(G, pos, ew, title, fname, directed=False, breite=None):
        fig, ax = plt.subplots(figsize=(13, 10))
        nx.draw_networkx_edges(G, pos, ax=ax, width=ew, edge_color="#8a8a8a", alpha=0.6,
                               arrows=directed, arrowsize=14, arrowstyle="-|>",
                               connectionstyle="arc3,rad=0.08" if directed else "arc3")
        nx.draw_networkx_nodes(G, pos, ax=ax, nodelist=list(G.nodes()),
                               node_color=[ncol(n) for n in G.nodes()],
                               node_size=[nsize(n) for n in G.nodes()],
                               node_shape="D", edgecolors="white", linewidths=1.3)
        nx.draw_networkx_labels(G, pos, ax=ax, font_size=7, font_color="#111",
                                labels={n: genus.get(n, n).replace(" uc", "") for n in G.nodes()})
        seen = {}
        for n in G.nodes():
            c = clust.get(n)
            if c is not None and c not in seen:
                seen[c] = ncol(n)
        handles = [Line2D([0], [0], marker="D", color="w", label=f"Louvain cluster {c}",
                          markerfacecolor=col, markersize=10) for c, col in sorted(seen.items())]
        abw = [ab.get(n, 0.0) for n in G.nodes()]
        if abw:
            ganz = lambda v: f"{v:,.0f}".replace(",", " ")
            handles.append(Line2D([0], [0], marker="D", color="w", markerfacecolor="#bbbbbb",
                                  markeredgecolor="#666666", markersize=9,
                                  label=f"Node size ∝ Abundance4y ({ganz(min(abw))}–{ganz(max(abw))})"))
        if breite:
            mass, werte = breite
            if len(werte):
                handles.append(Line2D([0], [0], color="#8a8a8a", lw=2.5,
                                      label=f"Edge width ∝ {mass} ({min(werte):.2f}–{max(werte):.2f})"))
        ax.legend(handles=handles, title="Legend (OTTER)", loc="upper left",
                  fontsize=8, title_fontsize=9, frameon=True)
        ax.set_title(title, fontsize=15, fontweight="bold")
        ax.axis("off")
        fig.tight_layout()
        for ext in ("png", "pdf"):
            fig.savefig(os.path.join(a.dst, f"{fname}.{ext}"), dpi=300, bbox_inches="tight")
        plt.close(fig)

    con = pd.read_csv(CON, sep=";")
    Gc = nx.Graph()
    for _, r in con.iterrows():
        Gc.add_edge(str(r["from"]), str(r["to"]), corr=float(r["corr"]),
                    p_value=float(r["p-value"]), p_adj_fdr_bh=float(r["p-value_adj_fdr_bh"]))
    add_attrs(Gc)
    posc = nx.spring_layout(Gc, seed=42, k=0.9, iterations=200)
    absr = [abs(Gc[u][v]["corr"]) for u, v in Gc.edges()]
    lo = con_threshold(manifest, CON, absr)
    ewc = [max(0.5, 0.5 + (r - lo) / max(1e-9, 1.0 - lo) * 3.5) for r in absr]
    draw(Gc, posc, ewc, f"Co-occurrence network (CON), Louvain clusters{zusatz}",
         "CON_network", breite=("|r|", absr))
    nx.write_graphml(Gc, os.path.join(a.dst, "CON_network.graphml"))

    pr = pd.read_csv(PRUNE, sep=";")
    Gp = nx.DiGraph()
    for _, r in pr.iterrows():
        Gp.add_edge(str(r["from"]), str(r["to"]), corr=float(r["corr"]),
                    p_value=float(r["p-value"]), from_clu=int(r["from_clu"]),
                    to_clu=int(r["to_clu"]))
    add_attrs(Gp)
    posp = nx.spring_layout(Gp, seed=42, k=1.1, iterations=200)
    ewp = [0.6 + Gp[u][v]["corr"] * 4.0 for u, v in Gp.edges()]
    draw(Gp, posp, ewp, f"Directed CCM edges on CON pairs (pruned){zusatz}",
         "CCM_directed", directed=True,
         breite=("NMI", [Gp[u][v]["corr"] for u, v in Gp.edges()]))
    nx.write_graphml(Gp, os.path.join(a.dst, "CCM_directed.graphml"))

    print(f"CON : {Gc.number_of_nodes()} nodes, {Gc.number_of_edges()} edges")
    print(f"CCM : {Gp.number_of_nodes()} nodes, {Gp.number_of_edges()} directed edges")
    print(f"-> {a.dst}  (PNG, PDF and GraphML per network)")


if __name__ == "__main__":
    main()
