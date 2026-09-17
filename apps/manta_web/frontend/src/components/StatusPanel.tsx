import { useEffect, useState } from "react";
import { adminStatus, type AdminStatus } from "../api";

const LABEL: Record<keyof AdminStatus["checks"], string> = {
  database: "Database",
  mail: "Mail",
  assistant: "Assistant",
  analysis_tools: "Analysis tools",
};

export default function StatusPanel() {
  const [state, setState] = useState<AdminStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    adminStatus().then(setState).catch((e) => setErr(String(e.message ?? e)));
  }, []);

  if (err) return <p data-testid="status-error" className="text-xs text-red-400">{err}</p>;
  if (!state) return <p className="text-xs text-slate-500">…</p>;

  return (
    <section className="space-y-1" data-testid="admin-status">
      <h3 className="text-sm font-medium text-slate-200">Status</h3>
      <table className="w-full text-sm">
        <tbody>
          {(Object.keys(LABEL) as (keyof AdminStatus["checks"])[]).map((key) => {
            const check = state.checks[key];
            return (
              <tr key={key} className="border-t border-slate-800" data-testid={`status-${key}`}>
                <td className="py-1.5 w-32 text-slate-300">{LABEL[key]}</td>
                <td className="py-1.5 w-6">
                  <span className={check.ok ? "text-emerald-400" : "text-amber-400"}>
                    {check.ok ? "●" : "○"}
                  </span>
                </td>
                <td className="py-1.5 text-slate-400">{check.detail}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
