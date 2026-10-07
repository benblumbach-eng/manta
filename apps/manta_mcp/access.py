from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass

PUBLIC = "public"
INTERNAL = "internal"
VISIBILITIES = (PUBLIC, INTERNAL)
DEFAULT_VISIBILITY = INTERNAL


@dataclass(frozen=True)
class Scope:
    can_see_internal: bool = False
    username: str | None = None


ANONYMOUS = Scope(can_see_internal=False, username=None)

_scope: ContextVar[Scope] = ContextVar("manta_scope", default=ANONYMOUS)


def set_scope(scope: Scope):
    return _scope.set(scope)


def reset_scope(token) -> None:
    _scope.reset(token)


def current() -> Scope:
    return _scope.get()


def cypher_condition(alias: str = "d") -> str:
    if current().can_see_internal:
        return "true"
    return f"coalesce({alias}.visibility, '{DEFAULT_VISIBILITY}') = '{PUBLIC}'"


def is_visible(visibility: str | None) -> bool:
    return (visibility or DEFAULT_VISIBILITY) == PUBLIC or current().can_see_internal


def normalise(visibility: str | None) -> str:
    v = (visibility or "").strip().lower()
    return v if v in VISIBILITIES else DEFAULT_VISIBILITY
