#!/usr/bin/env python3
"""Runs the fixed question catalog (fragen.json) against a running MANTA and scores the answers.

The expected values come from the dataset itself: before asking, the script runs the tools
directly (POST /api/agent/tools/<name>) and fills the catalog's facts from their results. So the
catalog works on any dataset, and a score compares models or code changes on the same data.

Each answer is also graded by a larger judge model (--judge) against the expected answer and the tool
results the assistant had, and every missed value is traced: did the tools deliver it
(model_missed) or not (tool_missing)?

    python3 tools/assistant_eval/messen.py --dataset example_12 --model qwen3:8b
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
    w["n_ccm_pairs"] = sum(1 for e in api.tool("cluster_network", dataset_id=ds).get("edges") or []
                           if e.get("from_cluster") != e.get("to_cluster"))
    groessen = {m["louvain_label"]: api.tool("cluster_detail", dataset_id=ds,
                                             cluster=m["louvain_label"]).get("n_members") or 0
                for m in s.get("modules") or []}
    if groessen:
        w["big_cluster"] = max(groessen, key=lambda k: (groessen[k], -k))
        w["big_cluster_n"] = groessen[w["big_cluster"]]
    env = api.tool("environment", dataset_id=ds).get("variables") or []
    namen = [v.get("label") or v.get("key") for v in env]
    w["n_env_vars"], w["env_vars"] = len(namen), ", ".join(str(n) for n in namen)
    if namen:
        w["env_var1"] = namen[0]
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
    if wert == 0 and re.search(r"\b(no|none|kein\w*)\b", antwort, re.I):
        return True
    return any(abs(z - wert) <= max(0.005 * abs(wert), 1e-9) for z in _zahlen(antwort))


# What the assistant had in front of it: the tool results it was given (or, on a fixed plan, the
# findings made from them), read back from the stored turn.
def belege(api: Api, r: dict) -> str:
    if not r.get("turn_id"):
        return ""
    try:
        zug = api.call("GET", f"/agent/turns/{r['turn_id']}")
    except RuntimeError:
        return ""
    teile = []
    for e in (zug.get("record") or {}).get("events") or []:
        if e.get("kind") == "tool":
            teile.append(e.get("model_saw") or json.dumps(e.get("output"), ensure_ascii=False,
                                                          default=str))
        elif e.get("kind") == "findings":
            teile.append(json.dumps(e.get("findings"), ensure_ascii=False, default=str))
    return "\n".join(teile)


def pruefungen(api: Api, r: dict) -> list[dict]:
    """The check rounds that did not pass: the model's draft and what the check objected to."""
    if not r.get("turn_id"):
        return []
    try:
        zug = api.call("GET", f"/agent/turns/{r['turn_id']}")
    except RuntimeError:
        return []
    return [{"action": e.get("action"), "problems": e.get("numbers"), "draft": e.get("draft")}
            for e in (zug.get("record") or {}).get("events") or []
            if e.get("kind") == "grounding" and e.get("draft")]


URTEIL = {"type": "object", "required": ["correct", "complete", "tools_enough", "missing"],
          "properties": {"correct": {"type": "integer", "minimum": 1, "maximum": 5},
                         "complete": {"type": "integer", "minimum": 1, "maximum": 5},
                         "tools_enough": {"type": "boolean"},
                         "missing": {"type": "string"}}}

RICHTER = (
    "You grade one answer of a data assistant for a marine amplicon dataset. You get the "
    "question, the expected answer, the tool results the assistant had, and its answer.\n"
    "correct (1-5): 5 = every statement agrees with the tool results and the expected answer; "
    "1 = wrong or invented. Saying plainly that the data do not hold something is correct when "
    "they do not.\n"
    "complete (1-5): 5 = it answers the whole question; 1 = it does not answer it.\n"
    "tools_enough: true if the tool results hold what a full answer needs.\n"
    "missing: if tools_enough is false, in a few words what a tool would have to deliver; "
    "else an empty string.\nReply with JSON only.")


def urteilen(ollama: str, modell: str, frage: str, erwartet: str, antwort: str,
             gesehen: str) -> dict:
    inhalt = (f"Question: {frage}\n\nExpected answer: {erwartet}\n\nTool results the "
              f"assistant had:\n{gesehen[:8000] or '(none)'}\n\nAssistant's answer:\n{antwort}")
    body = {"model": modell, "stream": False, "format": URTEIL, "options": {"temperature": 0},
            "messages": [{"role": "system", "content": RICHTER},
                         {"role": "user", "content": inhalt}]}
    req = urllib.request.Request(ollama.rstrip("/") + "/api/chat", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
            return json.loads(json.loads(r.read())["message"]["content"])
    except urllib.error.HTTPError as e:
        return {"error": f"judge failed: HTTP {e.code} {e.read().decode(errors='replace')[:200]}"}
    except (OSError, ValueError, KeyError) as e:
        return {"error": f"judge failed: {e}"}


def bewerte(frage: dict, r: dict, w: dict, gesehen: str = "", urteil: dict | None = None) -> dict:
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
    geliefert = {f: enthalten(v, gesehen) for f, v in fakten.items()}
    if fakten:
        teile["facts"] = sum(gefunden.values()) / len(fakten)
    # Where a missing value got lost: the tools never delivered it, or the model left it out.
    if not fakten:
        befund = None
    elif all(gefunden.values()):
        befund = "answered"
    elif all(geliefert[f] for f, ok in gefunden.items() if not ok):
        befund = "model_missed"
    else:
        befund = "tool_missing"
    if urteil and "correct" in urteil:
        teile["quality"] = ((urteil["correct"] - 1) / 4 + (urteil["complete"] - 1) / 4) / 2
    if frage.get("group") == "trap":
        # A number the question itself names (a year, say) is not invented when repeated.
        aus_frage = set(_zahlen(frage.get("_text", "")))
        teile["no_invented"] = float(not [u for u in r.get("ungrounded") or []
                                          if set(_zahlen(u)) - aus_frage])
    else:
        teile["grounded"] = float(not r.get("ungrounded") and r.get("check") not in ("failed",)
                                  and not r.get("truncated"))
    if r.get("check") in ("cited", "listed"):
        # 'listed': the model's text failed the check twice, so the bare findings were shown.
        teile["written"] = float(r["check"] == "cited")
    return {"parts": teile, "score": sum(teile.values()) / len(teile) if teile else 0.0,
            "facts_found": gefunden, "facts_in_tools": geliefert, "diagnosis": befund,
            "judge": urteil, "tools_run": tools, "tool_errors": fehler}


def _fuellen(text: str, w: dict) -> str:
    return re.sub(r"\{(\w+)\}", lambda m: str(w.get(m.group(1), "?")), text)


def laufen(a) -> None:
    api = Api(a.url)
    nutzer = a.user or input("MANTA user: ")
    passwort = os.environ.get("MANTA_PASSWORD") or getpass.getpass(f"Password for {nutzer}: ")
    api.call("POST", "/auth/login", {"username": nutzer, "password": passwort})
    if a.judge != "none":
        try:
            with urllib.request.urlopen(a.ollama.rstrip("/") + "/api/tags", timeout=10) as r:
                da = [m["name"] for m in json.loads(r.read()).get("models", [])]
        except OSError as e:
            sys.exit(f"The judge's Ollama is not reachable at {a.ollama} ({e}). "
                     f"Pass --ollama, or --judge none.")
        if a.judge not in da:
            sys.exit(f"Judge model {a.judge!r} is not in the Ollama at {a.ollama} "
                     f"(it has: {', '.join(da) or 'none'}).")
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
        erwartet = _fuellen(f["answer"], w)
        if r.get("error"):
            b = {"parts": {}, "score": 0.0}
        else:
            gesehen = belege(api, r)
            urteil = (urteilen(a.ollama, a.judge, frage, erwartet, r.get("answer") or "", gesehen)
                      if a.judge != "none" else None)
            b = bewerte({**f, "_text": frage}, r, w, gesehen, urteil)
        ergebnisse.append({"id": f["id"], "group": f["group"], "question": frage,
                           "expected": erwartet, "answer": r.get("answer"),
                           "error": r.get("error"), "question_kind": r.get("question_kind"),
                           "check": r.get("check"), "ungrounded": r.get("ungrounded"),
                           "steps": r.get("steps"), "seconds": sek,
                           "check_rounds": [] if r.get("error") else pruefungen(api, r), **b})
        print(f"[{i:2}/{len(katalog)}] {f['id']:<18} {b['score']:.2f}  {sek:6.1f}s  "
              + " ".join(f"{k}={v:.2f}" for k, v in b["parts"].items()) + (f"  {r['error']}" if r.get("error") else ""))

    lauf = {"model": a.model, "judge": a.judge, "dataset": a.dataset, "url": a.url,
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
    for teil in ("kind", "tool", "facts", "grounded", "written", "no_invented", "quality"):
        xs = [e["parts"][teil] for e in ergebnisse if teil in e.get("parts", {})]
        if xs:
            out["all"][teil] = mittel(xs)
    diagnosen = [e.get("diagnosis") for e in ergebnisse if e.get("diagnosis")]
    if diagnosen:
        out["all"]["diagnosis"] = {d: diagnosen.count(d) for d in dict.fromkeys(diagnosen)}
    urteile = [e["judge"] for e in ergebnisse if (e.get("judge") or {}).get("correct")]
    if urteile:
        out["all"]["tools_enough"] = mittel([float(u["tools_enough"]) for u in urteile])
    return out


def drucken(lauf: dict) -> None:
    print(f"\n{lauf['model']} on {lauf['dataset']}")
    for g, s in lauf["summary"].items():
        extra = " ".join(f"{k}={v}" for k, v in s.items() if k not in ("score", "n", "seconds"))
        print(f"  {g:<10} score {s['score']}  ({s['n']} questions, {s['seconds']} s each)  {extra}")
    luecken = [(e["id"], e["judge"]["missing"]) for e in lauf["results"]
               if (e.get("judge") or {}).get("tools_enough") is False and e["judge"].get("missing")]
    if luecken:
        print("\n  what the tools did not deliver (judge):")
        for i, m in luecken:
            print(f"    {i:<18} {m}")


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
    p.add_argument("--model", help="model name as installed in Ollama, e.g. qwen3:8b")
    p.add_argument("--judge", default="qwen3.6:35b",
                   help="Ollama model that grades each answer for quality (default: %(default)s; "
                        "'none' to skip)")
    p.add_argument("--ollama", default="http://127.0.0.1:11434",
                   help="Ollama for the judge (default: %(default)s)")
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
