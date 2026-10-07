import { useState } from "react";
import { login, type Me } from "../api";
import SignupForm from "./SignupForm";

export default function LoginScreen(
  { onDone, onGuest }: { onDone: (me: Me) => void; onGuest: () => void },
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

  const input = "w-full mt-1 px-3 py-2 rounded bg-slate-950 border border-slate-700 text-sm " +
                "text-slate-100 focus:border-cyan-500 focus:outline-none";

  if (asking) return <SignupForm onBack={() => setAsking(false)} />;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900">
      <form onSubmit={submit} data-testid="login-form"
            className="w-[22rem] rounded-lg border border-slate-700 bg-slate-800/60 p-6 space-y-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-100 tracking-wide">MANTA</h1>
          <p className="text-xs text-slate-400 mt-1">
            Marine Amplicon Network Time-series Analysis. Sign in to see internal datasets.
          </p>
        </div>

        <label className="block">
          <span className="text-[11px] uppercase tracking-wide text-slate-500">User</span>
          <input data-testid="login-user" className={input} value={username} autoFocus
                 autoComplete="username" onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-[11px] uppercase tracking-wide text-slate-500">Password</span>
          <input data-testid="login-pw" className={input} type="password" value={password}
                 autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} />
        </label>

        {error && (
          <p data-testid="login-error" className="text-xs text-red-400">{error}</p>
        )}

        <button type="submit" disabled={busy || !username || !password}
                data-testid="login-submit"
                className="w-full py-2 rounded bg-cyan-600 text-sm font-medium text-white
                           disabled:opacity-40 hover:bg-cyan-500">
          {busy ? "signing in …" : "Sign in"}
        </button>

        <button type="button" onClick={onGuest} data-testid="login-guest"
                className="w-full text-xs text-slate-400 hover:text-cyan-300 hover:underline">
          view as guest — public datasets only
        </button>

        <button type="button" onClick={() => setAsking(true)} data-testid="login-request"
                className="w-full text-xs text-slate-400 hover:text-cyan-300 hover:underline">
          no account yet? request access
        </button>
      </form>
    </div>
  );
}
