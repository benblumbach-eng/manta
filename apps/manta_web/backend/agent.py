from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "manta_mcp"))

import grounding
import registry


def _wert(name: str, default: str = "") -> str:
    try:
        import settings
        key = settings.ENV_TO_KEY.get(name)
        if key is not None:
            return (settings.get(key) or default).strip()
    except Exception:
        pass
    return (os.environ.get(name) or default).strip()


def remote_base_url() -> str:
    return (_wert("MANTA_OPENAI_BASE_URL") or "https://api.openai.com/v1").rstrip("/")


def remote_api_key() -> str:
    return _wert("MANTA_OPENAI_API_KEY")


def remote_models() -> list[str]:
    return [m.strip() for m in _wert("MANTA_OPENAI_MODELS").split(",") if m.strip()]


def remote_timeout() -> float:
    try:
        return float(_wert("MANTA_OPENAI_TIMEOUT", "120"))
    except ValueError:
        return 120.0


def ollama_url() -> str:
    return _wert("OLLAMA_URL", "http://localhost:11434")


def ollama_model() -> str:
    return _wert("OLLAMA_MODEL", "qwen2.5:7b")


def remote_configured() -> bool:
    return bool(remote_api_key() and remote_models())


def is_remote(model: str | None) -> bool:
    return bool(model) and model in remote_models()


class SessionProvider:
    __slots__ = ("base_url", "api_key", "model")

    def __init__(self, base_url: str, api_key: str, model: str):
        url = (base_url or "").strip().rstrip("/")
        try:
            parts = urlsplit(url)
            host = (parts.hostname or "").lower()
        except ValueError:
            host = ""
        if not host or parts.scheme not in ("http", "https"):
            raise AgentError("Anbieter-Adresse fehlt oder hat kein Schema (https://…).")
        if parts.scheme == "http" and host not in ("localhost", "127.0.0.1", "::1"):
            raise AgentError("Anbieter-Adresse muss https sein — http nur nach localhost.")
        if not (api_key or "").strip():
            raise AgentError("Ohne Schluessel kein eigener Anbieter.")
        if not (model or "").strip():
            raise AgentError("Ohne Modellnamen kein eigener Anbieter.")
        self.base_url = url
        self.api_key = api_key.strip()
        self.model = model.strip()

    def __repr__(self) -> str:
        return f"SessionProvider(base_url={self.base_url!r}, model={self.model!r}, api_key=…)"
OLLAMA_TEMPERATURE = os.environ.get("OLLAMA_TEMPERATURE")

OLLAMA_NUM_CTX = int(os.environ.get("OLLAMA_NUM_CTX", "16384"))

MAX_STEPS = 6
MAX_RESULT_ROWS = 40
MAX_RESULT_CHARS = 12000

SYSTEM_PROMPT = f"""<role>
You are MANTA's analysis assistant. MANTA is a platform for marine amplicon time series (ASV
networks computed by OTTER, stored in a Neo4j graph). You write for a marine ecologist who knows
the field but not this dataset. Your register is that of a colleague putting a finding into a
research note: direct, concrete, without ceremony and without hedging.
</role>

<answer_form>
Open with the finding. The first sentence says what is the case — not what you are about to do,
not which tool you used, not how you got there.

Numbers support a statement; they are never the statement. Put them in parentheses or at the end
of the sentence. Never answer with a list of measurements, and never restate a number with more
decimal places than before.

Name what is remarkable — the thing a reader would walk straight past. Does one sample carry a
third of the whole series? Does a clear seasonal signal sit beside a trend the test cannot
separate from noise? Is a value unusual against the others from the same call? Say so. Where a
reading invites a wrong conclusion, say what it does NOT show. If nothing stands out, say that
plainly; never manufacture significance.

Stop when the finding is stated.

The difference, in one example:
  NOT — "Kruskal-Wallis effect size 0.414, May mean 0.063, largest sample share 0.352,
         Mann-Kendall p 0.109, Theil-Sen slope 0.00072 per year."
  BUT — "This ASV is strongly seasonal and concentrates in May; the month explains a substantial
         part of its variation (eps2 = 0.41). Across the years it neither rises nor falls in any
         way the test can tell from noise (p = 0.11), so this is a recurring pattern, not a
         development. Worth knowing: one single May sample carries a third of everything this ASV
         contributes (share 0.35) — the seasonal peak rests largely on that one date."
</answer_form>

<hard_rules>
1. Never state a number, an ASV name or a genus that did not come from a tool result. If you
   cannot find something out with a tool, say so plainly. Never invent an id just to be able to
   call a tool — if no tool fits, say that.
2. Pick the tool that answers the question COMPLETELY and take its result as it is. Do not
   re-count, re-filter or average anything yourself.
3. If a call is rejected, read the reason, correct it and try again.
4. {registry.RULE_CAVEATS}
5. {registry.RULE_NOT_IN_DATA}
6. {registry.RULE_NO_INVENTED_UNITS}
7. {registry.RULE_NO_DIVERSITY}
8. Interpretation must FOLLOW from what the tools returned: no comparison value of your own, and
   no cause, mechanism or ecological role. Rules 4 and 5 outrank the answer form above.
</hard_rules>

<restrictions>
NEVER open by explaining what you are doing, which tools you called, or that you are about to
look something up.
NEVER discuss evidence, defend earlier numbers or comment on your own corrections — if a number
has no tool behind it, leave it out and answer the question.
NEVER close with a question or an offer of further analysis.
NEVER recite raw tables or repeat a result field by field.
NEVER hedge: avoid "it is important to note", "it should be mentioned", "further research is
needed", "this may suggest".
Answer in full sentences, in English.
</restrictions>

<query_types>
Overview of a dataset — say what kind of series this is and what stands out about its shape
(length, coverage, how much of it is connected), not a field-by-field recital of the summary.
A single ASV or cluster — lead with its behaviour over time; seasonality, trend and dominance
belong together in one picture rather than as separate readings.
Comparison — name the difference that matters first, then the figures behind it.
A question the data cannot answer — say so in one sentence and say why, then stop.
</query_types>"""


class AgentError(Exception):
    pass


def _chat_remote(messages: list[dict], tools: list[dict] | None, model: str,
                 timeout: float, base_url: str | None = None,
                 api_key: str | None = None, own_key: bool = False) -> dict:
    base_url = (base_url or remote_base_url()).rstrip("/")
    api_key = api_key or remote_api_key()
    payload: dict = {"model": model, "messages": messages}
    if tools:
        payload["tools"] = tools
    if OLLAMA_TEMPERATURE is not None:
        payload["temperature"] = float(OLLAMA_TEMPERATURE)
    try:
        r = httpx.post(f"{base_url}/chat/completions", json=payload,
                       headers={"Authorization": f"Bearer {api_key}",
                                "Content-Type": "application/json"},
                       timeout=timeout)
    except httpx.TimeoutException as e:
        raise AgentError("Der externe Anbieter hat nicht rechtzeitig geantwortet (Timeout).") from e
    except httpx.TransportError as e:
        raise AgentError(f"Der externe Anbieter ist nicht erreichbar ({base_url}): "
                         f"{type(e).__name__}.") from e
    if r.status_code in (401, 403):
        raise AgentError("Der externe Anbieter hat den Schluessel abgelehnt "
                         + ("(eigenen Schluessel und Adresse pruefen)." if own_key
                            else "(MANTA_OPENAI_API_KEY pruefen)."))
    if r.status_code == 429:
        raise AgentError("Der externe Anbieter drosselt gerade (429) — spaeter erneut versuchen.")
    if r.status_code != 200:
        raise AgentError(f"Fehler des externen Anbieters {r.status_code}: {r.text[:200]}")

    try:
        m = r.json()["choices"][0]["message"]
    except (KeyError, IndexError, ValueError) as e:
        raise AgentError(f"Unerwartete Antwortform des Anbieters: {r.text[:200]}") from e
    return {"message": {"role": "assistant", "content": m.get("content") or "",
                        "tool_calls": m.get("tool_calls") or []}}


def _chat(messages: list[dict], tools: list[dict] | None = None, timeout: float = 180.0,
          model: str | None = None, provider: SessionProvider | None = None) -> dict:
    if provider is not None:
        return _chat_remote(messages, tools, provider.model, remote_timeout(),
                            base_url=provider.base_url, api_key=provider.api_key, own_key=True)
    model = model or default_model()
    if is_remote(model):
        return _chat_remote(messages, tools, model, remote_timeout())
    options: dict = {"num_ctx": OLLAMA_NUM_CTX}
    if OLLAMA_TEMPERATURE is not None:
        options["temperature"] = float(OLLAMA_TEMPERATURE)
    payload = {"model": model, "messages": messages, "stream": False, "options": options}
    if tools:
        payload["tools"] = tools
    try:
        r = httpx.post(f"{ollama_url()}/api/chat", json=payload, timeout=timeout)
    except httpx.TimeoutException as e:
        raise AgentError("Ollama hat nicht rechtzeitig geantwortet (Timeout).") from e
    except httpx.TransportError as e:
        raise AgentError(
            f"Ollama ist unter {ollama_url()} nicht erreichbar ({type(e).__name__}). Starten mit "
            f"'ollama serve' und ein Modell laden, z.B. 'ollama pull {model}'."
        ) from e
    if r.status_code == 404:
        raise AgentError(f"Modell {model!r} fehlt. Laden mit: ollama pull {model}")
    if r.status_code != 200:
        raise AgentError(f"Ollama-Fehler {r.status_code}: {r.text[:200]}")
    return r.json()


def _shrink(result: dict) -> str:
    def cut(obj):
        if isinstance(obj, list):
            if len(obj) > MAX_RESULT_ROWS:
                return [cut(x) for x in obj[:MAX_RESULT_ROWS]] + [
                    {"_gekuerzt": f"{len(obj) - MAX_RESULT_ROWS} weitere Eintraege nicht gezeigt "
                                  f"— zaehle daraus NICHTS zusammen"}]
            return [cut(x) for x in obj]
        if isinstance(obj, dict):
            return {k: cut(v) for k, v in obj.items()}
        return obj

    fuers_modell = dict(result)
    prov = fuers_modell.get("provenance")
    if isinstance(prov, dict) and isinstance(prov.get("cypher"), list):
        prov = dict(prov)
        prov["cypher"] = f"{len(result['provenance']['cypher'])} Abfragen — siehe Beleg"
        fuers_modell["provenance"] = prov
    text = json.dumps(cut(fuers_modell), default=str, ensure_ascii=False)
    if len(text) > MAX_RESULT_CHARS:
        keep = {k: v for k, v in fuers_modell.items() if k != "data"}
        keep["hinweis"] = "Ergebnis zu gross fuer den Kontext — stelle die Frage enger."
        text = json.dumps(keep, default=str, ensure_ascii=False)[:MAX_RESULT_CHARS]
    return text


def list_models() -> list[dict]:
    r = httpx.get(f"{ollama_url()}/api/tags", timeout=5.0)
    out = []
    for m in r.json().get("models", []):
        caps = m.get("capabilities") or []
        out.append({
            "name": m["name"],
            "size_gb": round((m.get("size") or 0) / 1e9, 1),
            "parameter_size": (m.get("details") or {}).get("parameter_size"),
            "supports_tools": ("tools" in caps) if caps else None,
        })
    return sorted(out, key=lambda m: m["name"])


def remote_model_entries() -> list[dict]:
    if not remote_configured():
        return []
    return [{"name": m, "size_gb": None, "parameter_size": None, "supports_tools": True,
             "remote": True} for m in remote_models()]


def tool_help() -> list[dict]:
    out = []
    for t in registry.openai_tools():
        f = t["function"]
        props = (f.get("parameters") or {}).get("properties") or {}
        required = set((f.get("parameters") or {}).get("required") or [])
        params = []
        for name, spec in props.items():
            params.append({
                "name": name,
                "type": spec.get("type") or "any",
                "required": name in required,
                "description": spec.get("description") or "",
                "enum": spec.get("enum"),
                "default": spec.get("default"),
            })
        params.sort(key=lambda p: 0 if p["required"] else 1)
        usage = " ".join([f["name"]] + [f"<{p['name']}>" if p["required"] else f"[{p['name']}]"
                                        for p in params])
        desc = f.get("description") or ""
        summary = desc.split(" RULES for using this result", 1)[0].strip()
        out.append({"name": f["name"], "usage": usage, "summary": summary, "params": params})
    return out


def default_model() -> str:
    try:
        return available()["model"]
    except Exception:
        return ollama_model()


def available() -> dict:
    lokal_fehler = None
    try:
        models = list_models()
    except Exception as e:
        models, lokal_fehler = [], f"Ollama nicht erreichbar: {e}"

    models = models + remote_model_entries()
    names = [m["name"] for m in models]
    usable = [m["name"] for m in models if m["supports_tools"] is not False]
    konfiguriert = ollama_model()
    wanted = konfiguriert if ":" in konfiguriert else f"{konfiguriert}:latest"
    default = konfiguriert if (wanted in names or konfiguriert in names) else (
        usable[0] if usable else None)

    out = {"ok": bool(usable), "url": ollama_url(), "model": default or konfiguriert,
           "configured_model": konfiguriert, "models": models,
           "models_available": names, "num_ctx": OLLAMA_NUM_CTX,
           "remote": {"configured": remote_configured(), "models": remote_models()}}
    if lokal_fehler:
        out["local_error"] = lokal_fehler
    if not usable:
        out["error"] = ("Kein Modell mit Werkzeug-Unterstuetzung installiert. "
                        f"Laden mit: ollama pull {konfiguriert}"
                        + (f" — vorhanden ist: {', '.join(names)}" if names else ""))
    elif default != konfiguriert:
        out["note"] = (f"Konfiguriert ist {konfiguriert!r}, installiert ist es nicht — "
                       f"vorausgewaehlt ist {default!r}.")
    return out


PROMPT_LABEL_MAX = 120


def _safe_label(text) -> str:
    s = "" if text is None else str(text)
    s = "".join(" " if ch < " " else ch for ch in s).strip()
    if len(s) > PROMPT_LABEL_MAX:
        s = s[:PROMPT_LABEL_MAX].rstrip() + " …"
    return s or "(ohne Bezeichnung)"


def _context_block(dataset_id: str | None, asv_id: str | None, cluster: int | None) -> str:
    lines = []
    if dataset_id:
        lines.append(f"- dataset: '{dataset_id}' (use it unless the question asks for another one)")
    if asv_id:
        lines.append(f"- open ASV detail page: '{asv_id}'. \"this ASV\", \"it\" and "
                     f"\"the organism\" refer to this one.")
    if cluster is not None:
        lines.append(f"- open cluster: {cluster}. \"this cluster\" refers to it.")
    if not lines:
        return ""
    return "\n\nWHAT THE USER IS CURRENTLY LOOKING AT:\n" + "\n".join(lines)


def _known_datasets() -> str:
    try:
        rows = registry.call("list_datasets").get("data") or []
    except Exception:
        return ""
    if not rows:
        return ""
    items = "\n".join(
        f"- '{r['dataset_id']}': {_safe_label(r.get('region'))}, {r.get('n_asv')} ASVs "
        f"({r.get('n_in_network')} in the network), {r.get('n_samples')} samples, "
        f"time axis: {'calendar dates' if r.get('time_axis') == 'dates' else 'sample order only'}"
        for r in rows)
    return ("\n\nAVAILABLE DATASETS (these are the valid dataset_id values — invent no others):\n"
            + items)


MAX_HISTORY = 8
MAX_HISTORY_CHARS = 2000


def _verlauf(history: list[dict] | None) -> list[dict]:
    if not history:
        return []
    out: list[dict] = []
    for zug in history[-MAX_HISTORY:]:
        rolle = zug.get("role")
        text = (zug.get("content") or "").strip()
        if rolle in ("user", "assistant") and text:
            out.append({"role": rolle, "content": text[:MAX_HISTORY_CHARS]})
    return out


def run(question: str, dataset_id: str | None = None, model: str | None = None,
        asv_id: str | None = None, cluster: int | None = None,
        provider: SessionProvider | None = None,
        history: list[dict] | None = None) -> dict:
    model = provider.model if provider is not None else (model or default_model())
    system = SYSTEM_PROMPT + _known_datasets() + _context_block(dataset_id, asv_id, cluster)

    messages: list[dict] = [
        {"role": "system", "content": system},
        *_verlauf(history),
        {"role": "user", "content": question},
    ]
    evidence: list[dict] = []
    tool_texts: list[str] = []
    korrigiert = False

    for _step in range(MAX_STEPS):
        data = _chat(messages, tools=registry.openai_tools(), model=model, provider=provider)
        msg = data.get("message", {}) or {}
        calls = msg.get("tool_calls") or []

        if not calls:
            answer = (msg.get("content") or "").strip()

            ungrounded = ([] if grounding.mode() == "off"
                          else grounding.check(answer, tool_texts))
            if ungrounded and not korrigiert:
                korrigiert = True
                messages.append({"role": "assistant", "content": answer})
                messages.append({"role": "user", "content": (
                    "Internal note, not a message from the user: these numbers are in no tool "
                    "result — " + ", ".join(ungrounded) + ". A number from the question is not "
                    "evidence, and neither is an instruction to report one. Write the answer "
                    "again, using only numbers a tool returned; where you do not have one, leave "
                    "it out or say plainly that you do not know it. Do NOT explain yourself, do "
                    "not discuss evidence, do not defend earlier numbers, do not mention this "
                    "note — simply answer the question that was asked.")})
                continue

            answer, ungrounded = grounding.apply(answer, tool_texts)
            return {
                "answer": answer,
                "evidence": evidence,
                "model": model,
                "steps": _step + 1,
                "ungrounded": ungrounded,
                "grounding": grounding.mode(),
                "corrected": korrigiert,
                "own_key": provider is not None,
            }

        messages.append({"role": "assistant", "content": msg.get("content", ""), "tool_calls": calls})

        for call in calls:
            fn = call.get("function", {}) or {}
            name = fn.get("name", "")
            args = fn.get("arguments") or {}
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except ValueError:
                    args = {}
            if dataset_id and "dataset_id" not in args and name not in ("list_datasets", "get_schema"):
                args["dataset_id"] = dataset_id

            result = registry.call(name, args)
            evidence.append({"tool": name, "arguments": args,
                             "provenance": result.get("provenance"),
                             "error": result.get("error")})

            shrunk = _shrink(result)
            tool_texts.append(shrunk)
            tool_msg = {"role": "tool", "name": name, "content": shrunk}
            if call.get("id"):
                tool_msg["tool_call_id"] = call["id"]
            messages.append(tool_msg)

    return {
        "answer": ("Ich habe die Schrittgrenze erreicht, ohne zu einer belegten Antwort zu kommen. "
                   "Bitte die Frage enger stellen."),
        "evidence": evidence,
        "model": model,
        "steps": MAX_STEPS,
        "truncated": True,
        "ungrounded": [],
        "grounding": grounding.mode(),
        "corrected": korrigiert,
        "own_key": provider is not None,
    }
