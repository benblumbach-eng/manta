import { StateNotice } from "./ui";
import { useEffect, useState } from "react";
import { importJobs, type ImportJob } from "../api";

const FARBE: Record<string, string> = {
  done: "text-ok",
  running: "text-accent",
  error: "text-danger",
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
      <h3 className="text-sm font-medium text-fg">Imports</h3>
      {err && <p className="text-xs text-danger">{err}</p>}
      {jobs && jobs.length === 0 && (
        <StateNotice state="empty" inline testid="imports-empty">No jobs.</StateNotice>
      )}
      {jobs && jobs.length > 0 && (
        <table className="w-full text-sm">
          <thead className="text-xs font-semibold text-fg-muted">
            <tr><th className="text-left">dataset</th><th className="text-left">status</th>
                <th className="text-left">stage</th><th className="text-left">started</th></tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.job_id} className="border-t border-line-subtle"
                  data-testid={`import-${j.job_id}`}>
                <td className="py-2 text-fg">{j.dataset_id ?? j.job_id.slice(0, 8)}</td>
                <td className={`py-2 ${FARBE[j.status] ?? "text-fg-muted"}`}>{j.status}</td>
                <td className="py-2 text-fg-muted">
                  {j.stage}
                  {(() => {
                    const i = j.stages?.indexOf(j.stage) ?? -1;
                    return i >= 0 ? ` (${i + 1}/${j.stages!.length})` : "";
                  })()}
                  {j.error ? <span className="text-danger"> — {j.error}</span> : null}
                </td>
                <td className="py-2 text-fg-muted">{wann(j.started_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {hinweis && <p className="text-xs text-fg-muted" data-testid="imports-hinweis">{hinweis}</p>}
    </section>
  );
}
