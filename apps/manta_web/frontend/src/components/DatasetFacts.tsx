import { useEffect, useState } from "react";
import { getApplicability, type Applicability, type Capabilities, type Dataset } from "../api";

export default function DatasetFacts({ dataset, caps }: {
  dataset: Dataset; caps: Capabilities | null;
}) {
  const [app, setApp] = useState<{ ds: string; t: Applicability["time_structure"] } | null>(null);
  useEffect(() => {
    let lebt = true;
    getApplicability(dataset.dataset_id)
      .then((a) => { if (lebt) setApp({ ds: dataset.dataset_id, t: a.time_structure }); })
      .catch(() => { if (lebt) setApp(null); });
    return () => { lebt = false; };
  }, [dataset.dataset_id]);
  const t = app?.ds === dataset.dataset_id ? app.t : null;

  const wert = caps?.items.find((c) => c.key === "value_kind") ?? null;
  const reads = caps?.value_kind === "reads";
  const datiert = (t?.time_axis ?? caps?.time_axis) === "dates";
  const nZeit = t?.n_samples ?? dataset.n_sample;

  return (
    <dl data-testid="dataset-facts"
      className="rounded-md border border-line bg-raised px-3 py-2 text-xs leading-relaxed">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <dt className="sr-only">ASVs</dt>
        <dd data-testid="facts-asvs">
          <span className="font-semibold text-fg tabular-nums">{dataset.n_asv}</span>
          <span className="text-fg-muted"> ASVs</span>
        </dd>
        <dd aria-hidden className="text-fg-muted">·</dd>
        <dt className="sr-only">in the network</dt>
        <dd data-testid="facts-network">
          <span className="font-semibold text-fg tabular-nums">{dataset.n_network}</span>
          <span className="text-fg-muted"> in the network</span>
        </dd>
      </div>

      <div data-testid="facts-time">
        <dt className="sr-only">time points</dt>
        <dd>
          <span className="font-semibold text-fg tabular-nums">{nZeit}</span>
          <span className="text-fg-muted"> time points</span>
          {!datiert && <span className="text-fg-muted"> · sample order only</span>}
        </dd>
        {datiert && (
          <dd className="text-fg-muted tabular-nums" data-testid="facts-period">
            {t?.first && t?.last
              ? <><span className="text-fg">{t.first}</span> – <span className="text-fg">{t.last}</span></>
              : "…"}
            {t?.median_gap_days != null && (
              <>
                <br />
                <span data-testid="facts-spacing">
                  typically <span className="text-fg">{t.median_gap_days} days</span> apart
                  {t.largest_gap_days != null && t.largest_gap_days > t.median_gap_days
                    ? <>, largest gap {t.largest_gap_days} days</> : null}
                </span>
              </>
            )}
          </dd>
        )}
      </div>

      <div data-testid="facts-values" className="mt-1 border-t border-line-subtle pt-1">
        <dt className="inline text-fg-muted">Values: </dt>
        <dd className={`inline ${wert && !wert.available ? "text-warn" : "text-fg"}`}>
          {wert?.value ?? "…"}
        </dd>
        {caps && (
          <dd className="text-fg-muted leading-snug" data-testid="facts-share">
            {reads
              ? "A share is an ASV's reads divided by all reads of its sample, i.e. normalized for sequencing depth."
              : "A share is an ASV's value divided by its sample's total, comparable within a sample, not raw reads."}
          </dd>
        )}
      </div>
    </dl>
  );
}
