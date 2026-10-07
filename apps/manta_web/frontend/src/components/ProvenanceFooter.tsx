import { useEffect, useState } from "react";
import { getParams, type Params } from "../api";
import { fmtRun, fmtUtc } from "../format";

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
            ? <><span title={thr.run_id ? `run id: ${thr.run_id}` : undefined}>{fmtRun(thr.run_id)}</span>
                {" "}· computed <span className="whitespace-nowrap">{thr.computed_at ? fmtUtc(thr.computed_at) : "—"}</span></>
            : <>run not recorded</>}
          {" "}· retrieved <span className="whitespace-nowrap">{fmtUtc(p.retrieved_at)}</span>
          {" "}· {p.counts.n_asv} ASVs / {p.counts.n_sample} samples
        </>
      )}
    </div>
  );
}
