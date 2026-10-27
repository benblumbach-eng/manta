from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

HIER = Path(__file__).resolve().parent
sys.path[:0] = [str(HIER.parent), str(HIER.parents[2] / "manta_mcp")]

import auth  # noqa: E402
import own_model  # noqa: E402

URL = "https://api.anthropic.com/v1"


@pytest.fixture(autouse=True)
def db(tmp_path, monkeypatch):
    monkeypatch.setattr(auth, "DB_PATH", tmp_path / "auth.db")
    monkeypatch.delenv("MANTA_SECRET_KEY", raising=False)
    monkeypatch.delenv("MANTA_SECRET_KEY_FILE", raising=False)
    auth.init_db()
    auth.create_user("ben", "password123", "admin")
    auth.create_user("ellen", "password123", "viewer")
    return tmp_path


def test_key_is_stored_encrypted_and_read_back(db):
    own_model.save("ben", URL + "/", "claude-x", "sk-secret-123456")
    raw = sqlite3.connect(db / "auth.db").execute("SELECT key_enc FROM own_models").fetchone()[0]
    assert b"sk-secret" not in raw
    assert own_model.view("ben") == {"set": True, "base_url": URL, "model": "claude-x",
                                     "updated_at": own_model.view("ben")["updated_at"]}
    assert own_model.provider("ben").api_key == "sk-secret-123456"
    assert (db / "manta_secret.key").stat().st_mode & 0o777 == 0o600


def test_each_account_has_its_own(db):
    own_model.save("ben", URL, "claude-x", "k-ben")
    assert own_model.view("ellen") == {"set": False}
    assert own_model.provider("ellen") is None


def test_empty_key_keeps_the_stored_one_only_for_the_same_address():
    with pytest.raises(ValueError, match="API key"):
        own_model.save("ben", URL, "claude-x", "")
    own_model.save("ben", URL, "claude-x", "k-ben")
    own_model.save("ben", URL, "claude-y", None)
    assert own_model.provider("ben").api_key == "k-ben"
    with pytest.raises(ValueError, match="enter the API key again"):
        own_model.save("ben", "https://other.example/v1", "m", None)


def test_address_rules_apply():
    with pytest.raises(ValueError, match="https"):
        own_model.save("ben", "http://evil.example/v1", "m", "k")


def test_remove_and_account_deletion():
    own_model.save("ben", URL, "claude-x", "k-ben")
    own_model.remove("ben")
    assert own_model.view("ben") == {"set": False}
    own_model.save("ellen", URL, "claude-x", "k-ellen")
    auth.delete_user("ellen")
    assert own_model.view("ellen") == {"set": False}
