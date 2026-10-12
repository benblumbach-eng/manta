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

  if (err) return <p data-testid="status-error" className="text-xs text-danger">{err}</p>;
  if (!state) return <p className="text-xs text-fg-muted">…</p>;

  return (
    <section className="space-y-1" data-testid="admin-status">
      <h3 className="text-sm font-medium text-fg">Status</h3>
      <table className="w-full text-sm">
        <tbody>
          {(Object.keys(LABEL) as (keyof AdminStatus["checks"])[]).map((key) => {
            const check = state.checks[key];
            return (
              <tr key={key} className="border-t border-line-subtle" data-testid={`status-${key}`}>
                <td className="py-2 w-32 text-fg">{LABEL[key]}</td>
                <td className="py-2 w-6">
                  <span className={check.ok ? "text-ok" : "text-warn"}>
                    {check.ok ? "●" : "○"}
                  </span>
                </td>
                <td className="py-2 text-fg-muted">{check.detail}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
