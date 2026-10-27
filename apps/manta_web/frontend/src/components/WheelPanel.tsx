import { SectionHeading, StateNotice, ToggleButton } from "./ui";
import { useEffect, useMemo, useState } from "react";
import { subject, usePublishView } from "../viewContext";
import { getAsvList, getWheel, type Wheel, type WheelMonth } from "../api";
import { Chooser, ChooserRow } from "./controls";
import InfoTip from "./InfoTip";
import { useModules } from "../modules";
import ProvenanceFooter from "./ProvenanceFooter";
import ErrorNotice from "./ErrorNotice";
import { PanelHeader } from "./PanelFrame";
import { fmtShare } from "../format";
import { useTokens } from "../design/tokens";
import { markerRings } from "../design/dataColours";


type Kind = "cluster" | "env" | "asv";
type Ring = { key: string; kind: Kind; id: string; below: boolean; text: string };

const MODULE_DEFAULT = 10;
const ASV_DEFAULT = 1;
const ENV_BELOW = new Set(["mld"]);
const ENV_FIXED: Record<string, number> = { pw_frac: 0.5 };

const SHORT: Record<string, string> = {
  temp: "Temperature", sal: "Salinity", mld: "Mixed layer depth",
  chl_sens: "Chlorophyll", par_satellite: "Light (PAR)", pw_frac: "Polar water", o2_conc: "Oxygen",
};

function fmt(v: number): string {
  const a = Math.abs(v);
  return String(Number(v.toFixed(a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3)));
}

function pct(v: number | null): string {
  if (v == null) return "—";
  const p = v * 100;
  return `${p >= 10 ? p.toFixed(0) : p >= 1 ? p.toFixed(1) : p.toFixed(2)} %`;
}

function runs(months: number[]): number[][] {
  if (!months.length) return [];
  const out = [[months[0]]];
  for (const m of months.slice(1)) {
    if (m === out[out.length - 1][out[out.length - 1].length - 1] + 1) out[out.length - 1].push(m);
    else out.push([m]);
  }
  if (out.length > 1 && out[0][0] === 1 && out[out.length - 1].slice(-1)[0] === 12) {
    const first = out.shift()!;
    out[out.length - 1] = [...out[out.length - 1], ...first];
  }
  return out;
}

export default function WheelPanel({ datasetId, onClose, onOpenCluster, onOpenEnvironment }: {
  datasetId: string; onClose: () => void; onOpenCluster: (label: number) => void;
  onOpenEnvironment?: (key: string) => void;
}) {
  const [w, setW] = useState<Wheel | null>(null);
  const modules = useModules();
  const { light: hell } = useTokens();
  const RING_COLOURS = markerRings(hell);
  const [err, setErr] = useState<unknown>(null);
  const [nochmal, setNochmal] = useState(0);
  const [year, setYear] = useState<string | null>(null);
  const [rings, setRings] = useState<Ring[] | null>(null);
  const [adjust, setAdjust] = useState(false);
  const [asvListe, setAsvListe] = useState<{ id: string; label: string; share: number }[]>([]);
  useEffect(() => {
    setYear(null); setRings(null); setAsvListe([]);
    getAsvList(datasetId).then((r) => setAsvListe(r.asvs)).catch(() => setAsvListe([]));
  }, [datasetId]);

  const asvIds = useMemo(() => (rings ?? []).filter((r) => r.kind === "asv").map((r) => r.id),
    [rings]);
  const asvKey = asvIds.join(",");
  useEffect(() => { setW(null); }, [datasetId, year]);
  useEffect(() => {
    let live = true;
    setErr(null);
    getWheel(datasetId, year, asvIds).then((r) => {
      if (!live) return;
      // No average year: the wheel always shows one year, the first complete one by default.
      if (year == null && r.years?.length) setYear((r.years.find((y) => !y.note) ?? r.years[0]).year);
      else setW(r);
    })
      .catch((e) => { if (live) setErr(e); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId, year, asvKey, nochmal]);

  useEffect(() => {
    if (w && rings == null) {
      setRings(w.clusters.map((c) => ({ key: `cluster:${c.louvain_label}`, kind: "cluster",
        id: String(c.louvain_label), below: false, text: String(MODULE_DEFAULT) })));
    }
  }, [w, rings]);

  const envVars = w?.environment?.variables ?? [];
  const add = (kind: Kind, id: string) => {
    const key = `${kind}:${id}`;
    setRings((cur) => {
      if (!cur || cur.some((r) => r.key === key)) return cur;
      const v = envVars.find((x) => x.key === id);
      const text = kind === "cluster" ? String(MODULE_DEFAULT)
        : kind === "asv" ? String(ASV_DEFAULT)
        : fmt(ENV_FIXED[id] ?? v?.mean ?? 0);
      return [...cur, { key, kind, id, below: kind === "env" && ENV_BELOW.has(id), text }];
    });
  };
  const setText = (key: string, text: string) =>
    setRings((cur) => cur && cur.map((r) => (r.key === key ? { ...r, text } : r)));
  const remove = (key: string) => setRings((cur) => cur && cur.filter((r) => r.key !== key));

  const CX = 220, CY = 220;
  const R_LABEL = 209, R_MAX = 190, R_MIN = 52;
  const angleOfMonth = (m: number) => (-90 + (m - 1) * 30) * (Math.PI / 180);
  const P = (r: number, a: number) => [CX + r * Math.cos(a), CY + r * Math.sin(a)] as const;
  const arcPath = (r: number, mFirst: number, nMonths: number) => {
    const a0 = angleOfMonth(mFirst);
    const a1 = a0 + nMonths * 30 * (Math.PI / 180);
    const [x0, y0] = P(r, a0);
    const [x1, y1] = P(r, a1);
    return `M ${x0} ${y0} A ${r} ${r} 0 ${nMonths * 30 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
  };

  type Shown = Ring & { label: string; unit: string; colour: string; months: number[][];
                        threshold: number | null; clusterLabel?: number };
  const shown: Shown[] = useMemo(() => {
    if (!w || !rings) return [];
    let farbe = 0;
    return rings.flatMap((r): Shown[] => {
      const n = Number(r.text.replace(",", "."));
      const threshold = r.text.trim() !== "" && Number.isFinite(n) ? n : null;
      let monthly: { month: number; mean: number | null }[] = [];
      let label = r.id, unit = "%", colour: string;
      let scale = 100;
      if (r.kind === "cluster") {
        const c = w.clusters.find((x) => String(x.louvain_label) === r.id);
        if (!c) return [];
        monthly = c.by_month; label = modules.label(c.louvain_label);
        colour = modules.color(c.louvain_label);
      } else if (r.kind === "asv") {
        const a = (w.asvs ?? []).find((x) => x.id === r.id);
        monthly = a?.by_month ?? [];
        colour = RING_COLOURS[farbe++ % RING_COLOURS.length];
      } else {
        const v = envVars.find((x) => x.key === r.id);
        if (!v) return [];
        monthly = w.environment?.monthly[r.id] ?? [];
        label = SHORT[v.key] ?? v.label; unit = v.unit ?? ""; scale = 1;
        colour = RING_COLOURS[farbe++ % RING_COLOURS.length];
      }
      const marked = threshold == null ? [] : monthly
        .filter((p): p is WheelMonth => p.mean != null)
        .filter((p) => (r.below ? p.mean * scale <= threshold : p.mean * scale >= threshold))
        .map((p) => p.month).sort((a, b) => a - b);
      return [{ ...r, label, unit, colour, months: runs(marked), threshold,
                clusterLabel: r.kind === "cluster" ? Number(r.id) : undefined }];
    });
  }, [w, rings, modules, envVars, RING_COLOURS]);

  usePublishView("wheel", w ? {
    view: "wheel", subjects: shown.map((r) => subject(r.kind, r.id, r.label)),
    year: year != null ? Number(year) : null, years: (w.years ?? []).map((y) => Number(y.year)),
  } : null);

  const ringStep = shown.length > 1 ? (R_MAX - R_MIN) / (shown.length - 1) : 0;
  const ringR = (i: number) => (shown.length === 1 ? (R_MAX + R_MIN) / 2 : R_MIN + i * ringStep);
  const stroke = Math.max(3, Math.min(ringStep * 0.6, 9));
  const chosen = new Set((rings ?? []).map((r) => r.key));

  return (
    <div data-testid="wheel-panel">
      <PanelHeader title="The year wheel" onClose={onClose} closeTestid="wheel-close" />

      {err != null && <ErrorNotice error={err} what="Could not load the year wheel."
        onRetry={() => setNochmal((n) => n + 1)} />}
      {!w && err == null && <StateNotice state="loading">loading …</StateNotice>}

      {w?.absent_reason && (
        <div className="p-4 pb-0">
          <p className="text-sm text-warn" data-testid="wheel-absent">{w.absent_reason}</p>
        </div>
      )}

      {w && !w.absent_reason && (
        <div className="p-4 space-y-3 text-sm">

          <div className="flex flex-wrap items-center gap-2" data-testid="wheel-controls">
            {(w.years?.length ?? 0) > 0 && (
              <Chooser label="year" summary={year ?? undefined} closeOnPick
                testid="wheel-year-select">
                {w.years!.map((y) => (
                  <ChooserRow key={y.year} radio checked={year === y.year}
                    testid={`wheel-year-${y.year}`} onToggle={() => setYear(y.year)}
                    label={y.year} hint={y.note ?? `${y.n} samples · all 12 months`} />
                ))}
              </Chooser>
            )}
            <ToggleButton data-testid="wheel-adjust" pressed={adjust} className="ml-auto"
              onClick={() => setAdjust((a) => !a)}>adjust</ToggleButton>
          </div>

          {adjust && (
          <div className="rounded-md border border-line bg-raised px-2 py-2 space-y-1"
               data-testid="wheel-rings">
            <SectionHeading className="mb-1"
              aside={<InfoTip title="The rings">
                <p>One ring per row, from the centre outwards. A month is marked when its mean
                reaches the threshold. Modules and ASVs: share of all reads of a sample.
                Environment: the measured value.</p>
              </InfoTip>}>Rings</SectionHeading>
            {shown.map((s) => (
              <div key={s.key} className="flex items-center gap-2 text-xs" data-testid="wheel-ring-row"
                   data-kind={s.kind}>
                <span className="inline-block w-3 h-3 rounded-sm shrink-0" style={{ background: s.colour }} />
                <span className={`flex-1 truncate ${s.kind === "asv" ? "font-mono" : ""} text-fg`}>
                  {s.label}
                </span>
                <span className="text-fg-muted">{s.below ? "≤" : "≥"}</span>
                <input data-testid="wheel-threshold" type="text" inputMode="decimal" value={s.text}
                  aria-label={`threshold for ${s.label}`}
                  onChange={(e) => setText(s.key, e.target.value)}
                  className={`w-16 px-1 py-0.5 rounded-md bg-control border text-fg tabular-nums text-right ${
                    s.threshold == null ? "border-warn" : "border-line-strong"}`} />
                <span className="text-fg-muted w-8">{s.unit}</span>
                <button aria-label={`remove ${s.label}`} data-testid="wheel-ring-remove"
                  onClick={() => remove(s.key)} className="text-fg-muted hover:text-fg">✕</button>
              </div>
            ))}
            <div className="grid grid-cols-3 gap-1 pt-1" data-testid="wheel-pickers">
              {([
                ["cluster", "module", w.clusters.map((c) => [String(c.louvain_label),
                  modules.label(c.louvain_label)])],
                ["env", "environment", envVars.map((v) => [v.key, SHORT[v.key] ?? v.label])],
                ["asv", "ASV", asvListe.map((a) => [a.id,
                  `${a.id}${a.label !== "unassigned" ? ` · ${a.label}` : ""} · ${fmtShare(a.share)}`])],
              ] as [Kind, string, [string, string][]][]).map(([kind, name, eintraege]) => (
                <select key={kind} data-testid={`wheel-pick-${kind}`} value=""
                  aria-label={`add ${name}`}
                  disabled={eintraege.every(([id]) => chosen.has(`${kind}:${id}`))}
                  onChange={(e) => e.target.value && add(kind, e.target.value)}
                  className="min-w-0 px-1 py-1 rounded bg-control border border-line-strong text-fg text-xs">
                  <option value="">+ {name} …</option>
                  {eintraege.filter(([id]) => !chosen.has(`${kind}:${id}`)).map(([id, text]) => (
                    <option key={id} value={id}>{text}</option>
                  ))}
                </select>
              ))}
            </div>
          </div>
          )}

          {w.year?.note && (
            <p className="text-xs text-warn" data-testid="wheel-year-note">
              {w.year.year}: {w.year.note} — rings rest on this year&rsquo;s {w.year.n} samples only.
            </p>
          )}

          <svg viewBox="0 0 440 440" className="w-full" data-testid="wheel-svg">
            {w.months.map((name, i) => {
              const [tx, ty] = P(R_LABEL, angleOfMonth(i + 1) + 15 * (Math.PI / 180));
              const [gx0, gy0] = P(R_MIN - 8, angleOfMonth(i + 1));
              const [gx1, gy1] = P(R_MAX + 6, angleOfMonth(i + 1));
              return (
                <g key={name}>
                  <line x1={gx0} y1={gy0} x2={gx1} y2={gy1} stroke="var(--chart-grid)" strokeWidth={1} />
                  <text x={tx} y={ty} fill="var(--text-muted)" fontSize={11} textAnchor="middle"
                        dominantBaseline="middle">{name}</text>
                </g>
              );
            })}
            {shown.map((s, i) => {
              const r = ringR(i);
              const offen = s.kind === "cluster" ? () => onOpenCluster(s.clusterLabel!)
                : s.kind === "env" ? () => onOpenEnvironment?.(s.id) : undefined;
              return (
                <g key={s.key} data-testid={`wheel-ring-${s.key}`} onClick={offen}
                   className={offen ? "cursor-pointer" : undefined}>
                  <circle cx={CX} cy={CY} r={r} fill="none" stroke={s.colour} strokeWidth={1}
                          opacity={0.18} />
                  {s.months.map((run) => (run.length >= 12
                    ? <circle key="ring" cx={CX} cy={CY} r={r} fill="none" stroke={s.colour}
                              strokeWidth={stroke} opacity={0.9} />
                    : <path key={run[0]} d={arcPath(r, run[0], run.length)} fill="none"
                            stroke={s.colour} strokeWidth={stroke} strokeLinecap="round"
                            opacity={0.9} />))}
                  <title>{`${s.label} · ${s.below ? "≤" : "≥"} ${s.threshold ?? "?"} ${s.unit}`}</title>
                </g>
              );
            })}
          </svg>

          <div className="space-y-1" data-testid="wheel-list">
            {w.clusters.map((c) => (
              <button key={c.louvain_label} data-testid={`wheel-row-${c.louvain_label}`}
                onClick={() => onOpenCluster(c.louvain_label)}
                className="w-full flex items-center gap-2 text-left px-2 py-1 rounded hover:bg-control">
                <span className="inline-block w-3 h-3 rounded-sm shrink-0"
                      style={{ background: modules.color(c.louvain_label) }} />
                <span className="text-fg flex-1">{modules.label(c.louvain_label)}</span>
                <span className="text-fg font-semibold tabular-nums" data-testid="wheel-row-share">
                  {pct(c.share_total)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {w && (
        <div className="p-4 pt-2 text-sm border-t border-line-subtle">
          <ProvenanceFooter datasetId={datasetId} />
        </div>
      )}
    </div>
  );
}
