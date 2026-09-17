from __future__ import annotations

import asyncio
import contextlib
import io
import traceback

from mcp.server.mcpserver import MCPServer

app = MCPServer(
    name="stats",
    version="0.1.0",
    instructions=(
        "Fuehrt Python aus; numpy (np), pandas (pd), scipy.stats (stats) und statsmodels.api (sm) "
        "sind geladen. Variablen bleiben zwischen Aufrufen erhalten. Was hier herauskommt, hat "
        "keinen Herkunftszettel — es ist eine Rechnung des Modells, kein MANTA-Ergebnis. "
        "Eingabezahlen zuerst mit den MANTA-Werkzeugen holen und im Code wortgleich uebernehmen."
    ),
)

_NS: dict = {}


def _init() -> None:
    import numpy as np
    import pandas as pd
    import statsmodels.api as sm
    from scipy import stats
    _NS.update(np=np, pd=pd, stats=stats, sm=sm)


def run_python(code: str) -> str:
    if not _NS:
        _init()
    out = io.StringIO()
    lines = code.rstrip().split("\n")
    try:
        last = compile(lines[-1], "<stats>", "eval")
    except SyntaxError:
        last = None
    try:
        with contextlib.redirect_stdout(out):
            if last is None:
                exec(compile(code, "<stats>", "exec"), _NS)
            else:
                exec(compile("\n".join(lines[:-1]), "<stats>", "exec"), _NS)
                value = eval(last, _NS)
                if value is not None:
                    print(repr(value))
    except Exception:
        out.write(traceback.format_exc())
    text = out.getvalue()
    return text if text.strip() else "(keine Ausgabe)"


app.add_tool(run_python, name="run_python", description=run_python.__doc__)


if __name__ == "__main__":
    asyncio.run(app.run_stdio_async())
