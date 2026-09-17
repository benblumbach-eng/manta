import { useEffect, useRef, useState } from "react";
import { getImports, type ImportStatus } from "../api";

export default function ImportTray({ isAdmin, onJobDone }:
  { isAdmin: boolean; onJobDone: () => void }) {
  const [jobs, setJobs] = useState<ImportStatus[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(() => {
    try {
      return new Set<string>(JSON.parse(sessionStorage.getItem("manta-tray-dismissed") ?? "[]"));
    } catch { return new Set<string>(); }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem("manta-tray-dismissed", JSON.stringify([...dismissed]));
    } catch { }
  }, [dismissed]);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const seenDone = useRef<Set<string>>(new Set());
  const jobDone = useRef(onJobDone);
  jobDone.current = onJobDone;

  useEffect(() => {
    if (!isAdmin) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await getImports();
        if (stop) return;
        setJobs(r.jobs);
        for (const j of r.jobs) {
          if (j.status === "done" && !seenDone.current.has(j.job_id)) {
            seenDone.current.add(j.job_id);
            jobDone.current();
          }
        }
      } catch {
      }
      setNow(Date.now() / 1000);
    };
    tick();
    const iv = setInterval(tick, 3000);
    return () => { stop = true; clearInterval(iv); };
  }, [isAdmin]);

  if (!isAdmin) return null;
  const visible = jobs.filter((j) => !dismissed.has(j.job_id));
  if (visible.length === 0) return null;

  const mins = (t?: number) => (t ? Math.max(0, Math.floor((now - t) / 60)) : null);
  const fmt = (t?: number) => {
    const m = mins(t);
    return m === null ? "" : m < 1 ? "<1 min" : `${m} min`;
  };

  return (
    <div data-testid="import-tray"
      className="fixed bottom-24 left-[20.75rem] z-10 w-[340px] space-y-2">
      {visible.map((j) => (
        <div key={j.job_id} data-testid={`import-tray-${j.dataset_id}`}
          className={`rounded border p-2 text-xs shadow-lg bg-slate-900/95 ${
            j.status === "error" ? "border-red-700" :
            j.status === "done" ? "border-emerald-700" : "border-cyan-800"}`}>
          <div className="flex items-center justify-between">
            <span className="text-slate-200 font-medium truncate">{j.dataset_id}</span>
            {j.status !== "running" && (
              <button aria-label="dismiss" title="ausblenden"
                data-testid={`import-tray-dismiss-${j.dataset_id}`}
                onClick={() => setDismissed((p) => new Set(p).add(j.job_id))}
                className="text-slate-500 hover:text-slate-200 ml-2">✕</button>
            )}
          </div>
          {j.status === "running" && (
            <div className="mt-1">
              <div className="h-3 rounded bg-slate-800 border border-slate-700 overflow-hidden"
                data-testid={`import-progress-${j.dataset_id}`}>
                <div className="h-full bg-gradient-to-r from-cyan-600 to-cyan-400 transition-all duration-700"
                  style={{ width: `${Math.round((j.progress ?? 0) * 100)}%` }} />
              </div>
              <div className="mt-0.5 flex justify-between text-slate-400">
                <span>{Math.round((j.progress ?? 0) * 100)} % · {j.stage_detail ?? j.stage}</span>
                <span className="text-slate-500">{fmt(j.started_at)}</span>
              </div>
              <div className="text-slate-600">
                läuft serverseitig weiter, auch wenn du woanders klickst
              </div>
            </div>
          )}
          {j.status === "done" && (
            <div className="mt-1 text-emerald-400">
              ✓ fertig{j.finished_at && j.started_at
                ? ` nach ${Math.max(1, Math.round((j.finished_at - j.started_at) / 60))} min` : ""}
            </div>
          )}
          {j.status === "error" && (
            <div className="mt-1 text-red-400 break-words">✗ {j.error ?? "unbekannter Fehler"}</div>
          )}
        </div>
      ))}
    </div>
  );
}
