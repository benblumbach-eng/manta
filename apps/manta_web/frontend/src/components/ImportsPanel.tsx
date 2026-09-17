import { useEffect, useState } from "react";
import { importJobs, type ImportJob } from "../api";

const FARBE: Record<string, string> = {
  done: "text-emerald-400",
  running: "text-cyan-300",
  error: "text-red-400",
};

function wann(t?: number): string {
  return t ? new Date(t * 1000).toLocaleString() : "";
}

export default function ImportsPanel() {
  const [jobs, setJobs] = useState<ImportJob[] | null>(null);
  const [hinweis, setHinweis] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const laden = () =>
    importJobs().then((d) => { setJobs(d.jobs); setHinweis(d.hinweis); setErr(null); })
                .catch((e) => setErr(String(e.message ?? e)));

  useEffect(() => {
    laden();
    const t = setInterval(laden, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <section className="space-y-2" data-testid="admin-imports">
      <h3 className="text-sm font-medium text-slate-200">Imports</h3>
      {err && <p className="text-xs text-red-400">{err}</p>}
      {jobs && jobs.length === 0 && (
        <p className="text-xs text-slate-500" data-testid="imports-empty">No jobs.</p>
      )}
      {jobs && jobs.length > 0 && (
        <table className="w-full text-sm">
          <thead className="text-[11px] uppercase tracking-wide text-slate-500">
            <tr><th className="text-left">dataset</th><th className="text-left">status</th>
                <th className="text-left">stage</th><th className="text-left">started</th></tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.job_id} className="border-t border-slate-800"
                  data-testid={`import-${j.job_id}`}>
                <td className="py-1.5 text-slate-300">{j.dataset_id ?? j.job_id.slice(0, 8)}</td>
                <td className={`py-1.5 ${FARBE[j.status] ?? "text-slate-400"}`}>{j.status}</td>
                <td className="py-1.5 text-slate-400">
                  {j.stage}
                  {j.stages?.length ? ` (${j.stages.indexOf(j.stage) + 1}/${j.stages.length})` : ""}
                  {j.error ? <span className="text-red-400"> — {j.error}</span> : null}
                </td>
                <td className="py-1.5 text-slate-500">{wann(j.started_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {hinweis && <p className="text-xs text-slate-500" data-testid="imports-hinweis">{hinweis}</p>}
    </section>
  );
}
