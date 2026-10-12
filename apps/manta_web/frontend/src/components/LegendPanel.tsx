import type { Criterion2Summary, Thresholds } from "../api";
import { useModules } from "../modules";
import { FUNCTION_NONE } from "../clusterPalette";
import { SectionHeading } from "./ui";
import { PanelHeader } from "./PanelFrame";
import { Criterion2Details } from "./Criterion2";

export default function LegendPanel({ thr, c2, labelMax, functionClasses = [], colorMode = "module",
  sizeAbsent = false, widthText = null, onClose }: {
  datasetId: string;
  thr: Thresholds | undefined;
  c2: Criterion2Summary | null;
  labelMax: number;
  functionClasses?: { label: string; n: number; color: string; other?: boolean }[];
  colorMode?: "module" | "function";
  sizeAbsent?: boolean;
  widthText?: string | null;
  onClose: () => void;
}) {
  const modules = useModules();
  const c0 = modules.color(0), c1 = modules.color(1);
  const LINE = "var(--net-link)", AMBER = "var(--cross-link)", CYAN = "var(--accent)", GREY = FUNCTION_NONE,
        BG = "var(--net-node-outline)";

  const W = 48, H = 20, MY = H / 2;
  const Svg = ({ children }: { children: React.ReactNode }) => (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="shrink-0" aria-hidden="true">{children}</svg>
  );
  const arrow = (x2: number, dashed = false, color = LINE) => (
    <>
      <line x1={6} y1={MY} x2={x2} y2={MY} stroke={color} strokeWidth={1.5}
            strokeDasharray={dashed ? "4 3" : undefined} />
      <polygon points={`${x2},${MY} ${x2 - 7},${MY - 4} ${x2 - 7},${MY + 4}`} fill={color} />
    </>
  );
  const node = <Svg><circle cx={W / 2} cy={MY} r={6} fill={c0} stroke={BG} strokeWidth={1} /></Svg>;
  const size = <Svg><circle cx={14} cy={MY} r={3} fill={c1} /><circle cx={32} cy={MY} r={8} fill={c1} /></Svg>;
  const glowS = <Svg><circle cx={W / 2} cy={MY} r={6} fill={c0} stroke="var(--mark)" strokeWidth={2}
                            style={{ filter: "drop-shadow(0 0 3px var(--mark))" }} /></Svg>;
  const open = <Svg><circle cx={W / 2} cy={MY} r={6} fill={c0} stroke={CYAN} strokeWidth={2} /></Svg>;
  const marked = <Svg><circle cx={W / 2} cy={MY} r={6} fill={c0} stroke="var(--text)" strokeWidth={1.5}
                              strokeDasharray="2 2" /></Svg>;
  const grey = <Svg><circle cx={W / 2} cy={MY} r={6} fill={GREY} /></Svg>;
  const link = <Svg><line x1={6} y1={MY} x2={W - 6} y2={MY} stroke={LINE} strokeWidth={1.5} /></Svg>;
  const width = <Svg><line x1={6} y1={MY - 4} x2={W - 6} y2={MY - 4} stroke={LINE} strokeWidth={1} />
                     <line x1={6} y1={MY + 5} x2={W - 6} y2={MY + 5} stroke={LINE} strokeWidth={4} /></Svg>;
  const dir = <Svg>{arrow(W - 6)}</Svg>;
  const rejected = <Svg>{arrow(W - 6, true)}</Svg>;
  const side = <Svg>
    <line x1={6} y1={MY + 3} x2={W - 6} y2={MY + 3} stroke={LINE} strokeWidth={1.5} />
    <path d={`M ${W - 6} ${MY + 3} Q ${W / 2} ${MY - 9} 6 ${MY + 3}`} fill="none" stroke={LINE}
          strokeWidth={1} strokeDasharray="3 3" />
    <polygon points={`6,${MY + 3} 12,${MY - 1} 12,${MY + 5}`} fill={LINE} opacity={0.8} />
  </Svg>;
  const cross = <Svg><line x1={6} y1={MY} x2={W - 6} y2={MY} stroke={AMBER} strokeWidth={1.5} /></Svg>;

  const t = thr;
  const Row = ({ sample, term, desc, testid, label }: { sample: React.ReactNode; term: string; desc: string; testid?: string; label?: string }) => (
    <div className="flex items-start gap-2 py-1" data-testid={testid} data-label={label}>
      {sample}
      <div className="min-w-0">
        <span className="text-fg">{term}</span>
        <span className="text-fg-muted"> — {desc}</span>
      </div>
    </div>
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
        <Section title="Nodes">
          <Row sample={node} term="ASV" desc="one ASV, an exactly resolved sequence type — one circle each" />
          <Row sample={<Svg><circle cx={14} cy={MY} r={5} fill={colorMode === "function" ? (functionClasses[0]?.color ?? GREY) : c0} />
                            <circle cx={30} cy={MY} r={5} fill={colorMode === "function" ? (functionClasses[1]?.color ?? GREY) : c1} /></Svg>}
               term="Colour" testid="legend-colour-row" desc={colorMode === "function"
            ? "literature-annotated function, in its own colours (grey = not annotated; in the taxa view also mixed classes); switch back to modules in the sidebar"
            : `module ${modules.label(0)}, ${modules.label(1)}, …: a group with more links among themselves than chance would give`} />
          <Row sample={size} term="Size" testid="legend-size-row" desc={sizeAbsent
            ? "not computed for this dataset: its values are a transform of unknown form — all circles are drawn the same size"
            : "circle area relative to the largest circle in view = stored value summed over all samples"} />
          {c2 && (
            <div className="flex items-start gap-2 py-1">
              {glowS}
              <div className="min-w-0 space-y-1">
                <div data-testid="legend-c2">
                  <span className="text-fg">✦ Hub</span>
                  <span className="text-fg-muted"> — {c2.glow}</span>
                </div>
                <Criterion2Details c2={c2} testid="legend-c2-declaration" />
              </div>
            </div>
          )}
          <Row sample={open} term="Open" desc="the ASV whose page is open" />
          <Row sample={marked} term="Marked" desc="found by search, or member of the marked taxon or module" />
          <Row sample={<Svg><text x={4} y={MY + 4} fontSize={11} fill="var(--text)">Genus</text></Svg>} term="Name"
               desc={`genus where known, otherwise the ASV id; shown up to ${labelMax} visible nodes`} />
        </Section>

        <Section title="Links">
          <Row sample={link} term="Link" testid="legend-link-row" desc={(t?.recorded
            ? `co-occurrence: r ≥ ${t.con_tr} and p < ${t.con_alpha} (Pearson on the Fourier coefficients)`
            : "co-occurrence (Pearson on the Fourier coefficients); thresholds not recorded")
            + " — positive correlations only; anti-correlated pairs are never linked"} />
          <Row sample={width} term="Width" testid="legend-width-row"
               desc={widthText ?? `strength on a fixed scale, the same in every filter: r from ${t?.con_tr ?? "the threshold"}${t?.recorded ? "" : " (default)"} to 1; with Links off, the larger NMI from 0 to 1`} />
          <Row sample={dir} term="Arrow" desc="CCM direction kept (p < 0.05): it points to the end that can be predicted from the other" />
          <Row sample={rejected} term="Dashed arrow" desc="CCM direction tested and rejected: p ≥ 0.05 (switch Rejected on)" />
          <Row sample={side} term="Side arrow" desc="a rejected direction shown beside a link that is drawn anyway" />
          <Row sample={cross} term="Amber" testid="legend-cross-row" desc="link between two different modules" />
        </Section>

        {colorMode === "function" && (
          <Section title="Colour = function">
            <div data-testid="legend-function-classes">
              {functionClasses.map((c) => (
                <Row key={c.label} sample={<Svg><circle cx={W / 2} cy={MY} r={6} fill={c.color} /></Svg>}
                     testid="legend-function-class" label={c.label}
                     term={c.label} desc={`${c.n} ASV${c.n === 1 ? "" : "s"}`} />
              ))}
              <Row sample={grey} term="not annotated" desc="no entry for this name in the literature tables — in the taxa view also a taxon whose members carry different classes" />
            </div>
            <p className="text-fg-muted leading-snug">Looked up by taxon name — a property of the name, not a result of this dataset.</p>
          </Section>
        )}

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
