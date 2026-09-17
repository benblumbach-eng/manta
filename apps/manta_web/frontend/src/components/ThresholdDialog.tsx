import { useEffect, useRef, useState } from "react";
import { getImportStatus, recompute, type ImportStatus, type ThresholdInput, type Thresholds } from "../api";
import InfoTip from "./InfoTip";

export default function ThresholdDialog({ datasetId, current, nAsv, onClose, onDone }: {
  datasetId: string;
  current: Thresholds;
  nAsv: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [t, setT] = useState<ThresholdInput>({
    con_tr: current.con_tr, con_alpha: current.con_alpha, ccmn_tr: current.ccmn_tr,
    louvain_res: current.louvain_res, fft_coeffs: current.fft_coeffs,
    num_permutations: current.num_permutations, num_samples: current.num_samples,
  });
  const [job, setJob] = useState<ImportStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ack, setAck] = useState<{ estimated_minutes: number; warning: string } | null>(null);

  const estimate = Math.round((nAsv * (nAsv - 1) / 2) * 0.011 / 60);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const start = async () => {
    setErr(null);
    try {
      const r = await recompute(datasetId, t);
      setAck(r);
      const poll = setInterval(async () => {
        try {
          const st = await getImportStatus(r.job_id);
          setJob(st);
          if (st.status !== "running") {
            clearInterval(poll);
            pollRef.current = null;
            if (st.status === "done") onDone();
          }
        } catch { }
      }, 2000);
      pollRef.current = poll;
    } catch (e) { setErr(String(e)); }
  };

  const running = job?.status === "running" || (!!ack && !job);

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-slate-950/70 p-4" data-testid="threshold-dialog">
      <div className="w-[560px] max-h-full overflow-auto rounded-lg border border-slate-600 bg-slate-900 p-4 shadow-2xl">
        <div className="flex items-start justify-between">
          <h2 className="flex items-center text-slate-100 font-medium">
            Network thresholds
            <InfoTip title="What these values decide">
              <p>They decide which correlated pairs become links at all: the correlation cut and
              its p-value select the co-occurrence links, the CCM threshold and the permutations
              decide which of them keep a direction.</p>
              <p>Recomputing replaces the network of this dataset only. Samples, abundances and
              time series stay exactly as they are — nothing measured is touched.</p>
              {!current.recorded && (
                <p>Nothing was recorded for the current network, so the fields start on
                OTTER&rsquo;s defaults. They are what the tool would use, not what this dataset
                was computed with.</p>
              )}
            </InfoTip>
          </h2>
          <button onClick={onClose} data-testid="threshold-close" aria-label="Close" className="text-slate-400 hover:text-white">✕</button>
        </div>

        {!current.recorded && (
          <p className="mt-1 text-xs text-amber-400" data-testid="threshold-unrecorded">
            defaults — not recorded for this dataset
          </p>
        )}
        {current.recorded && current.computed_at && (
          <p className="mt-1 text-xs text-slate-500">computed {current.computed_at}</p>
        )}

        <div className="mt-3 grid grid-cols-2 gap-3">
          <Field label="CON correlation ≥" value={t.con_tr} step={0.01} min={0} max={0.99}
            testid="thr-con-tr" onChange={(v) => setT({ ...t, con_tr: v })}
            tip={<><p>The cut that does the actual work. Higher means fewer, tighter links;
              lower opens the network up and adds weakly correlated pairs.</p></>} />
          <Field label="CON p <" value={t.con_alpha} step={0.005} min={0.001} max={1}
            testid="thr-con-alpha" onChange={(v) => setT({ ...t, con_alpha: v })}
            tip={<><p>Benjamini-Hochberg corrected. Weak on its own here: it is a Pearson
              statistic over the Fourier coefficients, not over the samples.</p></>} />
          <Field label="CCM threshold ≥" value={t.ccmn_tr} step={0.01} min={0} max={0.99}
            testid="thr-ccmn-tr" onChange={(v) => setT({ ...t, ccmn_tr: v })}
            tip={<p>Applied before the permutation pruning, which does the selecting.</p>} />
          <Field label="CCM permutations" value={t.num_permutations} step={1} min={1} max={1000}
            testid="thr-permutations" integer onChange={(v) => setT({ ...t, num_permutations: v })}
            tip={<><p>Caps how fine the CCM p-values can be. With 2 permutations only 0.0 and
              0.025 can occur — that is a test configuration, not an analysis one.</p>
              <p>More permutations cost time roughly in proportion.</p></>} />
          <Field label="Fourier coefficients" value={t.fft_coeffs} step={1} min={2} max={64}
            testid="thr-fft" integer onChange={(v) => setT({ ...t, fft_coeffs: v })}
            tip={<><p>How many frequencies of the time series enter the correlation. Calibrated
              for roughly 100 sampling points; on a short series the upper coefficients become
              redundant or constant.</p></>} />
          <Field label="Louvain resolution" value={t.louvain_res} step={0.1} min={0.1} max={10}
            testid="thr-louvain" onChange={(v) => setT({ ...t, louvain_res: v })}
            tip={<p>Higher values split the network into more, smaller clusters.</p>} />
        </div>

        <p className="mt-3 text-xs text-amber-400 leading-snug tabular-nums"
           data-testid="threshold-warning">
          Replaces this network · about {estimate} minute{estimate === 1 ? "" : "s"} for {nAsv} ASVs
        </p>

        {err && <div className="mt-2 text-xs text-red-300" data-testid="threshold-error">{err}</div>}

        {ack && (
          <div className="mt-2 text-xs text-slate-300" data-testid="threshold-progress">
            {job?.status === "error"
              ? <span className="text-red-300">failed: {job.error}</span>
              : job?.status === "done"
                ? <span className="text-emerald-300">done — the network has been replaced.</span>
                : <>running · stage {job?.stage ?? "queued"} — this window can stay open.</>}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1 rounded border border-slate-600 text-slate-300 hover:text-white">
            {job?.status === "done" ? "Close" : "Cancel"}
          </button>
          <button data-testid="threshold-run" onClick={start} disabled={running}
            className="px-3 py-1 rounded bg-cyan-700 text-white disabled:opacity-40">
            {running ? "computing …" : "Recompute network"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, step, min, max, tip, integer, testid }: {
  label: string; value: number; onChange: (v: number) => void;
  step: number; min: number; max: number; tip: React.ReactNode; integer?: boolean; testid: string;
}) {
  return (
    <label className="text-xs text-slate-400">
      <span className="flex items-center">{label}<InfoTip title={label}>{tip}</InfoTip></span>
      <input type="number" data-testid={testid} value={value} step={step} min={min} max={max}
        onChange={(e) => {
          const v = integer ? parseInt(e.target.value, 10) : parseFloat(e.target.value);
          if (!Number.isNaN(v)) onChange(v);
        }}
        className="mt-0.5 w-full px-2 py-1 rounded bg-slate-800 border border-slate-600 text-slate-100 tabular-nums" />
    </label>
  );
}
