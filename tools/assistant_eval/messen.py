#!/usr/bin/env python3
"""Runs the fixed question catalog (fragen.json) against a running MANTA and scores the answers.

The expected values come from the dataset itself: before asking, the script runs the tools
directly (POST /api/agent/tools/<name>) and fills the catalog's facts from their results. So the
catalog works on any dataset, and a score compares models or code changes on the same data.

    python3 tools/assistant_eval/messen.py --dataset example_12 --model qwen2.5:7b
    python3 tools/assistant_eval/messen.py --compare a.json b.json

Standard library only. Every question is one new conversation and lands in your transcripts.
"""
from __future__ import annotations

import argparse
import getpass
import http.cookiejar
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HIER = Path(__file__).resolve().parent


class Api:
    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(self, method: str, path: str, body: dict | None = None, timeout: float = 600) -> dict:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"Content-Type": "application/json"})
        try:
            with self.opener.open(req, timeout=timeout) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            text = e.read().decode(errors="replace")[:300]
            raise RuntimeError(f"{method} {path}: HTTP {e.code} {text}") from None

    def tool(self, name: str, **args) -> dict:
        r = self.call("POST", f"/agent/tools/{name}", {"arguments": args})
        if r.get("error"):
            raise RuntimeError(f"tool {name}: {r['error']}")
        return (r.get("result") or {}).get("data") or {}


# The values the answers are checked against, from the tools' own results.
def wahrheit(api: Api, ds: str) -> dict:
    s = api.tool("dataset_summary", dataset_id=ds)
    w = {k: s.get(k) for k in ("n_samples", "n_asv", "n_in_network", "n_clusters",
                               "n_con_edges", "n_ccm_edges", "first_date", "last_date")}
    for rang in ("genus", "family", "class"):
        top = api.tool("taxa_composition", dataset_id=ds, rank=rang, limit=3).get("top") or []
        if top:
            w[f"top_{rang}"], w[f"top_{rang}_n"] = top[0]["taxon"], top[0]["n_asv"]
    asvs = api.tool("find_asv", dataset_id=ds, limit=2).get("asvs") or []
    if asvs:
        w["top_asv"], w["top_asv_genus"], w["top_asv_cluster"] = (
            asvs[0]["asv_id"], asvs[0].get("genus"), asvs[0].get("cluster"))
    if len(asvs) > 1:
        w["second_asv"] = asvs[1]["asv_id"]
    if w.get("top_asv"):
        nb = api.tool("neighbors", dataset_id=ds, asv_id=w["top_asv"])
        w["top_asv_n_neighbors"] = nb.get("n_neighbors_total")
    w["n_bridges"] = api.tool("cluster_bridges", dataset_id=ds, edge="con").get("n_bridges_total")
    w["n_ccm_pairs"] = api.tool("cluster_network", dataset_id=ds).get("n_cluster_pairs")
    groessen = {m["louvain_label"]: api.tool("cluster_detail", dataset_id=ds,
                                             cluster=m["louvain_label"]).get("n_members") or 0
                for m in s.get("modules") or []}
    if groessen:
        w["big_cluster"] = max(groessen, key=lambda k: (groessen[k], -k))
        w["big_cluster_n"] = groessen[w["big_cluster"]]
    env = api.tool("environment", dataset_id=ds).get("variables") or []
    namen = [v.get("label") or v.get("key") for v in env]
    w["n_env_vars"], w["env_vars"] = len(namen), ", ".join(str(n) for n in namen)
    return w


_ZAHL = re.compile(r"(?<![\w.])-?\d+(?:[.,]\d+)?")


def _zahlen(text: str) -> list[float]:
    ohne_tausender = re.sub(r"(?<=\d)[,' ](?=\d{3}\b)", "", text)
    return [float(z.replace(",", ".")) for z in _ZAHL.findall(ohne_tausender)]


def enthalten(wert, antwort: str) -> bool:
    if wert is None or wert == "":
        return False
    if isinstance(wert, bool) or not isinstance(wert, (int, float)):
        return re.search(r"(?<!\w)" + re.escape(str(wert)) + r"(?!\w)", antwort, re.I) is not None
    return any(abs(z - wert) <= max(0.005 * abs(wert), 1e-9) for z in _zahlen(antwort))


def bewerte(frage: dict, r: dict, w: dict) -> dict:
    antwort = r.get("answer") or ""
    tools = [e.get("tool") for e in r.get("evidence") or []]
    fehler = [e.get("error") for e in r.get("evidence") or [] if e.get("error")]
    teile: dict[str, float] = {}
    if frage.get("kind"):
        teile["kind"] = float(r.get("question_kind") == frage["kind"])
    if frage.get("tools"):
        teile["tool"] = float(any(t in tools for t in frage["tools"]) and not fehler)
    fakten = {f: w.get(f) for f in frage.get("facts") or []}
    gefunden = {f: enthalten(v, antwort) for f, v in fakten.items()}
    if fakten:
        teile["facts"] = sum(gefunden.values()) / len(fakten)
    if frage.get("group") == "trap":
        aus_frage = set(_zahlen(frage.get("_text", "")))
        teile["no_invented"] = float(not r.get("ungrounded")
                                     and not set(_zahlen(antwort)) - aus_frage)
    else:
        teile["grounded"] = float(not r.get("ungrounded") and r.get("check") not in ("failed",)
                                  and not r.get("truncated"))
    if r.get("check") in ("cited", "listed"):
        # 'listed': the model's text failed the check twice, so the bare findings were shown.
        teile["written"] = float(r["check"] == "cited")
    return {"parts": teile, "score": sum(teile.values()) / len(teile) if teile else 0.0,
            "facts_found": gefunden, "tools_run": tools, "tool_errors": fehler}


def _fuellen(text: str, w: dict) -> str:
    return re.sub(r"\{(\w+)\}", lambda m: str(w.get(m.group(1), "?")), text)


def laufen(a) -> None:
    api = Api(a.url)
    nutzer = a.user or input("MANTA user: ")
    passwort = os.environ.get("MANTA_PASSWORD") or getpass.getpass(f"Password for {nutzer}: ")
    api.call("POST", "/auth/login", {"username": nutzer, "password": passwort})
    katalog = json.loads((HIER / "fragen.json").read_text(encoding="utf-8"))["questions"]
    if a.only:
        katalog = [f for f in katalog if f["id"] in a.only.split(",") or f["group"] in a.only.split(",")]
    saetze = {t["name"]: t.get("question") for t in api.call("GET", "/agent/tools")["tools"]}
    w = wahrheit(api, a.dataset)
    print("expected values:", json.dumps(w, ensure_ascii=False))

    ergebnisse = []
    for i, f in enumerate(katalog, 1):
        frage = _fuellen(f.get("question") or saetze.get(f.get("question_kind")) or "", w)
        body = {"question": frage, "dataset_id": a.dataset, "model": a.model,
                "question_kind": f.get("question_kind")}
        if f.get("context") == "asv":
            body["asv_id"] = w.get("top_asv")
        if f.get("context") == "cluster":
            body["cluster"] = w.get("big_cluster")
        t0 = time.time()
        try:
            r = api.call("POST", "/agent/ask", body)
        except RuntimeError as e:
            r = {"answer": "", "error": str(e)}
        sek = round(time.time() - t0, 1)
        b = bewerte({**f, "_text": frage}, r, w) if not r.get("error") else {"parts": {}, "score": 0.0}
        ergebnisse.append({"id": f["id"], "group": f["group"], "question": frage,
                           "expected": _fuellen(f["answer"], w), "answer": r.get("answer"),
                           "error": r.get("error"), "question_kind": r.get("question_kind"),
                           "check": r.get("check"), "ungrounded": r.get("ungrounded"),
                           "steps": r.get("steps"), "seconds": sek, **b})
        print(f"[{i:2}/{len(katalog)}] {f['id']:<18} {b['score']:.2f}  {sek:6.1f}s  "
              + " ".join(f"{k}={v:.2f}" for k, v in b["parts"].items()) + (f"  {r['error']}" if r.get("error") else ""))

    lauf = {"model": a.model, "dataset": a.dataset, "url": a.url,
            "at": time.strftime("%Y-%m-%d %H:%M:%S"), "expected_values": w,
            "summary": zusammenfassen(ergebnisse), "results": ergebnisse}
    ziel = Path(a.out or f"messung_{a.model.replace(':', '_').replace('/', '_')}_"
                         f"{time.strftime('%Y%m%d_%H%M')}.json")
    ziel.write_text(json.dumps(lauf, ensure_ascii=False, indent=1), encoding="utf-8")
    drucken(lauf)
    print(f"\nsaved: {ziel}")


def zusammenfassen(ergebnisse: list[dict]) -> dict:
    def mittel(xs):
        return round(sum(xs) / len(xs), 3) if xs else None
    out = {"all": {"score": mittel([e["score"] for e in ergebnisse]), "n": len(ergebnisse),
                   "seconds": mittel([e["seconds"] for e in ergebnisse])}}
    for g in dict.fromkeys(e["group"] for e in ergebnisse):
        es = [e for e in ergebnisse if e["group"] == g]
        out[g] = {"score": mittel([e["score"] for e in es]), "n": len(es),
                  "seconds": mittel([e["seconds"] for e in es])}
    for teil in ("kind", "tool", "facts", "grounded", "written", "no_invented"):
        xs = [e["parts"][teil] for e in ergebnisse if teil in e.get("parts", {})]
        if xs:
            out["all"][teil] = mittel(xs)
    return out


def drucken(lauf: dict) -> None:
    print(f"\n{lauf['model']} on {lauf['dataset']}")
    for g, s in lauf["summary"].items():
        extra = " ".join(f"{k}={v}" for k, v in s.items() if k not in ("score", "n", "seconds"))
        print(f"  {g:<10} score {s['score']}  ({s['n']} questions, {s['seconds']} s each)  {extra}")


def vergleichen(alt_pfad: str, neu_pfad: str) -> None:
    alt, neu = (json.loads(Path(p).read_text(encoding="utf-8")) for p in (alt_pfad, neu_pfad))
    print(f"A = {alt['model']} ({alt['at']})   B = {neu['model']} ({neu['at']})")
    for g in neu["summary"]:
        a, b = (alt["summary"].get(g) or {}).get("score"), neu["summary"][g]["score"]
        print(f"  {g:<10} A {a}  B {b}")
    a_je = {e["id"]: e for e in alt["results"]}
    for e in neu["results"]:
        vorher = a_je.get(e["id"])
        if vorher and abs(vorher["score"] - e["score"]) >= 0.01:
            print(f"  {e['id']:<18} {vorher['score']:.2f} -> {e['score']:.2f}")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--url", default="http://127.0.0.1:8080/api", help="MANTA API (default: %(default)s)")
    p.add_argument("--user", help="MANTA account; the password is asked for, or taken from MANTA_PASSWORD")
    p.add_argument("--dataset", help="dataset id")
    p.add_argument("--model", help="model name as installed in Ollama, e.g. qwen2.5:7b")
    p.add_argument("--only", help="comma-separated question ids or groups (planned, suggested, free, trap)")
    p.add_argument("--out", help="result file (default: messung_<model>_<time>.json)")
    p.add_argument("--compare", nargs=2, metavar=("A.json", "B.json"), help="compare two saved runs")
    a = p.parse_args()
    if a.compare:
        vergleichen(*a.compare)
    elif not (a.dataset and a.model):
        p.error("--dataset and --model are needed (or --compare)")
    else:
        laufen(a)


if __name__ == "__main__":
    sys.exit(main())
