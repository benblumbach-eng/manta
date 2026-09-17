import { useEffect, useState } from "react";
import { auditLog, type AuditEntry } from "../api";

export default function AuditLog() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    auditLog().then((d) => setEntries(d.entries)).catch((e) => setErr(String(e.message ?? e)));
  }, []);

  return (
    <section className="space-y-2" data-testid="admin-audit">
      <h3 className="text-sm font-medium text-slate-200">Changes</h3>
      {err && <p className="text-xs text-red-400">{err}</p>}
      {entries && entries.length === 0 && (
        <p className="text-xs text-slate-500">Nothing recorded yet.</p>
      )}
      {entries && entries.length > 0 && (
        <table className="w-full text-sm">
          <thead className="text-[11px] uppercase tracking-wide text-slate-500">
            <tr><th className="text-left">when</th><th className="text-left">who</th>
                <th className="text-left">what</th></tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={i} className="border-t border-slate-800">
                <td className="py-1.5 w-40 text-slate-500">
                  {new Date(e.at * 1000).toLocaleString()}
                </td>
                <td className="py-1.5 w-28 text-slate-300">{e.who}</td>
                <td className="py-1.5 text-slate-400">
                  {e.what}{e.detail ? <span className="text-slate-500"> — {e.detail}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
