import { useEffect, useState } from "react";
import { getParams, type Params } from "../api";

export default function ProvenanceFooter({ datasetId, testid = "provenance-footer" }:
  { datasetId: string; testid?: string }) {
  const [p, setP] = useState<Params | null>(null);
  useEffect(() => {
    let live = true;
    setP(null);
    getParams(datasetId).then((r) => { if (live) setP(r); }).catch(() => { if (live) setP(null); });
    return () => { live = false; };
  }, [datasetId]);

  const thr = p?.thresholds;
  return (
    <div className="text-[10px] text-slate-500 tabular-nums leading-snug" data-testid={testid}>
      {datasetId} ·{" "}
      {p == null ? "retrieving …" : (
        <>
          {thr?.recorded
            ? <>run {thr.run_id ?? "—"} · computed {thr.computed_at ?? "—"}</>
            : <>run not recorded</>}
          {" "}· retrieved {fmtUtc(p.retrieved_at)} · {p.counts.n_asv} ASVs / {p.counts.n_sample} samples
        </>
      )}
    </div>
  );
}

function fmtUtc(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]} UTC` : iso;
}
