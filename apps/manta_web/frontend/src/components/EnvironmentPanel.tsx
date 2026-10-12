import { StateNotice } from "./ui";
import { useEffect, useState } from "react";
import ReactECharts from "echarts-for-react";
import { getEnvironment, getLight, type Environment, type EnvVariable,
         type Light, type SamplerPosition } from "../api";
import InfoTip from "./InfoTip";
import { PanelHeader } from "./PanelFrame";
import { esc } from "../format";
import ProvenanceFooter from "./ProvenanceFooter";
import ErrorNotice from "./ErrorNotice";
import { Segmented } from "./controls";
import { chartTooltip, FONT, useTokens } from "../design/tokens";
import { envColour, mixedLayerColours, sunColours } from "../design/dataColours";

export default function EnvironmentPanel({ datasetId, onClose, focus }: {
  datasetId: string; onClose: () => void;
  focus?: string;
}) {
  const [e, setE] = useState<Environment | null>(null);
  const [light, setLight] = useState<Light | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [nochmal, setNochmal] = useState(0);

  useEffect(() => {
    if (!e || !focus) return;
    const el = document.querySelector(`[data-testid="env-var-${focus}"]`) as HTMLElement | null;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.classList.add("ring-1", "ring-ok", "rounded");
    const t = setTimeout(() => el.classList.remove("ring-1", "ring-ok", "rounded"), 2500);
    return () => clearTimeout(t);
  }, [e, focus]);
  useEffect(() => {
    setE(null); setErr(null);
    getEnvironment(datasetId).then(setE).catch((x) => setErr(x));
    setLight(null);
    getLight(datasetId).then(setLight).catch(() => setLight(null));
  }, [datasetId, nochmal]);

  return (
    <div data-testid="environment-panel">
      <PanelHeader title="Environment over time" onClose={onClose} closeTestid="environment-close">
        {e && (
          <InfoTip title="Where these values come from">
            <p data-testid="environment-provenance">{e.provenance}</p>
            <p data-testid="environment-units-note">{e.units_note}</p>
          </InfoTip>
        )}
      </PanelHeader>

      {err != null && <ErrorNotice error={err} what="Could not load the environment."
        onRetry={() => setNochmal((n) => n + 1)} />}
      {!e && err == null && <StateNotice state="loading">loading …</StateNotice>}

      {e && (
        <div className="p-4 space-y-4 text-sm">
          <p className="text-xs text-fg" data-testid="environment-declaration">
            Measured, not derived from the sequences.
          </p>

          {e.variables.length === 0 ? (
            <div data-testid="environment-none" className="rounded border border-warn bg-warn-soft p-3">
              <div className="text-warn font-medium">No environmental data for this dataset</div>
              <p className="mt-1 text-xs text-fg">{e.absent_reason}</p>
            </div>
          ) : (
            <>
              {e.sampler && <WaterColumn sp={e.sampler} dated={e.time_axis === "dates"}
                                         vars={e.variables} light={light} />}
              {e.variables.map((v) => <VariableChart key={v.key} v={v} dated={e.time_axis === "dates"} />)}
            </>
          )}

          {e.absent.length > 0 && e.variables.length > 0 && (
            <div className="text-xs text-fg-muted" data-testid="environment-absent">
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
  const tok = useTokens();
  const achse = { color: tok.textMuted, fontSize: FONT.xs2 };
  const ENV = envColour(tok.light);
  const option = {
    backgroundColor: "transparent",
    grid: { left: 52, right: 12, top: 10, bottom: 20 },
    tooltip: {
      ...chartTooltip(tok),
      trigger: "axis" as const,
      formatter: (ps: { data: [string, number | null] }[]) => {
        const p = ps[0];
        if (!p) return "";
        return `<b>${esc(dated ? p.data[0] : `Sample ${p.data[0]}`)}</b><br/>`
          + (p.data[1] == null ? "not measured" : `${p.data[1].toFixed(3)}${v.unit ? ` ${esc(v.unit)}` : ""}`);
      },
    },
    xAxis: dated
      ? { type: "time" as const, axisLabel: achse }
      : { type: "category" as const, data: v.points.map((_, i) => String(i + 1)),
          axisLabel: { ...achse, interval: Math.max(0, Math.floor(v.points.length / 10) - 1) } },
    yAxis: {
      type: "value" as const, scale: true,
      axisLabel: achse,
      splitLine: { lineStyle: { color: tok.chartGrid } },
    },
    series: [{
      name: v.label, type: "line" as const, showSymbol: true, symbolSize: 3,
      connectNulls: false,
      data: v.points.map((p, i) => [dated ? p.date : String(i + 1), p.value] as [string, number | null]),
      lineStyle: { color: ENV, width: 1.5 }, itemStyle: { color: ENV },
    }],
  };

  return (
    <div data-testid={`env-var-${v.key}`}>
      <div className="flex items-baseline justify-between">
        <span className="text-fg">
          {v.label}
          {v.unit && <span className="text-fg-muted"> ({v.unit})</span>}
          {v.unit_note && (
            <span className="text-warn" data-testid={`env-unit-note-${v.key}`}>
              {" "}!
              <InfoTip title="The published unit does not match these values">
                <p>{v.unit_note}</p>
                <p>Column <span className="font-mono">{v.source_column}</span> in{" "}
                <span className="font-mono">environment_info.csv</span>.</p>
              </InfoTip>
            </span>
          )}
        </span>
        <span className="text-2xs text-fg-muted tabular-nums" data-testid={`env-coverage-${v.key}`}>
          {v.n} of {v.total} samples
        </span>
      </div>
      <div className="text-2xs text-fg-muted tabular-nums">
        {v.min.toFixed(2)} … {v.max.toFixed(2)}
        {v.unit ? ` ${v.unit}` : ""} · mean {v.mean.toFixed(2)}
        {missing > 0 && (
          <span className="text-warn" data-testid={`env-gap-${v.key}`}>
            {" "}· {missing} sample{missing === 1 ? "" : "s"} without a value, drawn as a gap
          </span>
        )}
      </div>
      <ReactECharts option={option} style={{ height: 100 }} notMerge />
    </div>
  );
}


type DotColour = "position" | "chl" | "light";

type Phase = "night" | "twilight" | "day";
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
  const { light: hell } = useTokens();
  const POS_COLOR = mixedLayerColours(hell);
  const sonne = sunColours(hell);
  const PHASE_COLOR: Record<Phase, string> = { night: sonne.night, twilight: sonne.twilight, day: sonne.day };
  const [hover, setHover] = useState<string | null>(null);
  const [pin, setPin] = useState<string | null>(null);

  const chlVar = vars.find((v) => v.key === "chl_sens") ?? null;
  const chl = new Map((chlVar?.points ?? []).filter((p) => p.value != null)
    .map((p) => [p.sample, p.value as number]));
  const phase = new Map((light?.per_sample ?? []).map((p) =>
    [p.sample, (p.polar_night ? "night" : p.polar_day ? "day" : "twilight") as Phase]));
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
        <span className="text-fg flex items-center">Where the sampler hung
          <InfoTip title="Reading this">
            <p>Time runs to the right, depth downwards. The axis reaches {MAX} m, the deepest value measured here, so nothing is cut off.</p>
            <p>The shaded body is the mixed layer — the water stirred together from the surface. Its line connects the sampling days; between them nothing was measured.</p>
            <p>Each dot is one sample at the depth it was taken. Its colour is your choice: inside or below that water, the chlorophyll measured with it, or the light phase of that day.</p>
            <p>A hollow dot means that value is missing for this sample. {sp.note}</p>
          </InfoTip>
        </span>
        <span className="text-2xs text-fg-muted tabular-nums">{sp.n_total} samples</span>
      </div>
      <p className="text-xs text-fg mt-1" data-testid="water-column-statement">{sp.statement}</p>

      <div className="mt-2">
        <Segmented label="Colour" value={mode} onChange={setMode}
          options={modi.filter((m) => m.da).map((m) => (
            { value: m.key, label: m.label, testid: `water-column-colour-${m.key}` }))} />
      </div>

      <div className="relative mt-1">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%"
        onDoubleClick={(ev) => {
          if ((ev.target as SVGElement).tagName.toLowerCase() !== "circle") setPin(null);
        }}>
        {ticks.map((d) => (
          <g key={d}>
            <line x1={L} x2={W - R} y1={y(d)} y2={y(d)} stroke="var(--chart-grid)" strokeWidth={0.5} />
            <text x={L - 4} y={y(d) + 4} fontSize={11} fill="var(--text-muted)" textAnchor="end">{d} m</text>
          </g>
        ))}
        {jahre.map((jr) => {
          const i = sp.samples.findIndex((s) => (s.date ?? "").startsWith(jr));
          if (i <= 0) return null;
          return (
            <g key={jr}>
              <line x1={x(i)} x2={x(i)} y1={T} y2={H - B} stroke="var(--chart-axis)" strokeWidth={0.5} strokeDasharray="2 3" />
              <text x={x(i) + 2} y={T - 4} fontSize={11} fill="var(--text-muted)">{jr}</text>
            </g>
          );
        })}
        {flaeche && <path d={flaeche} fill={POS_COLOR.band} opacity={0.10} />}
        {linie && <path d={linie} fill="none" stroke={POS_COLOR.band} strokeWidth={1.2} opacity={0.75} />}
        {sp.samples.map((s, i) => {
          const c = farbe(s);
          const an = pin === s.sample || (pin === null && hover === s.sample);
          return (
            <g key={s.sample}>
              {pin === s.sample && (
                <circle cx={x(i)} cy={y(s.depth)} r={6.5} fill="none" stroke="var(--text)"
                        strokeWidth={1} opacity={0.9} />
              )}
              <circle data-testid="water-column-dot" data-sample={s.sample}
                cx={x(i)} cy={y(s.depth)} r={an ? 4.5 : 3}
                fill={c ?? "none"} stroke={c ?? "var(--chart-line)"} strokeWidth={c ? 0 : 1}
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
            className="absolute z-10 rounded-md border border-line bg-overlay px-2 py-1
                       text-2xs leading-tight text-fg shadow-xl pointer-events-none"
            style={{ left: `${(x(i) / W) * 100}%`, top: `${(y(s.depth) / H) * 100}%`,
                     transform: `translate(${links ? "-104%" : "4%"}, ${oben ? "6%" : "-106%"})` }}>
            <div className="font-medium">{s.date ?? s.sample}</div>
            <div className="text-fg-muted tabular-nums">sampled at {s.depth.toFixed(0)} m</div>
            <div className="text-fg-muted tabular-nums">
              mixed layer {s.mld == null ? "not recorded" : `${s.mld.toFixed(0)} m`} · {s.position === "within" ? "inside" : s.position === "below" ? "below" : "unknown"}
            </div>
            <div className="text-fg-muted tabular-nums">
              chlorophyll {v == null ? "no value" : `${v.toFixed(2)}${chlVar?.unit ? " " + chlVar.unit : ""}`}
            </div>
            {ph && (
              <div className="text-fg-muted tabular-nums">
                {PHASE_LABEL[ph]}{li ? ` · ${li.day_length_h.toFixed(1)} h of sun` : ""}
              </div>
            )}
            <div className="text-fg-muted">{pin ? "double-click beside it to release" : "click to keep"}</div>
          </div>
        );
      })()}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-2xs text-fg-muted">
        <span><span className="inline-block w-3 h-2 align-middle mr-1" style={{ background: POS_COLOR.band, opacity: 0.35 }} />mixed layer</span>
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
