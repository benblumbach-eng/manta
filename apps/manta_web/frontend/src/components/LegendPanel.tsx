import type { Criterion2Summary, Thresholds } from "../api";
import { useModules } from "../modules";
import { useState } from "react";
import { SectionHeading } from "./ui";
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
    <g key={key} data-testid={`legend-part-${key}`} onClick={() => setSel(id)}
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
         role="img" aria-label="example network; click a point or a link">
      <rect width={400} height={180} fill="transparent" onClick={() => setSel(null)} />
      {Object.keys(LINKS).map(drawLink)}
      {(Object.keys(P) as K[]).map((k) => part({ node: k }, <>
        <circle cx={P[k][0]} cy={P[k][1]} r={R[k] + 6} fill="transparent" />
        <circle cx={P[k][0]} cy={P[k][1]} r={R[k]} fill={fillOf[k]} {...outlineStyle(outlineOf[k])} />
        {k === "e" && <text x={P.e[0] + 10} y={P.e[1] + 4} fontSize={12} fill="var(--text)">Genus</text>}
      </>, `node-${k}`))}
    </svg>
  );

  // Small samples for the value lists.
  const W = 48, H = 20, MY = H / 2;
  const Svg = ({ children }: { children: React.ReactNode }) => (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="shrink-0" aria-hidden="true">{children}</svg>
  );
  const dot = (o: Outline) => <Svg><circle cx={W / 2} cy={MY} r={6} fill={c0} {...outlineStyle(o)} /></Svg>;
  const arrowS = (dashed: boolean) => <Svg>
    <line x1={6} y1={MY} x2={W - 12} y2={MY} stroke={LINE} strokeWidth={1.5} strokeDasharray={dashed ? "4 3" : undefined} />
    {head(W - 6, MY, 1, 0, LINE)}</Svg>;
  const lineS = (color: string, w = 1.5) => <Svg><line x1={6} y1={MY} x2={W - 6} y2={MY} stroke={color} strokeWidth={w} /></Svg>;
  const Value = ({ sample, term, desc, here, testid }: { sample: React.ReactNode; term: string; desc: React.ReactNode; here?: boolean; testid?: string }) => (
    <div className={`flex items-start gap-2 py-1 px-1 rounded-md${here ? " bg-accent-soft" : ""}`} data-testid={testid}
         data-here={here ? "true" : undefined}>
      {sample}
      <div className="min-w-0">
        <span className={here ? "text-accent font-medium" : "text-fg"}>{term}</span>
        <span className="text-fg-muted"> — {desc}</span>
      </div>
    </div>
  );
  const Property = ({ name, children }: { name: string; children: React.ReactNode }) => (
    <div className="pt-2 first:pt-0">
      <div className="text-fg font-medium">{name}</div>
      {children}
    </div>
  );

  const nodeCard = (k: K) => (
    <>
      <div className="text-fg font-medium">Point</div>
      <p className="text-fg-muted leading-snug pb-1">one ASV, an exactly resolved sequence type — one circle each</p>
      <Property name="Colour">
        <Value testid="legend-colour-row" sample={<Svg><circle cx={14} cy={MY} r={5} fill={c0} /><circle cx={30} cy={MY} r={5} fill={c1} /></Svg>}
               term="module" desc={`${modules.label(0)}, ${modules.label(1)}, …: a group with more links among themselves than chance would give`} />
      </Property>
      <Property name="Size">
        <Value testid="legend-size-row" sample={<Svg><circle cx={14} cy={MY} r={3} fill={c1} /><circle cx={32} cy={MY} r={8} fill={c1} /></Svg>}
               term="area" desc={sizeAbsent
                 ? "not computed for this dataset: its values are a transform of unknown form — all circles are drawn the same size"
                 : "circle area relative to the largest circle in view = stored value summed over all samples"} />
      </Property>
      <Property name="Outline">
        <Value sample={dot("none")} term="none" desc="no mark" here={outlineOf[k] === "none"} />
        {c2 && <Value sample={dot("keystone")} term="✦ Keystone" here={outlineOf[k] === "keystone"}
                      desc={<span data-testid="legend-c2">{keyLabel}<Criterion2Details c2={c2} testid="legend-c2-declaration" /></span>} />}
        <Value sample={dot("open")} term="Open" desc="the ASV whose page is open" here={outlineOf[k] === "open"} />
        <Value sample={dot("marked")} term="Marked" desc="found by search, or member of the marked taxon or module" here={outlineOf[k] === "marked"} />
      </Property>
      <Property name="Name">
        <Value sample={<Svg><text x={4} y={MY + 4} fontSize={11} fill="var(--text)">Genus</text></Svg>} term="label"
               desc={`genus where known, otherwise the ASV id; shown up to ${labelMax} visible nodes`} />
      </Property>
    </>
  );
  const linkCard = (key: string) => {
    const l = LINKS[key];
    return (
      <>
        <div className="text-fg font-medium">Link</div>
        <p className="text-fg-muted leading-snug pb-1" data-testid="legend-link-row">{(t?.recorded
          ? `co-occurrence: r ≥ ${t.con_tr} and p < ${t.con_alpha} (Pearson on the Fourier coefficients)`
          : "co-occurrence (Pearson on the Fourier coefficients); thresholds not recorded")
          + " — positive correlations only; anti-correlated pairs are never linked"}</p>
        <Property name="Colour">
          <Value sample={lineS(LINE)} term="grey" desc="link within one module" here={!l.amber} />
          <Value testid="legend-cross-row" sample={lineS(AMBER)} term="Amber" desc="link between two different modules" here={!!l.amber} />
        </Property>
        <Property name="Width">
          <Value testid="legend-width-row" sample={<Svg><line x1={6} y1={MY - 4} x2={W - 6} y2={MY - 4} stroke={LINE} strokeWidth={1} />
                                                       <line x1={6} y1={MY + 5} x2={W - 6} y2={MY + 5} stroke={LINE} strokeWidth={4} /></Svg>}
                 term="strength" desc={widthText ?? `on a fixed scale, the same in every filter: r from ${t?.con_tr ?? "the threshold"}${t?.recorded ? "" : " (default)"} to 1; with Links off, the larger NMI from 0 to 1`} />
        </Property>
        <Property name="Direction">
          <Value sample={lineS(LINE)} term="none" desc="no CCM direction drawn" here={l.dir === "none"} />
          <Value sample={arrowS(false)} term="Arrow" here={l.dir === "arrow"}
                 desc="CCM direction kept (p < 0.05): it points to the end that can be predicted from the other" />
          <Value sample={arrowS(true)} term="Dashed arrow" here={l.dir === "dashed"}
                 desc="CCM direction tested and rejected: p ≥ 0.05 (switch Rejected on)" />
          <Value sample={<Svg>
                   <line x1={6} y1={MY + 3} x2={W - 6} y2={MY + 3} stroke={LINE} strokeWidth={1.5} />
                   <path d={`M ${W - 6} ${MY + 3} Q ${W / 2} ${MY - 9} 6 ${MY + 3}`} fill="none" stroke={LINE} strokeWidth={1} strokeDasharray="3 3" />
                   <polygon points={`6,${MY + 3} 12,${MY - 1} 12,${MY + 5}`} fill={LINE} opacity={0.8} /></Svg>}
                 term="Side arrow" here={l.dir === "side"} desc="a rejected direction shown beside a link that is drawn anyway" />
        </Property>
      </>
    );
  };
  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div>
      <SectionHeading className="mb-1">{title}</SectionHeading>
      {children}
    </div>
  );

  return (
    <div data-testid="legend-panel">
      <PanelHeader title="Legend" onClose={onClose} closeTestid="legend-panel-close" />

      <div className="p-4 space-y-4 text-xs">
        <div className="space-y-2">
          {mini}
          <div className="rounded-md border border-line bg-raised px-2 py-2" data-testid="legend-definition">
            {sel == null ? <span className="text-fg-muted">Click a point or a link.</span>
              : "node" in sel ? nodeCard(sel.node) : linkCard(sel.link)}
          </div>
        </div>

        <Section title="Thresholds of this run">
          <p className="text-fg tabular-nums" data-testid="legend-thresholds-line">
            {t?.recorded
              ? `r ≥ ${t.con_tr} · p < ${t.con_alpha} · ${t.num_permutations} permutations`
              : "the thresholds of this run are not recorded — the values shown elsewhere are OTTER's defaults"}
          </p>
          {t?.recorded && (
            <p className="text-fg-muted leading-snug" data-testid="legend-ccm-threshold-note">
              CCM threshold {t.ccmn_tr}: recorded in the run manifest only — OTTER does not
              apply it; the directions are selected by the permutation test alone.
            </p>
          )}
        </Section>

        <Section title="Not encoded">
          <p className="text-fg-muted leading-snug" data-testid="legend-means-nothing">
            Position, circle shape, arrow-head size and list order carry no meaning.
          </p>
          <p className="text-fg-muted leading-snug" data-testid="legend-never-meant">
            A link is co-occurrence, not an interaction; an arrow is predictive value, not a cause.
          </p>
        </Section>
      </div>
    </div>
  );
}
