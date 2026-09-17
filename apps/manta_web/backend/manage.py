#!/usr/bin/env python3
from __future__ import annotations

import argparse
import getpass
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "manta_mcp"))

import access
import auth


def _ask_password() -> str:
    a = getpass.getpass("Passwort: ")
    b = getpass.getpass("Wiederholen: ")
    if a != b:
        sys.exit("Die Passwoerter stimmen nicht ueberein.")
    if len(a) < auth.MIN_PASSWORD_LEN:
        sys.exit(f"Mindestens {auth.MIN_PASSWORD_LEN} Zeichen.")
    return a


def _driver():
    from neo4j import GraphDatabase
    pw = os.environ.get("NEO4J_PASSWORD", "")
    if not pw:
        sys.exit("NEO4J_PASSWORD ist nicht gesetzt.")
    return GraphDatabase.driver(os.environ.get("NEO4J_URI", "bolt://localhost:7687"),
                                auth=(os.environ.get("NEO4J_USER", "neo4j"), pw))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("adduser"); p.add_argument("username"); p.add_argument("--role", default="viewer", choices=auth.ROLES)
    sub.add_parser("list")
    p = sub.add_parser("passwd"); p.add_argument("username")
    p = sub.add_parser("disable"); p.add_argument("username")
    p = sub.add_parser("enable"); p.add_argument("username")
    p = sub.add_parser("revoke"); p.add_argument("username")
    p = sub.add_parser("deluser"); p.add_argument("username")
    sub.add_parser("visibility")
    sub.add_parser("migrate-visibility")
    a = ap.parse_args()

    try:
        if a.cmd == "adduser":
            u = auth.create_user(a.username, _ask_password(), a.role)
            print(f"angelegt: {u.username} ({u.role})  ->  {auth.DB_PATH}")
        elif a.cmd == "list":
            rows = auth.list_users()
            if not rows:
                print("noch keine Konten. Erstes anlegen: manage.py adduser <name> --role admin")
            for r in rows:
                zustand = "gesperrt" if r["disabled"] else "aktiv"
                print(f"{r['username']:20} {r['role']:8} {zustand:9} Sitzungen: {r['sessions']}")
        elif a.cmd == "passwd":
            auth.set_password(a.username, _ask_password())
            print(f"Passwort geaendert; alle Sitzungen von {a.username} beendet.")
        elif a.cmd in ("disable", "enable"):
            auth.set_disabled(a.username, a.cmd == "disable")
            print(f"{a.username}: {'gesperrt' if a.cmd=='disable' else 'aktiv'}")
        elif a.cmd == "revoke":
            print(f"{auth.revoke_all(a.username)} Sitzung(en) beendet.")
        elif a.cmd == "deluser":
            auth.delete_user(a.username)
            print(f"geloescht: {a.username}")
        elif a.cmd == "visibility":
            with _driver() as dr, dr.session() as s:
                for r in s.run("MATCH (d:Dataset) RETURN d.dataset_id AS id, "
                               "coalesce(d.visibility,'(fehlt)') AS v ORDER BY id"):
                    print(f"{r['id']:28} {r['v']}")
        elif a.cmd == "migrate-visibility":
            with _driver() as dr, dr.session() as s:
                n = s.run("MATCH (d:Dataset) WHERE d.visibility IS NULL "
                          f"SET d.visibility='{access.DEFAULT_VISIBILITY}' "
                          "RETURN count(d) AS n").single()["n"]
            print(f"{n} Datensatz/Datensaetze auf '{access.DEFAULT_VISIBILITY}' gesetzt.")
    except ValueError as e:
        sys.exit(str(e))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
