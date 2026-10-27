import type { Criterion2Summary, Thresholds } from "../api";
import { useModules } from "../modules";
import { useState } from "react";
import { PanelHeader } from "./PanelFrame";
import { Criterion2Details } from "./Criterion2";

export default function LegendPanel({ thr, c2, keyLabel, labelMax,
  sizeAbsent = false, widthText = null, onClose }: {
  datasetId: string;
  thr: Thresholds | undefined;
  c2: Criterion2Summary | null;
  keyLabel: string;
  labelMax: number;
  sizeAbsent?: boolean;
  widthText?: string | null;
  onClose: () => void;
}) {
  const modules = useModules();
  const c0 = modules.color(0), c1 = modules.color(1);
  const LINE = "var(--net-link)", AMBER = "var(--cross-link)", CYAN = "var(--accent)",
        BG = "var(--net-node-outline)";

  const t = thr;
  // Mini network. Clicking a point or a link lists its properties and every value they can take;
  // the value the clicked part shows is highlighted.
  const P = { a: [90, 62], b: [42, 150], c: [170, 142], d: [282, 66], e: [326, 150], g: [372, 40] } as const;
  type K = keyof typeof P;
  const R: Record<K, number> = { a: 11, b: 8, c: 9, d: 16, e: 5, g: 8 };
  const fillOf: Record<K, string> = { a: c0, b: c0, c: c0, d: c1, e: c1, g: c1 };
  type Outline = "none" | "keystone" | "open" | "marked";
  const outlineOf: Record<K, Outline> = { a: c2 ? "keystone" : "none", b: "none", c: "marked", d: "none", e: "none", g: "open" };
  type Dir = "none" | "arrow" | "dashed" | "side";
  const LINKS: Record<string, { from: K; to: K; amber?: boolean; w?: number; dir: Dir }> = {
    ab: { from: "a", to: "b", dir: "none" },
    ac: { from: "a", to: "c", w: 5, dir: "none" },
    bc: { from: "b", to: "c", dir: "arrow" },
    cd: { from: "c", to: "d", amber: true, dir: "none" },
    de: { from: "d", to: "e", dir: "dashed" },
    dg: { from: "d", to: "g", dir: "side" },
  };
  const [sel, setSel] = useState<{ node: K } | { link: string } | null>(null);
  const on = (id: { node: K } | { link: string }) => sel == null || JSON.stringify(sel) === JSON.stringify(id);
  const part = (id: { node: K } | { link: string }, children: React.ReactNode, key: string) => (
    <g key={key} data-testid={`legend-part-${key}`} onClick={() => select(id)}
       style={{ cursor: "pointer", opacity: on(id) ? 1 : 0.18 }}>
      {children}
    </g>
  );
  // Ends a line at the edge of the target circle so the arrow head stays visible.
  const toEdge = (from: K, to: K) => {
    const [x1, y1] = P[from], [x2, y2] = P[to];
    const L = Math.hypot(x2 - x1, y2 - y1), k = (L - R[to]) / L;
    return [x1 + (x2 - x1) * k, y1 + (y2 - y1) * k, (x2 - x1) / L, (y2 - y1) / L];
  };
  const head = (x: number, y: number, ux: number, uy: number, color: string) =>
    <polygon points={`${x},${y} ${x - 9 * ux + 4.5 * uy},${y - 9 * uy - 4.5 * ux} ${x - 9 * ux - 4.5 * uy},${y - 9 * uy + 4.5 * ux}`} fill={color} />;
  const drawLink = (key: string) => {
    const l = LINKS[key], color = l.amber ? AMBER : LINE, arrow = l.dir === "arrow" || l.dir === "dashed";
    const [x1, y1] = P[l.from];
    const [x2, y2, ux, uy] = arrow ? toEdge(l.from, l.to) : [...P[l.to], 0, 0];
    let side: React.ReactNode = null;
    if (l.dir === "side") {
      // a rejected direction from `to` back to `from`, bowed beside the drawn link
      const [gx, gy] = P[l.to], [dx, dy] = P[l.from];
      const [, , vx, vy] = toEdge(l.to, l.from);
      const qx = (gx + dx) / 2 - vy * 26, qy = (gy + dy) / 2 + vx * 26;
      const tl = Math.hypot(dx - qx, dy - qy), tx = (dx - qx) / tl, ty = (dy - qy) / tl;
      const sx = dx - tx * (R[l.from] + 2), sy = dy - ty * (R[l.from] + 2);
      side = <>
        <path d={`M ${gx} ${gy} Q ${qx} ${qy} ${sx} ${sy}`} fill="none" stroke="transparent" strokeWidth={14} />
        <path d={`M ${gx} ${gy} Q ${qx} ${qy} ${sx - 6 * tx} ${sy - 6 * ty}`} fill="none" stroke={LINE}
              strokeWidth={1} strokeDasharray="3 3" />
        {head(sx, sy, tx, ty, LINE)}
      </>;
    }
    return part({ link: key }, <>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={14} />
      <line x1={x1} y1={y1} x2={arrow ? x2 - 6 * ux : x2} y2={arrow ? y2 - 6 * uy : y2}
            stroke={color} strokeWidth={l.w ?? 1.5} strokeDasharray={l.dir === "dashed" ? "5 4" : undefined} />
      {arrow && head(x2, y2, ux, uy, color)}
      {side}
    </>, `link-${key}`);
  };
  const outlineStyle = (o: Outline) => ({
    stroke: o === "keystone" ? "var(--mark)" : o === "open" ? CYAN : o === "marked" ? "var(--text)" : BG,
    strokeWidth: o === "none" ? 1 : o === "marked" ? 1.5 : 2,
    strokeDasharray: o === "marked" ? "2 2" : undefined,
    style: o === "keystone" ? { filter: "drop-shadow(0 0 3px var(--mark))" } : undefined,
  });
  const mini = (
    <svg viewBox="0 0 400 180" className="w-full rounded-md border border-line bg-raised" data-testid="legend-mini-network"
         role="img" aria-label="example network; click a point or a link for its properties">
      <rect width={400} height={180} fill="transparent" onClick={() => select(null)} />
      {Object.keys(LINKS).map(drawLink)}
      {(Object.keys(P) as K[]).map((k) => part({ node: k }, <>
        <circle cx={P[k][0]} cy={P[k][1]} r={R[k] + 6} fill="transparent" />
        <circle cx={P[k][0]} cy={P[k][1]} r={R[k]} fill={fillOf[k]} {...outlineStyle(outlineOf[k])} />
        {k === "e" && <text x={P.e[0] + 10} y={P.e[1] + 4} fontSize={12} fill="var(--text)">Genus</text>}
      </>, `node-${k}`))}
    </svg>
  );

  // Small samples for the value lists.
  const W = 32, H = 16, MY = H / 2;
  const Svg = ({ children, w = W }: { children: React.ReactNode; w?: number }) => (
    <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} className="shrink-0" aria-hidden="true">{children}</svg>
  );
  const dot = (o: Outline) => <Svg w={16}><circle cx={8} cy={MY} r={5} fill={c0} {...outlineStyle(o)} /></Svg>;
  const lineS = (color: string, dashed = false, arrow = false) => <Svg>
    <line x1={3} y1={MY} x2={arrow ? W - 8 : W - 3} y2={MY} stroke={color} strokeWidth={1.5} strokeDasharray={dashed ? "3 2" : undefined} />
    {arrow && <polygon points={`${W - 3},${MY} ${W - 9},${MY - 3.5} ${W - 9},${MY + 3.5}`} fill={color} />}</Svg>;

  type Val = { term: string; sample: React.ReactNode; desc: React.ReactNode; testid?: string };
  type Prop = { name: string; values: Val[]; current: number };
  const nodeProps = (k: K): Prop[] => {
    const outlines: [Outline, Val][] = [
      ["none", { term: "none", sample: dot("none"), desc: "no mark" }],
      ...(c2 ? [["keystone", { term: "✦ Keystone", sample: dot("keystone"),
        desc: <span data-testid="legend-c2">{keyLabel}<Criterion2Details c2={c2} testid="legend-c2-declaration" /></span> }] as [Outline, Val]] : []),
      ["open", { term: "Open", sample: dot("open"), desc: "the ASV whose page is open" }],
      ["marked", { term: "Marked", sample: dot("marked"), desc: "found by search, or member of the marked taxon or module" }],
    ];
    return [
      { name: "Colour", current: 0, values: [{ term: "module", testid: "legend-colour-row",
        sample: <Svg><circle cx={10} cy={MY} r={4.5} fill={c0} /><circle cx={22} cy={MY} r={4.5} fill={c1} /></Svg>,
        desc: `${modules.label(0)}, ${modules.label(1)}, …: a group with more links among themselves than chance would give` }] },
      { name: "Size", current: 0, values: [{ term: "area", testid: "legend-size-row",
        sample: <Svg><circle cx={9} cy={MY} r={2.5} fill={c1} /><circle cx={21} cy={MY} r={6.5} fill={c1} /></Svg>,
        desc: sizeAbsent
          ? "not computed for this dataset: its values are a transform of unknown form — all circles are drawn the same size"
          : "circle area relative to the largest circle in view = stored value summed over all samples" }] },
      { name: "Outline", current: outlines.findIndex(([o]) => o === outlineOf[k]), values: outlines.map(([, v]) => v) },
      { name: "Name", current: 0, values: [{ term: "label",
        sample: null,
        desc: `genus where known, otherwise the ASV id; shown up to ${labelMax} visible nodes` }] },
    ];
  };
  const linkProps = (key: string): Prop[] => {
    const l = LINKS[key];
    const dirs: Dir[] = ["none", "arrow", "dashed", "side"];
    return [
      { name: "Colour", current: l.amber ? 1 : 0, values: [
        { term: "grey", sample: lineS(LINE), desc: "link within one module" },
        { term: "amber", sample: lineS(AMBER), desc: "link between two different modules", testid: "legend-cross-row" }] },
      { name: "Width", current: 0, values: [{ term: "strength", testid: "legend-width-row",
        sample: <Svg><line x1={3} y1={MY - 6} x2={W - 3} y2={MY - 6} stroke={LINE} strokeWidth={6} />
                     <line x1={3} y1={MY + 1} x2={W - 3} y2={MY + 1} stroke={LINE} strokeWidth={3} />
                     <line x1={3} y1={MY + 6} x2={W - 3} y2={MY + 6} stroke={LINE} strokeWidth={1} /></Svg>,
        desc: widthText ?? `on a fixed scale, the same in every filter: r from ${t?.con_tr ?? "the threshold"}${t?.recorded ? "" : " (default)"} to 1; with Links off, the larger NMI from 0 to 1` }] },
      { name: "Direction", current: dirs.indexOf(l.dir), values: [
        { term: "none", sample: lineS(LINE), desc: "no CCM direction drawn" },
        { term: "arrow", sample: lineS(LINE, false, true),
          desc: "CCM direction kept (p < 0.05): it points to the end that can be predicted from the other" },
        { term: "dashed", sample: lineS(LINE, true, true), desc: "CCM direction tested and rejected: p ≥ 0.05 (switch Rejected on)" },
        { term: "side arrow", sample: <Svg>
            <line x1={3} y1={MY + 3} x2={W - 3} y2={MY + 3} stroke={LINE} strokeWidth={1.5} />
            <path d={`M ${W - 3} ${MY + 3} Q ${W / 2} ${MY - 8} 6 ${MY + 1}`} fill="none" stroke={LINE} strokeWidth={1} strokeDasharray="2 2" />
            <polygon points={`3,${MY + 3} 9,${MY - 1} 9,${MY + 4}`} fill={LINE} /></Svg>,
          desc: "a rejected direction shown beside a link that is drawn anyway" }] },
    ];
  };
  // A value the viewer clicks in the card replaces the one the clicked part shows.
  const [picked, setPicked] = useState<Record<string, number>>({});
  const select = (id: { node: K } | { link: string } | null) => { setSel(id); setPicked({}); };
  const card = (title: string, desc: string, props: Prop[], testid?: string) => (
    <div className="rounded-md border border-line bg-raised" data-testid="legend-definition">
      <div className="px-3 py-2">
        <div className="text-sm font-semibold text-fg">{title}</div>
        <div className="text-fg-muted leading-snug" data-testid={testid}>{desc}</div>
      </div>
      <dl className="grid grid-cols-[4.5rem_1fr]">
        {props.map((p) => {
          const shown = picked[p.name] ?? p.current, v = p.values[shown];
          return (
            <div key={p.name} className="contents" data-testid={v.testid}>
              <dt className="border-t border-line px-3 py-2 font-semibold text-fg-muted">{p.name}</dt>
              <dd className="border-t border-line pr-3 py-2 space-y-1 min-w-0">
                {p.values.length > 1
                  ? <div className="flex flex-wrap gap-1">
                      {p.values.map((o, i) => (
                        <button key={o.term} type="button" aria-pressed={i === shown} data-here={i === p.current ? "true" : undefined}
                          onClick={() => setPicked({ ...picked, [p.name]: i })}
                          className={`inline-flex items-center gap-1 rounded-md pl-0.5 pr-1.5 py-0.5 ring-1 ring-inset transition-colors ${i === shown
                            ? "ring-accent/60 bg-accent-soft text-accent font-medium" : "ring-line text-fg hover:bg-control"}`}>
                          {o.sample}{o.term}
                        </button>
                      ))}
                    </div>
                  : <div className="flex items-center gap-1 text-fg">{v.sample}{v.term}</div>}
                <div className="text-fg-muted leading-snug">{v.desc}</div>
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
  const linkDesc = (t?.recorded
    ? `co-occurrence: r ≥ ${t.con_tr} and p < ${t.con_alpha} (Pearson on the Fourier coefficients)`
    : "co-occurrence (Pearson on the Fourier coefficients); thresholds not recorded")
    + " — positive correlations only; anti-correlated pairs are never linked";

  return (
    <div data-testid="legend-panel">
      <PanelHeader title="Legend" onClose={onClose} closeTestid="legend-panel-close" />

      <div className="p-4 space-y-4 text-xs">
        <div className="space-y-2">
          {mini}
          {sel && (
            <div>
              {"node" in sel
                ? card("Point", "one ASV, an exactly resolved sequence type — one circle each", nodeProps(sel.node))
                : card("Link", linkDesc, linkProps(sel.link), "legend-link-row")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
