import { Button, Dialog, SectionHeading } from "./ui";
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
import TranscriptsAdmin from "./TranscriptsAdmin";

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
  const [minPw, setMinPw] = useState(8);
  const [settingsSaved, setSettingsSaved] = useState(0);

  const reload = () =>
    adminUsers().then((d) => {
      setUsers(d.users); setRoles(d.roles);
      if (d.visibilities?.length) setVisibilities(d.visibilities);
      if (typeof d.min_password_len === "number" && d.min_password_len > 0) setMinPw(d.min_password_len);
    })
                .catch((e) => setError(String(e.message ?? e)));
  useEffect(() => { reload(); }, []);

  const run = (p: Promise<unknown>) =>
    p.then(() => { setError(null); reload(); })
     .catch((e) => setError(String(e.message ?? e)));

  const input = "px-2 py-1 rounded-md bg-control border border-line-strong text-sm text-fg " +
                "focus:border-accent focus:outline-none";

  return (
    <Dialog page title="Administration" onClose={onClose} testid="admin-panel" closeTestid="admin-close">
      <div className="space-y-6">

        {error && <p data-testid="admin-error" className="text-sm text-danger">{error}</p>}

        <StatusPanel />

        <AccessRequests onAccountsChanged={reload} focusRequest={focusRequest} minPassword={minPw} />

        <MailSettings input={input} />

        <AgentSettings input={input} onSaved={() => setSettingsSaved((n) => n + 1)} />

        <DatasetAdmin datasets={datasets} visibilities={visibilities} input={input}
                      onChanged={onDatasetsChanged} />

        <ImportsPanel />

        <AuditLog />

        <TranscriptsAdmin datasets={datasets} input={input} refresh={settingsSaved} />

        <section className="space-y-3">
          <SectionHeading as="h3">Accounts</SectionHeading>
          <table className="w-full text-sm">
            <thead className="text-xs font-semibold text-fg-muted">
              <tr><th className="text-left">user</th><th className="text-left">role</th>
                  <th className="text-left">sessions</th><th /></tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.username} className="border-t border-line-subtle">
                  <td className="py-2 text-fg">
                    {u.username}{u.disabled ? <span className="text-danger"> (blocked)</span> : null}
                  </td>
                  <td className="py-2">
                    <select className={input} value={u.role}
                            onChange={(e) => run(adminPatchUser(u.username, { role: e.target.value }))}>
                      {roles.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </td>
                  <td className="py-2 text-fg-muted">{u.sessions}</td>
                  <td className="py-2 text-right">
                    <div className="inline-flex gap-1">
                      <Button variant="ghost" onClick={() => run(adminRevokeSessions(u.username))}>
                        sign out everywhere</Button>
                      <Button variant="ghost"
                              onClick={() => run(adminPatchUser(u.username, { disabled: !u.disabled }))}>
                        {u.disabled ? "unblock" : "block"}
                      </Button>
                      <Button variant="ghost" className="text-danger hover:text-danger"
                              onClick={() => run(adminDeleteUser(u.username))}>delete</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="flex flex-wrap gap-2 items-end pt-2">
            <input className={input} placeholder="new user" value={name} data-testid="admin-new-user"
                   onChange={(e) => setName(e.target.value)} />
            <input className={input} placeholder={`password (min. ${minPw})`} type="password" value={pw}
                   data-testid="admin-new-pw" onChange={(e) => setPw(e.target.value)} />
            <select className={input} value={role} onChange={(e) => setRole(e.target.value)}>
              {roles.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <Button variant="primary" size="md" data-testid="admin-create"
                    disabled={!name || pw.length < minPw}
                    reason={`a user name and a password of at least ${minPw} characters`}
                    onClick={() => run(adminCreateUser(name, pw, role).then(() => {
                      setName(""); setPw("");
                    }))}>
              create
            </Button>
          </div>
        </section>
      </div>
    </Dialog>
  );
}
