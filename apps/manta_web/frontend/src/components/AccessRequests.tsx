import { useEffect, useState } from "react";
import InfoTip from "./InfoTip";
import {
  adminApproveRequest, adminDeleteRequest, adminRejectRequest, adminRequests, adminSetRoutes,
  type AccessRequest, type RequestRoute,
} from "../api";

export default function AccessRequests(
  { onAccountsChanged, focusRequest }:
  { onAccountsChanged: () => void; focusRequest?: number | null },
) {
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [routes, setRoutes] = useState<RequestRoute[]>([]);
  const [roles, setRoles] = useState<string[]>(["viewer", "admin"]);
  const [mail, setMail] = useState<{ configured: boolean; sender: string | null;
                                     collect_to: string[] }>(
    { configured: false, sender: null, collect_to: [] });
  const [error, setError] = useState<string | null>(null);
  const [showDecided, setShowDecided] = useState(false);
  const [draft, setDraft] = useState<Record<number, { username: string; password: string;
                                                     role: string; notify: boolean;
                                                     note: string }>>({});

  useEffect(() => {
    if (!focusRequest || !requests.length) return;
    const treffer = requests.find((r) => r.id === focusRequest);
    if (!treffer) return;
    if (treffer.status !== "open") setShowDecided(true);
    const el = document.querySelector(`[data-testid="request-${focusRequest}"]`)
            ?? document.querySelector(`[data-testid="admin-requests"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusRequest, requests]);

  const reload = () =>
    adminRequests().then((d) => {
      setRequests(d.requests); setRoutes(d.routes); setRoles(d.roles); setMail(d.mail);
    }).catch((e) => setError(String(e.message ?? e)));
  useEffect(() => { reload(); }, []);

  const run = (p: Promise<unknown>) =>
    p.then(() => { setError(null); return reload(); })
     .catch((e) => setError(String(e.message ?? e)));

  const d = (r: AccessRequest) => draft[r.id] ?? {
    username: r.wanted_username, password: "", role: "viewer", notify: mail.configured, note: "",
  };
  const setD = (r: AccessRequest, patch: Partial<ReturnType<typeof d>>) =>
    setDraft({ ...draft, [r.id]: { ...d(r), ...patch } });

  const generate = (r: AccessRequest) => {
    const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = crypto.getRandomValues(new Uint32Array(16));
    setD(r, { password: Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("") });
  };

  const input = "px-2 py-1 rounded bg-slate-950 border border-slate-700 text-sm text-slate-100 " +
                "focus:border-cyan-500 focus:outline-none";

  const open = requests.filter((r) => r.status === "open");
  const decided = requests.filter((r) => r.status !== "open");

  return (
    <section className="space-y-3" data-testid="admin-requests">
      <h3 className="flex items-center text-sm font-medium text-slate-200">
        Access requests{open.length ? <span className="ml-2 text-cyan-300">{open.length} open</span> : null}
        <InfoTip title="What a request is">
          <p>Filed through the form on the sign-in screen. Nothing here is an account yet —
          approving creates one with the same rules as the Accounts section below.</p>
          <p>Requests are stored in the database; the e-mail is only a notification, and its
          result is shown per request.</p>
        </InfoTip>
      </h3>

      {error && (
        <p data-testid="requests-error"
           className="text-sm text-red-400 border border-red-400/30 rounded px-3 py-2">
          Access requests could not be loaded: {error}
        </p>
      )}

      {!mail.configured && (
        <p data-testid="requests-nomail"
           className="text-xs text-amber-300 border border-amber-400/40 rounded px-3 py-2">
          No mail server is configured (MANTA_SMTP_HOST). Requests are still recorded, but nobody
          is notified — this page is then the only place they appear.
        </p>
      )}
      {mail.configured && mail.collect_to.length === 0 && (
        <p className="text-xs text-amber-300 border border-amber-400/40 rounded px-3 py-2">
          A mail server is configured, but no collection address (MANTA_REQUEST_MAILTO). Only
          requests with a matching topic below reach anyone.
        </p>
      )}

      {open.length === 0 && (
        <p className="text-xs text-slate-500" data-testid="requests-empty">No open requests.</p>
      )}

      {open.map((r) => (
        <div key={r.id} data-testid={`request-${r.id}`}
             className={"rounded p-3 space-y-2 bg-slate-800/40 border " +
                        (r.id === focusRequest
                          ? "border-cyan-500 ring-1 ring-cyan-500/40"
                          : "border-slate-700")}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="text-sm text-slate-200">
              {r.full_name}{" "}
              <a href={`mailto:${r.email}`} className="text-cyan-300 hover:underline">{r.email}</a>
            </div>
            <div className="text-[11px] text-slate-500">
              {new Date(r.created_at * 1000).toLocaleString()}
            </div>
          </div>

          <div className="text-xs text-slate-400 space-x-3">
            {r.institution && <span>{r.institution}</span>}
            {r.topic && <span className="text-slate-300">topic: {r.topic}</span>}
            {r.wanted_username && <span>wants: {r.wanted_username}</span>}
          </div>

          <p className="text-xs text-slate-300 whitespace-pre-wrap">{r.reason}</p>

          <p className="text-[11px] text-slate-500">
            notification:{" "}
            <span className={r.mail_status === "sent" ? "text-slate-400" : "text-amber-300"}>
              {r.mail_status || "—"}
            </span>
            {r.mail_to && <span className="text-slate-600"> → {r.mail_to}</span>}
          </p>

          <div className="flex flex-wrap items-end gap-2 pt-1 border-t border-slate-800">
            <input className={input} placeholder="user name" value={d(r).username}
                   data-testid={`request-user-${r.id}`}
                   onChange={(e) => setD(r, { username: e.target.value })} />
            <input className={input} placeholder="password (min. 8)" value={d(r).password}
                   data-testid={`request-pw-${r.id}`}
                   onChange={(e) => setD(r, { password: e.target.value })} />
            <button className="text-xs text-slate-400 hover:text-cyan-300"
                    onClick={() => generate(r)}>generate</button>
            <select className={input} value={d(r).role}
                    onChange={(e) => setD(r, { role: e.target.value })}>
              {roles.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <label className={"text-xs flex items-center gap-1 " +
                              (mail.configured ? "text-slate-400" : "text-slate-600")}
                   title={mail.configured ? "send them a short note (never the password)"
                                          : "no mail server configured"}>
              <input type="checkbox" checked={d(r).notify} disabled={!mail.configured}
                     onChange={(e) => setD(r, { notify: e.target.checked })} />
              tell them
            </label>
            <button data-testid={`request-approve-${r.id}`}
                    className="px-3 py-1 rounded bg-cyan-600 text-sm text-white hover:bg-cyan-500
                               disabled:opacity-40"
                    disabled={!d(r).username || d(r).password.length < 8}
                    onClick={() => run(adminApproveRequest(r.id, {
                      username: d(r).username, password: d(r).password, role: d(r).role,
                      notify: d(r).notify,
                    }).then(onAccountsChanged))}>
              approve
            </button>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <input className={input + " flex-1 min-w-[12rem]"} placeholder="reason for declining"
                   value={d(r).note} onChange={(e) => setD(r, { note: e.target.value })} />
            <button data-testid={`request-reject-${r.id}`}
                    className="px-3 py-1 rounded border border-slate-700 text-sm text-slate-300
                               hover:border-red-400 hover:text-red-300"
                    onClick={() => run(adminRejectRequest(r.id,
                      { note: d(r).note, notify: d(r).notify }))}>
              decline
            </button>
          </div>

          {d(r).password && (
            <p className="text-[11px] text-amber-300">
              Note the password down now and pass it on in person, by phone or by chat — it is
              never sent by e-mail and cannot be read back afterwards.
            </p>
          )}
        </div>
      ))}

      {decided.length > 0 && (
        <div className="pt-2">
          <button className="text-xs text-slate-400 hover:text-cyan-300"
                  data-testid="requests-toggle-decided"
                  onClick={() => setShowDecided(!showDecided)}>
            {showDecided ? "hide" : "show"} {decided.length} decided
          </button>
          {showDecided && (
            <table className="w-full text-xs mt-2">
              <tbody>
                {decided.map((r) => (
                  <tr key={r.id} className="border-t border-slate-800">
                    <td className="py-1 text-slate-400">{r.full_name}</td>
                    <td className="py-1 text-slate-500">{r.email}</td>
                    <td className={"py-1 " + (r.status === "approved" ? "text-cyan-300" : "text-slate-500")}>
                      {r.status}{r.created_user ? ` → ${r.created_user}` : ""}
                    </td>
                    <td className="py-1 text-slate-600">{r.decided_by ?? ""}</td>
                    <td className="py-1 text-right">
                      <button className="text-red-400 hover:text-red-300"
                              onClick={() => run(adminDeleteRequest(r.id))}>delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <Routes routes={routes} input={input} collect={mail.collect_to}
              onSave={(rs) => run(adminSetRoutes(rs))} />
    </section>
  );
}

function Routes({ routes, onSave, input, collect }: {
  routes: RequestRoute[]; onSave: (r: RequestRoute[]) => void; input: string; collect: string[];
}) {
  const [rows, setRows] = useState<RequestRoute[]>(routes);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (!dirty) setRows(routes); }, [routes, dirty]);

  const patch = (i: number, p: Partial<RequestRoute>) => {
    setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
    setDirty(true);
  };

  return (
    <div className="pt-4 border-t border-slate-800 space-y-2" data-testid="request-routes">
      <h4 className="flex items-center text-xs font-medium text-slate-300">
        Where requests are sent
        <InfoTip title="Collection address and topics">
          <p>The collection address comes from the deployment configuration and is always in the
          distribution list — a wrongly typed topic address must not swallow a request
          silently.</p>
          <p>Topics below appear in the request form as a choice; each also notifies its own
          address.</p>
        </InfoTip>
      </h4>
      <p className="text-xs text-slate-500">
        Collection address:{" "}
        <span className="text-slate-300">{collect.join(", ") || "— none configured —"}</span>
      </p>

      {rows.map((r, i) => (
        <div key={i} className="flex flex-wrap gap-2 items-center">
          <input className={input} placeholder="topic key" value={r.topic}
                 onChange={(e) => patch(i, { topic: e.target.value })} />
          <input className={input} placeholder="label shown in the form" value={r.label ?? ""}
                 onChange={(e) => patch(i, { label: e.target.value })} />
          <input className={input + " flex-1 min-w-[12rem]"} placeholder="address" value={r.email}
                 onChange={(e) => patch(i, { email: e.target.value })} />
          <button className="text-xs text-red-400 hover:text-red-300"
                  onClick={() => { setRows(rows.filter((_, j) => j !== i)); setDirty(true); }}>
            remove
          </button>
        </div>
      ))}

      <div className="flex gap-3 items-center">
        <button className="text-xs text-slate-400 hover:text-cyan-300" data-testid="route-add"
                onClick={() => { setRows([...rows, { topic: "", label: "", email: "" }]); setDirty(true); }}>
          add topic
        </button>
        <button data-testid="routes-save" disabled={!dirty}
                className="px-3 py-1 rounded bg-cyan-600 text-xs text-white hover:bg-cyan-500
                           disabled:opacity-40"
                onClick={() => { onSave(rows); setDirty(false); }}>
          save routing
        </button>
      </div>
    </div>
  );
}
