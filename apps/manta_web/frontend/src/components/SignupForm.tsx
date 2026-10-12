import { Button } from "./ui";
import { useEffect, useState } from "react";
import { signupOptions, submitSignup, type SignupOptions } from "../api";

export default function SignupForm({ onBack }: { onBack: () => void }) {
  const [opts, setOpts] = useState<SignupOptions | null>(null);
  const [form, setForm] = useState({
    full_name: "", email: "", institution: "", topic: "", wanted_username: "", reason: "",
    website: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    signupOptions().then(setOpts).catch(() => setOpts({ topics: [], mail_configured: false }));
  }, []);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement |
    HTMLTextAreaElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await submitSignup(form);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const input = "w-full mt-1 px-3 py-2 rounded-md bg-control border border-line-strong text-sm " +
                "text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none";
  const label = "text-xs text-fg-muted";

  if (done) {
    return (
      <div className="fixed inset-0 z-50 grid place-items-center bg-surface overflow-y-auto p-4">
        <div data-testid="signup-done"
             className="w-full max-w-[26rem] rounded-lg border border-line bg-raised p-6 space-y-4 shadow-xl">
          <h1 className="text-xl font-semibold text-fg">Request filed</h1>
          <p className="text-sm text-fg">
            {opts?.mail_configured
              ? "Thank you. Your request is recorded and the people responsible have been notified. You will hear from them by e-mail — accounts are created by hand, so this is not instant."
              : "Thank you. Your request is recorded and waiting in the administration page. Note that this instance sends no notifications, so nobody was alerted automatically — if it stays quiet, ask the people who run MANTA directly."}
          </p>
          <Button variant="primary" size="md" className="w-full" onClick={onBack} data-testid="signup-back">
            back to sign in
          </Button>
        </div>
      </div>
    );
  }

  const complete = form.full_name.trim() && form.email.trim() && form.reason.trim().length >= 10;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-surface overflow-y-auto p-4">
      <form onSubmit={submit} data-testid="signup-form"
            className="w-full max-w-[26rem] rounded-lg border border-line bg-raised p-6 space-y-4 shadow-xl">
        <div>
          <h1 className="text-xl font-semibold text-fg tracking-wide">Request access</h1>
          <p className="text-xs text-fg-muted mt-1">
            MANTA has no self-registration. This form asks for an account; a person reads it and
            decides.
          </p>
        </div>

        {opts && !opts.mail_configured && (
          <p data-testid="signup-nomail"
             className="text-xs text-warn border border-warn bg-warn-soft rounded-md px-3 py-2">
            This instance sends no notifications (no mail server or no recipient configured).
            Your request will still be recorded and waits in the administration page — but
            nobody is alerted automatically, so expect it to take longer.
          </p>
        )}

        <label className="block">
          <span className={label}>Name *</span>
          <input data-testid="signup-name" className={input} value={form.full_name} autoFocus
                 autoComplete="name" onChange={set("full_name")} />
        </label>

        <label className="block">
          <span className={label}>E-mail *</span>
          <input data-testid="signup-email" className={input} type="email" value={form.email}
                 autoComplete="email" onChange={set("email")} />
        </label>

        <label className="block">
          <span className={label}>Institution / group</span>
          <input data-testid="signup-institution" className={input} value={form.institution}
                 autoComplete="organization" onChange={set("institution")} />
        </label>

        {opts && opts.topics.length > 0 && (
          <label className="block">
            <span className={label}>Who should receive this?</span>
            <select data-testid="signup-topic" className={input} value={form.topic}
                    onChange={set("topic")}>
              <option value="">— general —</option>
              {opts.topics.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </label>
        )}

        <label className="block">
          <span className={label}>Preferred user name</span>
          <input data-testid="signup-username" className={input} value={form.wanted_username}
                 autoComplete="off" placeholder="optional — lowercase letters, digits, . _ -"
                 onChange={set("wanted_username")} />
        </label>

        <label className="block">
          <span className={label}>What do you need access for? *</span>
          <textarea data-testid="signup-reason" className={input + " h-24 resize-y"}
                    value={form.reason} onChange={set("reason")} />
        </label>

        <div aria-hidden="true"
             style={{ position: "absolute", left: "-9999px", width: 1, height: 1, overflow: "hidden" }}>
          <label>
            Website
            <input tabIndex={-1} autoComplete="off" value={form.website} onChange={set("website")} />
          </label>
        </div>

        {error && <p data-testid="signup-error" className="text-xs text-danger">{error}</p>}

        <Button type="submit" variant="primary" size="md" className="w-full"
                disabled={busy || !complete} data-testid="signup-submit"
                reason={busy ? "sending" : "fill in name, e-mail and a reason of at least 10 characters"}>
          {busy ? "sending …" : "Send request"}
        </Button>

        <Button variant="ghost" className="w-full" onClick={onBack} data-testid="signup-cancel">
          back to sign in
        </Button>
      </form>
    </div>
  );
}
