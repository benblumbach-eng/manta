import { Button } from "./ui";
import { useEffect, useState } from "react";
import { mailSettings, resetMailSettings, saveMailSettings, testMail,
         type MailSettingsPatch, type MailSettingsView } from "../api";
import InfoTip from "./InfoTip";
import SecretRemove, { patchField, secretNeededAgain, serverAskedFor } from "./SecretRemove";

const FIELDS: { key: keyof MailSettingsPatch; label: string; placeholder: string }[] = [
  { key: "smtp_host", label: "SMTP server", placeholder: "smtp.example.org" },
  { key: "smtp_port", label: "Port", placeholder: "587" },
  { key: "smtp_user", label: "User", placeholder: "you@example.org" },
  { key: "smtp_password", label: "Password", placeholder: "(unchanged)" },
  { key: "mail_from", label: "From", placeholder: "manta@example.org" },
  { key: "request_mailto", label: "Access requests to", placeholder: "you@example.org, team@…" },
  { key: "public_url", label: "Public address", placeholder: "https://manta.example.org" },
];

export default function MailSettings({ input }: { input: string }) {
  const [state, setState] = useState<MailSettingsView | null>(null);
  const [patch, setPatch] = useState<MailSettingsPatch>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => mailSettings().then(setState).catch((e) => setErr(String(e.message ?? e)));
  useEffect(() => { load(); }, []);

  const run = async (p: Promise<unknown>, ok: string) => {
    setBusy(true); setErr(null); setMsg(null);
    try { await p; setMsg(ok); setPatch({}); await load(); }
    catch (e) { setErr(String((e as Error).message ?? e)); }
    finally { setBusy(false); }
  };

  if (!state) return <section data-testid="mail-settings" className="text-xs text-fg-muted">…</section>;

  const gespeichert = (key: keyof MailSettingsPatch): string =>
    key === "smtp_password" ? "" : (state.values[key as keyof typeof state.values] as string) ?? "";
  const value = (key: keyof MailSettingsPatch) => patch[key] ?? gespeichert(key);
  const nochmal = secretNeededAgain("smtp_password", patch, state.values,
                                    state.values.smtp_password_set)
    || (serverAskedFor("smtp_password", err) && !("smtp_password" in patch));

  return (
    <section className="space-y-3" data-testid="mail-settings">
      <h3 className="flex items-center text-sm font-medium text-fg">
        Mail
        <InfoTip title="Where these values come from">
          <p>Saved here, they live in the database and win over <code>deploy/.env</code>, which is
          only the starting value. Clearing a field is a decision too: it switches the setting off
          even if the file still has it.</p>
          <p>The password is stored so the server can log in to your mail host; it is never shown
          again.</p>
        </InfoTip>
      </h3>

      <p className="text-xs text-fg-muted" data-testid="mail-state">
        {state.mail.configured
          ? <>Sending as <span className="text-fg">{state.mail.sender}</span>
             {state.mail.collect_to.length > 0
               ? <> to <span className="text-fg">{state.mail.collect_to.join(", ")}</span></>
               : <span className="text-warn"> — but no recipient is set</span>}</>
          : <span className="text-warn">No mail server configured — requests are stored, nobody is notified.</span>}
      </p>

      <div className="grid grid-cols-2 gap-2">
        {FIELDS.map(({ key, label, placeholder }) => (
          <label key={key} className="text-xs text-fg-muted">
            {label}
            <span className="ml-1 text-fg-muted">
              {state.source[key] === "panel" ? "panel" : state.source[key] === "env" ? ".env" : ""}
            </span>
            <input
              data-testid={`mail-${key}`} placeholder={placeholder}
              className={key === "smtp_password" && nochmal
                ? input.replace("border-line", "border-warn") : input}
              aria-invalid={key === "smtp_password" && nochmal ? true : undefined}
              type={key === "smtp_password" ? "password" : "text"}
              value={value(key)}
              onChange={(e) => setPatch(patchField(patch, key, e.target.value))} />
          </label>
        ))}
        <label className="text-xs text-fg-muted">
          Encryption
          <span className="ml-1 text-fg-muted">
            {state.source.smtp_tls === "panel" ? "panel" : state.source.smtp_tls === "env" ? ".env" : ""}
          </span>
          <select data-testid="mail-smtp_tls" className={input}
                  value={patch.smtp_tls ?? state.values.smtp_tls ?? "starttls"}
                  onChange={(e) => setPatch({ ...patch, smtp_tls: e.target.value })}>
            {["starttls", "ssl", "none"].map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
      </div>

      {nochmal ? (
        <p data-testid="mail-secret-again" role="alert" className="text-xs text-warn">
          Server, port or encryption changed: enter the password again — the stored one is never
          sent to a new destination.
        </p>
      ) : state.values.smtp_password_set && !("smtp_password" in patch) && (
        <p className="text-2xs text-fg-muted">
          A password is stored. Leave the field empty to keep it.{" "}
          <SecretRemove what="password" busy={busy} testid="mail-password-remove"
            onRemove={() => run(saveMailSettings({ smtp_password: "" }), "password removed")} />
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="md" data-testid="mail-save"
          disabled={busy || Object.keys(patch).length === 0} reason={busy ? "saving" : "nothing changed"}
          onClick={() => run(saveMailSettings(patch), "saved")}>save</Button>
        <Button variant="ghost" data-testid="mail-reset" disabled={busy}
          onClick={() => run(resetMailSettings([...FIELDS.map((f) => f.key), "smtp_tls"]),
                             "back to deploy/.env")}>
          back to .env
        </Button>
        <span className="flex-1" />
        <input data-testid="mail-test-to" className={input + " w-56"} placeholder="test message to …"
               value={to} onChange={(e) => setTo(e.target.value)} />
        <Button size="md" data-testid="mail-test" disabled={busy || !to.trim()} reason="enter an address first"
          onClick={() => run(testMail(to.trim()).then((r) => {
            if (r.status !== "sent") throw new Error(r.status);
          }), `test message sent to ${to.trim()}`)}>
          send test
        </Button>
      </div>

      {msg && <p data-testid="mail-msg" className="text-xs text-ok">{msg}</p>}
      {err && !serverAskedFor("smtp_password", err) && (
        <p data-testid="mail-error" className="text-xs text-danger">{err}</p>
      )}
      {state.updated_by && (
        <p className="text-2xs text-fg-muted">last change by {state.updated_by}</p>
      )}
    </section>
  );
}
