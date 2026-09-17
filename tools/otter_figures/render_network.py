#!/usr/bin/env python3
from __future__ import annotations

import argparse
import glob
import os

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
import networkx as nx
import pandas as pd


def finde(ordner: str, endung: str) -> str:
    treffer = sorted(glob.glob(os.path.join(ordner, f"*{endung}")))
    if not treffer:
        raise SystemExit(f"FEHLT in {ordner}: eine Datei auf '{endung}'")
    return treffer[0]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--in", dest="quelle", required=True, help="OTTER-Ausgabeverzeichnis")
    ap.add_argument("--out", dest="ziel", required=True, help="wohin die Bilder sollen")
    ap.add_argument("--titel", default="", help="Zusatz im Bildtitel, z.B. der Datensatzname")
    a = ap.parse_args()
    os.makedirs(a.ziel, exist_ok=True)
    zusatz = f" — {a.titel}" if a.titel else ""

    ENR = finde(a.quelle, "_meta_CON_CCM.csv")
    CON = finde(a.quelle, "_Pearson_FFT__complete_network_table_0.7_0.05.csv")
    PRUNE = finde(a.quelle, "_Pruned_CCM_CON_MAP_Network.csv")

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
        handles = [Line2D([0], [0], marker="D", color="w", label=f"Louvain-Cluster {c}",
                          markerfacecolor=col, markersize=10) for c, col in sorted(seen.items())]
        abw = [ab.get(n, 0.0) for n in G.nodes()]
        if abw:
            ganz = lambda v: f"{v:,.0f}".replace(",", " ")
            handles.append(Line2D([0], [0], marker="D", color="w", markerfacecolor="#bbbbbb",
                                  markeredgecolor="#666666", markersize=9,
                                  label=f"Knotengröße ∝ Abundance4y ({ganz(min(abw))}–{ganz(max(abw))})"))
        if breite:
            mass, werte = breite
            if len(werte):
                handles.append(Line2D([0], [0], color="#8a8a8a", lw=2.5,
                                      label=f"Kantenbreite ∝ {mass} ({min(werte):.2f}–{max(werte):.2f})"))
        ax.legend(handles=handles, title="Legende (OTTER)", loc="upper left",
                  fontsize=8, title_fontsize=9, frameon=True)
        ax.set_title(title, fontsize=15, fontweight="bold")
        ax.axis("off")
        fig.tight_layout()
        for ext in ("png", "pdf"):
            fig.savefig(os.path.join(a.ziel, f"{fname}.{ext}"), dpi=300, bbox_inches="tight")
        plt.close(fig)

    con = pd.read_csv(CON, sep=";")
    Gc = nx.Graph()
    for _, r in con.iterrows():
        Gc.add_edge(str(r["from"]), str(r["to"]), corr=float(r["corr"]),
                    p_value=float(r["p-value"]), p_adj_fdr_bh=float(r["p-value_adj_fdr_bh"]))
    add_attrs(Gc)
    posc = nx.spring_layout(Gc, seed=42, k=0.9, iterations=200)
    ewc = [0.5 + (Gc[u][v]["corr"] - 0.70) / 0.30 * 3.5 for u, v in Gc.edges()]
    draw(Gc, posc, ewc, f"Ko-Okkurrenz-Netzwerk (CON), Louvain-Cluster{zusatz}",
         "CON_netzwerk", breite=("|r|", [Gc[u][v]["corr"] for u, v in Gc.edges()]))
    nx.write_graphml(Gc, os.path.join(a.ziel, "CON_netzwerk.graphml"))

    pr = pd.read_csv(PRUNE, sep=";")
    Gp = nx.DiGraph()
    for _, r in pr.iterrows():
        Gp.add_edge(str(r["from"]), str(r["to"]), corr=float(r["corr"]),
                    p_value=float(r["p-value"]), from_clu=int(r["from_clu"]),
                    to_clu=int(r["to_clu"]))
    add_attrs(Gp)
    posp = nx.spring_layout(Gp, seed=42, k=1.1, iterations=200)
    ewp = [0.6 + Gp[u][v]["corr"] * 4.0 for u, v in Gp.edges()]
    draw(Gp, posp, ewp, f"Gerichtete CCM-Kanten auf CON-Paaren (gepruent){zusatz}",
         "CCM_gerichtet", directed=True,
         breite=("NMI", [Gp[u][v]["corr"] for u, v in Gp.edges()]))
    nx.write_graphml(Gp, os.path.join(a.ziel, "CCM_gerichtet.graphml"))

    print(f"CON : {Gc.number_of_nodes()} Knoten, {Gc.number_of_edges()} Kanten")
    print(f"CCM : {Gp.number_of_nodes()} Knoten, {Gp.number_of_edges()} gerichtete Kanten")
    print(f"-> {a.ziel}  (PNG, PDF und GraphML je Netz)")


if __name__ == "__main__":
    main()
