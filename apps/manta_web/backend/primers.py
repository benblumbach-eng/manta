from __future__ import annotations

import re
import sqlite3
import time

import auth

BUILTIN = [
    {"label": "515F-Y / 926R (16S V4-V5)", "marker": "16S",
     "fwd": "GTGYCAGCMGCCGCGGTAA", "rev": "CCGYCAATTYMTTTRAGTTT"},
    {"label": "515F-Y / 806RB (16S V4)", "marker": "16S",
     "fwd": "GTGYCAGCMGCCGCGGTAA", "rev": "GGACTACNVGGGTWTCTAAT"},
    {"label": "341F / 805R (16S V3-V4)", "marker": "16S",
     "fwd": "CCTACGGGNGGCWGCAG", "rev": "GACTACHVGGGTATCTAATCC"},
    {"label": "18S V4", "marker": "18S",
     "fwd": "GCGGTAATTCCAGCTCCAA", "rev": "ACTTTCGTTCTTGATYRR"},
]
PRIMER_RE = re.compile(r"^[ACGTRYSWKMBDHVN]{10,60}$")
MAX_LABEL = 60


def _conn() -> sqlite3.Connection:
    auth.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(auth.DB_PATH, timeout=10)
    c.row_factory = sqlite3.Row
    c.execute("""CREATE TABLE IF NOT EXISTS primer_pairs (
        id         INTEGER PRIMARY KEY,
        label      TEXT NOT NULL UNIQUE,
        fwd        TEXT NOT NULL,
        rev        TEXT NOT NULL,
        updated_at REAL NOT NULL,
        updated_by TEXT NOT NULL)""")
    return c


def clean(label: str, fwd: str, rev: str) -> tuple[str, str, str]:
    """Normalise and check one pair; raises ValueError with a message for the user."""
    label, fwd, rev = label.strip(), re.sub(r"\s", "", fwd).upper(), re.sub(r"\s", "", rev).upper()
    if not label or len(label) > MAX_LABEL:
        raise ValueError(f"the name must have 1-{MAX_LABEL} characters")
    if not (PRIMER_RE.match(fwd) and PRIMER_RE.match(rev)):
        raise ValueError("primers must be 10-60 IUPAC bases (A C G T R Y S W K M B D H V N), "
                         "written 5'->3'")
    if any(b["label"] == label for b in BUILTIN):
        raise ValueError(f"{label!r} is a built-in pair")
    return label, fwd, rev


def list_all() -> list[dict]:
    with _conn() as c:
        own = c.execute("SELECT id, label, fwd, rev FROM primer_pairs ORDER BY label").fetchall()
    return ([{**b, "id": None} for b in BUILTIN]
            + [{"id": r["id"], "label": r["label"], "marker": None, "fwd": r["fwd"],
                "rev": r["rev"]} for r in own])


def save(label: str, fwd: str, rev: str, by: str, pair_id: int | None = None) -> None:
    label, fwd, rev = clean(label, fwd, rev)
    try:
        with _conn() as c:
            if pair_id is None:
                c.execute("INSERT INTO primer_pairs(label, fwd, rev, updated_at, updated_by) "
                          "VALUES (?,?,?,?,?)", (label, fwd, rev, time.time(), by))
            elif c.execute("UPDATE primer_pairs SET label=?, fwd=?, rev=?, updated_at=?, "
                           "updated_by=? WHERE id=?",
                           (label, fwd, rev, time.time(), by, pair_id)).rowcount == 0:
                raise KeyError(pair_id)
    except sqlite3.IntegrityError:
        raise ValueError(f"a pair named {label!r} already exists") from None


def delete(pair_id: int) -> None:
    with _conn() as c:
        if c.execute("DELETE FROM primer_pairs WHERE id=?", (pair_id,)).rowcount == 0:
            raise KeyError(pair_id)
