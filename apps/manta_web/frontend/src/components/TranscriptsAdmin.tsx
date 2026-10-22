import { useEffect, useState } from "react";
import { adminTranscripts, type ConversationSummary, type Dataset } from "../api";
import { ConversationView } from "./Transcript";

export default function TranscriptsAdmin({ datasets = [], input }:
  { datasets?: Dataset[]; input: string }) {
  const [rows, setRows] = useState<ConversationSummary[] | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [q, setQ] = useState("");
  const [user, setUser] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      adminTranscripts({ q: q.trim() || undefined, user: user.trim() || undefined })
        .then((r) => { if (alive) { setRows(r.conversations); setEnabled(r.enabled); setErr(null); } })
        .catch((e) => { if (alive) setErr(String((e as Error).message ?? e)); });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [q, user]);

  const label = (ds: string) =>
    ds ? (datasets.find((d) => d.dataset_id === ds)?.region ?? ds) : "no dataset";

  return (
    <section className="space-y-2" data-testid="admin-transcripts">
            {err && <p className="text-xs text-danger">{err}</p>}
      {enabled === false && (
        <p data-testid="admin-transcripts-off" className="text-xs text-fg-muted">
          Off: <code>MANTA_ADMINS_READ_TRANSCRIPTS=off</code> is set in <code>deploy/.env</code>.
        </p>
      )}
      {enabled && (
        <>
          <div className="flex flex-wrap gap-2">
            <input className={`${input} flex-1 min-w-[12rem]`} placeholder="search questions and answers"
                   data-testid="admin-transcripts-search" value={q}
                   onChange={(e) => setQ(e.target.value)} />
            <input className={`${input} w-40`} placeholder="account" value={user}
                   data-testid="admin-transcripts-user" onChange={(e) => setUser(e.target.value)} />
          </div>
          {rows && rows.length === 0 && (
            <p className="text-xs text-fg-muted">No conversation matches.</p>
          )}
          {rows && rows.length > 0 && (
            <table className="w-full text-sm">
              <thead className="text-xs font-semibold text-fg-muted">
                <tr><th className="text-left">when</th><th className="text-left">who</th>
                    <th className="text-left">conversation</th></tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="border-t border-line-subtle align-top">
                    <td className="py-2 w-40 text-fg-muted">
                      {new Date(c.updated_at * 1000).toLocaleString()}
                    </td>
                    <td className="py-2 w-28 text-fg">
                      {c.username}
                      {c.earlier_account && <span className="block text-xs text-warn">earlier account</span>}
                    </td>
                    <td className="py-2 text-fg-muted">
                      <button data-testid="admin-transcript" data-id={c.id}
                        onClick={() => setOpen(open === c.id ? null : c.id)}
                        className="text-left hover:text-accent">
                        <span data-record="transcript">{c.title || "(no question)"}</span>
                        <span className="block text-xs text-fg-muted" data-record="transcript">
                          {label(c.dataset_id)} · {c.n_turns} {c.n_turns === 1 ? "question" : "questions"}
                        </span>
                      </button>
                      {open === c.id && (
                        <div className="mt-2 rounded border border-line p-3" data-record="transcript">
                          <ConversationView id={c.id} datasets={datasets} />
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
