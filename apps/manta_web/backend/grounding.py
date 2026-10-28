from __future__ import annotations

import math
import os
import re

def mode() -> str:
    return (os.environ.get("MANTA_GROUNDING") or "mark").strip().lower()
MARK = " [no evidence]"

EPS = 1e-9

_NUM = re.compile(r"(?<![\w.])[-+]?(?:\d(?:[\d,]*\d)?(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?"
                  r"(?![\d])(?!\.\d)(?!(?:st|nd|rd|th)\b)")

_PURE_NUMBER = re.compile(r"^[-+]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?$")

_NAME_AFTER = re.compile(r"[SD](?![A-Za-z0-9_])")


def _is_name(text: str, m: re.Match) -> bool:
    raw = m.group()
    if not raw.isdigit():
        return False
    nach = _NAME_AFTER.match(text, m.end())
    if not nach:
        return False
    return len(raw) <= 2 if nach.group() == "S" else raw in {"1", "2", "3", "4"}

# "95 % confidence interval" names the interval, it is not a value
_KONFIDENZ = re.compile(r"\s*%\s*(?:confidence|CI\b|Konfidenz)", re.I)

_LINE_ENUM = re.compile(r"(?m)^[ \t]*(\d{1,2})[.)][ \t]")
_PAREN = re.compile(r"\(\s*(\d{1,2})\s*\)")
_PAREN_AT_LINE_START = re.compile(r"(?m)^[ \t]*\(\s*(\d{1,2})\s*\)")
_REF = re.compile(
    r"(?i)\b(?:die|der|das|den|nummer|nr\.?|punkt|option|methode|variante|schritt|frage"
    r"|method|point|step|number|item)\s+(\d{1,2})\b")

_WORD_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.:/")
_TOKEN = re.compile(r"[A-Za-z0-9_\-.:/]+")
_TRAIL = ".:/-"
_ID_SUFFIX = re.compile(r"0\d+$")

LABEL_KEYS = frozenset({
    "kingdom", "phylum", "class", "order", "family", "genus", "species", "taxon", "taxa",
    "top_genera", "genera", "region", "name", "display", "cluster_display", "module_name",
    "s_genus", "t_genus", "mine_genus", "other_genus"})


# Models write the typographic minus (U+2212); read as "-" so "−0.86" is checked as -0.86,
# not as 0.86. One character for one, so positions in the text stay the same.
def _minus(text: str) -> str:
    return (text or "").replace("\u2212", "-")


def _to_float(raw: str) -> float | None:
    try:
        return float(raw.replace(",", ""))
    except ValueError:
        return None


def _decimals(raw: str) -> int:
    m = re.match(r"[-+]?[\d,]*(?:\.(\d+))?(?:[eE]([-+]?\d+))?$", raw)
    if not m:
        return 0
    return len(m.group(1) or "") - int(m.group(2) or 0)


def data_numbers(texts: list[str]) -> set[float]:
    out: set[float] = set()
    for t in texts:
        for m in _NUM.finditer(t or ""):
            v = _to_float(m.group())
            if v is not None:
                out.add(v)
    return out


def numbers_from(obj, _key: str | None = None) -> set[float]:
    out: set[float] = set()
    if isinstance(obj, bool) or obj is None:
        return out
    if isinstance(obj, (int, float)):
        if math.isfinite(obj):
            out.add(float(obj))
        return out
    if isinstance(obj, str):
        return set() if _key in LABEL_KEYS else data_numbers([obj])
    if isinstance(obj, dict):
        for k, v in obj.items():
            out |= data_numbers([str(k)])
            out |= numbers_from(v, str(k))
        return out
    if isinstance(obj, (list, tuple, set)):
        for v in obj:
            out |= numbers_from(v, _key)
        return out
    return data_numbers([str(obj)])


def _word_at(text: str, start: int, end: int) -> str:
    i, j = start, end
    while i > 0 and text[i - 1] in _WORD_CHARS:
        i -= 1
    while j < len(text) and text[j] in _WORD_CHARS:
        j += 1
    return text[i:j]


def _tokens(texts: list[str]) -> set[str]:
    out: set[str] = set()
    for t in texts:
        for w in _TOKEN.findall((t or "").lower()):
            w = w.rstrip(_TRAIL)
            if w:
                out.add(w)
    return out


def _is_identifier(wort: str) -> bool:
    return bool(wort) and not _PURE_NUMBER.match(wort)


def _covered(value: float, raw: str, pool: set[float]) -> bool:
    nk = _decimals(raw)
    for d in pool:
        if abs(d - value) <= EPS * max(1.0, abs(d)):
            return True
        if abs(round(d, nk) - value) <= EPS * max(1.0, abs(value)):
            return True
        if abs(round(d * 100, nk) - value) <= EPS * max(1.0, abs(value)):
            return True
    return False


def _gliederung(text: str) -> int:
    marken = {int(m.group(1)) for m in _LINE_ENUM.finditer(text or "")}
    marken |= {int(m.group(1)) for m in _PAREN.finditer(text or "")}
    n = 0
    while n + 1 in marken:
        n += 1
    return n


def _reference_spans(answer: str, references: list[str] | None) -> list[tuple[int, int]]:
    refs = [r for r in (references or []) if r]
    spans = [m.span() for m in _LINE_ENUM.finditer(answer)]
    spans += [m.span() for m in _PAREN_AT_LINE_START.finditer(answer)]
    eigene = _gliederung(answer)
    if eigene >= 2:
        spans += [m.span() for m in _PAREN.finditer(answer) if int(m.group(1)) <= eigene]
    weit = max([eigene] + [_gliederung(r) for r in refs])
    angesprochen = {int(m.group(1)) for r in refs for m in _REF.finditer(r)}
    for m in _REF.finditer(answer):
        n = int(m.group(1))
        if (1 <= n <= weit) or n in angesprochen:
            spans.append(m.span())
    return spans


def check(answer: str, tool_texts: list[str], pool: set[float] | None = None,
          references: list[str] | None = None) -> list[str]:
    if not answer:
        return []
    if pool is None:
        pool = data_numbers(tool_texts)
    tokens = _tokens(tool_texts)
    ref_spans = _reference_spans(answer, references)

    answer = _minus(answer)
    schlecht: list[str] = []
    for m in _NUM.finditer(answer):
        if any(a <= m.start() < b for a, b in ref_spans):
            continue
        if _is_name(answer, m):
            continue
        if m.group() in {"90", "95", "99"} and _KONFIDENZ.match(answer, m.end()):
            continue
        wort = _word_at(answer, m.start(), m.end()).rstrip(_TRAIL)
        if _is_identifier(wort) and wort.lower() in tokens:
            continue
        # "ASV 005" for asv_005: a zero-padded number is an id, not a value
        if _ID_SUFFIX.match(m.group()) and any(t.endswith("_" + m.group()) for t in tokens):
            continue
        v = _to_float(m.group())
        if v is None or _covered(v, m.group(), pool):
            continue
        if m.group() not in schlecht:
            schlecht.append(m.group())
    return schlecht


def annotate(answer: str, ungrounded: list[str]) -> str:
    if not ungrounded:
        return answer
    ziel = set(ungrounded)
    gelesen = _minus(answer)
    treffer = [m for m in _NUM.finditer(gelesen) if m.group() in ziel and not _is_name(gelesen, m)]
    out = answer
    for m in reversed(treffer):
        out = out[:m.end()] + MARK + out[m.end():]
    return out


REFUSAL = ("This answer contained numbers that appear in no tool result ({zahlen}), so it "
           "was discarded. Please rephrase the question.")


def apply(answer: str, tool_texts: list[str], pool: set[float] | None = None,
          references: list[str] | None = None) -> tuple[str, list[str]]:
    eingestellt = mode()
    if eingestellt == "off":
        return answer, []
    schlecht = check(answer, tool_texts, pool=pool, references=references)
    if not schlecht:
        return answer, []
    if eingestellt == "refuse":
        return REFUSAL.format(zahlen=", ".join(schlecht)), schlecht
    return annotate(answer, schlecht), schlecht


# The check for answers written from findings: every sentence cites at least one finding, and
# every number and every name in it must come from a finding it cites, not from anywhere else.
MARKE = re.compile(r"\[\s*(F\d+(?:\s*[,;]\s*F\d+)*)\s*\]")
_SATZ = re.compile(r"(?<=[.!?])\s+(?=\S)")
_ASV_KENNUNG = re.compile(r"\b\w*asv\w*\d\w*\b", re.I)
_EIGENNAME = re.compile(r"\b[A-Z][a-z]{3,}\b")
FREIE_NAMEN = frozenset({
    "asv", "asvs", "ccm", "con", "nmi", "manta", "louvain", "otter",
    "this", "these", "that", "those", "there", "here", "about", "only", "most", "next", "both",
    "each", "over", "under", "across", "among", "with", "without", "from", "between", "within",
    "however", "also", "while", "since", "because", "unlike", "like", "compared", "together",
    "overall", "note", "still", "taken", "their", "they", "when", "where", "which", "what",
    "some", "many", "several", "half", "more", "less", "fewer", "none", "just", "even", "after",
    "before", "beyond", "behind", "almost", "nearly", "roughly", "around", "apart", "besides",
    "instead", "then", "thus", "hence", "such", "every", "much",
    "additionally", "notably", "furthermore", "moreover", "finally", "first", "second",
    "following", "ranked", "caveat", "importantly", "specifically", "similarly", "likewise",
    "therefore", "remaining", "another", "summary", "total", "others", "other", "rest",
    "clearly", "directed", "cluster", "clusters", "module", "modules", "links", "link",
    "network", "dataset", "genus", "genera", "family", "families", "read", "reads", "samples"})


def saetze(answer: str) -> list[str]:
    return [s for s in (t.strip() for z in (answer or "").splitlines()
                        for t in _SATZ.split(z)) if s]


def check_cited(answer: str, findings: list[dict], question: str = "") -> list[str]:
    nach_id = {f["id"]: f for f in findings}
    probleme: list[str] = []
    for satz in saetze(answer):
        ids = [i.strip() for m in MARKE.finditer(satz) for i in re.split(r"[,;]", m.group(1))]
        if not ids:
            # a sentence with no number and no name holds nothing a finding could back
            text = _minus(satz)
            if (_NUM.search(text) or _ASV_KENNUNG.search(text)
                    or any(n.lower() not in FREIE_NAMEN for n in _EIGENNAME.findall(text))):
                probleme.append(f"no finding cited: \"{satz[:80]}\"")
            continue
        unbekannt = [i for i in ids if i not in nach_id]
        if unbekannt:
            probleme.append(f"unknown finding {', '.join(unbekannt)}")
            continue
        zitiert = [nach_id[i] for i in ids]
        pool = {float(w) for f in zitiert for w in f["werte"]} | data_numbers(
            [f["text"] for f in zitiert])
        erlaubt = _tokens([f["text"] for f in zitiert] + [n for f in zitiert for n in f["namen"]]
                          + [question]) | FREIE_NAMEN
        text = _minus(MARKE.sub(" ", satz))
        for m in _NUM.finditer(text):
            v = _to_float(m.group())
            if v is not None and not _covered(v, m.group(), pool):
                probleme.append(f"{m.group()} is not in {', '.join(ids)}")
        namen = {m.group() for m in _ASV_KENNUNG.finditer(text)}
        namen |= {m.group() for m in _EIGENNAME.finditer(text)}
        for n in sorted(namen):
            if n.lower().rstrip(_TRAIL) not in erlaubt:
                probleme.append(f"{n} is not in {', '.join(ids)}")
    return probleme


def check_translation(translated: str, original: str) -> list[str]:
    """A translation of a checked answer may change words, not numbers, ids or citations."""
    probleme = check(translated, [original])
    kennungen = {m.group().lower() for m in _ASV_KENNUNG.finditer(original)}
    probleme += [m.group() for m in _ASV_KENNUNG.finditer(translated)
                 if m.group().lower() not in kennungen]
    if sorted(MARKE.findall(translated)) != sorted(MARKE.findall(original)):
        probleme.append("citations changed")
    return probleme
