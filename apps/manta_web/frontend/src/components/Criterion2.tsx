import { useState } from "react";
import type { Criterion2Asv, Criterion2Summary } from "../api";
import { fmtP } from "../format";
import { TextButton } from "./ui";


function HubDefinition({ glow }: { glow: string }) {
  return <>Hub{" — "}{glow}</>;
}

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
        {c2.mean_closeness != null && ` · network mean ${c2.mean_closeness.toFixed(3)}`}
        {" "}· q = {fmtP(c2.q)}
      </p>
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
