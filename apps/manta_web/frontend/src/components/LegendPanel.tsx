import type { HubCriterion, Thresholds } from "../api";
import { useModules } from "../modules";

export default function LegendPanel({ thr, hub, labelMax, functionClasses = [], colorMode = "module", onClose }: {
  datasetId: string;
  thr: Thresholds | undefined;
  hub: HubCriterion | null;
  labelMax: number;
  functionClasses?: { label: string; n: number; color: string }[];
  colorMode?: "module" | "function";
  onClose: () => void;
}) {
  const modules = useModules();
  const c0 = modules.color(0), c1 = modules.color(1);
  const LINE = "#5b6b8c", AMBER = "#f59e0b", CYAN = "#22d3ee", GREY = "#94a3b8", BG = "#0f172a";

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
  const hubS = <Svg><circle cx={W / 2} cy={MY} r={6} fill={c0} stroke={AMBER} strokeWidth={2}
                            style={{ filter: `drop-shadow(0 0 3px ${AMBER})` }} /></Svg>;
  const open = <Svg><circle cx={W / 2} cy={MY} r={6} fill={c0} stroke={CYAN} strokeWidth={2} /></Svg>;
  const marked = <Svg><circle cx={W / 2} cy={MY} r={6} fill={c0} stroke="#e2e8f0" strokeWidth={1.5}
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
  const Row = ({ sample, term, desc, testid }: { sample: React.ReactNode; term: string; desc: string; testid?: string }) => (
    <div className="flex items-start gap-2 py-1" data-testid={testid}>
      {sample}
      <div className="min-w-0">
        <span className="text-slate-200">{term}</span>
        <span className="text-slate-400"> — {desc}</span>
      </div>
    </div>
  );
  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">{title}</div>
      {children}
    </div>
  );

  return (
    <div className="h-full overflow-auto" data-testid="legend-panel">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-700 sticky top-0 bg-slate-900 z-10">
        <span className="text-slate-100 font-medium">Legend</span>
        <button onClick={onClose} data-testid="legend-panel-close" aria-label="Close"
                className="text-slate-400 hover:text-white">✕</button>
      </div>

      <div className="p-4 space-y-4 text-xs">
        <Section title="Nodes">
          <Row sample={node} term="ASV" desc="one ASV, an exactly resolved sequence type — one circle each" />
          <Row sample={<Svg><circle cx={14} cy={MY} r={5} fill={c0} /><circle cx={30} cy={MY} r={5} fill={c1} /></Svg>}
               term="Colour" desc={colorMode === "function"
            ? "literature-annotated function (grey = not annotated); switch back to modules in the sidebar"
            : `module ${modules.label(0)}, ${modules.label(1)}, …: a group with more links among themselves than chance would give`} />
          <Row sample={size} term="Size" desc="circle area relative to the largest circle in view = stored value summed over all samples" />
          {hub && (
            <Row sample={hubS} term={hub.title ?? "Hub"} testid="legend-hub"
                 desc={`${hub.measure_label} above the mean plus ${hub.k} standard deviation${hub.k === 1 ? "" : "s"} of all network ASVs (⚙)`} />
          )}
          <Row sample={open} term="Open" desc="the ASV whose page is open" />
          <Row sample={marked} term="Marked" desc="found by search, or member of the marked taxon or module" />
          <Row sample={<Svg><text x={4} y={MY + 4} fontSize={11} fill="#cbd5e1">Genus</text></Svg>} term="Name"
               desc={`genus where known, otherwise the ASV id; shown up to ${labelMax} visible nodes`} />
        </Section>

        <Section title="Links">
          <Row sample={link} term="Link" desc={t?.recorded
            ? `co-occurrence: |r| ≥ ${t.con_tr} and p < ${t.con_alpha} (Pearson on the Fourier coefficients)`
            : "co-occurrence (Pearson on the Fourier coefficients); thresholds not recorded"} />
          <Row sample={width} term="Width" desc="strength: |r| of the co-occurrence; with Links off, the larger NMI" />
          <Row sample={dir} term="Arrow" desc="CCM direction kept (p < 0.05): it points to the end that can be predicted from the other" />
          <Row sample={rejected} term="Dashed arrow" desc="CCM direction tested and rejected: p ≥ 0.05 (switch Rejected on)" />
          <Row sample={side} term="Side arrow" desc="a rejected direction shown beside a link that is drawn anyway" />
          <Row sample={cross} term="Amber" desc="link between two different modules" />
        </Section>

        {colorMode === "function" && (
          <Section title="Colour = function">
            <div data-testid="legend-function-classes">
              {functionClasses.map((c) => (
                <Row key={c.label} sample={<Svg><circle cx={W / 2} cy={MY} r={6} fill={c.color} /></Svg>}
                     term={c.label} desc={`${c.n} ASV${c.n === 1 ? "" : "s"}`} />
              ))}
              <Row sample={grey} term="not annotated" desc="no entry for this name in the literature tables" />
            </div>
            <p className="text-slate-500 leading-snug">Looked up by taxon name — a property of the name, not a result of this dataset.</p>
          </Section>
        )}

        <Section title="Thresholds of this run">
          <p className="text-slate-300 tabular-nums" data-testid="legend-thresholds-line">
            {t?.recorded
              ? `r ≥ ${t.con_tr} · p < ${t.con_alpha} · NMI ≥ ${t.ccmn_tr} · ${t.num_permutations} permutations`
              : "the thresholds of this run are not recorded — the values shown elsewhere are OTTER's defaults"}
          </p>
        </Section>

        <Section title="Not encoded">
          <p className="text-slate-400 leading-snug" data-testid="legend-means-nothing">
            Position, circle shape, arrow-head size and list order carry no meaning.
          </p>
          <p className="text-slate-400 leading-snug" data-testid="legend-never-meant">
            A link is co-occurrence, not an interaction; an arrow is predictive value, not a cause.
          </p>
        </Section>
      </div>
    </div>
  );
}
