import { Button } from "./ui";
import { useEffect, useState } from "react";
import { agentSettings, resetAgentSettings, saveAgentSettings,
         type AgentSettingsPatch, type MailSettingsView } from "../api";
import InfoTip from "./InfoTip";
import SecretRemove, { patchField, secretNeededAgain, serverAskedFor } from "./SecretRemove";

const KEYS: { key: keyof AgentSettingsPatch; label: string; placeholder: string;
               hint?: string }[] = [
  { key: "ollama_model", label: "Local model", placeholder: "qwen2.5:7b" },
  { key: "openai_base_url", label: "Provider URL", placeholder: "https://api.openai.com/v1" },
  { key: "openai_api_key", label: "API key", placeholder: "(unchanged)" },
  { key: "openai_models", label: "Provider models", placeholder: "gpt-4o-mini, gpt-4o" },
  { key: "openai_timeout", label: "Timeout (s)", placeholder: "120" },
  { key: "provider_hosts", label: "Hosts for own providers",
    placeholder: "api.openai.com, llm.example.org:8443",
    hint: "host or host:port, comma-separated; with a port only that port matches" },
];

const GROUNDING: { value: string; text: string }[] = [
  { value: "mark", text: "mark — flag numbers without evidence" },
  { value: "refuse", text: "refuse — replace the whole answer" },
  { value: "off", text: "off — no check" },
];

export default function AgentSettings({ input, onSaved }:
  { input: string; onSaved?: () => void }) {
  const [state, setState] = useState<MailSettingsView | null>(null);
  const [patch, setPatch] = useState<AgentSettingsPatch>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => agentSettings().then(setState).catch((e) => setErr(String(e.message ?? e)));
  useEffect(() => { load(); }, []);

  const run = async (p: Promise<unknown>, ok: string) => {
    setBusy(true); setErr(null); setMsg(null);
    try { await p; setMsg(ok); setPatch({}); await load(); onSaved?.(); }
    catch (e) { setErr(String((e as Error).message ?? e)); }
    finally { setBusy(false); }
  };

  if (!state) return <section data-testid="agent-settings" className="text-xs text-fg-muted">…</section>;

  const gespeichert = (key: keyof AgentSettingsPatch): string =>
    key === "openai_api_key" ? "" : (state.values[key as keyof typeof state.values] as string) ?? "";
  const value = (key: keyof AgentSettingsPatch) => patch[key] ?? gespeichert(key);
  const herkunft = (key: string) =>
    state.source[key] === "panel" ? "panel" : state.source[key] === "env" ? ".env" : "";
  const nochmal = secretNeededAgain("openai_api_key", patch, state.values,
                                    state.values.openai_api_key_set)
    || (serverAskedFor("openai_api_key", err) && !("openai_api_key" in patch));

  return (
    <section className="space-y-3" data-testid="agent-settings">
      <h3 className="flex items-center text-sm font-medium text-fg">
        Assistant
        <InfoTip title="What these decide">
          <p>The <strong>local model</strong> is the default when nobody picks one. A
          <strong> provider</strong> is optional: with a URL, a key and at least one model name,
          those models appear in the chat next to the local ones.</p>
          <p><strong>Evidence</strong> decides what happens to numbers in an answer that appear in
          no tool result — mark them, refuse the answer, or do not check. Changes take effect
          immediately, without restarting.</p>
          <p><strong>Hosts for own providers</strong> limits where a user&rsquo;s own provider
          (their own key in the chat) may point. Empty: any https address, http only to
          localhost.</p>
          <p>Every conversation is saved to its account. With <strong>Admins can read all
          transcripts</strong> on (the default), administrators can open every account&rsquo;s
          transcripts below, and the chat tells its users so.</p>
        </InfoTip>
      </h3>

      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-fg-muted">
          Evidence
          <span className="ml-1 text-fg-muted">{herkunft("grounding")}</span>
          <select data-testid="agent-grounding" className={input}
                  value={patch.grounding ?? state.values.grounding ?? "mark"}
                  onChange={(e) => setPatch({ ...patch, grounding: e.target.value })}>
            {GROUNDING.map((g) => <option key={g.value} value={g.value}>{g.text}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 self-end pb-1 text-xs text-fg">
          <input type="checkbox" data-testid="agent-admins_read_transcripts"
                 checked={(patch.admins_read_transcripts
                           ?? state.values.admins_read_transcripts ?? "") !== "off"}
                 onChange={(e) => setPatch({ ...patch,
                   admins_read_transcripts: e.target.checked ? "on" : "off" })} />
          Admins can read all transcripts
          <span className="text-2xs text-fg-muted">{herkunft("admins_read_transcripts")}</span>
        </label>
        {KEYS.map(({ key, label, placeholder, hint }) => (
          <label key={key} className={`text-xs text-fg-muted${
            hint ? " col-span-2" : ""}`}>
            {label}
            <span className="ml-1 text-fg-muted">{herkunft(key)}</span>
            <input data-testid={`agent-${key}`} placeholder={placeholder}
                   className={key === "openai_api_key" && nochmal
                     ? input.replace("border-line", "border-warn") : input}
                   aria-invalid={key === "openai_api_key" && nochmal ? true : undefined}
                   type={key === "openai_api_key" ? "password" : "text"}
                   value={value(key)}
                   onChange={(e) => setPatch(patchField(patch, key, e.target.value))} />
            {hint && (
              <span data-testid={`agent-${key}-hint`}
                className="mt-1 block normal-case tracking-normal text-fg-muted">{hint}</span>
            )}
          </label>
        ))}
      </div>

      {nochmal ? (
        <p data-testid="agent-secret-again" role="alert" className="text-xs text-warn">
          The provider URL changed: enter the API key again — the stored one is never sent to a
          new address.
        </p>
      ) : state.values.openai_api_key_set && !("openai_api_key" in patch) && (
        <p className="text-2xs text-fg-muted">
          A key is stored. Leave the field empty to keep it.{" "}
          <SecretRemove what="key" busy={busy} testid="agent-key-remove"
            onRemove={() => run(saveAgentSettings({ openai_api_key: "" }), "key removed")} />
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="md" data-testid="agent-save"
          disabled={busy || Object.keys(patch).length === 0} reason={busy ? "saving" : "nothing changed"}
          onClick={() => run(saveAgentSettings(patch), "saved")}>save</Button>
        <Button variant="ghost" data-testid="agent-reset" disabled={busy}
          onClick={() => run(resetAgentSettings([...KEYS.map((k) => k.key), "grounding",
                                                 "admins_read_transcripts"]),
                             "back to deploy/.env")}>
          back to .env
        </Button>
      </div>

      {msg && <p data-testid="agent-msg" className="text-xs text-ok">{msg}</p>}
      {err && !serverAskedFor("openai_api_key", err) && (
        <p data-testid="agent-error" className="text-xs text-danger">{err}</p>
      )}
    </section>
  );
}
