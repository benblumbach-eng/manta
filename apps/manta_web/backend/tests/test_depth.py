from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

sys.path[:0] = [str(Path(__file__).resolve().parent.parent)]

import app  # noqa: E402


@pytest.mark.parametrize("f,t", [(None, None), (20, None), (20, 23), (20, 20), (0, None)])
def test_depth_accepted(f, t):
    app._check_depth(f, t)


@pytest.mark.parametrize("f,t", [(None, 23), (23, 20), (-1, None)])
def test_depth_rejected(f, t):
    with pytest.raises(HTTPException):
        app._check_depth(f, t)
