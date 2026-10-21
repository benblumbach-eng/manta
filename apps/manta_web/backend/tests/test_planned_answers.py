from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

HIER = Path(__file__).resolve().parent
sys.path[:0] = [str(HIER.parent), str(HIER.parents[2] / "manta_mcp")]

import agent  # noqa: E402
import befunde  # noqa: E402
import grounding  # noqa: E402

DS = "teststation"

SUMMARY = {"data": {"dataset_id": DS, "n_samples": 96, "first_date": "2016-08-01",
                    "last_date": "2020-07-15", "n_asv": 220, "n_in_network": 36,
                    "n_clusters": 4, "n_con_edges": 120, "n_ccm_edges": 25, "marker": "18S",
                    "region": "Fram Strait",
                    "modules": [{"louvain_label": 0, "display": "M0"},
                                {"louvain_label": 1, "display": "M1 · Spring"},
                                {"louvain_label": 2, "display": "M2"},
                                {"louvain_label": 3, "display": "M3"}]},
           "provenance": {"tool": "dataset_summary", "cypher": [], "n_results": 1}}
TAXA = {"data": {"rank": "genus", "network_only": False, "n_distinct_taxa": 31,
                 "n_asv_considered": 180,
                 "top": [{"taxon": "Gyrodinium", "n_asv": 12, "read_count_total": 90000},
                         {"taxon": "Phaeocystis", "n_asv": 6, "read_count_total": 120000},
                         {"taxon": "Micromonas", "n_asv": 5, "read_count_total": 4000}],
                 "note": "'read_count_total' is a ranking aid, NOT a percentage."},
        "provenance": {"tool": "taxa_composition", "cypher": [], "n_results": 3}}
BRIDGES = {"data": {"edge": "con", "n_bridges_total": 30,
                    "by_cluster_pair": [{"cluster_a": 1, "cluster_b": 2, "n_edges": 14},
                                        {"cluster_a": 1, "cluster_b": 3, "n_edges": 9},
                                        {"cluster_a": 0, "cluster_b": 2, "n_edges": 7}],
                    "cluster_caveat": "Clusters are ONE partition."},
           "provenance": {"tool": "cluster_bridges", "cypher": [], "n_results": 3}}
ASVS = {"data": {"asvs": [
    {"asv_id": "euk_asv_001", "genus": "Gyrodinium", "cluster": 1, "cluster_name": "M1 · Spring",
     "read_count_total": 50000, "n_samples_present": 80},
    {"asv_id": "euk_asv_002", "genus": "Phaeocystis", "cluster": None, "cluster_name": "",
     "read_count_total": 20000, "n_samples_present": 60}],
    "n_returned": 2, "n_matching_total": 220, "ordered_by": "read_count_total: summed reads"},
    "provenance": {"tool": "find_asv", "cypher": [], "n_results": 2}}

RESULTS = {"dataset_summary": SUMMARY, "taxa_composition": TAXA, "cluster_bridges": BRIDGES,
           "find_asv": ASVS, "list_datasets": {"data": []},
           "dataset_capabilities": {"data": None}}


@pytest.fixture
def calls(monkeypatch):
    seen: list[tuple[str, dict]] = []

    def call(name, args=None):
        seen.append((name, dict(args or {})))
        return RESULTS.get(name, {"data": {"ok": True}, "provenance": {"tool": name}})

    monkeypatch.setattr(agent.registry, "call", call)
    monkeypatch.setattr(grounding, "mode", lambda: "mark")
    return seen


def model_says(monkeypatch, *replies, size="7.6B"):
    sent: list[dict] = []
    queue = list(replies)

    def chat(messages, tools=None, timeout=180.0, model=None, provider=None, fmt=None,
             temperature=None):
        sent.append({"messages": messages, "tools": tools, "fmt": fmt,
                     "temperature": temperature})
        r = queue.pop(0)
        return {"message": r if isinstance(r, dict) else {"content": r}}

    monkeypatch.setattr(agent, "_chat", chat)
    monkeypatch.setattr(agent, "list_models", lambda: [
        {"name": "m", "parameter_size": size, "supports_tools": True}])
    return sent


def test_suggested_question_runs_the_fixed_plan(calls, monkeypatch):
    sent = model_says(monkeypatch, "Gyrodinium is the genus with the most ASVs here (12 ASVs) [F1].")
    out = agent.run("Which taxa dominate this dataset?", DS, model="m",
                    question_kind="taxa_composition")
    assert [n for n, _ in calls] == ["taxa_composition", "dataset_summary"]
    assert calls[0][1] == {"dataset_id": DS, "rank": "genus", "limit": 15}
    assert out["check"] == "cited" and out["question_kind"] == "taxa_composition"
    assert out["answer"].startswith("Gyrodinium")
    assert sent[0]["tools"] is None, "the model writing the answer sees no tools"
    assert "F1" in sent[0]["messages"][1]["content"]


def test_typed_question_is_sorted_by_a_forced_form(calls, monkeypatch):
    sent = model_says(monkeypatch, json.dumps({"frage_art": "cluster_bridges", "rang": "none"}),
                      "The clusters are linked by 30 of the 120 co-occurrence links [F1].")
    out = agent.run("how much do the modules hang together?", DS, model="m")
    assert sent[0]["fmt"]["properties"]["frage_art"]["enum"][0] == "dataset_summary"
    assert sent[0]["temperature"] == 0.0
    assert [n for n, _ in calls] == ["cluster_bridges", "dataset_summary"]
    assert out["check"] == "cited"


def test_invented_numbers_get_one_retry_then_the_findings_list(calls, monkeypatch):
    model_says(monkeypatch, "Gyrodinium makes up 36 % of the dataset [F1].",
               "Prochlorococcus dominates [F1].")
    out = agent.run("Which taxa dominate this dataset?", DS, model="m")
    assert out["corrected"] is True and out["check"] == "listed"
    assert "36" not in out["answer"] and "Prochlorococcus" not in out["answer"]
    assert out["answer"].startswith("- The genus with the most ASVs is Gyrodinium")


def test_tool_call_written_as_text_is_still_executed(calls, monkeypatch):
    text_call = ('Here is a sample command:\n```json\n{"name": "find_asv", "arguments": '
                 '{"dataset_id": "teststation", "limit": 10}}\n```')
    model_says(monkeypatch, json.dumps({"frage_art": "andere", "rang": "none"}), text_call,
               "The largest ASV is euk_asv_001.")
    out = agent.run("show me something about the biggest sequences please", DS, model="m")
    assert ("find_asv", {"dataset_id": DS, "limit": 10}) in calls
    assert out["evidence"][0]["tool"] == "find_asv"
    assert out["answer"] == "The largest ASV is euk_asv_001."


def test_small_model_does_not_guess_outside_the_plans(calls, monkeypatch):
    model_says(monkeypatch, json.dumps({"frage_art": "andere", "rang": "none"}), size="1.5B")
    out = agent.run("what eats Gyrodinium?", DS, model="m")
    assert out["check"] == "none" and out["evidence"] == []
    assert "Which taxa dominate this dataset?" in out["answer"]


def test_other_suggested_questions_call_their_tool_first(calls, monkeypatch):
    model_says(monkeypatch, "It peaks in May.")
    out = agent.run("When is this ASV present, and does it come back every year?", DS,
                    model="m", asv_id="euk_asv_001", question_kind="asv_seasonality")
    assert ("asv_seasonality", {"dataset_id": DS, "asv_id": "euk_asv_001"}) in calls
    assert out["evidence"][0]["tool"] == "asv_seasonality"


def test_findings_for_the_dominant_taxa():
    fs = befunde.taxa_composition({"taxa_composition": TAXA, "dataset_summary": SUMMARY})
    texte = [f["text"] for f in fs]
    assert texte[0] == "The genus with the most ASVs is Gyrodinium (12 ASVs)."
    assert texte[1].startswith("Gyrodinium is clearly ahead: 12 ASVs against 6")
    assert texte[2].startswith("By summed read count, Phaeocystis leads instead")
    assert texte[3].startswith("40 of the 220 ASVs (18 %) have no genus")
    assert fs[-1]["art"] == "vorbehalt"


def test_findings_for_links_between_clusters():
    fs = befunde.cluster_bridges({"cluster_bridges": BRIDGES, "dataset_summary": SUMMARY})
    texte = [f["text"] for f in fs]
    assert texte[0].startswith("30 of the 120 co-occurrence links (25 %)")
    assert texte[1] == "The strongest connection is between M1 · Spring and M2 (14 links)."
    assert texte[2].startswith("M1 · Spring takes part in 23 of the 30 links")


def test_cited_check_rejects_numbers_and_names_from_elsewhere():
    fs = befunde.taxa_composition({"taxa_composition": TAXA, "dataset_summary": SUMMARY})
    assert grounding.check_cited("Gyrodinium has the most ASVs (12) [F1].", fs) == []
    probleme = grounding.check_cited(
        "Gyrodinium has 36 ASVs [F1]. Prochlorococcus follows [F2]. Nothing cited here.", fs)
    assert probleme == ["36 is not in F1", "Prochlorococcus is not in F2",
                        'no finding cited: "Nothing cited here."']
    # 220 is a real value, but of F4, not of the finding the sentence cites
    assert grounding.check_cited("Gyrodinium has 220 ASVs [F1].", fs) == ["220 is not in F1"]
