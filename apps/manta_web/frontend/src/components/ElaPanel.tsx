import { StateNotice, SectionHeading } from "./ui";
import { useEffect, useMemo, useState } from "react";
import { getEla, type Ela, type ElaState, type ElaTree } from "../api";
import { useModules } from "../modules";
import InfoTip from "./InfoTip";
import { PanelHeader } from "./PanelFrame";
import ProvenanceFooter from "./ProvenanceFooter";
import ErrorNotice from "./ErrorNotice";


const RELIABLE = 0.8;

function stateColor(s: ElaState, farbe: (l: number | null | undefined) => string): string {
  if (s.active.length === 0) return "var(--control-strong)";
  return s.majority_cluster != null ? farbe(s.majority_cluster) : "var(--chart-line)";
}

function leavesInOrder(t: ElaTree): string[] {
  if (t.state_id !== undefined) return [t.state_id];
  return t.children.flatMap(leavesInOrder);
}

function Disconnectivity({ tree, states, selected, onSelect }: {
  tree: ElaTree;
  states: ElaState[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const modules = useModules();
  const W = 520, H = 328;
  const M = { top: 18, right: 10, bottom: 62, left: 52 };
  const byId = useMemo(() => new Map(states.map((s) => [s.state_id, s])), [states]);
  const order = useMemo(() => leavesInOrder(tree), [tree]);

  const merges: number[] = [];
  (function collect(t: ElaTree) {
    if (t.children) { merges.push(t.energy); t.children.forEach(collect); }
  })(tree);
  const eMin = Math.min(...states.map((s) => s.energy));
  const eMax = merges.length ? Math.max(...merges) : Math.max(...states.map((s) => s.energy));
  const pad = Math.max((eMax - eMin) * 0.08, 0.25);
  const y = (e: number) =>
    M.top + ((eMax + pad - e) / (eMax + pad - (eMin - pad))) * (H - M.top - M.bottom);
  const x = (i: number) =>
    M.left + ((i + 0.5) / order.length) * (W - M.left - M.right);

  const lines: { x1: number; y1: number; x2: number; y2: number }[] = [];
  const leaves: { id: string; x: number; y: number }[] = [];
  function walk(t: ElaTree): { x: number; y: number } {
    if (t.state_id !== undefined) {
      const p = { x: x(order.indexOf(t.state_id)), y: y(byId.get(t.state_id)!.energy) };
      leaves.push({ id: t.state_id, ...p });
      return p;
    }
    const pts = t.children.map(walk);
    const yM = y(t.energy);
    for (const p of pts) lines.push({ x1: p.x, y1: p.y, x2: p.x, y2: yM });
    lines.push({ x1: Math.min(...pts.map((p) => p.x)), y1: yM,
                 x2: Math.max(...pts.map((p) => p.x)), y2: yM });
    return { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: yM };
  }
  const root = walk(tree);
  lines.push({ x1: root.x, y1: root.y, x2: root.x, y2: Math.max(root.y - 12, 4) });

  const ticks: number[] = [];
  const span = eMax + pad - (eMin - pad);
  const step = Math.pow(10, Math.floor(Math.log10(span / 4)));
  const nice = [1, 2, 2.5, 5, 10].map((m) => m * step).find((s) => span / s <= 6) ?? step;
  for (let v = Math.ceil((eMin - pad) / nice) * nice; v <= eMax + pad; v += nice)
    ticks.push(Number(v.toFixed(6)));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded bg-raised"
      data-testid="ela-disconnectivity"
      role="img" aria-label="Disconnectivity graph of the stable states">
      <line x1={M.left - 8} y1={M.top - 6} x2={M.left - 8} y2={H - M.bottom + 4}
        stroke="var(--chart-axis)" strokeWidth="1" />
      {ticks.map((t) => (
        <g key={t}>
          <line x1={M.left - 11} y1={y(t)} x2={M.left - 8} y2={y(t)} stroke="var(--chart-axis)" />
          <text x={M.left - 14} y={y(t) + 3} textAnchor="end" fontSize="11"
            fill="var(--text-muted)" fontFamily="ui-monospace, monospace">{t}</text>
        </g>
      ))}
      <text x={12} y={M.top - 6} fontSize="11" fill="var(--text-muted)">energy</text>

      {lines.map((l, i) => (
        <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
          stroke="var(--chart-line)" strokeWidth="1.4" strokeLinecap="round" />
      ))}

      {leaves.map((l) => {
        const s = byId.get(l.id)!;
        const idx = states.findIndex((z) => z.state_id === l.id);
        const reliable = s.recurrence == null || s.recurrence >= RELIABLE;
        const fill = stateColor(s, modules.color);
        return (
          <g key={l.id} data-testid={`ela-leaf-${idx}`} className="cursor-pointer"
            onClick={() => onSelect(l.id)}>
            <title>
              {`state ${idx + 1} (${l.id}) · energy ${s.energy.toFixed(3)} · barrier ` +
                `${s.barrier == null ? "—" : s.barrier.toFixed(3)} · recurrence ` +
                `${s.recurrence == null ? "—" : Math.round(100 * s.recurrence) + " %"} · ` +
                `${s.n_active} active ASVs · modules ` +
                (Object.keys(s.cluster_counts).length
                  ? Object.entries(s.cluster_counts).map(([c, n]) => `${modules.label(Number(c))} ×${n}`).join(", ")
                  : "—")}
            </title>
            <circle cx={l.x} cy={l.y} r={selected === l.id ? 7 : 5.5}
              fill={reliable ? fill : "transparent"}
              stroke={reliable ? (selected === l.id ? "var(--text)" : "var(--raised)") : "var(--warn)"}
              strokeWidth={selected === l.id ? 2 : 1.2}
              strokeDasharray={reliable ? undefined : "2 2"} />
            <text x={l.x} y={H - M.bottom + 15} textAnchor="middle" fontSize="11"
              fill={selected === l.id ? "var(--text)" : "var(--text-muted)"}>{idx + 1}</text>
            {s.majority_cluster != null && (
              <text x={l.x} y={H - M.bottom + 28} textAnchor="middle" fontSize="11"
                fill={modules.color(s.majority_cluster)}>
                <title>{modules.label(s.majority_cluster)}</title>
                M{s.majority_cluster}{Object.keys(s.cluster_counts).length > 1 ? "+" : ""}
              </text>
            )}
            {s.active.length === 0 && (
              <text x={l.x} y={H - M.bottom + 28} textAnchor="middle" fontSize="11"
                fill="var(--text-muted)">empty</text>
            )}
            {!reliable && (
              <text x={l.x} y={H - M.bottom + 41} textAnchor="middle" fontSize="11"
                fill="var(--warn)">{Math.round(100 * (s.recurrence ?? 0))} %</text>
            )}
          </g>
        );
      })}
      <text x={(M.left + W - M.right) / 2} y={H - 3} textAnchor="middle" fontSize="11"
        fill="var(--text-muted)">stable states (deeper = lower energy; branches join at the lowest pass)</text>
    </svg>
  );
}

function ObservedChart({ observed, states, selected, onSelect }: {
  observed: NonNullable<Ela["observed"]>;
  states: ElaState[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const modules = useModules();
  const W = 520, H = 246;
  const M = { top: 12, right: 34, bottom: 34, left: 52 };
  const pts = observed.samples;
  const byId = useMemo(() => new Map(states.map((s) => [s.state_id, s])), [states]);
  const hasDates = pts.every((p) => p.date != null);
  const xs = hasDates ? pts.map((p) => Date.parse(p.date!)) : pts.map((_, i) => i);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const eAll = pts.map((p) => p.energy).concat(states.map((s) => s.energy));
  const eMin = Math.min(...eAll), eMax = Math.max(...eAll);
  const pad = Math.max((eMax - eMin) * 0.08, 0.25);
  const x = (v: number) =>
    M.left + (x1 === x0 ? 0.5 : (v - x0) / (x1 - x0)) * (W - M.left - M.right);
  const y = (e: number) =>
    M.top + ((eMax + pad - e) / (eMax + pad - (eMin - pad))) * (H - M.top - M.bottom);

  const ticks: { v: number; label: string }[] = [];
  if (hasDates) {
    const years = new Set(pts.map((p) => p.date!.slice(0, 4)));
    for (const yr of [...years].sort()) {
      const t = Date.parse(`${yr}-01-01`);
      if (t >= x0 && t <= x1) ticks.push({ v: t, label: yr });
    }
  } else {
    for (let i = 0; i < pts.length; i += Math.max(1, Math.floor(pts.length / 6)))
      ticks.push({ v: i, label: String(i + 1) });
  }

  const eTicks: number[] = [];
  {
    const lo = eMin - pad, hi = eMax + pad, span = hi - lo;
    const step = Math.pow(10, Math.floor(Math.log10(span / 4)));
    const nice = [1, 2, 2.5, 5, 10].map((m) => m * step).find((s) => span / s <= 6) ?? step;
    for (let v = Math.ceil(lo / nice) * nice; v <= hi; v += nice) eTicks.push(Number(v.toFixed(6)));
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded bg-raised"
      data-testid="ela-observed-chart" role="img"
      aria-label="Energy of observed communities over time">
      <line x1={M.left - 8} y1={M.top - 4} x2={M.left - 8} y2={H - M.bottom + 4}
        stroke="var(--chart-axis)" strokeWidth="1" />
      <g data-testid="ela-observed-energy-ticks" data-n={eTicks.length}>
        {eTicks.map((t) => (
          <g key={t}>
            <line x1={M.left - 11} y1={y(t)} x2={M.left - 8} y2={y(t)} stroke="var(--chart-axis)" />
            <text x={M.left - 14} y={y(t) + 3} textAnchor="end" fontSize="11"
              fill="var(--text-muted)" fontFamily="ui-monospace, monospace">{t}</text>
          </g>
        ))}
      </g>
      <text x={4} y={M.top - 2} fontSize="11" fill="var(--text-muted)">energy</text>
      {ticks.map((t) => (
        <g key={t.label}>
          <line x1={x(t.v)} y1={H - M.bottom} x2={x(t.v)} y2={H - M.bottom + 4}
            stroke="var(--chart-axis)" />
          <text x={x(t.v)} y={H - M.bottom + 15} textAnchor="middle" fontSize="11"
            fill="var(--text-muted)">{t.label}</text>
        </g>
      ))}
      <text x={(M.left + W - M.right) / 2} y={H - 3} textAnchor="middle" fontSize="11"
        fill="var(--text-muted)">
        {hasDates ? "lower = more stable in the fitted model"
          : "sample order (ordinal axis — no calendar)"}
      </text>

      {states.map((s, i) => (
        <g key={s.state_id}>
          <line x1={M.left - 4} y1={y(s.energy)} x2={W - M.right + 4} y2={y(s.energy)}
            stroke={stateColor(s, modules.color)} strokeWidth="0.8" strokeDasharray="3 3"
            opacity={selected == null || selected === s.state_id ? 0.55 : 0.15} />
          <text x={W - M.right + 7} y={y(s.energy) + 3} fontSize="11"
            fill={stateColor(s, modules.color)}
            opacity={selected == null || selected === s.state_id ? 1 : 0.3}>{i + 1}</text>
        </g>
      ))}

      <polyline fill="none" stroke="var(--chart-axis)" strokeWidth="0.7"
        points={pts.map((p, i) => `${x(xs[i])},${y(p.energy)}`).join(" ")} />
      {pts.map((p, i) => {
        const st = byId.get(p.basin);
        const dim = selected != null && selected !== p.basin;
        return (
          <circle key={p.sample} cx={x(xs[i])} cy={y(p.energy)} r={st ? 2.6 : 2.2}
            fill={st ? stateColor(st, modules.color) : "transparent"}
            stroke={st ? "var(--raised)" : "var(--chart-line)"} strokeWidth="0.6"
            opacity={dim ? 0.15 : 1} className={st ? "cursor-pointer" : undefined}
            onClick={st ? () => onSelect(p.basin) : undefined}>
            <title>
              {`${p.sample}${p.date && p.date !== p.sample ? ` (${p.date})` : ""} · ` +
                `energy ${p.energy.toFixed(3)} · basin ` +
                (st ? `state ${states.findIndex((z) => z.state_id === p.basin) + 1}` +
                      (st.majority_cluster != null ? ` (${modules.label(st.majority_cluster)})` : "")
                    : `${p.basin} — a shallow basin pruned from the stable-state list`)}
            </title>
          </circle>
        );
      })}
    </svg>
  );
}

export default function ElaPanel({ datasetId, onClose, onOpenAsv }: {
  datasetId: string;
  onClose: () => void;
  onOpenAsv?: (id: string) => void;
}) {
  const modules = useModules();
  const [d, setD] = useState<Ela | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [nochmal, setNochmal] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    setD(null); setErr(null); setSelected(null);
    getEla(datasetId).then(setD).catch((e) => setErr(e));
  }, [datasetId, nochmal]);

  const taxa = useMemo(() => {
    if (!d) return [];
    const seen = new Map<string, { id: string; genus: string | null; cluster: number | null }>();
    for (const s of d.states) for (const a of s.active) if (!seen.has(a.id)) seen.set(a.id, a);
    return [...seen.values()].sort((a, b) =>
      (a.cluster ?? 1e9) - (b.cluster ?? 1e9) || a.id.localeCompare(b.id));
  }, [d]);

  return (
    <div data-testid="ela-panel" className="text-sm text-fg">
      <PanelHeader title="Energy landscape" onClose={onClose} closeTestid="ela-close">
          <InfoTip title="What this view answers — and what it does not">
            <p>A pairwise maximum-entropy model over presence/absence of the ASVs in the model:
            every community state gets an <strong>energy</strong> — valleys are stable
            states, passes are the transitions between them.</p>
            <p>It answers whether distinct stable states exist and how they connect. It
            does NOT prove ecological attractors, does not use abundance heights, time
            order or environmental covariates (base model), and says nothing about
            threat or resilience.</p>
            {d?.run && <p className="text-fg-muted">{d.run.reference}</p>}
          </InfoTip>
      </PanelHeader>
      <div className="px-4 pb-4">

      {err != null && <div className="mt-3"><ErrorNotice error={err} testid="ela-error" inline
        what="Could not load the energy landscape." onRetry={() => setNochmal((n) => n + 1)} /></div>}
      {err == null && !d && <StateNotice state="loading" inline className="mt-3">loading …</StateNotice>}

      {d && d.absent_reason && (
        <p className="mt-3 flex items-center text-warn" data-testid="ela-absent">
          No energy-landscape run for this dataset
          <InfoTip title="Why there is none, and how one comes about">
            <p data-testid="ela-absent-full">{d.absent_reason}</p>
          </InfoTip>
        </p>
      )}

      {d && !d.absent_reason && d.run && (
        <>
          <p className="mt-2 text-xs text-fg-muted" data-testid="ela-run">
            {d.run.tool} · {d.run.n_species_model} ASVs in the model · binarised at relative
            value ≥ {d.run.ath} · seed {d.run.seed} · bootstrap {d.run.boot}×
          </p>
          <p className="mt-1 text-xs text-fg-muted">
            {d.value_declaration.frame} — values are {d.value_declaration.unit}.
          </p>

          <section className="mt-4" data-testid="ela-figure">
            <SectionHeading>
              Disconnectivity graph
              <InfoTip title="How to read this figure">
                <p>The standard figure of the cited literature: each leaf is one stable
                state, drawn at its energy (deeper = more stable in the model). Two
                branches join at the height of the <strong>lowest pass</strong> between
                them — the longer the stem below a junction, the higher the barrier the
                model has to cross to leave that valley.</p>
                <p>Dashed leaves fall below the {Math.round(RELIABLE * 100)} % bootstrap
                guard: reported, not relied on. Leaf colour is the majority module of the
                state's active ASVs — orientation only, not a finding.</p>
              </InfoTip>
            </SectionHeading>
            {d.disconnectivity
              ? <Disconnectivity tree={d.disconnectivity} states={d.states}
                  selected={selected}
                  onSelect={(id) => setSelected(selected === id ? null : id)} />
              : <p className="mt-1 text-xs text-fg-muted" data-testid="ela-no-tree">
                  no figure — the pass matrix between the states is incomplete, and a
                  guessed tree would be a lie.</p>}
          </section>

          {d.observed && (
            <section className="mt-4" data-testid="ela-observed">
              <SectionHeading>
                Observed communities over time
                <InfoTip title="Where each sample sits in the landscape">
                  <p>{d.observed.method}</p>
                  <p>Each dot is one sample: its height is the energy of that sample's
                  binarised composition (lower = more stable in the fitted model), its
                  colour the stable state it descends into. Dashed lines mark the stable
                  states. A seasonal system shows up as regular switching between
                  valleys.</p>
                  <p className="text-fg-muted">{d.observed.reference}</p>
                </InfoTip>
              </SectionHeading>
              {d.observed.absent_reason
                ? <p className="mt-1 text-xs text-warn" data-testid="ela-observed-absent">
                    {d.observed.absent_reason}</p>
                : <ObservedChart observed={d.observed} states={d.states}
                    selected={selected}
                    onSelect={(id) => setSelected(selected === id ? null : id)} />}
            </section>
          )}

          <section className="mt-4" data-testid="ela-states">
            <SectionHeading>
              Stable states ({d.states.length})
              <InfoTip title="How to read a state">
                <p>Each row is one state. Lower energy = deeper valley.
                <strong> barrier</strong> is the lowest pass out of the state minus its own
                energy — how much the model has to climb to leave it.
                <strong> recurrence</strong> is the share of bootstrap refits in which the
                state reappears — a state below {Math.round(RELIABLE * 100)} % is reported,
                not relied on.</p>
              </InfoTip>
            </SectionHeading>
            <table className="mt-1 w-full text-xs">
              <thead><tr className="text-fg-muted text-left">
                <th className="pr-2 font-normal">#</th>
                <th className="pr-2 font-normal">energy</th>
                <th className="pr-2 font-normal">barrier</th>
                <th className="pr-2 font-normal">recurrence</th>
                <th className="pr-2 font-normal">ASVs</th>
                <th className="font-normal">modules</th>
              </tr></thead>
              <tbody>
                {d.states.map((s, i) => (
                  <tr key={s.state_id} data-testid={`ela-state-${i}`}
                    onClick={() => setSelected(selected === s.state_id ? null : s.state_id)}
                    className={"align-top border-t border-line-subtle cursor-pointer " +
                      (selected === s.state_id ? "bg-control/70" : "hover:bg-control/40")}>
                    <td className="pr-2 py-1 tabular-nums text-fg-muted">{i + 1}</td>
                    <td className="pr-2 py-1 tabular-nums">{s.energy.toFixed(3)}</td>
                    <td className="pr-2 py-1 tabular-nums">
                      {s.barrier == null ? "—" : s.barrier.toFixed(3)}</td>
                    <td className="pr-2 py-1 tabular-nums">
                      {s.recurrence == null ? "—"
                        : <span className={s.recurrence < RELIABLE ? "text-warn" : ""}>
                            {Math.round(100 * s.recurrence)} %</span>}
                    </td>
                    <td className="pr-2 py-1 tabular-nums">
                      {s.active.length === 0
                        ? <span className="text-fg-muted">none — the empty state</span>
                        : s.n_active}
                    </td>
                    <td className="py-1">
                      {Object.entries(s.cluster_counts).map(([c, n]) => (
                        <span key={c} className="inline-flex items-center mr-2 whitespace-nowrap"
                          title={modules.label(Number(c))}>
                          <span className="inline-block w-2 h-2 rounded-sm mr-1"
                            style={{ background: modules.color(Number(c)) }} />
                          M{c}{n > 1 ? ` ×${n}` : ""}
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {taxa.length > 0 && (
            <section className="mt-4" data-testid="ela-composition">
              <SectionHeading>
                State composition
                <InfoTip title="Which ASVs make up which state">
                  <p>Rows are the ASVs of the model that are active in at least one stable
                  state, grouped by network module (colour). A dot means the ASV is ON in that
                  state. Click an ASV to open its detail view.</p>
                </InfoTip>
              </SectionHeading>
              <table className="mt-1 text-xs">
                <thead><tr>
                  <th className="pr-2 font-normal text-left text-fg-muted">ASV</th>
                  {d.states.map((s, i) => (
                    <th key={s.state_id}
                      onClick={() => setSelected(selected === s.state_id ? null : s.state_id)}
                      className={"px-1 font-normal tabular-nums cursor-pointer " +
                        (selected === s.state_id ? "text-fg" : "text-fg-muted")}>
                      {i + 1}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {taxa.map((t) => (
                    <tr key={t.id} className="border-t border-line-subtle">
                      <td className="pr-2 py-1">
                        <button onClick={() => onOpenAsv?.(t.id)} disabled={!onOpenAsv}
                          title={t.genus ?? t.id}
                          className="inline-flex items-center font-mono text-2xs
                                     hover:text-fg">
                          <span className="inline-block w-2 h-2 rounded-sm mr-1 shrink-0"
                            style={{ background: t.cluster != null
                              ? modules.color(t.cluster) : "var(--control-strong)" }} />
                          {t.id}
                        </button>
                      </td>
                      {d.states.map((s) => {
                        const on = s.active.some((a) => a.id === t.id);
                        const dim = selected != null && selected !== s.state_id;
                        return (
                          <td key={s.state_id} className="px-1 py-1 text-center">
                            {on && <span className={"inline-block w-2.5 h-2.5 rounded-full " +
                                (dim ? "opacity-25" : "")}
                              style={{ background: t.cluster != null
                                ? modules.color(t.cluster) : "var(--chart-line)" }} />}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <section className="mt-4" data-testid="ela-tippings">
            <SectionHeading>
              Passes between states
              <InfoTip title="Tipping points">
                <p>The lowest pass the model finds between two stable states. A high pass
                between two deep valleys means the model does not switch between them
                easily; it is NOT a prediction of what the ecosystem will do.</p>
              </InfoTip>
            </SectionHeading>
            {d.tipping_points.length === 0
              ? <p className="mt-1 text-xs text-fg-muted">none — only one stable state.</p>
              : <table className="mt-1 text-xs tabular-nums">
                  <tbody>
                    {d.tipping_points.map((t, i) => {
                      const nr = (id: string) => {
                        const k = d.states.findIndex((s) => s.state_id === id);
                        return k < 0 ? id : `state ${k + 1}`;
                      };
                      return (
                        <tr key={i} className="border-t border-line-subtle" data-testid="ela-tipping-row">
                          <td className="pr-2 py-1" title={`state code ${t.ss1}`}>{nr(t.ss1)}</td>
                          <td className="pr-2 py-1 text-fg-muted">↔</td>
                          <td className="pr-2 py-1" title={`state code ${t.ss2}`}>{nr(t.ss2)}</td>
                          <td className="py-1">pass at energy {t.energy.toFixed(3)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>}
          </section>

          <section className="mt-4 text-xs text-fg-muted space-y-1" data-testid="ela-caveats">
            {d.caveats.map((c, i) => <p key={i}>{c}</p>)}
          </section>
        </>
      )}

      <div className="mt-4">
        <ProvenanceFooter datasetId={datasetId} />
      </div>
      </div>
    </div>
  );
}
