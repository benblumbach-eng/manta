import { useEffect, useState } from "react";
import { getEdge, type EdgeDetail, type EdgeDirection, type EdgeEndpoint } from "../api";
import ProvenanceFooter from "./ProvenanceFooter";
import InfoTip from "./InfoTip";
import { useModules } from "../modules";


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
  const [err, setErr] = useState<string | null>(null);
  const [fourier, setFourier] = useState(true);

  useEffect(() => {
    setD(null); setErr(null);
    getEdge(datasetId, source, target, type).then(setD).catch((e) => setErr(String(e)));
  }, [datasetId, source, target, type]);

  const arrow = type === "ccm" ? "→" : "—";

  return (
    <div className="h-full overflow-auto"
      data-testid="edge-drawer">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-700 sticky top-0 bg-slate-900 z-10">
        <span className="flex items-center text-sm">
          <span className="font-mono text-cyan-300">{source}</span>
          <span className="text-slate-400"> {arrow} </span>
          <span className="font-mono text-cyan-300">{target}</span>
          {d && (
            <span className="ml-2 text-xs text-slate-500" data-testid="edge-modules">
              {modules.label(d.source.cluster)} {arrow} {modules.label(d.target.cluster)}
              {d.cross_cluster && <span className="ml-1 text-amber-400">crosses modules</span>}
            </span>
          )}
          {d && (
            <InfoTip title="Definitions of this run">
              {d.decision_note && <p data-testid="edge-decision-note">{d.decision_note}</p>}
              <p>Thresholds of this run: {d.thresholds.recorded
                ? <>Pearson ≥ {d.thresholds.con_tr} · p &lt; {d.thresholds.con_alpha}{" "}
                  (Benjamini-Hochberg) · CCM NMI ≥ {d.thresholds.ccmn_tr},{" "}
                  {d.thresholds.num_permutations} permutations</>
                : <>not recorded for this dataset — the values shown are OTTER&rsquo;s
                  defaults</>}.</p>
              <p className="text-slate-500" data-testid="edge-source-citation">
                Definitions after {d.source_publication.citation},
                doi:{d.source_publication.doi}.
              </p>
            </InfoTip>
          )}
        </span>
        <button onClick={onClose} data-testid="edge-drawer-close" aria-label="Close" className="text-slate-400 hover:text-white">✕</button>
      </div>

      {err && <div className="p-4 text-red-300" data-testid="error">{err}</div>}
      {!d && !err && <div className="p-4 text-slate-500">loading …</div>}

      {d && (
        <div className="p-5 space-y-4 text-sm">
          <Numbers d={d} />
          <p className="text-[10px] text-slate-500" data-testid="edge-declaration">
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
          <span className="tabular-nums text-slate-100 text-base"
            title={`${istCon ? "corr" : "NMI"} ${voll(staerke)} · ${rohP}`}>
            {num(staerke, 4)}
          </span>
        </Row>
        <Row label="p (BH-adjusted)" testid="edge-p-adj">
          <span className="tabular-nums text-slate-100 text-base"
            title={`p adjusted ${voll(d.edge.p_adj_fdr)} · ${rohP}`}>
            {d.edge.p_adj_fdr == null ? "—" : d.edge.p_adj_fdr.toExponential(2)}
          </span>
        </Row>
        {richtungUnbekannt ? (
          <Row label="Direction" testid="edge-direction">
            <span className="text-slate-400" data-testid="edge-dir-unknown">
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
            <td className="py-0.5 text-[11px] text-amber-400/80" data-testid="edge-ccm-resolution">
              CCM p: {d.thresholds.num_permutations} permutations — few distinct values possible
            </td>
          </tr>
        )}
        <tr>
          <td />
          <td className="py-0.5 text-[11px] text-amber-400/80" data-testid="edge-ccm-caveat">
            CCM: predictive value without a convergence test — no evidence of causation.
          </td>
        </tr>
        <Row label="Seen together" testid="edge-seen-together">
          <span className="tabular-nums text-slate-100">
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
      <span className="text-slate-400" data-testid={testid}>
        {recorded ? "not tested"
          : "none kept — rejected directions not recorded for this dataset"}
      </span>
    );
  }
  const rejected = dir.decision === "rejected";
  return (
    <span className={`tabular-nums text-base ${rejected ? "text-slate-300" : "text-slate-100"}`}
      title={`NMI ${voll(dir.nmi)} · p ${voll(dir.p_value)}`}>
      {num(dir.nmi, 4)}
      <span className="ml-2 text-xs text-slate-400">p {pRoh(dir.p_value)}</span>
      {dir.decision && (
        <span data-testid={testid}
          className={`ml-2 text-[11px] ${rejected ? "text-amber-400" : "text-emerald-300"}`}>
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
      <td className="pr-3 py-0.5 align-top text-slate-500 whitespace-nowrap w-[9.5rem]">
        {label}
      </td>
      <td className="py-0.5">{children}</td>
    </tr>
  );
}
function Pattern({ d, fourier, onFourier, width }: {
  d: EdgeDetail; fourier: boolean; onFourier: (v: boolean) => void; width: number;
}) {
  const pat = d.pattern;
  if (!pat) return null;
  const H = 150, PAD_L = 8, PAD_R = 8, PAD_T = 8, PAD_B = 16;
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
        <line x1={PAD_L} y1={mid} x2={PAD_L + plotW} y2={mid} stroke="#334155" />
        <path d={path(norm(centred(pat.source_raw)))} fill="none"
          stroke="#22d3ee" strokeWidth="0.8" opacity="0.35" />
        <path d={path(norm(centred(pat.target_raw)))} fill="none"
          stroke="#fbbf24" strokeWidth="0.8" opacity="0.35" />
        {fourier && <>
          <path d={path(norm(pat.source_pattern))} fill="none" stroke="#22d3ee" strokeWidth="1.8" />
          <path d={path(norm(pat.target_pattern))} fill="none" stroke="#fbbf24" strokeWidth="1.8" />
        </>}
        <text x={PAD_L} y={H - 4} fill="#64748b" fontSize="9">
          {pat.time_axis === "dates"
            ? `${pat.samples[0]?.date ?? ""} → ${pat.samples[n - 1]?.date ?? ""} (sample order)`
            : `sample order, 1 → ${n}`}
        </text>
      </svg>
      <div className="text-[11px] text-slate-400 flex flex-wrap items-center gap-x-3">
        <span><span className="inline-block w-3 h-0.5 align-middle mr-1"
          style={{ background: "#22d3ee" }} />{d.source.id}</span>
        <span><span className="inline-block w-3 h-0.5 align-middle mr-1"
          style={{ background: "#fbbf24" }} />{d.target.id}</span>
        <label className="flex items-center gap-1 text-slate-500 cursor-pointer">
          <input type="checkbox" checked={fourier} data-testid="edge-fourier-toggle"
            onChange={(e) => onFourier(e.target.checked)} />
          rhythms 1–{pat.n_rhythms}
        </label>
      </div>
      {pat.time_axis !== "dates" && (
        <p className="text-[10px] text-slate-500" data-testid="edge-pattern-axis">
          sample order only — no sampling dates
        </p>
      )}
    </section>
  );
}

function Endpoint({ e, onOpen }: { e: EdgeEndpoint; onOpen: (id: string) => void }) {
  const modules = useModules();
  return (
    <div className="rounded border border-slate-700 bg-slate-950/60 p-2" data-testid="edge-endpoint">
      <button data-testid="edge-endpoint-open" onClick={() => onOpen(e.id)}
        className="text-left hover:underline">
        <span className="font-mono text-cyan-300">{e.id}</span>{" "}
        <span className="text-slate-200">{e.lineage.genus ?? "unassigned"}</span>
      </button>
      <div className="mt-0.5 text-[11px] text-slate-500">
        {[e.lineage.phylum, e.lineage.class, e.lineage.family].filter(Boolean).join(" › ") || "no taxonomy"}
        {e.cluster != null && <> · {modules.label(e.cluster)}</>}
      </div>
    </div>
  );
}
