import { useState } from "react";

export const SECRET_KEYS = new Set(["smtp_password", "openai_api_key"]);

export function patchField<P extends object>(patch: P, key: string, v: string): P {
  if (SECRET_KEYS.has(key) && v === "") {
    const rest = { ...patch } as Record<string, unknown>;
    delete rest[key];
    return rest as P;
  }
  return { ...patch, [key]: v };
}

export const SECRET_TARGETS: Record<string, string[]> = {
  smtp_password: ["smtp_host", "smtp_port", "smtp_tls"],
  openai_api_key: ["openai_base_url"],
};

function ziel(key: string, value: string | undefined): string {
  const v = (value ?? "").trim();
  if (key === "openai_base_url") return (v || "https://api.openai.com/v1").replace(/\/+$/, "").toLowerCase();
  if (key === "smtp_tls") return (v || "starttls").toLowerCase();
  if (key === "smtp_port") return v || "587";
  return v.toLowerCase();
}

export function secretNeededAgain(secret: string, patch: Record<string, string | undefined>,
                                  stored: Record<string, unknown>, isSet: boolean): boolean {
  if (!isSet || secret in patch) return false;
  return (SECRET_TARGETS[secret] ?? []).some((k) =>
    k in patch && ziel(k, patch[k]) !== ziel(k, stored[k] as string | undefined));
}

export const serverAskedFor = (secret: string, err: string | null): boolean =>
  !!err && err.includes(`enter ${secret} again`);

export default function SecretRemove({ what, busy, onRemove, testid }:
  { what: string; busy: boolean; onRemove: () => void; testid: string }) {
  const [ask, setAsk] = useState(false);
  if (!ask) {
    return (
      <button data-testid={testid} disabled={busy} onClick={() => setAsk(true)}
        className="underline text-fg-muted hover:text-danger disabled:opacity-40">
        remove the stored {what}
      </button>
    );
  }
  return (
    <span className="text-danger">
      Remove the stored {what}? It is switched off, even if deploy/.env still has one.{" "}
      <button data-testid={`${testid}-yes`} disabled={busy}
        onClick={() => { setAsk(false); onRemove(); }}
        className="underline hover:text-danger">remove</button>{" "}
      <button onClick={() => setAsk(false)}
        className="underline text-fg-muted hover:text-fg">keep</button>
    </span>
  );
}
