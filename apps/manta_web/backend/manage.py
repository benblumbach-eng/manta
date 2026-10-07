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


DESCRIPTION = """MANTA accounts from the command line.

The first administrator cannot be created in the interface (that would need a sign-in), so it
is created here. Everything else works in the browser as well.

    python manage.py adduser alice --role admin
    python manage.py list
    python manage.py passwd alice
    python manage.py disable alice  /  enable alice
    python manage.py revoke alice
    python manage.py deluser alice
    python manage.py visibility            # show the visibility of every dataset
    python manage.py migrate-visibility    # set missing visibility to 'internal'

Passwords are asked for interactively (twice), never passed as an argument: arguments end up
in the shell history and in the process list."""


def _ask_password() -> str:
    try:
        a = getpass.getpass("Password: ")
        b = getpass.getpass("Repeat password: ")
    except EOFError:
        sys.exit("No password entered. Run this command in an interactive terminal.")
    if a != b:
        sys.exit("The passwords do not match.")
    if len(a) < auth.MIN_PASSWORD_LEN:
        sys.exit(f"The password must have at least {auth.MIN_PASSWORD_LEN} characters.")
    return a


def _driver():
    from neo4j import GraphDatabase
    pw = os.environ.get("NEO4J_PASSWORD", "")
    if not pw:
        sys.exit("NEO4J_PASSWORD is not set.")
    return GraphDatabase.driver(os.environ.get("NEO4J_URI", "bolt://localhost:7687"),
                                auth=(os.environ.get("NEO4J_USER", "neo4j"), pw),
                                notifications_disabled_categories=["UNRECOGNIZED", "DEPRECATION"])


def main() -> int:
    ap = argparse.ArgumentParser(description=DESCRIPTION,
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
            print(f"created: {u.username} ({u.role})  ->  {auth.DB_PATH}")
        elif a.cmd == "list":
            rows = auth.list_users()
            if not rows:
                print("no accounts yet. Create the first one with: manage.py adduser <name> --role admin")
            for r in rows:
                state = "disabled" if r["disabled"] else "active"
                print(f"{r['username']:20} {r['role']:8} {state:9} sessions: {r['sessions']}")
        elif a.cmd == "passwd":
            auth.set_password(a.username, _ask_password())
            print(f"password changed; all sessions of {a.username} ended.")
        elif a.cmd in ("disable", "enable"):
            auth.set_disabled(a.username, a.cmd == "disable")
            print(f"{a.username}: {'disabled' if a.cmd=='disable' else 'active'}")
        elif a.cmd == "revoke":
            print(f"{auth.revoke_all(a.username)} session(s) ended.")
        elif a.cmd == "deluser":
            auth.delete_user(a.username)
            print(f"deleted: {a.username}")
        elif a.cmd == "visibility":
            with _driver() as dr, dr.session() as s:
                for r in s.run("MATCH (d:Dataset) RETURN d.dataset_id AS id, "
                               "coalesce(d.visibility,'(missing)') AS v ORDER BY id"):
                    print(f"{r['id']:28} {r['v']}")
        elif a.cmd == "migrate-visibility":
            with _driver() as dr, dr.session() as s:
                n = s.run("MATCH (d:Dataset) WHERE d.visibility IS NULL "
                          f"SET d.visibility='{access.DEFAULT_VISIBILITY}' "
                          "RETURN count(d) AS n").single()["n"]
            print(f"{n} dataset(s) set to '{access.DEFAULT_VISIBILITY}'.")
    except ValueError as e:
        sys.exit(str(e))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
