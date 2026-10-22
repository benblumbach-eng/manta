import type { Criterion2Summary, Thresholds } from "../api";
import { useModules } from "../modules";
import { useState } from "react";
import { SectionHeading, ToggleButton } from "./ui";
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
  const DEF: Record<string, React.ReactNode> = {
    "ASV": "one ASV, an exactly resolved sequence type — one circle each",
    "Colour": `module ${modules.label(0)}, ${modules.label(1)}, …: a group with more links among themselves than chance would give`,
    "Size": sizeAbsent
      ? "not computed for this dataset: its values are a transform of unknown form — all circles are drawn the same size"
      : "circle area relative to the largest circle in view = stored value summed over all samples",
    ...(c2 ? { "✦ Keystone": <div className="space-y-1"><div data-testid="legend-c2">{keyLabel}</div>
                                <Criterion2Details c2={c2} testid="legend-c2-declaration" /></div> } : {}),
    "Open": "the ASV whose page is open",
    "Marked": "found by search, or member of the marked taxon or module",
    "Name": `genus where known, otherwise the ASV id; shown up to ${labelMax} visible nodes`,
    "Link": (t?.recorded
      ? `co-occurrence: r ≥ ${t.con_tr} and p < ${t.con_alpha} (Pearson on the Fourier coefficients)`
      : "co-occurrence (Pearson on the Fourier coefficients); thresholds not recorded")
      + " — positive correlations only; anti-correlated pairs are never linked",
    "Width": widthText ?? `strength on a fixed scale, the same in every filter: r from ${t?.con_tr ?? "the threshold"}${t?.recorded ? "" : " (default)"} to 1; with Links off, the larger NMI from 0 to 1`,
    "Arrow": "CCM direction kept (p < 0.05): it points to the end that can be predicted from the other",
    "Dashed arrow": "CCM direction tested and rejected: p ≥ 0.05 (switch Rejected on)",
    "Side arrow": "a rejected direction shown beside a link that is drawn anyway",
    "Amber": "link between two different modules",
  };
  const NODE_TERMS = ["ASV", "Colour", "Size", ...(c2 ? ["✦ Keystone"] : []), "Open", "Marked", "Name"];
  const LINK_TERMS = ["Link", "Width", "Arrow", "Dashed arrow", "Side arrow", "Amber"];
  const [sel, setSel] = useState<string | null>(null);

  // Mini network: every drawn part names the terms it shows; the first one is chosen on click.
  const P = { a: [90, 62], b: [42, 150], c: [170, 142], d: [282, 66], e: [326, 150], g: [372, 40] } as const;
  type K = keyof typeof P;
  const R: Record<K, number> = { a: 11, b: 8, c: 9, d: 16, e: 5, g: 8 };
  const nodeTerms: Record<K, string[]> = {
    a: [c2 ? "✦ Keystone" : "ASV", "Colour"], b: ["ASV", "Colour"], c: ["Marked", "Colour"],
    d: ["Size", "Colour"], e: ["Size", "Colour"], g: ["Open", "Colour"],
  };
  const fillOf: Record<K, string> = { a: c0, b: c0, c: c0, d: c1, e: c1, g: c1 };
  const on = (terms: string[]) => sel == null || terms.includes(sel);
  const part = (terms: string[], children: React.ReactNode, key: string) => (
    <g key={key} data-testid={`legend-part-${key}`} onClick={() => setSel(terms[0])}
       style={{ cursor: "pointer", opacity: on(terms) ? 1 : 0.18 }}>
      <title>{terms[0]}</title>
      {children}
    </g>
  );
  // Ends a line at the edge of the target circle so the arrow head stays visible.
  const toEdge = (from: K, to: K, pad = 0) => {
    const [x1, y1] = P[from], [x2, y2] = P[to];
    const L = Math.hypot(x2 - x1, y2 - y1), k = (L - R[to] - pad) / L;
    return [x1 + (x2 - x1) * k, y1 + (y2 - y1) * k, (x2 - x1) / L, (y2 - y1) / L];
  };
  const head = (x: number, y: number, ux: number, uy: number, color: string) =>
    <polygon points={`${x},${y} ${x - 9 * ux + 4.5 * uy},${y - 9 * uy - 4.5 * ux} ${x - 9 * ux - 4.5 * uy},${y - 9 * uy + 4.5 * ux}`} fill={color} />;
  const edge = (key: string, terms: string[], from: K, to: K, o: { color?: string; w?: number; dash?: string; arrow?: boolean }) => {
    const [x1, y1] = P[from];
    const [x2, y2, ux, uy] = o.arrow ? toEdge(from, to) : [...P[to], 0, 0];
    const color = o.color ?? LINE;
    return part(terms, <>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={14} />
      <line x1={x1} y1={y1} x2={o.arrow ? x2 - 6 * ux : x2} y2={o.arrow ? y2 - 6 * uy : y2}
            stroke={color} strokeWidth={o.w ?? 1.5} strokeDasharray={o.dash} />
      {o.arrow && head(x2, y2, ux, uy, color)}
    </>, key);
  };
  // Side arrow: a dashed curve from g to d, bowed beside the drawn d–g link.
  const [gx, gy] = P.g, [dx, dy] = P.d;
  const [, , ux0, uy0] = toEdge("g", "d");
  const qx = (gx + dx) / 2 - uy0 * 26, qy = (gy + dy) / 2 + ux0 * 26;
  const tl = Math.hypot(dx - qx, dy - qy), tx = (dx - qx) / tl, ty = (dy - qy) / tl;
  const sx = dx - tx * (R.d + 2), sy = dy - ty * (R.d + 2);
  const mini = (
    <svg viewBox="0 0 400 180" className="w-full rounded-md border border-line bg-raised" data-testid="legend-mini-network"
         role="img" aria-label="example network; click a part for its definition">
      <rect width={400} height={180} fill="transparent" onClick={() => setSel(null)} />
      {edge("link", ["Link", "Width"], "a", "b", { w: 1.5 })}
      {edge("width", ["Width"], "a", "c", { w: 5 })}
      {edge("arrow", ["Arrow"], "b", "c", { arrow: true })}
      {edge("amber", ["Amber"], "c", "d", { color: AMBER })}
      {edge("dashed", ["Dashed arrow"], "d", "e", { dash: "5 4", arrow: true })}
      {edge("side-link", ["Link"], "d", "g", {})}
      {part(["Side arrow"], <>
        <path d={`M ${gx} ${gy} Q ${qx} ${qy} ${sx} ${sy}`} fill="none" stroke="transparent" strokeWidth={14} />
        <path d={`M ${gx} ${gy} Q ${qx} ${qy} ${sx - 6 * tx} ${sy - 6 * ty}`} fill="none" stroke={LINE}
              strokeWidth={1} strokeDasharray="3 3" />
        {head(sx, sy, tx, ty, LINE)}
      </>, "side")}
      {(Object.keys(P) as K[]).map((k) => part(nodeTerms[k], <>
        <circle cx={P[k][0]} cy={P[k][1]} r={R[k] + 6} fill="transparent" />
        <circle cx={P[k][0]} cy={P[k][1]} r={R[k]} fill={fillOf[k]}
          stroke={k === "a" && c2 ? "var(--mark)" : k === "g" ? CYAN : k === "c" ? "var(--text)" : BG}
          strokeWidth={k === "a" && c2 ? 2 : k === "g" ? 2 : k === "c" ? 1.5 : 1}
          strokeDasharray={k === "c" ? "2 2" : undefined}
          style={k === "a" && c2 ? { filter: "drop-shadow(0 0 3px var(--mark))" } : undefined} />
      </>, `node-${k}`))}
      {part(["Name"], <text x={P.e[0] + 10} y={P.e[1] + 4} fontSize={12} fill="var(--text)">Genus</text>, "name")}
    </svg>
  );
  const chip = (term: string) => (
    <ToggleButton key={term} pressed={sel === term} data-testid="legend-term" data-label={term}
                  onClick={() => setSel(sel === term ? null : term)}>{term}</ToggleButton>
  );
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
          <div className="flex flex-wrap gap-1">{NODE_TERMS.map(chip)}</div>
          <div className="flex flex-wrap gap-1">{LINK_TERMS.map(chip)}</div>
          <div className="rounded-md border border-line bg-raised px-2 py-2 min-h-[3rem]" data-testid="legend-definition">
            {sel
              ? <><div className="text-fg font-medium">{sel}</div><div className="text-fg-muted leading-snug">{DEF[sel]}</div></>
              : <span className="text-fg-muted">Click a part of the network.</span>}
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
