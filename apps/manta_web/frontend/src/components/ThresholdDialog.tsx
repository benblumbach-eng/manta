import { Button, Dialog } from "./ui";
import { useEffect, useRef, useState } from "react";
import { getImportStatus, getRecomputeEstimate, recompute, fmtMinutes, pastEstimate, STILL_RUNNING,
         PRODUCTION_THRESHOLDS,
         type ImportStatus, type RecomputeAck, type RecomputePreview, type ThresholdInput,
         type Thresholds } from "../api";
import InfoTip from "./InfoTip";
import { fmtUtc } from "../format";

export default function ThresholdDialog({ datasetId, current, onClose, onDone, onOpenDataset }: {
  datasetId: string;
  current: Thresholds;
  onClose: () => void;
  onDone: () => void;
  onOpenDataset?: (datasetId: string) => void;
}) {
  const [t, setT] = useState<ThresholdInput>(current.recorded ? {
    con_tr: current.con_tr, con_alpha: current.con_alpha, ccmn_tr: current.ccmn_tr,
    louvain_res: current.louvain_res, fft_coeffs: current.fft_coeffs,
    num_permutations: current.num_permutations, num_samples: current.num_samples,
  } : { ...PRODUCTION_THRESHOLDS });
  const [job, setJob] = useState<ImportStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ack, setAck] = useState<RecomputeAck | null>(null);
  const [vorschau, setVorschau] = useState<RecomputePreview | null>(null);
  const [vorschauErr, setVorschauErr] = useState<string | null>(null);
  useEffect(() => {
    if (ack) return;
    let aktuell = true;
    const h = setTimeout(() => {
      getRecomputeEstimate(datasetId, t.num_permutations, t.num_samples)
        .then((v) => { if (aktuell) { setVorschau(v); setVorschauErr(null); } })
        .catch((e) => { if (aktuell) setVorschauErr(String(e instanceof Error ? e.message : e)); });
    }, 300);
    return () => { aktuell = false; clearTimeout(h); };
  }, [datasetId, t.num_permutations, t.num_samples, ack]);
  const est = ack?.estimate ?? vorschau?.estimate ?? null;
  const neueId = ack?.new_dataset_id ?? vorschau?.new_dataset_id ?? null;

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
    } catch (e) { setErr(String(e instanceof Error ? e.message : e)); }
  };

  const running = job?.status === "running" || (!!ack && !job);
  const done = job?.status === "done";
  const zuGross = est != null && !est.fits;

  const titel = (
        <span className="flex items-center">
            Network thresholds
            <InfoTip title="What these values decide">
              <p>They decide which correlated pairs become links at all: the correlation cut and
              its p-value select the co-occurrence links, the permutation test decides which of
              them keep a direction.</p>
              <p>Recomputing creates a new dataset next to this one: the samples, values,
              environment and taxonomy are copied, the network is computed anew from all ASVs.
              This dataset stays exactly as it is — its network, module names, notes and stars.
              The new one appears in the list under the original, and each can be deleted on its
              own.</p>
              <p>The run time is a range estimated from measurements on one machine; another
              machine or a longer series can take longer.</p>
              {!current.recorded && (
                <p>Nothing was recorded for the current network, so its settings are unknown.
                The fields start on the values a new run uses ({PRODUCTION_THRESHOLDS.num_permutations}{" "}
                permutations), not on OTTER&rsquo;s test defaults and not on what this dataset was
                computed with.</p>
              )}
            </InfoTip>
        </span>
  );
  const knoepfe = (
    <>
      <Button size="md" onClick={onClose} data-testid="threshold-dismiss">
        {!ack ? "Cancel" : running ? "Close (keeps running)" : "Close"}
      </Button>
      {done && ack && onOpenDataset ? (
        <Button size="md" variant="primary" data-testid="threshold-open-new"
          onClick={() => onOpenDataset(ack.new_dataset_id)}>
          Open new dataset
        </Button>
      ) : (
        <Button size="md" variant="primary" data-testid="threshold-run" onClick={start}
          disabled={running || !!ack || zuGross}
          reason={zuGross ? "not enough memory for this run (see above)" : "a recomputation is already running"}>
          {running ? "computing …" : "Recompute as new dataset"}
        </Button>
      )}
    </>
  );

  return (
    <Dialog title={titel} onClose={onClose} testid="threshold-dialog" closeTestid="threshold-close"
      closeLabel="Close" width="max-w-[560px]" footer={knoepfe}>
        {!current.recorded && (
          <p className="mt-1 text-xs text-warn" data-testid="threshold-unrecorded">
            not recorded for this dataset — fields start on the values of a new run
            ({PRODUCTION_THRESHOLDS.num_permutations} permutations)
          </p>
        )}
        {current.recorded && current.computed_at && (
          <p className="mt-1 text-xs text-fg-muted">
            computed <span className="whitespace-nowrap">{fmtUtc(current.computed_at)}</span>
          </p>
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
          <Field label="CCM permutations" value={t.num_permutations} step={1} min={1} max={1000}
            testid="thr-permutations" integer onChange={(v) => setT({ ...t, num_permutations: v })}
            tip={<><p>Sets how fine the CCM p-values can be: the null holds at most permutations ×
              sampled pairs × 2 values, capped at the number of directions tested, and p moves in
              steps of one over that. With 2 permutations and 10 pairs the step is 1/40 — below
              the 0.05 cut only 0.0 and 0.025 remain. That is a test configuration, not an
              analysis one.</p>
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

        <p className="mt-2 text-xs text-fg-muted leading-snug" data-testid="thr-ccmn-note">
          CCM threshold {t.ccmn_tr}: recorded only — OTTER does not apply it; the permutation
          test selects the directions.
        </p>

        <p className="mt-3 text-xs text-ok leading-snug" data-testid="threshold-new-dataset">
          Creates a new dataset — the original stays unchanged.
        </p>
        {neueId && (
          <p className="mt-1 text-2xs text-fg-muted leading-snug break-all" data-testid="threshold-new-id">
            new id <code className="text-fg">{neueId}</code>
          </p>
        )}
        {est && (
          <p className={`mt-1 text-xs leading-snug tabular-nums ${zuGross ? "text-danger" : "text-warn"}`}
             data-testid="threshold-estimate" title={est.basis}>
            all {est.n_asv} ASVs · expected {fmtMinutes(est)} · memory ~{est.memory_gb} GB
            {est.memory_budget_gb != null ? ` of ${est.memory_budget_gb} GB` : ""}
          </p>
        )}
        {zuGross && !ack && (
          <p className="mt-1 text-xs text-danger leading-snug" data-testid="threshold-refusal">
            {est?.refusal}
          </p>
        )}
        {vorschauErr && !est && (
          <p className="mt-1 text-xs text-danger" data-testid="threshold-estimate-error">{vorschauErr}</p>
        )}

        {err && <div className="mt-2 text-xs text-danger" data-testid="threshold-error">{err}</div>}

        {ack && (
          <div className="mt-2 text-xs text-fg" data-testid="threshold-progress">
            {job?.status === "error"
              ? <span className="text-danger">failed: {job.error}</span>
              : done
                ? <span className="text-ok">done — the new dataset is in the list.</span>
                : <>running · stage {job?.stage ?? "queued"} — closing this window does not stop it.
                    {pastEstimate(est, job?.started_at, Date.now() / 1000) && <> {STILL_RUNNING}.</>}</>}
            {done && (job?.notes ?? []).map((n) => (
              <p key={n} className="mt-1 text-warn break-words" data-testid="threshold-note">{n}</p>
            ))}
          </div>
        )}

    </Dialog>
  );
}

function Field({ label, value, onChange, step, min, max, tip, integer, testid }: {
  label: string; value: number; onChange: (v: number) => void;
  step: number; min: number; max: number; tip: React.ReactNode; integer?: boolean; testid: string;
}) {
  return (
    <label className="text-xs text-fg-muted">
      <span className="flex items-center">{label}<InfoTip title={label}>{tip}</InfoTip></span>
      <input type="number" data-testid={testid} value={value} step={step} min={min} max={max}
        onChange={(e) => {
          const v = integer ? parseInt(e.target.value, 10) : parseFloat(e.target.value);
          if (!Number.isNaN(v)) onChange(v);
        }}
        className="mt-1 w-full px-2 py-1 rounded-md bg-control border border-line-strong text-fg tabular-nums" />
    </label>
  );
}
