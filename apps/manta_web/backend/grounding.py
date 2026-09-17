from __future__ import annotations

import os
import re

def mode() -> str:
    try:
        import settings
        return (settings.get("grounding") or "mark").strip().lower()
    except Exception:
        return (os.environ.get("MANTA_GROUNDING") or "mark").strip().lower()
MARK = " [ohne Beleg]"

EPS = 1e-9

_NUM = re.compile(r"(?<![\w.])[-+]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?(?![\w])")

_ENUM = re.compile(
    r"(?mi)"
    r"^[ \t]*\d{1,2}[.)][ \t]"
    r"|\b(?:die|der|das|den|nummer|nr\.?|punkt|option|methode|variante|schritt|frage"
    r"|method|option|point|step|number|item)\s+\d{1,2}\b"
    r"|\bdie\s+\d{1,2}\."
    r"|\(\s*\d{1,2}\s*\)")

_WORD_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.:/")


def _to_float(raw: str) -> float | None:
    try:
        return float(raw.replace(",", ""))
    except ValueError:
        return None


def _decimals(raw: str) -> int:
    m = re.search(r"\.(\d+)", raw)
    return len(m.group(1)) if m else 0


def data_numbers(texts: list[str]) -> set[float]:
    out: set[float] = set()
    for t in texts:
        for m in _NUM.finditer(t or ""):
            v = _to_float(m.group())
            if v is not None:
                out.add(v)
    return out


def _word_at(text: str, start: int, end: int) -> str:
    i, j = start, end
    while i > 0 and text[i - 1] in _WORD_CHARS:
        i -= 1
    while j < len(text) and text[j] in _WORD_CHARS:
        j += 1
    return text[i:j]


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


def check(answer: str, tool_texts: list[str]) -> list[str]:
    if not answer:
        return []
    pool = data_numbers(tool_texts)
    haystack = "\n".join(t or "" for t in tool_texts).lower()
    enum_spans = [m.span() for m in _ENUM.finditer(answer)]

    schlecht: list[str] = []
    for m in _NUM.finditer(answer):
        if any(a <= m.start() < b for a, b in enum_spans):
            continue
        wort = _word_at(answer, m.start(), m.end())
        if wort and wort.lower() in haystack:
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
    treffer = [m for m in _NUM.finditer(answer) if m.group() in ziel]
    out = answer
    for m in reversed(treffer):
        out = out[:m.end()] + MARK + out[m.end():]
    return out


REFUSAL = ("Diese Antwort enthielt Zahlen, die in keinem Werkzeug-Ergebnis vorkommen "
           "({zahlen}) — sie wurde deshalb verworfen. Bitte die Frage anders stellen.")


def apply(answer: str, tool_texts: list[str]) -> tuple[str, list[str]]:
    eingestellt = mode()
    if eingestellt == "off":
        return answer, []
    schlecht = check(answer, tool_texts)
    if not schlecht:
        return answer, []
    if eingestellt == "refuse":
        return REFUSAL.format(zahlen=", ".join(schlecht)), schlecht
    return annotate(answer, schlecht), schlecht
