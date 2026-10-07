import { useEffect, useState } from "react";
import { agentSettings, resetAgentSettings, saveAgentSettings,
         type AgentSettingsPatch, type MailSettingsView } from "../api";
import InfoTip from "./InfoTip";

const KEYS: { key: keyof AgentSettingsPatch; label: string; placeholder: string }[] = [
  { key: "ollama_model", label: "Local model", placeholder: "qwen2.5:7b" },
  { key: "openai_base_url", label: "Provider URL", placeholder: "https://api.openai.com/v1" },
  { key: "openai_api_key", label: "API key", placeholder: "(unchanged)" },
  { key: "openai_models", label: "Provider models", placeholder: "gpt-4o-mini, gpt-4o" },
  { key: "openai_timeout", label: "Timeout (s)", placeholder: "120" },
];

const GROUNDING: { value: string; text: string }[] = [
  { value: "mark", text: "mark — flag numbers without evidence" },
  { value: "refuse", text: "refuse — replace the whole answer" },
  { value: "off", text: "off — no check" },
];

export default function AgentSettings({ input }: { input: string }) {
  const [state, setState] = useState<MailSettingsView | null>(null);
  const [patch, setPatch] = useState<AgentSettingsPatch>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => agentSettings().then(setState).catch((e) => setErr(String(e.message ?? e)));
  useEffect(() => { load(); }, []);

  const run = async (p: Promise<unknown>, ok: string) => {
    setBusy(true); setErr(null); setMsg(null);
    try { await p; setMsg(ok); setPatch({}); await load(); }
    catch (e) { setErr(String((e as Error).message ?? e)); }
    finally { setBusy(false); }
  };

  if (!state) return <section data-testid="agent-settings" className="text-xs text-slate-500">…</section>;

  const gespeichert = (key: keyof AgentSettingsPatch): string =>
    key === "openai_api_key" ? "" : (state.values[key as keyof typeof state.values] as string) ?? "";
  const value = (key: keyof AgentSettingsPatch) => patch[key] ?? gespeichert(key);
  const herkunft = (key: string) =>
    state.source[key] === "panel" ? "panel" : state.source[key] === "env" ? ".env" : "";

  return (
    <section className="space-y-3" data-testid="agent-settings">
      <h3 className="flex items-center text-sm font-medium text-slate-200">
        Assistant
        <InfoTip title="What these decide">
          <p>The <strong>local model</strong> is the default when nobody picks one. A
          <strong> provider</strong> is optional: with a URL, a key and at least one model name,
          those models appear in the chat next to the local ones.</p>
          <p><strong>Evidence</strong> decides what happens to numbers in an answer that appear in
          no tool result — mark them, refuse the answer, or do not check. Changes take effect
          immediately, without restarting.</p>
        </InfoTip>
      </h3>

      <div className="grid grid-cols-2 gap-2">
        <label className="text-[11px] uppercase tracking-wide text-slate-500">
          Evidence
          <span className="ml-1 normal-case tracking-normal text-slate-600">{herkunft("grounding")}</span>
          <select data-testid="agent-grounding" className={input}
                  value={patch.grounding ?? state.values.grounding ?? "mark"}
                  onChange={(e) => setPatch({ ...patch, grounding: e.target.value })}>
            {GROUNDING.map((g) => <option key={g.value} value={g.value}>{g.text}</option>)}
          </select>
        </label>
        {KEYS.map(({ key, label, placeholder }) => (
          <label key={key} className="text-[11px] uppercase tracking-wide text-slate-500">
            {label}
            <span className="ml-1 normal-case tracking-normal text-slate-600">{herkunft(key)}</span>
            <input data-testid={`agent-${key}`} className={input} placeholder={placeholder}
                   type={key === "openai_api_key" ? "password" : "text"}
                   value={value(key)}
                   onChange={(e) => setPatch({ ...patch, [key]: e.target.value })} />
          </label>
        ))}
      </div>

      {state.values.openai_api_key_set && !("openai_api_key" in patch) && (
        <p className="text-[11px] text-slate-500">A key is stored. Leave the field empty to keep it.</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button data-testid="agent-save" disabled={busy || Object.keys(patch).length === 0}
          className="px-3 py-1 rounded bg-cyan-700 text-sm text-white hover:bg-cyan-500 disabled:opacity-40"
          onClick={() => run(saveAgentSettings(patch), "saved")}>save</button>
        <button data-testid="agent-reset" disabled={busy}
          className="text-xs text-slate-400 hover:text-cyan-300"
          onClick={() => run(resetAgentSettings([...KEYS.map((k) => k.key), "grounding"]),
                             "back to deploy/.env")}>
          back to .env
        </button>
      </div>

      {msg && <p data-testid="agent-msg" className="text-xs text-emerald-400">{msg}</p>}
      {err && <p data-testid="agent-error" className="text-xs text-red-400">{err}</p>}
    </section>
  );
}
