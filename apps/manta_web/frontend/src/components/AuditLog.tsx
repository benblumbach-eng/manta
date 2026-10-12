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
      <h3 className="text-sm font-medium text-fg">Changes</h3>
      {err && <p className="text-xs text-danger">{err}</p>}
      {entries && entries.length === 0 && (
        <p className="text-xs text-fg-muted">Nothing recorded yet.</p>
      )}
      {entries && entries.length > 0 && (
        <table className="w-full text-sm">
          <thead className="text-xs font-semibold text-fg-muted">
            <tr><th className="text-left">when</th><th className="text-left">who</th>
                <th className="text-left">what</th></tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={i} className="border-t border-line-subtle">
                <td className="py-2 w-40 text-fg-muted">
                  {new Date(e.at * 1000).toLocaleString()}
                </td>
                <td className="py-2 w-28 text-fg">{e.who}</td>
                <td className="py-2 text-fg-muted">
                  {e.what}
                  {e.detail ? <span className="block text-xs text-fg-muted" data-record="audit">{e.detail}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
