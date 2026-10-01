import { useEffect, useMemo, useRef, useState } from "react";
import { getAsv, getCluster, getEnvironment, getModules, getNetwork,
         type Environment, type ModuleLabel, type Network } from "../api";
import { Chooser, ChooserRow, Segmented } from "./controls";
import InfoTip from "./InfoTip";
import ProvenanceFooter from "./ProvenanceFooter";


const LINE_COLORS = ["#22d3ee", "#fbbf24", "#f472b6", "#4ade80", "#a78bfa", "#fb923c"];
const MAX_CURVES = LINE_COLORS.length;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const SHARE_UNIT = "share of the analysed values of one sample";

type Kind = "asv" | "cluster" | "env";
type Punkt = { t: number; date: string; value: number | null };
type Curve = {
  key: string; kind: Kind; id: string; label: string; sub: string | null;
  unit: string; scale: "ratio" | "interval";
  share: boolean;
  points: Punkt[];
};
type Mode = "absolute" | "peak" | "range";

const ausPunkten = (rohe: { date: string | null; value: number | null }[]): Punkt[] =>
  rohe
    .filter((p): p is { date: string; value: number | null } => !!p.date)
    .map((p) => ({ t: Date.parse(p.date), date: p.date, value: p.value }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);

export default function ComparePanel({ datasetId, initialAsvId, onClose, onOpenAsv }: {
  datasetId: string;
  initialAsvId?: string;
  onClose: () => void;
  onOpenAsv: (id: string) => void;
}) {
  const [net, setNet] = useState<Network | null>(null);
  const [env, setEnv] = useState<Environment | null>(null);
  const [modules, setModules] = useState<ModuleLabel[]>([]);
  const [curves, setCurves] = useState<Curve[]>([]);
  const [search, setSearch] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("absolute");
  const [zeitraum, setZeitraum] = useState<string>("total");

  useEffect(() => {
    setNet(null); setCurves([]); setErr(null); setEnv(null); setModules([]);
    getNetwork(datasetId, "con").then(setNet).catch((e) => setErr(String(e)));
    getEnvironment(datasetId).then(setEnv).catch(() => setEnv(null));
    getModules(datasetId).then((m) => setModules(m.modules)).catch(() => setModules([]));
  }, [datasetId]);

  const timeAxisIsDates = env ? env.time_axis === "dates" : true;

  const chosen = useMemo(() => new Set(curves.map((c) => c.key)), [curves]);

  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [] as { key: string; kind: Kind; id: string; label: string; sub: string | null }[];
    const treffer: { key: string; kind: Kind; id: string; label: string; sub: string | null }[] = [];
    for (const v of env?.variables ?? []) {
      if (v.label.toLowerCase().includes(q) || v.key.toLowerCase().includes(q)) {
        treffer.push({ key: `env:${v.key}`, kind: "env", id: v.key, label: v.label,
                       sub: v.unit });
      }
    }
    for (const m of modules) {
      const name = m.display || `module ${m.louvain_label}`;
      if (name.toLowerCase().includes(q) || String(m.louvain_label) === q
          || `module ${m.louvain_label}`.includes(q)) {
        treffer.push({ key: `cluster:${m.louvain_label}`, kind: "cluster",
                       id: String(m.louvain_label), label: name, sub: "collective curve" });
      }
    }
    for (const n of net?.nodes ?? []) {
      if (n.id.toLowerCase().includes(q) || (n.genus ?? "").toLowerCase().includes(q)) {
        treffer.push({ key: `asv:${n.id}`, kind: "asv", id: n.id, label: n.id, sub: n.genus });
      }
    }
    return treffer.filter((t) => !chosen.has(t.key)).slice(0, 8);
  }, [net, env, modules, search, chosen]);

  const add = (kind: Kind, id: string) => {
    const key = `${kind}:${id}`;
    if (curves.length >= MAX_CURVES || chosen.has(key)) return;
    setSearch("");
    const anfuegen = (c: Curve) =>
      setCurves((cur) => cur.some((x) => x.key === c.key) ? cur : [...cur, c]);

    if (kind === "asv") {
      getAsv(datasetId, id).then((d) => anfuegen({
        key, kind, id, label: id, sub: d.lineage?.genus ?? null,
        unit: d.frequency.quantity?.unit ?? SHARE_UNIT, scale: "ratio", share: true,
        points: ausPunkten(d.frequency.points.map((p) => ({ date: p.date, value: p.share }))),
      })).catch((e) => setErr(String(e)));
    } else if (kind === "cluster") {
      getCluster(datasetId, Number(id)).then((d) => anfuegen({
        key, kind, id, label: modules.find((m) => String(m.louvain_label) === id)?.display
                              ?? `module ${id}`,
        sub: "collective curve", unit: d.frequency.quantity?.unit ?? SHARE_UNIT,
        scale: "ratio", share: true,
        points: ausPunkten(d.frequency.points.map((p) => ({ date: p.date, value: p.share }))),
      })).catch((e) => setErr(String(e)));
    } else {
      const v = env?.variables.find((x) => x.key === id);
      if (!v) return;
      anfuegen({
        key, kind, id, label: v.label, sub: v.unit, unit: v.unit ?? "(no unit stated)", share: false,
        scale: v.scale ?? "interval",
        points: ausPunkten(v.points),
      });
    }
  };

  const seeded = useRef<string | null>(null);
  useEffect(() => {
    if (!initialAsvId) return;
    const key = `${datasetId}|${initialAsvId}`;
    if (seeded.current === key) return;
    seeded.current = key;
    add("asv", initialAsvId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId, initialAsvId]);

  const jahre = useMemo(() => {
    const j = new Set<string>();
    for (const c of curves) for (const p of c.points) j.add(p.date.slice(0, 4));
    return [...j].sort();
  }, [curves]);
  useEffect(() => {
    if (zeitraum !== "total" && !jahre.includes(zeitraum)) setZeitraum("total");
  }, [jahre, zeitraum]);

  const einheiten = useMemo(() => new Set(curves.map((c) => c.unit)), [curves]);
  const sameUnit = einheiten.size <= 1;
  const alleMitNull = curves.every((c) => c.scale === "ratio");
  const erlaubt: Record<Mode, string | null> = {
    absolute: sameUnit ? null : "mixed units — one axis would compare unlike things",
    peak: alleMitNull ? null : "°C has no real zero, so a share of its maximum means nothing",
    range: null,
  };
  useEffect(() => {
    if (erlaubt[mode] !== null) setMode("range");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [erlaubt.absolute, erlaubt.peak, mode]);

  const W = 460, H = 220, PAD_L = 52, PAD_R = 8, PAD_T = 10, PAD_B = 24;
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;

  const fenster = useMemo(() => {
    if (zeitraum !== "total") {
      return [Date.parse(`${zeitraum}-01-01T00:00:00Z`),
              Date.parse(`${zeitraum}-12-31T23:59:59Z`)] as const;
    }
    const ts = curves.flatMap((c) => c.points.map((p) => p.t));
    return ts.length ? [Math.min(...ts), Math.max(...ts)] as const : [0, 1] as const;
  }, [curves, zeitraum]);

  const series = useMemo(() => curves.map((c, i) => {
    const drin = c.points.filter((p) => p.t >= fenster[0] && p.t <= fenster[1]);
    const vals = drin.map((p) => p.value).filter((v): v is number => v != null);
    const max = vals.length ? Math.max(...vals) : 0;
    const min = vals.length ? Math.min(...vals) : 0;
    const gezeigt = (v: number) =>
      mode === "absolute" ? v
      : mode === "peak" ? (max > 0 ? v / max : null)
      : (max > min ? (v - min) / (max - min) : null);
    return {
      ...c,
      color: LINE_COLORS[i % LINE_COLORS.length],
      min, max, n: vals.length,
      points: drin.map((p) => ({ ...p, shown: p.value == null ? null : gezeigt(p.value) })),
    };
  }), [curves, mode, fenster]);

  const yMax = useMemo(() => {
    const vals = series.flatMap((s) => s.points.map((p) => p.shown).filter((v): v is number => v != null));
    return vals.length ? Math.max(...vals) : 1;
  }, [series]);
  const yMin = useMemo(() => {
    if (mode !== "absolute") return 0;
    const vals = series.flatMap((s) => s.points.map((p) => p.shown).filter((v): v is number => v != null));
    return vals.length ? Math.min(0, ...vals) : 0;
  }, [series, mode]);

  const X = (t: number) => PAD_L + (fenster[1] > fenster[0]
    ? ((t - fenster[0]) / (fenster[1] - fenster[0])) * plotW : plotW / 2);
  const Y = (v: number) => PAD_T + plotH - (yMax > yMin ? ((v - yMin) / (yMax - yMin)) * plotH : 0);

  const marken = useMemo(() => {
    const raus: { t: number; label: string }[] = [];
    if (zeitraum !== "total") {
      for (let m = 0; m < 12; m++) {
        raus.push({ t: Date.parse(`${zeitraum}-${String(m + 1).padStart(2, "0")}-01T00:00:00Z`),
                    label: MONTHS[m][0] });
      }
      return raus;
    }
    const von = new Date(fenster[0]).getUTCFullYear(), bis = new Date(fenster[1]).getUTCFullYear();
    for (let y = von; y <= bis; y++) {
      const t = Date.parse(`${y}-01-01T00:00:00Z`);
      if (t >= fenster[0] && t <= fenster[1]) raus.push({ t, label: String(y) });
    }
    return raus;
  }, [fenster, zeitraum]);

  const achsenText = (v: number) => {
    if (mode !== "absolute") return `${(100 * v).toFixed(0)} %`;
    return curves.every((c) => c.share) ? `${(100 * v).toFixed(2)} %` : v.toFixed(2);
  };
  const wert = (c: Curve, v: number) =>
    c.share ? `${(100 * v).toFixed(3)} %` : `${v.toFixed(3)}${c.unit ? ` ${c.unit}` : ""}`;

  const path = (pts: { t: number; shown: number | null }[]) => {
    let d = "", pen = false;
    for (const p of pts) {
      if (p.shown == null) { pen = false; continue; }
      d += `${pen ? "L" : "M"} ${X(p.t).toFixed(1)} ${Y(p.shown).toFixed(1)} `;
      pen = true;
    }
    return d.trim();
  };

  const MODE_LABEL: Record<Mode, string> = {
    absolute: "absolute",
    peak: "own peak",
    range: "own range",
  };

  return (
    <div className="h-full overflow-auto"
      data-testid="compare-panel">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-700 sticky top-0 bg-slate-900 z-10">
        <h2 className="text-slate-100 font-medium text-sm flex items-center">
          Comparison
          <InfoTip title="What is being compared">
            <p>Each line is the <strong>measured series</strong> of one thing — an ASV, a whole
            module, or a measured environmental variable. The same points its own page shows,
            each on its real sampling date. Nothing is averaged and nothing new is computed
            here; <em>period</em> only restricts which samples are drawn.</p>
            <p>ASV and module curves are shares, not cell counts — a share can rise because
            others declined. Environmental curves are measured next to the samples.</p>
            <p>No average year is drawn here. Folding several years onto twelve points is a
            computation over the years, not what was measured. A single year shows exactly its
            own samples, with its empty stretches left empty.</p>
            <p>Different units cannot share one axis. The absolute reading is therefore only
            available while every curve carries the same unit; the other two readings rescale
            each curve by itself and say so. Dividing by the peak needs a real zero, which
            degrees Celsius do not have — the scale of each variable is declared in the meaning
            layer, never guessed here. Months without coverage stay gaps.</p>
          </InfoTip>
        </h2>
        <button onClick={onClose} aria-label="Close" data-testid="compare-close"
          className="text-slate-400 hover:text-white">✕</button>
      </div>

      <div className="p-4 text-xs text-slate-300 space-y-3">
        {err && <div className="text-red-300">{err}</div>}

        {!timeAxisIsDates ? (
          <p className="text-slate-400" data-testid="compare-no-dates">
            This dataset has no calendar dates — the samples are ordered, not dated. A common
            time axis would place them on days nobody measured, so there is nothing to lay
            side by side here.
          </p>
        ) : (
          <>
            <div>
              <input data-testid="compare-search" value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={curves.length >= MAX_CURVES
                  ? `at most ${MAX_CURVES} curves`
                  : "add an ASV, a module or an environmental variable …"}
                disabled={curves.length >= MAX_CURVES}
                className="w-full px-2 py-1 rounded bg-slate-800 border border-slate-600 text-slate-100" />
              {candidates.length > 0 && (
                <ul className="mt-1 rounded border border-slate-700 bg-slate-950/70">
                  {candidates.map((t) => (
                    <li key={t.key}>
                      <button data-testid="compare-candidate" data-kind={t.kind}
                        onClick={() => add(t.kind, t.id)}
                        className="w-full text-left px-2 py-1 hover:bg-slate-800 flex items-baseline gap-1">
                        <span className={`text-[9px] uppercase tracking-wide ${
                          t.kind === "env" ? "text-emerald-400"
                          : t.kind === "cluster" ? "text-violet-300" : "text-slate-500"}`}>
                          {t.kind === "env" ? "env" : t.kind === "cluster" ? "module" : "asv"}
                        </span>
                        <span className={t.kind === "asv" ? "font-mono text-cyan-300" : "text-slate-200"}>
                          {t.label}
                        </span>
                        {t.sub && <span className="text-slate-500">({t.sub})</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {curves.length > 0 && (
              <div className="flex flex-wrap gap-1.5" data-testid="compare-legend">
                {series.map((s) => (
                  <span key={s.key} data-testid="compare-curve" data-kind={s.kind}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-slate-700">
                    <svg width="14" height="6" className="shrink-0">
                      <line x1="0" y1="3" x2="14" y2="3" stroke={s.color} strokeWidth="1.5"
                        strokeDasharray={s.kind === "env" ? "3 2" : undefined} />
                    </svg>
                    {s.kind === "asv" ? (
                      <button onClick={() => onOpenAsv(s.id)}
                        className="font-mono text-cyan-300 hover:underline">{s.label}</button>
                    ) : (
                      <span className="text-slate-200">{s.label}</span>
                    )}
                    {s.sub && <span className="text-slate-500">({s.sub})</span>}
                    <button aria-label={`remove ${s.label}`} data-testid="compare-remove"
                      onClick={() => setCurves((cur) => cur.filter((c) => c.key !== s.key))}
                      className="text-slate-500 hover:text-white">✕</button>
                  </span>
                ))}
              </div>
            )}

            {curves.length === 0 && (
              <p className="text-slate-500">
                Add two or more curves to lay their measured series over each other.
              </p>
            )}

            {curves.length > 0 && (
              <>
                <div className="flex flex-wrap items-center gap-2" data-testid="compare-controls">
                  <Chooser label="period" summary={zeitraum === "total" ? "total" : zeitraum}
                    closeOnPick testid="compare-period">
                    <ChooserRow radio checked={zeitraum === "total"} testid="compare-period-total"
                      onToggle={() => setZeitraum("total")} label="total"
                      hint="every sample, on its real date" />
                    {jahre.map((j) => (
                      <ChooserRow key={j} radio checked={zeitraum === j}
                        testid={`compare-period-${j}`} onToggle={() => setZeitraum(j)}
                        label={j} hint="the samples of this calendar year" />
                    ))}
                  </Chooser>
                  <Segmented value={mode} onChange={setMode} testid="compare-modes" label="axis"
                    options={(["absolute", "peak", "range"] as Mode[]).map((m) => ({
                      value: m, label: MODE_LABEL[m], disabled: erlaubt[m] !== null,
                      reason: erlaubt[m] ?? undefined, testid: `compare-mode-${m}`,
                    }))} />
                </div>

                <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: 760 }}
                  data-testid="compare-chart" data-mode={mode} data-period={zeitraum} role="img"
                  aria-label="the measured curves of the selected ASVs, modules and variables">
                  <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={PAD_T + plotH} stroke="#334155" />
                  <line x1={PAD_L} y1={Y(Math.max(yMin, Math.min(0, yMax)))}
                        x2={PAD_L + plotW} y2={Y(Math.max(yMin, Math.min(0, yMax)))} stroke="#334155" />
                  <text x={PAD_L - 4} y={PAD_T + 8} textAnchor="end" fill="#64748b" fontSize="9">
                    {achsenText(yMax)}
                  </text>
                  <text x={PAD_L - 4} y={PAD_T + plotH} textAnchor="end" fill="#64748b" fontSize="9">
                    {achsenText(yMin)}
                  </text>
                  {marken.map((m) => (
                    <g key={m.t}>
                      <line x1={X(m.t)} y1={PAD_T + plotH} x2={X(m.t)} y2={PAD_T + plotH + 3}
                            stroke="#334155" />
                      <text x={X(m.t)} y={H - 8} textAnchor="middle" fill="#64748b" fontSize="9">
                        {m.label}
                      </text>
                    </g>
                  ))}
                  {series.map((s) => (
                    <g key={s.key}>
                      <path d={path(s.points)} fill="none" stroke={s.color} strokeWidth="1.5"
                        strokeDasharray={s.kind === "env" ? "4 3" : undefined} />
                      {s.points.map((p) => p.shown != null && p.value != null && (
                        <circle key={p.date} cx={X(p.t)} cy={Y(p.shown)} r="1.8" fill={s.color}>
                          <title>{`${s.label} · ${p.date}: ${wert(s, p.value)}`
                            + (mode === "absolute" ? "" : ` (${(100 * p.shown).toFixed(0)} % of `
                              + `${mode === "peak" ? "its peak" : "its own range"})`)}</title>
                        </circle>
                      ))}
                    </g>
                  ))}
                </svg>

                {(["absolute", "peak"] as Mode[]).some((m) => erlaubt[m]) && (
                  <p className="text-[10px] text-slate-500" data-testid="compare-locked">
                    {(["absolute", "peak"] as Mode[]).filter((m) => erlaubt[m])
                      .map((m) => `${MODE_LABEL[m]}: ${erlaubt[m]}`).join(" · ")}
                  </p>
                )}
                <p className="text-[10px] text-slate-500" data-testid="compare-caveat">
                  {mode === "absolute"
                    ? "Measured samples on their own dates — nothing averaged. Shares can rise because others fell."
                    : mode === "peak"
                      ? "Each curve divided by its own maximum in this window — shapes comparable, sizes not."
                      : "Each curve stretched over its own min-max here — only the timing is comparable."}
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
