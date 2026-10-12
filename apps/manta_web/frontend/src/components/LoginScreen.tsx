import { Button } from "./ui";
import { useState } from "react";
import { login, type Me } from "../api";
import SignupForm from "./SignupForm";

export default function LoginScreen(
  { onDone, onGuest, notice = null }: {
    onDone: (me: Me) => void; onGuest: () => void;
    notice?: string | null;
  },
) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await login(username, password));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const input = "w-full mt-1 px-3 py-2 rounded-md bg-control border border-line-strong text-sm " +
                "text-fg focus:border-accent focus:outline-none";

  if (asking) return <SignupForm onBack={() => setAsking(false)} />;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-surface p-4">
      <form onSubmit={submit} data-testid="login-form"
            className="w-full max-w-[22rem] rounded-lg border border-line bg-raised p-6 space-y-4 shadow-xl">
        <div>
          <h1 className="text-xl font-semibold text-fg tracking-wide">MANTA</h1>
          <p className="text-xs text-fg-muted mt-1">
            Marine Amplicon Network Time-series Analysis. Sign in to see internal datasets.
          </p>
        </div>

        {notice && (
          <p data-testid="signed-out-notice" role="status"
             className="rounded border border-warn bg-warn-soft px-2 py-2 text-xs text-warn">
            {notice}
          </p>
        )}

        <label className="block">
          <span className="text-xs text-fg-muted">User</span>
          <input data-testid="login-user" className={input} value={username} autoFocus
                 autoComplete="username" onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-xs text-fg-muted">Password</span>
          <input data-testid="login-pw" className={input} type="password" value={password}
                 autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} />
        </label>

        {error && (
          <p data-testid="login-error" className="text-xs text-danger">{error}</p>
        )}

        <Button type="submit" variant="primary" size="md" className="w-full"
                disabled={busy || !username || !password}
                reason={busy ? "signing in" : "enter user and password first"}
                data-testid="login-submit">
          {busy ? "signing in …" : "Sign in"}
        </Button>

        <Button variant="ghost" onClick={onGuest} data-testid="login-guest" className="w-full">
          view as guest — public datasets only
        </Button>

        <Button variant="ghost" onClick={() => setAsking(true)} data-testid="login-request"
                className="w-full">
          no account yet? request access
        </Button>
      </form>
    </div>
  );
}
