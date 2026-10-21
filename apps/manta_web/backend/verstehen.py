from __future__ import annotations

import json
import re
from typing import Callable, Literal

import pydantic

import frage_arten

ARTEN = tuple(frage_arten.GEPLANT) + (frage_arten.ANDERE,)
KEIN_RANG = "none"


class Formular(pydantic.BaseModel):
    frage_art: Literal[ARTEN]  # type: ignore[valid-type]
    rang: Literal[frage_arten.RAENGE + (KEIN_RANG,)] = KEIN_RANG  # type: ignore[valid-type]


SCHEMA = {
    "type": "object",
    "properties": {
        "frage_art": {"type": "string", "enum": list(ARTEN)},
        "rang": {"type": "string", "enum": list(frage_arten.RAENGE) + [KEIN_RANG]},
    },
    "required": ["frage_art", "rang"],
}


def prompt() -> str:
    arten = "\n".join(
        f"- {name}: \"{frage_arten.beispiel(name)}\" (also: {', '.join(a['synonyme'])})"
        for name, a in frage_arten.GEPLANT.items())
    begriffe = "\n".join(f"- {b}" for b in frage_arten.BEGRIFFE)
    return (
        "You sort a question about a marine amplicon dataset into one kind. You do not answer "
        "it.\n\nKinds:\n" + arten +
        f"\n- {frage_arten.ANDERE}: anything else, or a question about one single ASV or one "
        "single cluster\n\nWhat the words mean:\n" + begriffe +
        "\n\n'rang' is the taxonomic rank the question names (genus, family, …), or "
        f"'{KEIN_RANG}' if it names none.\n\nReply with JSON only, exactly this shape:\n"
        + json.dumps({"frage_art": "taxa_composition", "rang": KEIN_RANG}))


def _lesen(text: str) -> Formular | None:
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        return None
    try:
        return Formular.model_validate_json(m.group())
    except pydantic.ValidationError:
        return None


# chat(messages, schema) returns the model's text. Two tries; after that the question counts as
# 'andere', because a wrong kind would answer a different question.
def verstehe(frage: str, chat: Callable[[list[dict], dict], str]) -> tuple[Formular, list[str]]:
    messages = [{"role": "system", "content": prompt()}, {"role": "user", "content": frage}]
    antworten: list[str] = []
    for _ in range(2):
        text = chat(messages, SCHEMA)
        antworten.append(text)
        f = _lesen(text)
        if f is not None:
            return f, antworten
        messages = messages + [{"role": "assistant", "content": text},
                               {"role": "user", "content": "That was not valid. Reply with the "
                                                           "JSON object only."}]
    return Formular(frage_art=frage_arten.ANDERE), antworten
