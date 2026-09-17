import { useEffect, useMemo, useState } from "react";
import { getWheel, type Wheel } from "../api";
import { useModules } from "../modules";
import ProvenanceFooter from "./ProvenanceFooter";
import ModulesOverTime from "./ModulesOverTime";

export default function WheelPanel({ datasetId, onClose, onOpenCluster }: {
  datasetId: string; onClose: () => void; onOpenCluster: (label: number) => void;
}) {
  const [w, setW] = useState<Wheel | null>(null);
  const modules = useModules();
  const [err, setErr] = useState<string | null>(null);
  const [envKey, setEnvKey] = useState<string | null>("temp");
  const [year, setYear] = useState<string | null>(null);
  useEffect(() => { setYear(null); }, [datasetId]);
  const [hover, setHover] = useState<number | null>(null);
  const [held, setHeld] = useState<number | null>(null);
  const front = held ?? hover;
  const setFront = setHover;
  const hold = (l: number) => setHeld((h) => (h === l ? null : l));
  useEffect(() => { setHover(null); setHeld(null); }, [datasetId]);

  useEffect(() => {
    setW(null); setErr(null);
    getWheel(datasetId, year).then(setW).catch((e) => setErr(String(e)));
  }, [datasetId, year]);

  const envVars = w?.environment?.variables ?? [];
  const activeEnv = envVars.find((v) => v.key === envKey) ?? null;
  const monthly = (activeEnv && w?.environment?.monthly[activeEnv.key]) || null;

  const CX = 220, CY = 220;
  const R_LABEL = 200;
  const R_ENV_MAX = 186, R_ENV_MIN = 160;
  const R_CLUSTER_MAX = 148, R_CLUSTER_MIN = 56;
  const monthStart = (m: number) => (-90 + (m - 1) * 30) * (Math.PI / 180);
  const monthCenter = (m: number) => (-90 + (m - 1) * 30 + 15) * (Math.PI / 180);
  const P = (r: number, a: number) => [CX + r * Math.cos(a), CY + r * Math.sin(a)] as const;

  const arcPath = (r: number, mFirst: number, nMonths: number) => {
    const a0 = monthStart(mFirst);
    const a1 = a0 + nMonths * 30 * (Math.PI / 180);
    const [x0, y0] = P(r, a0);
    const [x1, y1] = P(r, a1);
    return `M ${x0} ${y0} A ${r} ${r} 0 ${nMonths * 30 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
  };

  const clusters = w?.clusters ?? [];
  const ringStep = clusters.length
    ? (R_CLUSTER_MAX - R_CLUSTER_MIN) / Math.max(clusters.length - 1, 1) : 0;
  const ringR = (i: number) =>
    clusters.length === 1 ? (R_CLUSTER_MAX + R_CLUSTER_MIN) / 2 : R_CLUSTER_MIN + i * ringStep;

  const envGeo = useMemo(() => {
    if (!monthly) return null;
    const vals = monthly.filter((p) => p.mean != null) as { month: number; mean: number; n: number }[];
    if (!vals.length) return null;
    const lo = Math.min(...vals.map((p) => p.mean));
    const hi = Math.max(...vals.map((p) => p.mean));
    const rOf = (v: number) =>
      hi === lo ? (R_ENV_MIN + R_ENV_MAX) / 2 : R_ENV_MIN + ((v - lo) / (hi - lo)) * (R_ENV_MAX - R_ENV_MIN);
    const pts = new Map(vals.map((p) => [p.month, { ...p, xy: P(rOf(p.mean), monthCenter(p.month)) }]));
    const segs: [readonly [number, number], readonly [number, number]][] = [];
    for (let m = 1; m <= 12; m++) {
      const a = pts.get(m), b = pts.get((m % 12) + 1);
      if (a && b) segs.push([a.xy, b.xy]);
    }
    return { pts: [...pts.values()], segs, lo, hi };
  }, [monthly]);

  const modulesBlock = w ? (
    <div className="pt-1" data-testid="wheel-modules-over-time">
      <ModulesOverTime datasetId={datasetId} label={front} onFront={setFront} onHold={hold}
        order={clusters.map((c) => c.louvain_label)} />
    </div>
  ) : null;

  return (
    <div className="h-full overflow-auto" data-testid="wheel-panel">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-700 sticky top-0 bg-slate-900 z-10">
        <span className="text-slate-100 font-medium flex items-center">
          The year wheel

        </span>
        <button onClick={onClose} data-testid="wheel-close" aria-label="Close" className="text-slate-400 hover:text-white">✕</button>
      </div>

      {err && <div className="p-4 text-red-300" data-testid="error">{err}</div>}
      {!w && !err && <div className="p-4 text-slate-500">loading …</div>}

      {w?.absent_reason && (
        <div className="p-4 pb-0">
          <p className="text-sm text-amber-400/90" data-testid="wheel-absent">{w.absent_reason}</p>
        </div>
      )}

      {w && !w.absent_reason && (
        <div className="p-4 space-y-3 text-sm">

          {(w.years?.length ?? 0) > 0 && (
            <div className="flex flex-wrap items-center gap-1 text-xs" data-testid="wheel-year-select">
              <span className="text-slate-500 mr-1">year</span>
              <button data-testid="wheel-year-avg" onClick={() => setYear(null)}
                className={`px-2 py-0.5 rounded border ${year == null
                  ? "border-cyan-400 text-cyan-300"
                  : "border-slate-700 text-slate-400 hover:border-slate-500"}`}>
                average year
              </button>
              {w.years!.map((y) => (
                <button key={y.year} data-testid={`wheel-year-${y.year}`}
                  title={y.note ?? `${y.n} samples · all 12 months`}
                  onClick={() => setYear(y.year)}
                  className={`px-2 py-0.5 rounded border ${year === y.year
                    ? "border-cyan-400 text-cyan-300"
                    : "border-slate-700 text-slate-400 hover:border-slate-500"}`}>
                  {y.year}{y.note ? "*" : ""}
                </button>
              ))}
            </div>
          )}
          {w.year?.note && (
            <p className="text-[10px] text-amber-400" data-testid="wheel-year-note">
              {w.year.year}: {w.year.note} — windows rest on this year&rsquo;s {w.year.n} samples only.
            </p>
          )}

          {envVars.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 text-xs" data-testid="wheel-env-select">
              <span className="text-slate-500 mr-1">outer band</span>
              {envVars.map((v) => (
                <button key={v.key} data-testid={`wheel-env-${v.key}`}
                  onClick={() => setEnvKey(v.key)}
                  className={`px-2 py-0.5 rounded border ${envKey === v.key
                    ? "border-cyan-400 text-cyan-300"
                    : "border-slate-700 text-slate-400 hover:border-slate-500"}`}>
                  {v.key}
                </button>
              ))}
              <button data-testid="wheel-env-none" onClick={() => setEnvKey(null)}
                className={`px-2 py-0.5 rounded border ${envKey === null
                  ? "border-cyan-400 text-cyan-300"
                  : "border-slate-700 text-slate-400 hover:border-slate-500"}`}>
                none
              </button>
            </div>
          )}

          <svg viewBox="0 0 440 440" className="w-full" data-testid="wheel-svg">
            {w.months.map((name, i) => {
              const [tx, ty] = P(R_LABEL, monthCenter(i + 1));
              const [gx0, gy0] = P(R_CLUSTER_MIN - 8, monthStart(i + 1));
              const [gx1, gy1] = P(R_ENV_MAX + 4, monthStart(i + 1));
              return (
                <g key={name}>
                  <line x1={gx0} y1={gy0} x2={gx1} y2={gy1} stroke="#1e293b" strokeWidth={1} />
                  <text x={tx} y={ty} fill="#64748b" fontSize={11} textAnchor="middle"
                        dominantBaseline="middle">{name}</text>
                </g>
              );
            })}

            {envGeo && activeEnv && (
              <g data-testid="wheel-env-band">
                {envGeo.segs.map(([a, b], i) => (
                  <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]}
                        stroke="#34d399" strokeWidth={1.5} strokeDasharray="4 3" opacity={0.8} />
                ))}
                {envGeo.pts.map((p) => (
                  <circle key={p.month} cx={p.xy[0]} cy={p.xy[1]} r={2.5} fill="#34d399">
                    <title>{`${activeEnv.label}, ${w.months[p.month - 1]}: mean ${p.mean.toFixed(2)}${activeEnv.unit ? ` ${activeEnv.unit}` : ""} (n=${p.n})`}</title>
                  </circle>
                ))}
              </g>
            )}

            {clusters.map((c, i) => {
              const r = ringR(i);
              const col = modules.color(c.louvain_label);
              const title = `Cluster ${c.louvain_label} · ${c.statement ?? "no window"} · ${c.n_members} ASVs`;
              return (
                <g key={c.louvain_label} data-testid={`wheel-arc-${c.louvain_label}`}
                   className="cursor-pointer"
                   onClick={() => { hold(c.louvain_label); onOpenCluster(c.louvain_label); }}
                   onMouseEnter={() => setFront(c.louvain_label)}>
                  <circle cx={CX} cy={CY} r={r} fill="none" stroke={col} strokeWidth={1} opacity={0.14} />
                  {c.window_months.length > 0 && c.window_months.length < 12 && (
                    <path d={arcPath(r, c.window_months[0], c.window_months.length)}
                          fill="none" stroke={col} strokeWidth={Math.min(ringStep * 0.6, 9)}
                          strokeLinecap="round" opacity={0.9} />
                  )}
                  {c.window_months.length >= 12 && (
                    <circle cx={CX} cy={CY} r={r} fill="none" stroke={col}
                            strokeWidth={Math.min(ringStep * 0.6, 9)} opacity={0.9} />
                  )}
                  {c.peak_month != null && (() => {
                    const [px, py] = P(r, monthCenter(c.peak_month));
                    return <circle cx={px} cy={py} r={4} fill={col} stroke="#0f172a" strokeWidth={1.5} />;
                  })()}
                  <title>{title}</title>
                </g>
              );
            })}
          </svg>

          {modulesBlock}

          {activeEnv && envGeo && (
            <p className="text-[11px] text-slate-400 tabular-nums" data-testid="wheel-env-caption">
              {activeEnv.label}: monthly mean {w.year ? `of ${w.year.year}` : "over all years"},
              {" "}{envGeo.lo.toFixed(2)}–{envGeo.hi.toFixed(2)}
              {activeEnv.unit ? ` ${activeEnv.unit}` : ""} (inner–outer edge of the band).
              {activeEnv.unit_note && (
                <span className="text-slate-500"> — {activeEnv.unit_note}</span>
              )}
            </p>
          )}
          {activeEnv && envGeo && (
            <p className="text-[10px] text-slate-500" data-testid="wheel-env-declaration">
              Context only — no correlation is computed. Gaps stay gaps.
            </p>
          )}

          <div className="space-y-1" data-testid="wheel-list">
            {clusters.map((c) => (
              <button key={c.louvain_label} data-testid={`wheel-row-${c.louvain_label}`}
                onClick={() => { hold(c.louvain_label); onOpenCluster(c.louvain_label); }}
                onMouseEnter={() => setFront(c.louvain_label)}
                aria-pressed={held === c.louvain_label}
                className={`w-full flex items-center gap-2 text-left px-2 py-1 rounded hover:bg-slate-800 ${held === c.louvain_label ? "bg-slate-800 ring-1 ring-slate-500" : ""}`}>
                <span className="inline-block w-3 h-3 rounded-sm shrink-0"
                      style={{ background: modules.color(c.louvain_label) }} />
                <span className="text-slate-200 shrink-0">{modules.label(c.louvain_label)}</span>
                <span className="text-slate-400 text-xs flex-1">
                  {c.window.length
                    ? `${c.window[0]}–${c.window[c.window.length - 1]}` + (c.peak ? ` · peak ${c.peak}` : "")
                    : "no window above its own annual mean"}
                </span>
                <span className="text-slate-500 text-xs tabular-nums shrink-0">{c.n_members} ASVs</span>
              </button>
            ))}
          </div>

          <p className="flex items-center text-[10px] text-slate-500" data-testid="wheel-windows-note">
            <span data-testid="wheel-windows-definition">Shares, not cell counts — a window is the months
            above the module&rsquo;s own annual mean; the dot is its strongest month.</span>
          </p>
        </div>
      )}

      {w?.absent_reason && modulesBlock}

      {w && (
        <div className="p-4 pt-2 space-y-2 text-sm border-t border-slate-800" data-testid="wheel-pairs">
          <h3 className="text-slate-300 font-medium flex items-center">
            Transitions between communities

          </h3>
          {w.pairs.length === 0 ? (
            <p className="text-xs text-slate-400" data-testid="wheel-pairs-empty">
              No link crosses a cluster border — the clusters are unconnected parts.
            </p>
          ) : (
            <div className="space-y-1">
              {w.pairs.map((p) => (
                <div key={`${p.ca}-${p.cb}`} data-testid={`wheel-pair-${p.ca}-${p.cb}`}
                  className="flex items-center gap-2 px-2 py-1 rounded bg-slate-950/40">
                  <span className="inline-block w-3 h-3 rounded-sm shrink-0"
                        style={{ background: modules.color(p.ca) }} />
                  <button className="text-slate-200 hover:underline shrink-0"
                          onClick={() => onOpenCluster(p.ca)}>C{p.ca}</button>
                  <span className="text-slate-500 shrink-0">↔</span>
                  <span className="inline-block w-3 h-3 rounded-sm shrink-0"
                        style={{ background: modules.color(p.cb) }} />
                  <button className="text-slate-200 hover:underline shrink-0"
                          onClick={() => onOpenCluster(p.cb)}>C{p.cb}</button>
                  <span className="text-xs text-slate-400 flex-1 text-right tabular-nums">
                    {p.n_con} link{p.n_con === 1 ? "" : "s"} · {p.n_with_ccm} with direction
                    {p.mean_nmi != null && <> · mean NMI {p.mean_nmi.toFixed(2)}</>}
                  </span>
                  {p.n_with_ccm === 0 && (
                    <span className="text-[10px] text-amber-400/90 shrink-0"
                          data-testid="wheel-pair-reset">
                      no measurable direction
                    </span>
                  )}
                </div>
              ))}
              <p className="text-[10px] text-slate-500">
                Links are co-occurrences (similar temporal pattern, not interaction); a direction
                is a pruned CCM annotation. Pairs sorted by how strongly they are connected.
              </p>
            </div>
          )}
          <ProvenanceFooter datasetId={datasetId} />
        </div>
      )}
    </div>
  );
}
