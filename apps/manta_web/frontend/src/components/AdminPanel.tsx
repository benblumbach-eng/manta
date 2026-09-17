import { useEffect, useState } from "react";
import {
  adminCreateUser, adminDeleteUser, adminPatchUser, adminRevokeSessions, adminUsers,
  type AdminUser, type Dataset,
} from "../api";
import AccessRequests from "./AccessRequests";
import AgentSettings from "./AgentSettings";
import AuditLog from "./AuditLog";
import DatasetAdmin from "./DatasetAdmin";
import ImportsPanel from "./ImportsPanel";
import MailSettings from "./MailSettings";
import StatusPanel from "./StatusPanel";

export default function AdminPanel(
  { datasets, onClose, onDatasetsChanged, focusRequest }:
  { datasets: Dataset[]; onClose: () => void; onDatasetsChanged: () => void;
    focusRequest?: number | null },
) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [roles, setRoles] = useState<string[]>(["viewer", "admin"]);
  const [visibilities, setVisibilities] = useState<string[]>(["internal", "public"]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [pw, setPw] = useState("");
  const [role, setRole] = useState("viewer");

  const reload = () =>
    adminUsers().then((d) => {
      setUsers(d.users); setRoles(d.roles);
      if (d.visibilities?.length) setVisibilities(d.visibilities);
    })
                .catch((e) => setError(String(e.message ?? e)));
  useEffect(() => { reload(); }, []);

  const run = (p: Promise<unknown>) =>
    p.then(() => { setError(null); reload(); })
     .catch((e) => setError(String(e.message ?? e)));

  const input = "px-2 py-1 rounded bg-slate-950 border border-slate-700 text-sm text-slate-100 " +
                "focus:border-cyan-500 focus:outline-none";

  return (
    <div className="fixed inset-0 z-40 bg-slate-900/95 overflow-y-auto" data-testid="admin-panel">
      <div className="mx-auto max-w-3xl p-6 space-y-8">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">Administration</h2>
          <button onClick={onClose} data-testid="admin-close"
                  className="text-sm text-slate-400 hover:text-cyan-300">close</button>
        </div>

        {error && <p data-testid="admin-error" className="text-sm text-red-400">{error}</p>}

        <StatusPanel />

        <AccessRequests onAccountsChanged={reload} focusRequest={focusRequest} />

        <MailSettings input={input} />

        <AgentSettings input={input} />

        <DatasetAdmin datasets={datasets} visibilities={visibilities} input={input}
                      onChanged={onDatasetsChanged} />

        <ImportsPanel />

        <AuditLog />

        <section className="space-y-3">
          <h3 className="text-sm font-medium text-slate-200">Accounts</h3>
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase tracking-wide text-slate-500">
              <tr><th className="text-left">user</th><th className="text-left">role</th>
                  <th className="text-left">sessions</th><th /></tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.username} className="border-t border-slate-800">
                  <td className="py-1.5 text-slate-300">
                    {u.username}{u.disabled ? <span className="text-red-400"> (blocked)</span> : null}
                  </td>
                  <td className="py-1.5">
                    <select className={input} value={u.role}
                            onChange={(e) => run(adminPatchUser(u.username, { role: e.target.value }))}>
                      {roles.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </td>
                  <td className="py-1.5 text-slate-400">{u.sessions}</td>
                  <td className="py-1.5 text-right space-x-3 text-xs">
                    <button className="text-slate-400 hover:text-cyan-300"
                            onClick={() => run(adminRevokeSessions(u.username))}>sign out everywhere</button>
                    <button className="text-slate-400 hover:text-cyan-300"
                            onClick={() => run(adminPatchUser(u.username, { disabled: !u.disabled }))}>
                      {u.disabled ? "unblock" : "block"}
                    </button>
                    <button className="text-red-400 hover:text-red-300"
                            onClick={() => run(adminDeleteUser(u.username))}>delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="flex flex-wrap gap-2 items-end pt-2">
            <input className={input} placeholder="new user" value={name} data-testid="admin-new-user"
                   onChange={(e) => setName(e.target.value)} />
            <input className={input} placeholder="password (min. 10)" type="password" value={pw}
                   data-testid="admin-new-pw" onChange={(e) => setPw(e.target.value)} />
            <select className={input} value={role} onChange={(e) => setRole(e.target.value)}>
              {roles.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <button data-testid="admin-create"
                    className="px-3 py-1 rounded bg-cyan-600 text-sm text-white hover:bg-cyan-500
                               disabled:opacity-40"
                    disabled={!name || pw.length < 10}
                    onClick={() => run(adminCreateUser(name, pw, role).then(() => {
                      setName(""); setPw("");
                    }))}>
              create
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
