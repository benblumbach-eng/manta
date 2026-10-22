import { Button, SectionHeading, TextButton } from "./ui";
import { useEffect, useState } from "react";
import { getOwnModel, removeOwnModel, saveOwnModel, type OwnModel } from "../api";

export const OWN_MODEL_EVENT = "manta:own-model";

export const PRESETS: Record<string, { label: string; base_url: string; model: string }> = {
  anthropic: { label: "Anthropic (Claude)", base_url: "https://api.anthropic.com/v1",
               model: "claude-sonnet-5" },
  openai: { label: "OpenAI", base_url: "https://api.openai.com/v1", model: "" },
  other: { label: "other (OpenAI-compatible)", base_url: "", model: "" },
};

const FIELD = "w-full bg-surface border border-line rounded px-2 py-1 text-xs text-fg outline-none " +
              "focus:border-accent";

export function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

export default function OwnModelSettings() {
  const [own, setOwn] = useState<OwnModel | null>(null);
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState("anthropic");
  const [url, setUrl] = useState(PRESETS.anthropic.base_url);
  const [model, setModel] = useState(PRESETS.anthropic.model);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { getOwnModel().then(setOwn).catch((e) => setErr(String(e.message ?? e))); }, []);

  const done = (o: OwnModel) => {
    setOwn(o); setOpen(false); setKey(""); setErr(null);
    window.dispatchEvent(new Event(OWN_MODEL_EVENT));
  };
  const run = (p: Promise<OwnModel>) => {
    setBusy(true); setErr(null);
    p.then(done).catch((e) => setErr(String(e.message ?? e))).finally(() => setBusy(false));
  };
  const edit = () => {
    const p = Object.entries(PRESETS).find(([, v]) => v.base_url && v.base_url === own?.base_url);
    setPreset(own?.set ? (p?.[0] ?? "other") : "anthropic");
    setUrl(own?.set ? own.base_url ?? "" : PRESETS.anthropic.base_url);
    setModel(own?.set ? own.model ?? "" : PRESETS.anthropic.model);
    setKey(""); setErr(null); setOpen(true);
  };
  const pick = (name: string) => {
    setPreset(name);
    setUrl(PRESETS[name].base_url); setModel(PRESETS[name].model);
  };
  const sameUrl = own?.set && url.trim().replace(/\/+$/, "") === own.base_url;
  const keyNeeded = !key.trim() && !sameUrl;

  return (
    <div className="pt-3 border-t border-line space-y-2" data-testid="own-model">
      <SectionHeading>Own model</SectionHeading>
      {!open && (
        <div className="text-xs text-fg">
          {own === null ? "…" : own.set ? (
            <span data-testid="own-model-summary">{own.model} · {hostOf(own.base_url ?? "")}</span>
          ) : (
            <span className="text-fg-muted">none — the assistant uses the local model</span>
          )}
          <div className="mt-1 flex gap-3">
            <TextButton data-testid="own-model-edit" className="text-xs" onClick={edit}>
              {own?.set ? "change …" : "connect …"}</TextButton>
            {own?.set && (
              <TextButton data-testid="own-model-remove" className="text-xs" disabled={busy}
                onClick={() => run(removeOwnModel())}>remove</TextButton>
            )}
          </div>
        </div>
      )}
      {open && (
        <div className="space-y-2" data-testid="own-model-form">
          {([
            ["Provider", (
              <select data-testid="own-model-preset" value={preset}
                onChange={(e) => pick(e.target.value)} className={FIELD}>
                {Object.entries(PRESETS).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
              </select>
            )],
            ["Address", (
              <input data-testid="own-model-url" value={url} spellCheck={false}
                onChange={(e) => setUrl(e.target.value)} placeholder="https://…/v1"
                className={`${FIELD} font-mono`} />
            )],
            ["Model", (
              <input data-testid="own-model-model" value={model} spellCheck={false}
                onChange={(e) => setModel(e.target.value)} placeholder="model name"
                className={`${FIELD} font-mono`} />
            )],
            ["API key", (
              <input data-testid="own-model-key" type="password" value={key} autoComplete="off"
                onChange={(e) => setKey(e.target.value)}
                placeholder={sameUrl ? "(unchanged)" : "sk-…"} className={`${FIELD} font-mono`} />
            )],
          ] as const).map(([label, control]) => (
            <label key={label} className="flex items-center gap-2 text-xs text-fg-muted">
              <span className="w-14 shrink-0">{label}</span>
              <span className="flex-1 min-w-0">{control}</span>
            </label>
          ))}
          <p className="text-2xs text-fg-muted">Stored encrypted with your account.</p>
          {err && <p data-testid="own-model-error" className="text-xs text-danger">{err}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>cancel</Button>
            <Button variant="primary" data-testid="own-model-save"
              disabled={busy || !url.trim() || !model.trim() || keyNeeded}
              reason={keyNeeded ? "enter the API key" : "address and model are needed"}
              onClick={() => run(saveOwnModel(url.trim(), model.trim(), key.trim()))}>save</Button>
          </div>
        </div>
      )}
    </div>
  );
}
