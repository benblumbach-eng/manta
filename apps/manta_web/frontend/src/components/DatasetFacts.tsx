import { useEffect, useState } from "react";
import { getApplicability, type Applicability, type Dataset } from "../api";

const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

export default function DatasetFacts({ dataset }: { dataset: Dataset }) {
  const [app, setApp] = useState<{ ds: string; t: Applicability["time_structure"] } | null>(null);
  useEffect(() => {
    let lebt = true;
    getApplicability(dataset.dataset_id)
      .then((a) => { if (lebt) setApp({ ds: dataset.dataset_id, t: a.time_structure }); })
      .catch(() => { if (lebt) setApp(null); });
    return () => { lebt = false; };
  }, [dataset.dataset_id]);
  const t = app?.ds === dataset.dataset_id ? app.t : null;

  const rows: { key: string; label: string; value: string }[] = [
    { key: "asvs", label: "ASVs", value: String(dataset.n_asv) },
    { key: "period", label: "Period",
      value: t?.first && t?.last ? `${t.first} – ${t.last}` : t ? "—" : "…" },
    { key: "time", label: "Time points", value: String(t?.n_samples ?? dataset.n_sample) },
    { key: "spacing", label: "Typical gap",
      value: t?.median_gap_days != null ? days(t.median_gap_days) : t ? "—" : "…" },
    { key: "gap", label: "Longest gap",
      value: t?.largest_gap_days != null ? days(t.largest_gap_days) : t ? "—" : "…" },
  ];

  return (
    <dl data-testid="dataset-facts"
      className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 rounded-md border border-line bg-raised px-3 py-2 text-xs">
      {rows.map((r) => (
        <div key={r.key} className="contents">
          <dt className="text-fg-muted whitespace-nowrap">{r.label}</dt>
          <dd data-testid={`facts-${r.key}`} className="text-right font-semibold text-fg tabular-nums whitespace-nowrap">
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
