import { useEffect, useMemo, useRef, useState } from "react";
import { getAsv, getNetwork, type ClimMonth, type Frequency, type Network } from "../api";
import InfoTip from "./InfoTip";
import ProvenanceFooter from "./ProvenanceFooter";


const LINE_COLORS = ["#22d3ee", "#fbbf24", "#f472b6", "#4ade80", "#a78bfa", "#fb923c"];
const MAX_CURVES = LINE_COLORS.length;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Curve = { id: string; genus: string | null; freq: Frequency };

export default function ComparePanel({ datasetId, initialAsvId, onClose, onOpenAsv }: {
  datasetId: string;
  initialAsvId?: string;
  onClose: () => void;
  onOpenAsv: (id: string) => void;
}) {
  const [net, setNet] = useState<Network | null>(null);
  const [curves, setCurves] = useState<Curve[]>([]);
  const [search, setSearch] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [scaled, setScaled] = useState(false);

  useEffect(() => {
    setNet(null); setCurves([]); setErr(null);
    getNetwork(datasetId, "con").then(setNet).catch((e) => setErr(String(e)));
  }, [datasetId]);

  const timeAxisIsDates = curves.length === 0 || curves[0].freq.time_axis === "dates";

  const candidates = useMemo(() => {
    if (!net || !search.trim()) return [];
    const q = search.trim().toLowerCase();
    const chosen = new Set(curves.map((c) => c.id));
    return net.nodes
      .filter((n) => !chosen.has(n.id)
        && (n.id.toLowerCase().includes(q) || (n.genus ?? "").toLowerCase().includes(q)))
      .slice(0, 8);
  }, [net, search, curves]);

  const add = (id: string) => {
    if (curves.length >= MAX_CURVES) return;
    setSearch("");
    getAsv(datasetId, id)
      .then((d) => setCurves((cur) => cur.some((c) => c.id === id) ? cur
        : [...cur, { id, genus: d.lineage?.genus ?? null, freq: d.frequency }]))
      .catch((e) => setErr(String(e)));
  };

  const seeded = useRef<string | null>(null);
  useEffect(() => {
    if (!initialAsvId) return;
    const key = `${datasetId}|${initialAsvId}`;
    if (seeded.current === key) return;
    seeded.current = key;
    add(initialAsvId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId, initialAsvId]);

  const W = 460, H = 220, PAD_L = 44, PAD_R = 8, PAD_T = 10, PAD_B = 24;
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;

  const series = useMemo(() => curves.map((c, i) => {
    const clim: ClimMonth[] = c.freq.seasonal?.climatology ?? [];
    const own = clim.map((m) => m.mean).filter((v): v is number => v != null);
    const ownMax = own.length ? Math.max(...own) : 0;
    return {
      ...c,
      color: LINE_COLORS[i % LINE_COLORS.length],
      points: clim.map((m) => ({
        month: m.month, n: m.n,
        value: m.mean == null ? null
          : scaled ? (ownMax > 0 ? m.mean / ownMax : null) : m.mean,
      })),
    };
  }), [curves, scaled]);

  const yMax = useMemo(() => {
    const vals = series.flatMap((s) => s.points.map((p) => p.value).filter((v): v is number => v != null));
    return vals.length ? Math.max(...vals) : 1;
  }, [series]);

  const X = (month: number) => PAD_L + ((month - 1) / 11) * plotW;
  const Y = (v: number) => PAD_T + plotH - (yMax > 0 ? (v / yMax) * plotH : 0);

  const path = (pts: { month: number; value: number | null }[]) => {
    let d = "", pen = false;
    for (const p of pts) {
      if (p.value == null) { pen = false; continue; }
      d += `${pen ? "L" : "M"} ${X(p.month).toFixed(1)} ${Y(p.value).toFixed(1)} `;
      pen = true;
    }
    return d.trim();
  };

  return (
    <div className="h-full overflow-auto"
      data-testid="compare-panel">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-700 sticky top-0 bg-slate-900 z-10">
        <h2 className="text-slate-100 font-medium text-sm flex items-center">
          Seasonal comparison
          <InfoTip title="What is being compared">
            <p>Each line is the <strong>average year</strong> of one ASV — the same climatology
            its detail page shows: all years folded onto the calendar and averaged, one point per
            month. Nothing new is computed here; the curves are only drawn together.</p>
            <p>Shares, not cell counts — a share can rise because others declined. Months without
            coverage stay gaps.</p>
          </InfoTip>
        </h2>
        <button onClick={onClose} aria-label="Close" data-testid="compare-close"
          className="text-slate-400 hover:text-white">✕</button>
      </div>

      <div className="p-4 text-xs text-slate-300 space-y-3">
        {err && <div className="text-red-300">{err}</div>}

        {!timeAxisIsDates ? (
          <p className="text-slate-400" data-testid="compare-no-dates">
            This dataset has no calendar dates — the samples are ordered, not dated. An average
            year would place its months into a calendar nobody measured, so there is nothing to
            compare seasonally.
          </p>
        ) : (
          <>
            <div>
              <input data-testid="compare-search" value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={curves.length >= MAX_CURVES
                  ? `at most ${MAX_CURVES} curves`
                  : "add an ASV — id or genus …"}
                disabled={curves.length >= MAX_CURVES}
                className="w-full px-2 py-1 rounded bg-slate-800 border border-slate-600 text-slate-100" />
              {candidates.length > 0 && (
                <ul className="mt-1 rounded border border-slate-700 bg-slate-950/70">
                  {candidates.map((n) => (
                    <li key={n.id}>
                      <button data-testid="compare-candidate" onClick={() => add(n.id)}
                        className="w-full text-left px-2 py-1 hover:bg-slate-800">
                        <span className="font-mono text-cyan-300">{n.id}</span>
                        {n.genus && <span className="text-slate-500"> ({n.genus})</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {curves.length > 0 && (
              <div className="flex flex-wrap gap-1.5" data-testid="compare-legend">
                {series.map((s) => (
                  <span key={s.id}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-slate-700">
                    <span className="inline-block w-3 h-0.5" style={{ background: s.color }} />
                    <button onClick={() => onOpenAsv(s.id)}
                      className="font-mono text-cyan-300 hover:underline">{s.id}</button>
                    {s.genus && <span className="text-slate-500">({s.genus})</span>}
                    <button aria-label={`remove ${s.id}`} data-testid="compare-remove"
                      onClick={() => setCurves((cur) => cur.filter((c) => c.id !== s.id))}
                      className="text-slate-500 hover:text-white">✕</button>
                  </span>
                ))}
              </div>
            )}

            {curves.length === 0 && (
              <p className="text-slate-500">
                Add two or more ASVs to lay their average years over each other.
              </p>
            )}

            {curves.length > 0 && (
              <>
                <svg width={W} height={H} data-testid="compare-chart" role="img"
                  aria-label="average-year curves of the selected ASVs">
                  <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={PAD_T + plotH} stroke="#334155" />
                  <line x1={PAD_L} y1={PAD_T + plotH} x2={PAD_L + plotW} y2={PAD_T + plotH} stroke="#334155" />
                  <text x={PAD_L - 4} y={PAD_T + 8} textAnchor="end" fill="#64748b" fontSize="9">
                    {scaled ? "100 %" : `${(100 * yMax).toFixed(2)} %`}
                  </text>
                  <text x={PAD_L - 4} y={PAD_T + plotH} textAnchor="end" fill="#64748b" fontSize="9">0</text>
                  {MONTHS.map((m, i) => (
                    <text key={m} x={X(i + 1)} y={H - 8} textAnchor="middle" fill="#64748b" fontSize="9">
                      {m[0]}
                    </text>
                  ))}
                  {series.map((s) => (
                    <g key={s.id}>
                      <path d={path(s.points)} fill="none" stroke={s.color} strokeWidth="1.5" />
                      {s.points.map((p) => p.value != null && (
                        <circle key={p.month} cx={X(p.month)} cy={Y(p.value)} r="2" fill={s.color}>
                          <title>{`${s.id} · ${MONTHS[p.month - 1]}: ${
                            scaled ? `${(100 * p.value).toFixed(0)} % of its own peak`
                                   : `${(100 * p.value).toFixed(3)} %`} · ${p.n} sample${p.n === 1 ? "" : "s"}`}</title>
                        </circle>
                      ))}
                    </g>
                  ))}
                </svg>

                <label className="flex items-center gap-2 text-slate-400">
                  <input type="checkbox" data-testid="compare-scaled" checked={scaled}
                    onChange={(e) => setScaled(e.target.checked)} />
                  scale each curve to its own peak (compare the pattern, discard the magnitude)
                </label>
                <p className="text-[10px] text-slate-500" data-testid="compare-caveat">
                  {scaled
                    ? "Each curve is divided by its own annual maximum — the shapes are comparable, the magnitudes deliberately are not."
                    : "Mean share per calendar month, all years folded together. Shares, not cell counts — a share can rise because others declined."}
                </p>
              </>
            )}
          </>
        )}
        <ProvenanceFooter datasetId={datasetId} />
      </div>
    </div>
  );
}
