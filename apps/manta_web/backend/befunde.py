from __future__ import annotations

# Turns the results of a fixed plan into a short list of findings. Each finding is one statement
# with the exact values and names it rests on; the model may only write what a finding says, and
# the check holds every sentence against the findings it cites.

# A first place counts as clearly ahead when it has at least this many times the second place
# (QUIS, arXiv 2410.10270: outstanding value max1/max2 >= 1.4).
DEUTLICH_VORN = 1.4


class _Liste:
    def __init__(self):
        self.befunde: list[dict] = []

    def add(self, text: str, werte=(), namen=(), art: str = "befund") -> None:
        self.befunde.append({"id": f"F{len(self.befunde) + 1}", "art": art, "text": text,
                             "werte": [w for w in werte if isinstance(w, (int, float))],
                             "namen": [str(n) for n in namen if n]})

    def vorbehalt(self, text: str | None) -> None:
        if text:
            self.add(text, art="vorbehalt")


def _daten(ergebnisse: dict, tool: str) -> dict:
    r = ergebnisse.get(tool)
    return (r.get("data") or {}) if isinstance(r, dict) else {}


def _module(ergebnisse: dict) -> dict[int, str]:
    mods = _daten(ergebnisse, "dataset_summary").get("modules") or []
    return {m["louvain_label"]: m.get("display") or f"M{m['louvain_label']}"
            for m in mods if isinstance(m, dict) and m.get("louvain_label") is not None}


def _modul(mods: dict[int, str], label) -> str:
    return mods.get(label) or f"M{label}"


def _namen_modul(anzeige: str) -> list[str]:
    return [t.strip() for t in anzeige.split("·") if t.strip()]


def _anteil(teil, ganz) -> float | None:
    if not isinstance(teil, (int, float)) or not isinstance(ganz, (int, float)) or ganz <= 0:
        return None
    return teil / ganz


def _prozent(x: float) -> int:
    return round(x * 100)


def dataset_summary(ergebnisse: dict) -> list[dict]:
    d = _daten(ergebnisse, "dataset_summary")
    b = _Liste()
    if not d:
        return b.befunde
    zeit = (f"from {d['first_date']} to {d['last_date']}" if d.get("first_date")
            else "with a sampling order only, no calendar dates")
    b.add(f"The dataset has {d.get('n_samples')} samples, {zeit}.",
          [d.get("n_samples")], [d.get("first_date"), d.get("last_date")])
    an = _anteil(d.get("n_in_network"), d.get("n_asv"))
    if an is not None:
        b.add(f"{d['n_in_network']} of its {d['n_asv']} ASVs ({_prozent(an)} %) are in the network.",
              [d["n_in_network"], d["n_asv"], _prozent(an), an])
    b.add(f"The network splits into {d.get('n_clusters')} clusters, with {d.get('n_con_edges')} "
          f"co-occurrence (CON) links and {d.get('n_ccm_edges')} directed CCM links.",
          [d.get("n_clusters"), d.get("n_con_edges"), d.get("n_ccm_edges")])
    if d.get("marker") or d.get("region"):
        b.add(f"Marker: {d.get('marker') or 'not stated'}; region: {d.get('region') or 'not stated'}.",
              namen=[d.get("marker"), d.get("region")])
    b.vorbehalt(d.get("time_axis_note"))
    return b.befunde


def taxa_composition(ergebnisse: dict) -> list[dict]:
    d = _daten(ergebnisse, "taxa_composition")
    s = _daten(ergebnisse, "dataset_summary")
    b = _Liste()
    top = d.get("top") or []
    rang = d.get("rank") or "genus"
    if not top:
        b.add(f"No ASV in this dataset has a {rang} assigned.", namen=[rang])
        return b.befunde
    erst = top[0]
    b.add(f"The {rang} with the most ASVs is {erst['taxon']} ({erst['n_asv']} ASVs).",
          [erst["n_asv"]], [erst["taxon"], rang])
    if len(top) > 1:
        zweit = top[1]
        verh = erst["n_asv"] / zweit["n_asv"] if zweit["n_asv"] else None
        if verh is not None and verh >= DEUTLICH_VORN:
            b.add(f"{erst['taxon']} is clearly ahead: {erst['n_asv']} ASVs against "
                  f"{zweit['n_asv']} for {zweit['taxon']}, the next {rang}.",
                  [erst["n_asv"], zweit["n_asv"], round(verh, 1)], [erst["taxon"], zweit["taxon"]])
        else:
            folgende = top[1:3]
            b.add("It is followed closely by " + " and ".join(
                f"{t['taxon']} ({t['n_asv']} ASVs)" for t in folgende) + ".",
                [t["n_asv"] for t in folgende], [t["taxon"] for t in folgende])
    mit_reads = [t for t in top if isinstance(t.get("read_count_total"), (int, float))]
    if mit_reads:
        nach_reads = max(mit_reads, key=lambda t: t["read_count_total"])
        if nach_reads["taxon"] == erst["taxon"]:
            b.add(f"{erst['taxon']} also has the highest summed read count among these taxa.",
                  [erst["read_count_total"]], [erst["taxon"]])
        else:
            b.add(f"By summed read count, {nach_reads['taxon']} leads instead "
                  f"({nach_reads['read_count_total']} reads, {nach_reads['n_asv']} ASVs).",
                  [nach_reads["read_count_total"], nach_reads["n_asv"]], [nach_reads["taxon"]])
    else:
        b.vorbehalt(d.get("read_count_total_absent_reason"))
    gesamt, bestimmt = s.get("n_asv"), d.get("n_asv_considered")
    if isinstance(gesamt, int) and isinstance(bestimmt, int) and gesamt > bestimmt:
        ohne = gesamt - bestimmt
        b.add(f"{ohne} of the {gesamt} ASVs ({_prozent(ohne / gesamt)} %) have no {rang}; the "
              f"ranking covers only the {bestimmt} that do.",
              [ohne, gesamt, bestimmt, _prozent(ohne / gesamt), ohne / gesamt], [rang])
    if isinstance(d.get("n_distinct_taxa"), int):
        b.add(f"There are {d['n_distinct_taxa']} distinct {rang} names in total.",
              [d["n_distinct_taxa"]], [rang])
    b.vorbehalt(d.get("note"))
    return b.befunde


def find_asv(ergebnisse: dict) -> list[dict]:
    d = _daten(ergebnisse, "find_asv")
    b = _Liste()
    asvs = d.get("asvs") or []
    if not asvs:
        b.add("This dataset has no ASVs.")
        return b.befunde
    nach_reads = isinstance(asvs[0].get("read_count_total"), (int, float))
    mass = "read_count_total" if nach_reads else "n_samples_present"
    einheit = "reads summed over all samples" if nach_reads else "samples with a detection"

    def wer(a: dict) -> str:
        return f"{a['asv_id']} ({a.get('genus') or 'no genus'})"

    erst = asvs[0]
    modul = erst.get("cluster_name") or (f"M{erst['cluster']}" if erst.get("cluster") is not None
                                         else None)
    b.add(f"The largest ASV is {wer(erst)} with {erst[mass]} {einheit}"
          + (f", in cluster {modul}." if modul else ", outside the network."),
          [erst[mass], erst.get("cluster")],
          [erst["asv_id"], erst.get("genus"), *(_namen_modul(modul) if modul else [])])
    if len(asvs) > 1:
        folgende = asvs[1:3]
        b.add("Next come " + " and ".join(f"{wer(a)} with {a[mass]}" for a in folgende) + ".",
              [a[mass] for a in folgende],
              [x for a in folgende for x in (a["asv_id"], a.get("genus"))])
        verh = erst[mass] / asvs[1][mass] if asvs[1][mass] else None
        if verh is not None and verh >= DEUTLICH_VORN:
            b.add(f"The first is clearly ahead of the second ({round(verh, 1)} times as large).",
                  [round(verh, 1)])
    gattungen: dict[str, int] = {}
    for a in asvs:
        if a.get("genus"):
            gattungen[a["genus"]] = gattungen.get(a["genus"], 0) + 1
    if gattungen:
        g, n = max(gattungen.items(), key=lambda kv: (kv[1], kv[0]))
        if n >= 3:
            b.add(f"{n} of these {len(asvs)} largest ASVs belong to {g}.", [n, len(asvs)], [g])
    im_netz = sum(1 for a in asvs if a.get("cluster") is not None)
    b.add(f"{im_netz} of the {len(asvs)} largest ASVs are in the network.", [im_netz, len(asvs)])
    b.vorbehalt(f"Ranked by {d.get('ordered_by')}." if d.get("ordered_by") else None)
    return b.befunde


def cluster_bridges(ergebnisse: dict) -> list[dict]:
    d = _daten(ergebnisse, "cluster_bridges")
    s = _daten(ergebnisse, "dataset_summary")
    mods = _module(ergebnisse)
    b = _Liste()
    n_br, n_con = d.get("n_bridges_total"), s.get("n_con_edges")
    if not isinstance(n_br, int):
        return b.befunde
    if n_br == 0:
        b.add("No co-occurrence link runs between two different clusters: the clusters are "
              "not linked to each other at all.", [0])
    else:
        an = _anteil(n_br, n_con)
        if an is not None:
            b.add(f"{n_br} of the {n_con} co-occurrence links ({_prozent(an)} %) run between "
                  f"different clusters; the rest stay within a cluster.",
                  [n_br, n_con, _prozent(an), an])
        else:
            b.add(f"{n_br} co-occurrence links run between different clusters.", [n_br])
        paare = d.get("by_cluster_pair") or []
        if paare:
            p = paare[0]
            a, c = _modul(mods, p["cluster_a"]), _modul(mods, p["cluster_b"])
            b.add(f"The strongest connection is between {a} and {c} ({p['n_edges']} links).",
                  [p["n_edges"], p["cluster_a"], p["cluster_b"]],
                  [*_namen_modul(a), *_namen_modul(c)])
            je: dict[int, int] = {}
            for q in paare:
                for k in (q["cluster_a"], q["cluster_b"]):
                    je[k] = je.get(k, 0) + q["n_edges"]
            hub, n = max(je.items(), key=lambda kv: (kv[1], -kv[0]))
            if n_br and n / n_br >= 0.5 and len(je) > 2:
                h = _modul(mods, hub)
                b.add(f"{h} takes part in {n} of the {n_br} links between clusters, so it acts "
                      f"as the main bridge.", [n, n_br, hub], _namen_modul(h))
    b.vorbehalt("A co-occurrence link is a correlation of the time series, not an observed "
                "interaction.")
    b.vorbehalt(d.get("cluster_caveat"))
    return b.befunde


def cluster_network(ergebnisse: dict) -> list[dict]:
    d = _daten(ergebnisse, "cluster_network")
    mods = _module(ergebnisse)
    b = _Liste()
    kanten = d.get("edges") or []
    zwischen = [k for k in kanten if k["from_cluster"] != k["to_cluster"]]
    if not zwischen:
        b.add("No directed CCM link runs from one cluster to another.", [0])
    else:
        b.add(f"Directed CCM links connect {len(zwischen)} ordered pairs of different clusters.",
              [len(zwischen)])
        k = max(zwischen, key=lambda e: (e["n_edges"], e["mean_nmi"] or 0))
        a, c = _modul(mods, k["from_cluster"]), _modul(mods, k["to_cluster"])
        nmi = f", mean NMI {round(k['mean_nmi'], 2)}" if k["mean_nmi"] is not None else ""
        b.add(f"Most links run from {a} to {c} ({k['n_edges']} links{nmi}).",
              [k["n_edges"], k["mean_nmi"], k["from_cluster"], k["to_cluster"],
               round(k["mean_nmi"], 2) if k["mean_nmi"] is not None else None],
              [*_namen_modul(a), *_namen_modul(c)])
        mit_nmi = [e for e in zwischen if e["mean_nmi"] is not None]
        st = max(mit_nmi, key=lambda e: (e["mean_nmi"], e["n_edges"])) if mit_nmi else k
        if st is not k:
            a, c = _modul(mods, st["from_cluster"]), _modul(mods, st["to_cluster"])
            b.add(f"The highest mean predictive skill is from {a} to {c} (mean NMI "
                  f"{round(st['mean_nmi'], 2)} over {st['n_edges']} links).",
                  [round(st["mean_nmi"], 2), st["mean_nmi"], st["n_edges"], st["from_cluster"],
                   st["to_cluster"]], [*_namen_modul(a), *_namen_modul(c)])
    innen = sum(k["n_edges"] for k in kanten if k["from_cluster"] == k["to_cluster"])
    if innen:
        b.add(f"{innen} CCM links stay within one cluster.", [innen])
    for v in d.get("caveats") or []:
        b.vorbehalt(v)
    return b.befunde


ERZEUGER = {"dataset_summary": dataset_summary, "taxa_composition": taxa_composition,
            "find_asv": find_asv, "cluster_bridges": cluster_bridges,
            "cluster_network": cluster_network}


def erzeuge(art: str, ergebnisse: dict) -> list[dict]:
    return ERZEUGER[art](ergebnisse)
