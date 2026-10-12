import { useState } from "react";
import type { Criterion2Asv, Criterion2Module, Criterion2Summary } from "../api";
import { fmtP } from "../format";
import { TextButton } from "./ui";


const NICHT_TESTBAR: Record<string, string> = {
  module_too_small: "module too small",
  module_disconnected: "module not connected",
  zero_variance: "all members equally central",
};
const stichwort = (reason: string | null, text: string | null) =>
  (reason && NICHT_TESTBAR[reason]) ?? text ?? "not testable";

export function Criterion2AsvLine({ c2, testid }: { c2: Criterion2Asv; testid: string }) {
  if (!c2.testable) {
    return (
      <div data-testid={testid} data-passes="0" title={c2.reason_text ?? undefined}
        className="text-xs text-fg-muted">
        Centrality in module: not testable ({stichwort(c2.reason, c2.reason_text)})
      </div>
    );
  }
  return (
    <div data-testid={testid} data-passes={c2.passes ? "1" : "0"} title={c2.glow}
      className="text-xs tabular-nums">
      {c2.passes
        ? <span data-testid="drawer-c2" className="text-mark">◎ Central in its module</span>
        : <span className="text-fg-muted">Not central in its module</span>}
      <span className="text-fg-muted" data-testid={`${testid}-values`}>
        {" "}· closeness {c2.closeness?.toFixed(3) ?? "—"} · q = {fmtP(c2.q)}
      </span>
    </div>
  );
}

export function Criterion2ModuleLine({ c2, testid }: { c2: Criterion2Module; testid: string }) {
  if (!c2.testable) {
    return (
      <div data-testid={testid} title={c2.reason_text ?? undefined} className="text-xs text-fg-muted">
        Centrality in module: not testable ({stichwort(c2.reason, c2.reason_text)})
      </div>
    );
  }
  return (
    <div data-testid={testid} title={c2.glow} className="text-xs tabular-nums">
      <span className={c2.n_pass > 0 ? "text-mark" : "text-fg-muted"}>◎</span>{" "}
      <span className="text-fg">{c2.n_pass} of {c2.module_size}</span>
      <span className="text-fg-muted"> members central in this module · mean closeness{" "}
        {c2.mean_closeness?.toFixed(3) ?? "—"}</span>
    </div>
  );
}

export function Criterion2Details({ c2, testid }: { c2: Criterion2Summary; testid: string }) {
  const [offen, setOffen] = useState(false);
  return (
    <div className="space-y-1 text-xs leading-snug">
      <TextButton data-testid={`${testid}-how`} aria-expanded={offen}
        onClick={() => setOffen((v) => !v)}>
        {offen ? "hide how the glow is computed" : "how the glow is computed"}
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
