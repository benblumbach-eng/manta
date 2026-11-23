from __future__ import annotations

import sys
from pathlib import Path

import pytest

HIER = Path(__file__).resolve().parent
sys.path[:0] = [str(HIER.parent)]

import auth  # noqa: E402
import primers  # noqa: E402


@pytest.fixture(autouse=True)
def db(tmp_path, monkeypatch):
    monkeypatch.setattr(auth, "DB_PATH", tmp_path / "auth.db")


def own():
    return [p for p in primers.list_all() if p["id"] is not None]


def test_create_edit_delete():
    primers.save("my pair", " gtgycagcmg ccgcggtaa", "CCGYCAATTYMTTTRAGTTT", "ben")
    [p] = own()
    assert p["fwd"] == "GTGYCAGCMGCCGCGGTAA"
    primers.save("renamed", p["fwd"], "GGACTACNVGGGTWTCTAAT", "ben", p["id"])
    [q] = own()
    assert (q["id"], q["label"], q["rev"]) == (p["id"], "renamed", "GGACTACNVGGGTWTCTAAT")
    primers.delete(q["id"])
    assert own() == []
    assert len(primers.list_all()) == len(primers.BUILTIN)


@pytest.mark.parametrize("label,fwd", [("x", "GTGYCAG"), ("x", "GTGYCAGCMGCCGCGGTAX"),
                                       ("", "GTGYCAGCMGCCGCGGTAA"),
                                       ("18S V4", "GTGYCAGCMGCCGCGGTAA")])
def test_rejects_bad_input(label, fwd):
    with pytest.raises(ValueError):
        primers.save(label, fwd, "CCGYCAATTYMTTTRAGTTT", "ben")


def test_duplicate_name_and_missing_id():
    primers.save("a", "GTGYCAGCMGCCGCGGTAA", "CCGYCAATTYMTTTRAGTTT", "ben")
    with pytest.raises(ValueError):
        primers.save("a", "GTGYCAGCMGCCGCGGTAA", "CCGYCAATTYMTTTRAGTTT", "ben")
    with pytest.raises(KeyError):
        primers.delete(999)
    with pytest.raises(KeyError):
        primers.save("b", "GTGYCAGCMGCCGCGGTAA", "CCGYCAATTYMTTTRAGTTT", "ben", 999)
