import { StateNotice } from "./ui";
import { useEffect, useState } from "react";
import { getEdge, type EdgeDetail, type EdgeDirection, type EdgeEndpoint } from "../api";
import ProvenanceFooter from "./ProvenanceFooter";
import ErrorNotice from "./ErrorNotice";
import InfoTip from "./InfoTip";
import { PanelHeader } from "./PanelFrame";
import { useModules } from "../modules";
import { useTokens } from "../design/tokens";
import { seriesColour } from "../design/dataColours";


const num = (v: number | null | undefined, d: number) => (v == null ? "—" : v.toFixed(d));
const voll = (v: number | null | undefined) => (v == null ? "—" : String(v));
const pRoh = (v: number | null | undefined) => (v == null ? "—" : String(v));

export default function EdgeDrawer({ datasetId, source, target, type, onClose, onOpenAsv }: {
  datasetId: string;
  source: string;
  target: string;
  type: "con" | "ccm";
  onClose: () => void;
  onOpenAsv: (id: string) => void;
}) {
  const modules = useModules();
  const [d, setD] = useState<EdgeDetail | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [nochmal, setNochmal] = useState(0);
  const [fourier, setFourier] = useState(true);

  useEffect(() => {
    setD(null); setErr(null);
    let alive = true;
    getEdge(datasetId, source, target, type).then((x) => { if (alive) setD(x); })
      .catch((e) => { if (alive) setErr(e); });
    return () => { alive = false; };
  }, [datasetId, source, target, type, nochmal]);

  const arrow = type === "ccm" ? "→" : "—";

  return (
    <div data-testid="edge-drawer">
      <PanelHeader onClose={onClose} closeTestid="edge-drawer-close"
        title={<span className="font-normal select-text cursor-text" data-no-drag="">
          <span className="font-mono text-accent">{source}</span>
          <span className="text-fg-muted"> {arrow} </span>
          <span className="font-mono text-accent">{target}</span>
        </span>}>
          {d && (
            <span className="min-w-0 truncate text-xs text-fg-muted" data-testid="edge-modules">
              {modules.label(d.source.cluster)} {arrow} {modules.label(d.target.cluster)}
              {d.cross_cluster && <span className="ml-1 text-warn">crosses modules</span>}
            </span>
          )}
          {d && (
            <InfoTip title="Definitions of this run"
              ask={{ concept: "CO_OCCURS_WITH", question: "What does a co-occurrence link mean here, and what does it not?" }}>
              {d.decision_note && <p data-testid="edge-decision-note">{d.decision_note}</p>}
              <p>Thresholds of this run: {d.thresholds.recorded
                ? <>Pearson ≥ {d.thresholds.con_tr} · p &lt; {d.thresholds.con_alpha}{" "}
                  (Benjamini-Hochberg) · CCM directions by permutation test,{" "}
                  {d.thresholds.num_permutations} permutations</>
                : <>not recorded for this dataset — the values shown are OTTER&rsquo;s
                  defaults</>}.</p>
              <p className="text-fg-muted" data-testid="edge-source-citation">
                Definitions after {d.source_publication.citation},
                doi:{d.source_publication.doi}.
              </p>
            </InfoTip>
          )}
      </PanelHeader>

      {err != null && <ErrorNotice error={err} what="Could not load this link."
        onRetry={() => setNochmal((n) => n + 1)} />}
      {!d && err == null && <StateNotice state="loading">loading …</StateNotice>}

      {d && (
        <div className="p-6 space-y-4 text-sm">
          <Numbers d={d} />
          <p className="text-2xs text-fg-muted" data-testid="edge-declaration">
            r = Pearson on the Fourier coefficients 1–{(d.pattern?.fft_coeffs ?? d.thresholds?.fft_coeffs ?? 14) - 1} (a shared pattern, not an interaction) · NMI = CCM without a convergence test — no evidence of causation
          </p>
          <Pattern d={d} fourier={fourier} onFourier={setFourier} width={470} />

          <div className="space-y-2">
            <Endpoint e={d.source} onOpen={onOpenAsv} />
            <Endpoint e={d.target} onOpen={onOpenAsv} />
          </div>
          <ProvenanceFooter datasetId={datasetId} />
        </div>
      )}
    </div>
  );
}

function Numbers({ d }: { d: EdgeDetail }) {
  const fwd = d.directions?.forward ?? null;
  const bwd = d.directions?.backward ?? null;
  const richtungUnbekannt = d.directions == null;
  const anyDir = fwd != null || bwd != null;
  const istCon = d.type === "con";
  const staerke = istCon ? d.edge.corr : d.edge.nmi;
  const rohP = `raw p ${voll(d.edge.p_value)}`;
  return (
    <table className="text-sm w-full" data-testid="edge-numbers">
      <tbody>
        <Row label={istCon ? "Strength r" : "Strength NMI"} testid="edge-strength">
          <span className="tabular-nums text-fg text-base"
            title={`${istCon ? "corr" : "NMI"} ${voll(staerke)} · ${rohP}`}>
            {num(staerke, 4)}
          </span>
        </Row>
        <Row label="p (BH-adjusted)" testid="edge-p-adj">
          <span className="tabular-nums text-fg text-base"
            title={`p adjusted ${voll(d.edge.p_adj_fdr)} · ${rohP}`}>
            {d.edge.p_adj_fdr == null ? "—" : d.edge.p_adj_fdr.toExponential(2)}
          </span>
        </Row>
        {richtungUnbekannt ? (
          <Row label="Direction" testid="edge-direction">
            <span className="text-fg-muted" data-testid="edge-dir-unknown">
              not reported by this server
            </span>
          </Row>
        ) : (
          <>
            <Row label="NMI →" testid="edge-dir-forward">
              <Direction dir={fwd} recorded={d.ccm_tested_recorded} testid="edge-dir-forward-decision" />
            </Row>
            <Row label="NMI ←" testid="edge-dir-backward">
              <Direction dir={bwd} recorded={d.ccm_tested_recorded} testid="edge-dir-backward-decision" />
            </Row>
          </>
        )}
        {anyDir && (
          <tr>
            <td />
            <td className="py-1 text-xs text-warn" data-testid="edge-ccm-resolution">
              <span className="inline-flex items-center">
                {d.ccm_p_resolution?.short
                  ?? `CCM p: ${d.thresholds.num_permutations} permutations`}
                {d.ccm_p_resolution?.statement && (
                  <InfoTip title="How fine the CCM p-values can be">
                    <p data-testid="edge-ccm-resolution-full">{d.ccm_p_resolution.statement}</p>
                  </InfoTip>
                )}
              </span>
            </td>
          </tr>
        )}
        <tr>
          <td />
          <td className="py-1 text-xs text-warn" data-testid="edge-ccm-caveat">
            CCM: predictive value without a convergence test — no evidence of causation.
          </td>
        </tr>
        <Row label="Seen together" testid="edge-seen-together">
          <span className="tabular-nums text-fg">
            {d.co_detected_in} of {d.n_samples} samples
          </span>
        </Row>
      </tbody>
    </table>
  );
}

function Direction({ dir, recorded, testid }: {
  dir: EdgeDirection | null; recorded: boolean | undefined; testid: string;
}) {
  if (!dir) {
    return (
      <span className="text-fg-muted" data-testid={testid}>
        {recorded ? "not tested"
          : "none kept — rejected directions not recorded for this dataset"}
      </span>
    );
  }
  const rejected = dir.decision === "rejected";
  return (
    <span className={`tabular-nums text-base ${rejected ? "text-fg" : "text-fg"}`}
      title={`NMI ${voll(dir.nmi)} · p ${voll(dir.p_value)}`}>
      {num(dir.nmi, 4)}
      <span className="ml-2 text-xs text-fg-muted">p {pRoh(dir.p_value)}</span>
      {dir.decision && (
        <span data-testid={testid}
          className={`ml-2 text-xs ${rejected ? "text-warn" : "text-ok"}`}>
          {rejected ? "tested, rejected" : "kept"}
        </span>
      )}
    </span>
  );
}

function Row({ label, testid, children }: {
  label: string; testid: string; children: React.ReactNode;
}) {
  return (
    <tr data-testid={testid}>
      <td className="pr-3 py-1 align-top text-fg-muted whitespace-nowrap w-[9.5rem]">
        {label}
      </td>
      <td className="py-1">{children}</td>
    </tr>
  );
}
function Pattern({ d, fourier, onFourier, width }: {
  d: EdgeDetail; fourier: boolean; onFourier: (v: boolean) => void; width: number;
}) {
  const hell = useTokens().light;
  const SRC = seriesColour(0, hell), TGT = seriesColour(1, hell);
  const pat = d.pattern;
  if (!pat) return null;
  const H = 152, PAD_L = 8, PAD_R = 8, PAD_T = 8, PAD_B = 18;
  const plotW = width - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
  const n = pat.samples.length;
  const X = (i: number) => PAD_L + (n > 1 ? (i / (n - 1)) * plotW : 0);
  const norm = (vs: number[]) => {
    const m = Math.max(...vs.map((v) => Math.abs(v)), 1e-12);
    return vs.map((v) => v / m);
  };
  const mid = PAD_T + plotH / 2;
  const Y = (v: number) => mid - v * (plotH / 2) * 0.92;
  const path = (vs: number[]) =>
    vs.map((v, i) => `${i ? "L" : "M"} ${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(" ");
  const centred = (vs: number[]) => {
    const mean = vs.reduce((a, b) => a + b, 0) / Math.max(1, vs.length);
    return vs.map((v) => v - mean);
  };
  return (
    <section data-testid="edge-pattern">
      <svg width={width} height={H} role="img"
        aria-label="the two series and their Fourier reconstruction">
        <line x1={PAD_L} y1={mid} x2={PAD_L + plotW} y2={mid} stroke="var(--chart-axis)" />
        <path d={path(norm(centred(pat.source_raw)))} fill="none"
          stroke={SRC} strokeWidth="0.8" opacity="0.35" />
        <path d={path(norm(centred(pat.target_raw)))} fill="none"
          stroke={TGT} strokeWidth="0.8" opacity="0.35" />
        {fourier && <>
          <path d={path(norm(pat.source_pattern))} fill="none" stroke={SRC} strokeWidth="1.8" />
          <path d={path(norm(pat.target_pattern))} fill="none" stroke={TGT} strokeWidth="1.8" />
        </>}
        <text x={PAD_L} y={H - 4} fill="var(--text-muted)" fontSize="11">
          {pat.time_axis === "dates"
            ? `${pat.samples[0]?.date ?? ""} → ${pat.samples[n - 1]?.date ?? ""} (sample order)`
            : `sample order, 1 → ${n}`}
        </text>
      </svg>
      <div className="text-2xs text-fg-muted flex flex-wrap items-center gap-x-3">
        <span><span className="inline-block w-3 h-0.5 align-middle mr-1"
          style={{ background: SRC }} />{d.source.id}</span>
        <span><span className="inline-block w-3 h-0.5 align-middle mr-1"
          style={{ background: TGT }} />{d.target.id}</span>
        <label className="flex items-center gap-1 text-fg-muted cursor-pointer">
          <input type="checkbox" checked={fourier} data-testid="edge-fourier-toggle"
            onChange={(e) => onFourier(e.target.checked)} />
          rhythms 1–{pat.n_rhythms}
        </label>
      </div>
      {pat.time_axis !== "dates" && (
        <p className="text-2xs text-fg-muted" data-testid="edge-pattern-axis">
          sample order only — no sampling dates
        </p>
      )}
    </section>
  );
}

function Endpoint({ e, onOpen }: { e: EdgeEndpoint; onOpen: (id: string) => void }) {
  const modules = useModules();
  return (
    <div className="rounded border border-line bg-surface/60 p-2" data-testid="edge-endpoint">
      <button data-testid="edge-endpoint-open" onClick={() => onOpen(e.id)}
        className="text-left hover:underline">
        <span className="font-mono text-accent">{e.id}</span>{" "}
        <span className="text-fg">{e.lineage.genus ?? "unassigned"}</span>
      </button>
      <div className="mt-1 text-2xs text-fg-muted">
        {[e.lineage.phylum, e.lineage.class, e.lineage.family].filter(Boolean).join(" › ") || "no taxonomy"}
        {e.cluster != null && <> · {modules.label(e.cluster)}</>}
      </div>
    </div>
  );
}
