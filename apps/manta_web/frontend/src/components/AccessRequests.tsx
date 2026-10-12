import { Button, StateNotice } from "./ui";
import { useEffect, useState } from "react";
import InfoTip from "./InfoTip";
import {
  adminApproveRequest, adminDeleteRequest, adminRejectRequest, adminRequests, adminSetRoutes,
  type AccessRequest, type RequestRoute,
} from "../api";

export default function AccessRequests(
  { onAccountsChanged, focusRequest, minPassword = 8 }:
  { onAccountsChanged: () => void; focusRequest?: number | null;
    minPassword?: number },
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

  const input = "px-2 py-1 rounded-md bg-control border border-line-strong text-sm text-fg " +
                "focus:border-accent focus:outline-none";

  const open = requests.filter((r) => r.status === "open");
  const decided = requests.filter((r) => r.status !== "open");

  return (
    <section className="space-y-3" data-testid="admin-requests">
      <h3 className="flex items-center text-sm font-medium text-fg">
        Access requests{open.length ? <span className="ml-2 text-accent">{open.length} open</span> : null}
        <InfoTip title="What a request is">
          <p>Filed through the form on the sign-in screen. Nothing here is an account yet —
          approving creates one with the same rules as the Accounts section below.</p>
          <p>Requests are stored in the database; the e-mail is only a notification, and its
          result is shown per request.</p>
        </InfoTip>
      </h3>

      {error && (
        <p data-testid="requests-error"
           className="text-sm text-danger border border-danger bg-danger-soft rounded-md px-3 py-2">
          Access requests could not be loaded: {error}
        </p>
      )}

      {!mail.configured && (
        <p data-testid="requests-nomail"
           className="text-xs text-warn border border-warn rounded px-3 py-2">
          No mail server is configured (MANTA_SMTP_HOST). Requests are still recorded, but nobody
          is notified — this page is then the only place they appear.
        </p>
      )}
      {mail.configured && mail.collect_to.length === 0 && (
        <p className="text-xs text-warn border border-warn rounded px-3 py-2">
          A mail server is configured, but no collection address (MANTA_REQUEST_MAILTO). Only
          requests with a matching topic below reach anyone.
        </p>
      )}

      {open.length === 0 && (
        <StateNotice state="empty" inline testid="requests-empty">No open requests.</StateNotice>
      )}

      {open.map((r) => (
        <div key={r.id} data-testid={`request-${r.id}`}
             className={"rounded p-3 space-y-2 bg-control/40 border " +
                        (r.id === focusRequest
                          ? "border-accent ring-1 ring-accent"
                          : "border-line")}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="text-sm text-fg">
              {r.full_name}{" "}
              <a href={`mailto:${r.email}`} className="text-accent hover:underline">{r.email}</a>
            </div>
            <div className="text-2xs text-fg-muted">
              {new Date(r.created_at * 1000).toLocaleString()}
            </div>
          </div>

          <div className="text-xs text-fg-muted space-x-3">
            {r.institution && <span>{r.institution}</span>}
            {r.topic && <span className="text-fg">topic: {r.topic}</span>}
            {r.wanted_username && <span>wants: {r.wanted_username}</span>}
          </div>

          <p className="text-xs text-fg whitespace-pre-wrap">{r.reason}</p>

          <p className="text-2xs text-fg-muted">
            notification:{" "}
            <span className={r.mail_status === "sent" ? "text-fg-muted" : "text-warn"}>
              {r.mail_status || "—"}
            </span>
            {r.mail_to && <span className="text-fg-muted"> → {r.mail_to}</span>}
          </p>

          <div className="flex flex-wrap items-end gap-2 pt-1 border-t border-line-subtle">
            <input className={input} placeholder="user name" value={d(r).username}
                   data-testid={`request-user-${r.id}`}
                   onChange={(e) => setD(r, { username: e.target.value })} />
            <input className={input} placeholder={`password (min. ${minPassword})`} value={d(r).password}
                   data-testid={`request-pw-${r.id}`}
                   onChange={(e) => setD(r, { password: e.target.value })} />
            <button className="text-xs text-fg-muted hover:text-accent"
                    onClick={() => generate(r)}>generate</button>
            <select className={input} value={d(r).role}
                    onChange={(e) => setD(r, { role: e.target.value })}>
              {roles.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <label className={"text-xs flex items-center gap-1 " +
                              (mail.configured ? "text-fg-muted" : "text-fg-disabled")}
                   title={mail.configured ? "send them a short note (never the password)"
                                          : "no mail server configured"}>
              <input type="checkbox" checked={d(r).notify} disabled={!mail.configured}
                     onChange={(e) => setD(r, { notify: e.target.checked })} />
              tell them
            </label>
            <Button variant="primary" size="md" data-testid={`request-approve-${r.id}`}
                    disabled={!d(r).username || d(r).password.length < minPassword}
                    reason={`a user name and a password of at least ${minPassword} characters`}
                    onClick={() => run(adminApproveRequest(r.id, {
                      username: d(r).username, password: d(r).password, role: d(r).role,
                      notify: d(r).notify,
                    }).then(onAccountsChanged))}>
              approve
            </Button>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <input className={input + " flex-1 min-w-[12rem]"} placeholder="reason for declining"
                   value={d(r).note} onChange={(e) => setD(r, { note: e.target.value })} />
            <Button size="md" data-testid={`request-reject-${r.id}`}
                    className="hover:border-danger hover:text-danger"
                    onClick={() => run(adminRejectRequest(r.id,
                      { note: d(r).note, notify: d(r).notify }))}>
              decline
            </Button>
          </div>

          {d(r).password && (
            <p className="text-xs text-warn">
              Note the password down now and pass it on in person, by phone or by chat — it is
              never sent by e-mail and cannot be read back afterwards.
            </p>
          )}
        </div>
      ))}

      {decided.length > 0 && (
        <div className="pt-2">
          <button className="text-xs text-fg-muted hover:text-accent"
                  data-testid="requests-toggle-decided"
                  onClick={() => setShowDecided(!showDecided)}>
            {showDecided ? "hide" : "show"} {decided.length} decided
          </button>
          {showDecided && (
            <table className="w-full text-xs mt-2">
              <tbody>
                {decided.map((r) => (
                  <tr key={r.id} className="border-t border-line-subtle">
                    <td className="py-1 text-fg-muted">{r.full_name}</td>
                    <td className="py-1 text-fg-muted">{r.email}</td>
                    <td className={"py-1 " + (r.status === "approved" ? "text-accent" : "text-fg-muted")}>
                      {r.status}{r.created_user ? ` → ${r.created_user}` : ""}
                    </td>
                    <td className="py-1 text-fg-muted">{r.decided_by ?? ""}</td>
                    <td className="py-1 text-right">
                      <Button variant="ghost" className="text-danger hover:text-danger"
                              onClick={() => run(adminDeleteRequest(r.id))}>delete</Button>
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
    <div className="pt-4 border-t border-line-subtle space-y-2" data-testid="request-routes">
      <h4 className="flex items-center text-xs font-medium text-fg">
        Where requests are sent
        <InfoTip title="Collection address and topics">
          <p>The collection address comes from the deployment configuration and is always in the
          distribution list — a wrongly typed topic address must not swallow a request
          silently.</p>
          <p>Topics below appear in the request form as a choice; each also notifies its own
          address.</p>
        </InfoTip>
      </h4>
      <p className="text-xs text-fg-muted">
        Collection address:{" "}
        <span className="text-fg">{collect.join(", ") || "— none configured —"}</span>
      </p>

      {rows.map((r, i) => (
        <div key={i} className="flex flex-wrap gap-2 items-center">
          <input className={input} placeholder="topic key" value={r.topic}
                 onChange={(e) => patch(i, { topic: e.target.value })} />
          <input className={input} placeholder="label shown in the form" value={r.label ?? ""}
                 onChange={(e) => patch(i, { label: e.target.value })} />
          <input className={input + " flex-1 min-w-[12rem]"} placeholder="address" value={r.email}
                 onChange={(e) => patch(i, { email: e.target.value })} />
          <Button variant="ghost" className="text-danger hover:text-danger"
                  onClick={() => { setRows(rows.filter((_, j) => j !== i)); setDirty(true); }}>
            remove
          </Button>
        </div>
      ))}

      <div className="flex gap-3 items-center">
        <Button variant="ghost" data-testid="route-add"
                onClick={() => { setRows([...rows, { topic: "", label: "", email: "" }]); setDirty(true); }}>
          add topic
        </Button>
        <Button variant="primary" data-testid="routes-save" disabled={!dirty} reason="nothing changed"
                onClick={() => { onSave(rows); setDirty(false); }}>
          save routing
        </Button>
      </div>
    </div>
  );
}
