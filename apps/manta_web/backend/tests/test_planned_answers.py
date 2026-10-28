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


def test_suggested_question_is_answered_from_its_own_tool_only(calls, monkeypatch):
    sent = model_says(monkeypatch, "It is made up mostly of Gyrodinium.")
    agent.run("What does this module consist of, and who dominates it?", DS, model="m",
              cluster=1, question_kind="cluster_detail")
    assert calls[-1] == ("cluster_detail", {"dataset_id": DS, "cluster": 1})
    assert len(sent) == 1 and sent[0]["tools"] is None


def test_suggestion_from_a_view_calls_its_tool_with_the_given_arguments(calls, monkeypatch):
    model_says(monkeypatch, "The link is kept in one direction.")
    out = agent.run("How strong is the link between euk_asv_001 and euk_asv_002?", DS,
                    model="m", question_kind="edge",
                    question_args={"source": "euk_asv_001", "target": "euk_asv_002",
                                   "dataset_id": "other", "limit": 3})
    assert ("edge", {"dataset_id": DS, "source": "euk_asv_001",
                     "target": "euk_asv_002"}) in calls
    assert out["evidence"][0]["tool"] == "edge"


def test_suggestion_for_a_rank_runs_the_fixed_plan_with_that_rank(calls, monkeypatch):
    model_says(monkeypatch, "Gyrodinium is the genus with the most ASVs here (12 ASVs) [F1].")
    agent.run("Which species dominate this dataset?", DS, model="m",
              question_kind="taxa_composition", question_args={"rank": "species"})
    assert calls[0][1] == {"dataset_id": DS, "rank": "species", "limit": 15}


def test_question_about_one_asv_skips_the_plans(calls, monkeypatch):
    sent = model_says(monkeypatch, {"content": "", "tool_calls": [
        {"function": {"name": "asv_detail", "arguments": {"asv_id": "euk_asv_001"}}}]},
        "euk_asv_001 is a Gyrodinium.")
    out = agent.run("Is euk_asv_001 rising or falling over time?", DS, model="m")
    assert sent[0]["fmt"] is None, "no sorting form: it can only be 'andere'"
    assert out["question_kind"] == "andere"
    assert calls[-1] == ("asv_detail", {"asv_id": "euk_asv_001", "dataset_id": DS})


def test_rank_named_in_the_question_wins(calls, monkeypatch):
    model_says(monkeypatch, json.dumps({"frage_art": "taxa_composition", "rang": "none"}),
               "Gyrodinium leads [F1].")
    agent.run("What is the most common class here?", DS, model="m")
    assert calls[0] == ("taxa_composition", {"dataset_id": DS, "rank": "class", "limit": 15})


def test_repeated_tool_call_is_not_run_again(calls, monkeypatch):
    nochmal = {"content": "", "tool_calls": [
        {"function": {"name": "cluster_detail", "arguments": {"cluster": 1}}}]}
    sent = model_says(monkeypatch, nochmal, nochmal, "The cluster consists of the members listed.")
    out = agent.run("What is in cluster 1?", DS, model="m")
    assert [n for n, _ in calls].count("cluster_detail") == 1
    assert sent[2]["tools"] is None, "after a repeat the model has to answer"
    assert sent[2]["messages"][-1]["content"] == agent.REPEAT_NOTE
    assert out["answer"] == "The cluster consists of the members listed." and out["steps"] == 3


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
        "Gyrodinium has 36 ASVs [F1]. Prochlorococcus follows [F2]. Phaeocystis is second.", fs)
    assert probleme == ["36 is not in F1", "Prochlorococcus is not in F2",
                        'no finding cited: "Phaeocystis is second."']
    # 220 is a real value, but of F4, not of the finding the sentence cites
    assert grounding.check_cited("Gyrodinium has 220 ASVs [F1].", fs) == ["220 is not in F1"]


def test_local_model_is_asked_not_to_think(monkeypatch):
    gesendet = {}

    class Antwort:
        status_code = 200

        def json(self):
            return {"message": {"role": "assistant", "content": "ok"}}

    def post(url, json, timeout):
        gesendet.update(json)
        return Antwort()

    monkeypatch.setattr(agent.httpx, "post", post)
    agent._chat([{"role": "user", "content": "hi"}], model="qwen3:8b")
    assert gesendet["think"] is False
    monkeypatch.setattr(agent, "OLLAMA_THINK", "")
    gesendet.clear()
    agent._chat([{"role": "user", "content": "hi"}], model="qwen3:8b")
    assert "think" not in gesendet


def test_sentence_without_numbers_or_names_needs_no_citation():
    fs = befunde.taxa_composition({"taxa_composition": TAXA, "dataset_summary": SUMMARY})
    assert grounding.check_cited(
        "Additionally, the ranking counts ASVs, not reads. Gyrodinium has the most ASVs (12) "
        "[F1].", fs) == []


def test_typographic_minus_is_read_as_minus():
    assert grounding.check("rho = \u22120.86, 95 % confidence interval", ["rho -0.86"]) == []
    assert grounding.check("rho = \u22120.87", ["rho -0.86"]) == ["-0.87"]
    assert grounding.annotate("rho = \u22120.87.", ["-0.87"]) == "rho = \u22120.87 [no evidence]."


def test_keystone_tool_lists_both_criteria(monkeypatch):
    import tools

    modules = [{"id": a, "module": 0} for a in ("a", "b", "c", "d", "e")]
    # a-b-c-d chain plus a shortcut a-c; e has no significant CCM link
    links = [("a", "b", 0.9, 0.0), ("b", "c", 0.9, 0.0), ("c", "d", 0.9, 0.0),
             ("a", "c", 0.5, 0.01), ("d", "e", 0.9, 0.5)]

    def q(query, **_):
        if "INFLUENCES" in query:
            return [{"source": s, "target": t, "nmi": n, "p": p} for s, t, n, p in links]
        return modules

    monkeypatch.setattr(tools, "_require_dataset", lambda d: None)
    monkeypatch.setattr(tools, "_q", q)
    monkeypatch.setattr(tools, "_envelope", lambda tool, query, params, data, n: data)
    out = tools.keystone_asvs(DS)
    assert [r["asv_id"] for r in out["criterion1"]["asvs"]] == ["a", "b", "c", "d"]
    assert out["n_network"] == 5
    assert set(out["both"]) == {r["asv_id"] for r in out["criterion2"]["asvs"]}
    assert "not available" in out["criterion3"]


def test_question_is_repeated_after_a_tool_result(calls, monkeypatch):
    sent = model_says(monkeypatch, {"content": "", "tool_calls": [
        {"function": {"name": "asv_detail", "arguments": {"asv_id": "euk_asv_001"}}}]},
        "euk_asv_001 is a Gyrodinium.")
    agent.run("Is euk_asv_001 rising or falling over time?", DS, model="m")
    assert sent[1]["messages"][-1] == {
        "role": "user", "content": agent.QUESTION_NOTE.format(
            question="Is euk_asv_001 rising or falling over time?")}


def test_last_step_has_to_answer(calls, monkeypatch):
    replies = [{"content": "", "tool_calls": [
        {"function": {"name": "find_asv", "arguments": {"limit": i}}}]}
        for i in range(agent.MAX_STEPS - 1)]
    sent = model_says(monkeypatch, *replies, "euk_asv_001 is in cluster 1.")
    out = agent.run("In which module is euk_asv_001?", DS, model="m")
    assert sent[-1]["tools"] is None
    assert out["answer"] == "euk_asv_001 is in cluster 1." and not out.get("truncated")


def test_zero_padded_asv_number_counts_as_its_id():
    tool = ['{"neighbors": [{"asv_id": "asv_005"}, {"asv_id": "asv_022"}]}']
    assert grounding.check("It is linked to ASVs 005 and 022.", tool, pool=set()) == []
    assert grounding.check("It is linked to ASV 023.", tool, pool=set()) == ["023"]


def test_german_answer_is_checked_in_english_then_translated(calls, monkeypatch):
    sent = model_says(monkeypatch, json.dumps({"frage_art": "taxa_composition", "rang": "genus"}),
                      "Gyrodinium has the most ASVs (12 ASVs) [F1].",
                      "Gyrodinium hat die meisten ASVs (12 ASVs) [F1].")
    out = agent.run("Welche Gattungen dominieren hier?", DS, model="m")
    assert "Write the answer in English" in sent[1]["messages"][-1]["content"]
    assert out["check"] == "cited"
    assert out["answer"] == "Gyrodinium hat die meisten ASVs (12 ASVs) [F1]."


def test_translation_that_changes_a_number_is_dropped(calls, monkeypatch):
    model_says(monkeypatch, json.dumps({"frage_art": "taxa_composition", "rang": "genus"}),
               "Gyrodinium has the most ASVs (12 ASVs) [F1].",
               "Gyrodinium hat die meisten ASVs (13 ASVs) [F1].")
    out = agent.run("Welche Gattungen dominieren hier?", DS, model="m")
    assert out["answer"] == "Gyrodinium has the most ASVs (12 ASVs) [F1]."


def test_english_question_is_not_translated():
    assert not agent._auf_deutsch("Which genera dominate this dataset?")
    assert not agent._auf_deutsch("What does this module consist of, and who dominates it?")
    assert agent._auf_deutsch("Gib mir einen Überblick über diesen Datensatz.")
    assert agent._auf_deutsch("Wie stark sind die Module untereinander verbunden?")
