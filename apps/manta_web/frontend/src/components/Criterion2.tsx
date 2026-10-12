import { useState } from "react";
import type { Criterion2Asv, Criterion2Module, Criterion2Summary } from "../api";
import { fmtP } from "../format";
import { TextButton } from "./ui";


function HubDefinition({ glow }: { glow: string }) {
  return <>Hub{" — "}{glow}</>;
}

const NICHT_TESTBAR: Record<string, string> = {
  module_too_small: "module too small",
  module_disconnected: "module not connected",
  zero_variance: "all members equally central",
};
const stichwort = (reason: string | null, text: string | null) =>
  (reason && NICHT_TESTBAR[reason]) ?? text ?? "not testable";

export function HubInfoButton({ open, onToggle, testid, label }: {
  open: boolean; onToggle: () => void; testid: string; label: string;
}) {
  return (
    <button type="button" data-testid={testid} data-no-drag="" onClick={onToggle}
      aria-label={label} aria-expanded={open}
      className={`shrink-0 rounded-md px-1 text-xs ${open
        ? "bg-accent-soft text-accent" : "text-fg-muted hover:text-fg hover:bg-control"}`}>ⓘ</button>
  );
}

export function HubMark() {
  return <span data-testid="drawer-hub"
    className="shrink-0 text-sm font-normal text-mark">✦ hub</span>;
}

export function HubAsvDetails({ c2, moduleLabel, testid }: {
  c2: Criterion2Asv; moduleLabel: string | null; testid: string;
}) {
  return (
    <div data-testid={testid}
      className="rounded-md border border-line bg-raised px-3 py-2 space-y-1 text-xs leading-snug">
      <p className="text-fg" data-testid={`${testid}-definition`}><HubDefinition glow={c2.glow} /></p>
      <p className="text-fg-muted tabular-nums" data-testid={`${testid}-values`}>
        {moduleLabel ?? `module ${c2.module}`}{c2.module_size != null ? ` (${c2.module_size} members)` : ""}
        {" "}· closeness {c2.closeness?.toFixed(3) ?? "—"}
        {c2.module_mean_closeness != null && ` · module mean ${c2.module_mean_closeness.toFixed(3)}`}
        {" "}· q = {fmtP(c2.q)}
      </p>
    </div>
  );
}

export function Criterion2ModuleLine({ c2, testid }: { c2: Criterion2Module; testid: string }) {
  const [offen, setOffen] = useState(false);
  if (!c2.testable) {
    return (
      <div data-testid={testid} title={c2.reason_text ?? undefined} className="text-xs text-fg-muted">
        Hubs: not testable ({stichwort(c2.reason, c2.reason_text)})
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <div data-testid={testid} className="flex items-center gap-1 text-xs tabular-nums">
        <span className={c2.n_pass > 0 ? "text-mark" : "text-fg-muted"}>✦</span>
        <span className="text-fg">{c2.n_pass} of {c2.module_size} members are hubs</span>
        <HubInfoButton open={offen} onToggle={() => setOffen((v) => !v)}
          testid={`${testid}-info`} label="what a hub is" />
      </div>
      {offen && (
        <div data-testid={`${testid}-details`}
          className="rounded-md border border-line bg-raised px-3 py-2 space-y-1 text-xs leading-snug">
          <p className="text-fg"><HubDefinition glow={c2.glow} /></p>
          <p className="text-fg-muted tabular-nums">
            module mean closeness {c2.mean_closeness?.toFixed(3) ?? "—"}
            {c2.sd_closeness != null && ` · sd ${c2.sd_closeness.toFixed(3)}`}
          </p>
        </div>
      )}
    </div>
  );
}

export function Criterion2Details({ c2, testid }: { c2: Criterion2Summary; testid: string }) {
  const [offen, setOffen] = useState(false);
  return (
    <div className="space-y-1 text-xs leading-snug">
      <TextButton data-testid={`${testid}-how`} aria-expanded={offen}
        onClick={() => setOffen((v) => !v)}>
        {offen ? "hide how hubs are computed" : "how hubs are computed"}
      </TextButton>
      {offen && (
        <div data-testid={testid} className="space-y-1">
          <p className="text-fg" data-testid={`${testid}-verdict`}>{c2.statement}</p>
          <p className="text-fg-muted" data-testid={`${testid}-method`}>{c2.method}</p>
          <p className="text-fg-muted" data-testid={`${testid}-not-keystone`}>{c2.not_keystone}</p>
          <p className="text-fg-muted" data-testid={`${testid}-selection`}>{c2.selection_note}</p>
          <p className="text-fg-muted" data-testid={`${testid}-source`}>Source: {c2.source}</p>
        </div>
      )}
    </div>
  );
}
