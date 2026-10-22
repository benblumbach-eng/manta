import { Button, Dialog } from "./ui";
import { Segmented } from "./controls";
import { useEffect, useState } from "react";
import {
  adminCreateUser, adminDeleteUser, adminPatchUser, adminRevokeSessions, adminUsers,
  type AdminUser, type Dataset,
} from "../api";
import AccessRequests from "./AccessRequests";
import AuditLog from "./AuditLog";
import DatasetAdmin from "./DatasetAdmin";
import ImportsPanel from "./ImportsPanel";
import MailSettings from "./MailSettings";
import StatusPanel from "./StatusPanel";
import TranscriptsAdmin from "./TranscriptsAdmin";

type Tab = "accounts" | "datasets" | "mail" | "transcripts" | "log";

const TABS: { value: Tab; label: string; intro: string }[] = [
  { value: "accounts", label: "Accounts",
    intro: "Answer access requests and manage who can sign in." },
  { value: "datasets", label: "Datasets",
    intro: "Rename, place, publish or delete datasets, and follow running imports." },
  { value: "mail", label: "Mail",
    intro: "The mail server MANTA uses to send access requests and replies." },
  { value: "transcripts", label: "Transcripts",
    intro: "Every assistant conversation of every account, for supervision." },
  { value: "log", label: "Log",
    intro: "Whether the services are running, and who changed what." },
];

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
  const [tab, setTab] = useState<Tab>("accounts");
  useEffect(() => { if (focusRequest != null) setTab("accounts"); }, [focusRequest]);

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

        <Segmented value={tab} onChange={setTab} testid="admin-tabs"
          options={TABS.map((t) => ({ value: t.value, label: t.label, testid: `admin-tab-${t.value}` }))} />
        <p data-testid="admin-intro" className="text-xs text-fg-muted">
          {TABS.find((t) => t.value === tab)?.intro}
        </p>

        {tab === "accounts" && <>
        <AccessRequests onAccountsChanged={reload} focusRequest={focusRequest} minPassword={minPw} />

        <section className="space-y-3">
          <h3 className="text-sm font-medium text-fg">Accounts</h3>
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
        </>}

        {tab === "datasets" && <>
          <DatasetAdmin datasets={datasets} visibilities={visibilities} input={input}
                        onChanged={onDatasetsChanged} />
          <ImportsPanel />
        </>}

        {tab === "mail" && <MailSettings input={input} />}

        {tab === "transcripts" && <TranscriptsAdmin datasets={datasets} input={input} />}

        {tab === "log" && <>
          <StatusPanel />
          <AuditLog />
        </>}
      </div>
    </Dialog>
  );
}
