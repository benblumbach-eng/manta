import { useEffect, useState } from "react";
import ReactECharts from "echarts-for-react";
import { getEnvironment, getLight, type Environment, type EnvVariable,
         type Light, type SamplerPosition } from "../api";
import InfoTip from "./InfoTip";
import ProvenanceFooter from "./ProvenanceFooter";

export default function EnvironmentPanel({ datasetId, onClose, focus }: {
  datasetId: string; onClose: () => void;
  focus?: string;
}) {
  const [e, setE] = useState<Environment | null>(null);
  const [light, setLight] = useState<Light | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!e || !focus) return;
    const el = document.querySelector(`[data-testid="env-var-${focus}"]`) as HTMLElement | null;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.classList.add("ring-1", "ring-emerald-400/60", "rounded");
    const t = setTimeout(() => el.classList.remove("ring-1", "ring-emerald-400/60", "rounded"), 2500);
    return () => clearTimeout(t);
  }, [e, focus]);
  useEffect(() => {
    setE(null); setErr(null);
    getEnvironment(datasetId).then(setE).catch((x) => setErr(String(x)));
    setLight(null);
    getLight(datasetId).then(setLight).catch(() => setLight(null));
  }, [datasetId]);

  return (
    <div className="h-full overflow-auto"
      data-testid="environment-panel">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-700 sticky top-0 bg-slate-900 z-10">
        <span className="flex items-center text-slate-100 font-medium">
          Environment over time
          {e && (
            <InfoTip title="Where these values come from">
              <p data-testid="environment-provenance">{e.provenance}</p>
              <p data-testid="environment-units-note">{e.units_note}</p>
            </InfoTip>
          )}
        </span>
        <button onClick={onClose} data-testid="environment-close" aria-label="Close"
          className="text-slate-400 hover:text-white">✕</button>
      </div>

      {err && <div className="p-4 text-red-300" data-testid="error">{err}</div>}
      {!e && !err && <div className="p-4 text-slate-500">loading …</div>}

      {e && (
        <div className="p-4 space-y-4 text-sm">
          <p className="text-xs text-slate-300" data-testid="environment-declaration">
            Measured, not derived from the sequences.
          </p>

          {e.variables.length === 0 ? (
            <div data-testid="environment-none" className="rounded border border-amber-500/40 bg-amber-500/5 p-3">
              <div className="text-amber-300 font-medium">No environmental data for this dataset</div>
              <p className="mt-1 text-xs text-slate-300">{e.absent_reason}</p>
            </div>
          ) : (
            <>
              {e.sampler && <WaterColumn sp={e.sampler} dated={e.time_axis === "dates"}
                                         vars={e.variables} light={light} />}
              {e.variables.map((v) => <VariableChart key={v.key} v={v} dated={e.time_axis === "dates"} />)}
            </>
          )}

          {e.absent.length > 0 && e.variables.length > 0 && (
            <div className="text-xs text-slate-500" data-testid="environment-absent">
              Not supplied with this dataset: {e.absent.map((a) => a.label).join(", ")}.
            </div>
          )}
          <ProvenanceFooter datasetId={datasetId} />
        </div>
      )}
    </div>
  );
}

function VariableChart({ v, dated }: { v: EnvVariable; dated: boolean }) {
  const missing = v.total - v.n;
  const option = {
    backgroundColor: "transparent",
    grid: { left: 52, right: 12, top: 10, bottom: 20 },
    tooltip: {
      trigger: "axis" as const,
      formatter: (ps: { data: [string, number | null] }[]) => {
        const p = ps[0];
        if (!p) return "";
        return `<b>${dated ? p.data[0] : `Sample ${p.data[0]}`}</b><br/>`
          + (p.data[1] == null ? "not measured" : `${p.data[1].toFixed(3)}${v.unit ? ` ${v.unit}` : ""}`);
      },
    },
    xAxis: dated
      ? { type: "time" as const, axisLabel: { color: "#94a3b8", fontSize: 9 } }
      : { type: "category" as const, data: v.points.map((_, i) => String(i + 1)),
          axisLabel: { color: "#94a3b8", fontSize: 9,
                       interval: Math.max(0, Math.floor(v.points.length / 10) - 1) } },
    yAxis: {
      type: "value" as const, scale: true,
      axisLabel: { color: "#94a3b8", fontSize: 9 },
      splitLine: { lineStyle: { color: "#1e293b" } },
    },
    series: [{
      name: v.label, type: "line" as const, showSymbol: true, symbolSize: 3,
      connectNulls: false,
      data: v.points.map((p, i) => [dated ? p.date : String(i + 1), p.value] as [string, number | null]),
      lineStyle: { color: "#34d399", width: 1.5 }, itemStyle: { color: "#34d399" },
    }],
  };

  return (
    <div data-testid={`env-var-${v.key}`}>
      <div className="flex items-baseline justify-between">
        <span className="text-slate-200">
          {v.label}
          {v.unit && <span className="text-slate-400"> ({v.unit})</span>}
          {v.unit_note && (
            <span className="text-amber-400" data-testid={`env-unit-note-${v.key}`}>
              {" "}!
              <InfoTip title="The published unit does not match these values">
                <p>{v.unit_note}</p>
                <p>Column <span className="font-mono">{v.source_column}</span> in{" "}
                <span className="font-mono">environment_info.csv</span>.</p>
              </InfoTip>
            </span>
          )}
        </span>
        <span className="text-[10px] text-slate-500 tabular-nums" data-testid={`env-coverage-${v.key}`}>
          {v.n} of {v.total} samples
        </span>
      </div>
      <div className="text-[10px] text-slate-500 tabular-nums">
        {v.min.toFixed(2)} … {v.max.toFixed(2)}
        {v.unit ? ` ${v.unit}` : ""} · mean {v.mean.toFixed(2)}
        {missing > 0 && (
          <span className="text-amber-400/80" data-testid={`env-gap-${v.key}`}>
            {" "}· {missing} sample{missing === 1 ? "" : "s"} without a value, drawn as a gap
          </span>
        )}
      </div>
      <ReactECharts option={option} style={{ height: 100 }} notMerge />
    </div>
  );
}


type DotColour = "position" | "chl" | "light";

const POS_COLOR = { within: "#22d3ee", below: "#f97316", unknown: "#64748b" } as const;
const PHASE_COLOR = { night: "#818cf8", twilight: "#94a3b8", day: "#fbbf24" } as const;
const PHASE_LABEL = { night: "polar night", twilight: "day and night", day: "midnight sun" } as const;

function chlRamp(t: number): string {
  const a = [14, 116, 144], b = [250, 204, 21];
  const c = a.map((x, i) => Math.round(x + (b[i] - x) * Math.max(0, Math.min(1, t))));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function WaterColumn({ sp, dated, vars, light }: {
  sp: SamplerPosition; dated: boolean; vars: EnvVariable[]; light: Light | null;
}) {
  const [mode, setMode] = useState<DotColour>("position");
  const [hover, setHover] = useState<string | null>(null);
  const [pin, setPin] = useState<string | null>(null);

  const chlVar = vars.find((v) => v.key === "chl_sens") ?? null;
  const chl = new Map((chlVar?.points ?? []).filter((p) => p.value != null)
    .map((p) => [p.sample, p.value as number]));
  const phase = new Map((light?.per_sample ?? []).map((p) =>
    [p.sample, (p.polar_night ? "night" : p.polar_day ? "day" : "twilight") as keyof typeof PHASE_COLOR]));
  const lightBy = new Map((light?.per_sample ?? []).map((p) => [p.sample, p]));
  const chlLo = chlVar?.min ?? 0, chlHi = chlVar?.max ?? 1;

  const W = 470, H = 250, L = 40, R = 12, T = 16, B = 22;
  const tief = Math.max(100, ...sp.samples.map((s) => Math.max(s.depth, s.mld ?? 0)));
  const MAX = Math.ceil(tief / 100) * 100;
  const n = sp.samples.length;
  const t0 = dated ? Date.parse(sp.samples[0].date ?? "") : 0;
  const t1 = dated ? Date.parse(sp.samples[n - 1].date ?? "") : n - 1;
  const x = (i: number) => {
    const s = sp.samples[i];
    const t = dated && s.date ? Date.parse(s.date) : i;
    return L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  };
  const y = (d: number) => T + (Math.min(d, MAX) / MAX) * (H - T - B);
  const ticks = Array.from({ length: MAX / 100 + 1 }, (_, k) => k * 100);

  const mldPts = sp.samples.map((s, i) => ({ i, mld: s.mld }))
    .filter((p): p is { i: number; mld: number } => p.mld != null);
  const linie = mldPts.map((p, k) => `${k ? "L" : "M"} ${x(p.i)} ${y(p.mld)}`).join(" ");
  const flaeche = mldPts.length
    ? `M ${x(mldPts[0].i)} ${y(0)} ` + mldPts.map((p) => `L ${x(p.i)} ${y(p.mld)}`).join(" ")
      + ` L ${x(mldPts[mldPts.length - 1].i)} ${y(0)} Z`
    : "";

  const jahre = dated
    ? [...new Set(sp.samples.map((s) => (s.date ?? "").slice(0, 4)))].filter(Boolean)
    : [];

  const farbe = (s: SamplerPosition["samples"][number]): string | null => {
    if (mode === "position") return POS_COLOR[s.position];
    if (mode === "chl") {
      const v = chl.get(s.sample);
      return v == null ? null : chlRamp(chlHi === chlLo ? 0.5 : (v - chlLo) / (chlHi - chlLo));
    }
    const ph = phase.get(s.sample);
    return ph ? PHASE_COLOR[ph] : null;
  };

  const modi: { key: DotColour; label: string; da: boolean }[] = [
    { key: "position", label: "mixed layer", da: true },
    { key: "chl", label: "chlorophyll", da: chl.size > 0 },
    { key: "light", label: "light phase", da: phase.size > 0 },
  ];

  return (
    <div data-testid="water-column" data-within={sp.n_within} data-below={sp.n_below}
         data-unknown={sp.n_unknown} data-depth-axis={MAX}>
      <div className="flex items-baseline justify-between">
        <span className="text-slate-200 flex items-center">Where the sampler hung
          <InfoTip title="Reading this">
            <p>Time runs to the right, depth downwards. The axis reaches {MAX} m, the deepest value measured here, so nothing is cut off.</p>
            <p>The shaded body is the mixed layer — the water stirred together from the surface. Its line connects the sampling days; between them nothing was measured.</p>
            <p>Each dot is one sample at the depth it was taken. Its colour is your choice: inside or below that water, the chlorophyll measured with it, or the light phase of that day.</p>
            <p>A hollow dot means that value is missing for this sample. {sp.note}</p>
          </InfoTip>
        </span>
        <span className="text-[10px] text-slate-500 tabular-nums">{sp.n_total} samples</span>
      </div>
      <p className="text-xs text-slate-300 mt-0.5" data-testid="water-column-statement">{sp.statement}</p>

      <div className="flex flex-wrap items-center gap-1 mt-1.5 text-[10px]">
        <span className="text-slate-500 mr-0.5">colour</span>
        {modi.filter((m) => m.da).map((m) => (
          <button key={m.key} data-testid={`water-column-colour-${m.key}`} onClick={() => setMode(m.key)}
            className={`px-1.5 py-0.5 rounded border ${mode === m.key
              ? "border-cyan-600 text-cyan-300 bg-cyan-500/10"
              : "border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500"}`}>
            {m.label}
          </button>
        ))}
      </div>

      <div className="relative mt-1">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%"
        onDoubleClick={(ev) => {
          if ((ev.target as SVGElement).tagName.toLowerCase() !== "circle") setPin(null);
        }}>
        {ticks.map((d) => (
          <g key={d}>
            <line x1={L} x2={W - R} y1={y(d)} y2={y(d)} stroke="#1e293b" strokeWidth={0.5} />
            <text x={L - 4} y={y(d) + 3} fontSize={8} fill="#64748b" textAnchor="end">{d} m</text>
          </g>
        ))}
        {jahre.map((jr) => {
          const i = sp.samples.findIndex((s) => (s.date ?? "").startsWith(jr));
          if (i <= 0) return null;
          return (
            <g key={jr}>
              <line x1={x(i)} x2={x(i)} y1={T} y2={H - B} stroke="#334155" strokeWidth={0.5} strokeDasharray="2 3" />
              <text x={x(i) + 2} y={T - 4} fontSize={8} fill="#64748b">{jr}</text>
            </g>
          );
        })}
        {flaeche && <path d={flaeche} fill="#38bdf8" opacity={0.10} />}
        {linie && <path d={linie} fill="none" stroke="#38bdf8" strokeWidth={1.2} opacity={0.75} />}
        {sp.samples.map((s, i) => {
          const c = farbe(s);
          const an = pin === s.sample || (pin === null && hover === s.sample);
          return (
            <g key={s.sample}>
              {pin === s.sample && (
                <circle cx={x(i)} cy={y(s.depth)} r={6.5} fill="none" stroke="#e2e8f0"
                        strokeWidth={1} opacity={0.9} />
              )}
              <circle data-testid="water-column-dot" data-sample={s.sample}
                cx={x(i)} cy={y(s.depth)} r={an ? 4.5 : 3}
                fill={c ?? "none"} stroke={c ?? "#64748b"} strokeWidth={c ? 0 : 1}
                style={{ cursor: "pointer" }}
                onMouseEnter={() => setHover(s.sample)}
                onMouseLeave={() => setHover((h) => (h === s.sample ? null : h))}
                onClick={() => setPin(s.sample)} />
            </g>
          );
        })}
      </svg>
      {(() => {
        const key = pin ?? hover;
        const i = key == null ? -1 : sp.samples.findIndex((s) => s.sample === key);
        if (i < 0) return null;
        const s = sp.samples[i];
        const v = chl.get(s.sample), ph = phase.get(s.sample), li = lightBy.get(s.sample);
        const links = x(i) > (L + W - R) / 2;
        const oben = y(s.depth) < (T + H - B) / 2;
        return (
          <div data-testid="water-column-readout" data-sample={s.sample} data-pinned={pin ? "1" : "0"}
            className="absolute z-10 rounded border border-slate-600 bg-slate-950/95 px-2 py-1
                       text-[10px] leading-tight text-slate-200 shadow-xl pointer-events-none"
            style={{ left: `${(x(i) / W) * 100}%`, top: `${(y(s.depth) / H) * 100}%`,
                     transform: `translate(${links ? "-104%" : "4%"}, ${oben ? "6%" : "-106%"})` }}>
            <div className="font-medium">{s.date ?? s.sample}</div>
            <div className="text-slate-400 tabular-nums">sampled at {s.depth.toFixed(0)} m</div>
            <div className="text-slate-400 tabular-nums">
              mixed layer {s.mld == null ? "not recorded" : `${s.mld.toFixed(0)} m`} · {s.position === "within" ? "inside" : s.position === "below" ? "below" : "unknown"}
            </div>
            <div className="text-slate-400 tabular-nums">
              chlorophyll {v == null ? "no value" : `${v.toFixed(2)}${chlVar?.unit ? " " + chlVar.unit : ""}`}
            </div>
            {ph && (
              <div className="text-slate-400 tabular-nums">
                {PHASE_LABEL[ph]}{li ? ` · ${li.day_length_h.toFixed(1)} h of sun` : ""}
              </div>
            )}
            <div className="text-slate-500">{pin ? "double-click beside it to release" : "click to keep"}</div>
          </div>
        );
      })()}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-[10px] text-slate-400">
        <span><span className="inline-block w-3 h-2 align-middle mr-1" style={{ background: "#38bdf8", opacity: 0.35 }} />mixed layer</span>
        {mode === "position" && (<>
          <span><span className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: POS_COLOR.within }} />inside it ({sp.n_within})</span>
          <span><span className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: POS_COLOR.below }} />below it ({sp.n_below})</span>
        </>)}
        {mode === "chl" && (<>
          <span className="tabular-nums">{chlLo.toFixed(1)}</span>
          <span className="inline-block h-2 w-16 rounded"
            style={{ background: `linear-gradient(to right, ${chlRamp(0)}, ${chlRamp(0.5)}, ${chlRamp(1)})` }} />
          <span className="tabular-nums">{chlHi.toFixed(1)} {chlVar?.unit ?? ""}</span>
          <span>· {sp.n_total - chl.size} without a value</span>
        </>)}
        {mode === "light" && (["night", "twilight", "day"] as const).map((k) => (
          <span key={k}><span className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: PHASE_COLOR[k] }} />{PHASE_LABEL[k]}</span>
        ))}
      </div>
    </div>
  );
}
