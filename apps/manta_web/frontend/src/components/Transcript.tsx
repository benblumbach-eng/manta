import { StateNotice, SectionHeading } from "./ui";
import { useEffect, useMemo, useState } from "react";
import { getConversation, getTurnRecord, type ConversationDetail, type Dataset,
         type StoredTurn, type TranscriptEvent, type TurnRecord } from "../api";


function inline(line: string) {
  return line.split(/(\*\*[^*]+\*\*|`[^`]+`|\[F\d+(?:\s*[,;]\s*F\d+)*\])/g).map((part, i) => {
    if (/^\[F\d/.test(part))
      return <sup key={i} data-testid="finding-mark" className="ml-0.5 rounded bg-accent-soft px-1 text-2xs text-accent">{part.slice(1, -1)}</sup>;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4)
      return <strong key={i} className="text-fg font-semibold">{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
      return <code key={i} className="rounded bg-control px-1 text-accent">{part.slice(1, -1)}</code>;
    return part.replace(/\*\*/g, "");
  });
}

export function AnswerText({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const Tag = list.ordered ? "ol" : "ul";
    blocks.push(
      <Tag key={blocks.length} className={`${list.ordered ? "list-decimal" : "list-disc"} pl-6 space-y-1`}>
        {list.items.map((it, i) => <li key={i}>{inline(it)}</li>)}
      </Tag>);
    list = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const m = /^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (m) {
      const ordered = !!m[2];
      const indented = /^\s{2,}/.test(line) && list;
      if (list && (list.ordered !== ordered) && !indented) flush();
      if (!list) list = { ordered, items: [] };
      if (indented && list.items.length) list.items[list.items.length - 1] += " · " + m[3];
      else list.items.push(m[3]);
      continue;
    }
    flush();
    if (!line.trim()) continue;
    const h = /^#{1,4}\s+(.*)$/.exec(line);
    blocks.push(h
      ? <p key={blocks.length} className="text-fg font-medium">{inline(h[1])}</p>
      : <p key={blocks.length} className="whitespace-pre-wrap">{inline(line)}</p>);
  }
  flush();
  return <>{blocks}</>;
}

const RAW_MAX = 20000;
export function RawJson({ value, testid = "tool-run-json", wrap = false }:
  { value: unknown; testid?: string; wrap?: boolean }) {
  const [alles, setAlles] = useState(false);
  const s = useMemo(() => (typeof value === "string" ? value : JSON.stringify(value, null, 2)) ?? "",
                    [value]);
  const cut = !alles && s.length > RAW_MAX;
  return (
    <>
      <pre data-testid={testid} className={"mt-1 max-h-72 overflow-auto rounded bg-surface border border-line-subtle p-2 text-2xs text-fg"
                                            + (wrap ? " whitespace-pre-wrap break-words" : "")}>
        {cut ? s.slice(0, RAW_MAX) : s}
      </pre>
      {cut && (
        <div data-testid="tool-run-cut" className="mt-1 text-xs text-warn">
          … {(s.length - RAW_MAX).toLocaleString("en")} more characters not shown ·{" "}
          <button onClick={() => setAlles(true)} className="underline hover:text-warn">show all</button>
        </div>
      )}
    </>
  );
}

const when = (t: number) => new Date(t * 1000).toLocaleString();
const secs = (a: number, b: number) => `${Math.max(0, b - a).toFixed(1)} s`;
const ms = (v: unknown) => (typeof v === "number" ? ` · ${v} ms` : "");

export function providerText(kind: string, host: string): string {
  const at = host ? ` (${host})` : "";
  if (kind === "own") return `your own model${at}`;
  if (kind === "operator") return `the server's provider${at}`;
  if (kind === "local") return `a local model${at}`;
  return host || "unknown";
}

export function checkText(t: { grounding?: string; ungrounded?: string[]; corrected?: boolean;
                               status?: string; check?: string | null }): string {
  if (t.status === "error" || t.status === "step_limit") return "no answer, so nothing to check";
  if (!t.grounding) return "not recorded";
  if (t.grounding === "off" || t.check === "off") return "not checked (the check is switched off)";
  const again = t.corrected ? " · the model was asked once to correct itself" : "";
  if (t.check === "cited") return `every sentence cites a finding, and its numbers and names match it${again}`;
  if (t.check === "listed") return "the model's text did not match the findings, so the findings are shown as they are";
  if (t.check === "none") return "no data were used for this reply";
  if (t.check === "failed") return "the query did not run";
  const n = t.ungrounded?.length ?? 0;
  if (n === 0) return `every number appears in a tool result${again}`;
  const what = t.grounding === "refuse" ? "answer replaced" : "marked in the answer";
  return `${n} number${n === 1 ? "" : "s"} without evidence (${t.ungrounded!.join(", ")}) — ${what}${again}`;
}

const STATUS_TEXT: Record<string, string> = {
  answered: "answered",
  step_limit: "stopped at the step limit — no complete answer",
  error: "failed",
};

const ACTION_TEXT: Record<string, string> = {
  "not checked": "not checked",
  clean: "every number appears in a tool result the model saw",
  "correction requested": "numbers without evidence — the model was asked to write the answer again",
  marked: "numbers without evidence — marked in the answer",
  refused: "numbers without evidence — the answer was replaced",
  cited: "every sentence cites a finding, and its numbers and names match it",
  listed: "the text did not match its findings — the findings are shown as a list instead",
};

function Row({ label, children, testid }: { label: string; children: React.ReactNode; testid?: string }) {
  return (
    <div className="flex gap-2" data-testid={testid}>
      <dt className="w-24 shrink-0 text-fg-muted">{label}</dt>
      <dd className="min-w-0 text-fg break-words">{children}</dd>
    </div>
  );
}

function Fold({ title, children, testid }: { title: string; children: React.ReactNode; testid?: string }) {
  return (
    <details data-testid={testid}>
      <summary className="cursor-pointer text-accent hover:underline">{title}</summary>
      <div className="mt-1">{children}</div>
    </details>
  );
}

function Step({ e }: { e: TranscriptEvent }) {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  if (e.kind === "prompt") {
    const msgs = Array.isArray(e.messages) ? e.messages as { role: string; content: string }[] : [];
    return (
      <div data-testid="protocol-step" data-kind="prompt" className="space-y-1">
        <div className="text-fg">Prompt sent to {str(e.model) || "the model"}</div>
        <Fold title={`system text (${Number(e.system_prompt_chars ?? 0).toLocaleString("en")} characters)`}>
          <RawJson value={str(e.system_prompt) || "(not stored)"} testid="protocol-system" wrap />
        </Fold>
        <Fold title={`messages after it (${msgs.length})`}>
          <ol className="space-y-1 list-decimal list-inside">
            {msgs.map((m, i) => (
              <li key={i}><span className="text-fg-muted">{m.role}:</span>{" "}
                <span className="whitespace-pre-wrap text-fg">{m.content}</span></li>
            ))}
          </ol>
        </Fold>
      </div>
    );
  }
  if (e.kind === "model") {
    const calls = Array.isArray(e.tool_calls) ? e.tool_calls as { name: string }[] : [];
    return (
      <div data-testid="protocol-step" data-kind="model" className="space-y-1">
        <div className="text-fg">Model, step {e.step}<span className="text-fg-muted">{ms(e.duration_ms)}</span></div>
        {str(e.content) && (
          <div className="whitespace-pre-wrap border-l-2 border-line pl-2 text-fg">{str(e.content)}</div>
        )}
        {calls.length > 0 && (
          <div className="text-fg-muted">asked for: {calls.map((c) => c.name).join(", ")}</div>
        )}
      </div>
    );
  }
  if (e.kind === "tool") {
    const out = (e.output ?? {}) as { provenance?: { cypher?: unknown; n_results?: number } };
    const cypher = Array.isArray(out.provenance?.cypher)
      ? (out.provenance!.cypher as { cypher: string }[]) : [];
    return (
      <div data-testid="protocol-step" data-kind="tool" data-tool={str(e.name)} className="space-y-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <code className="text-accent">{str(e.name)}</code>
          <span className="text-fg-muted">{ms(e.duration_ms).replace(" · ", "")}</span>
          {e.error
            ? <span className="text-danger">refused</span>
            : <span className="text-fg-muted">{out.provenance?.n_results ?? "?"} results</span>}
          {e.shortened_for_model === true && (
            <span data-testid="protocol-shortened" className="text-warn">shortened for the model</span>
          )}
          {e.stored_truncated === true && (
            <span className="text-warn">stored shortened (over 1 MB)</span>
          )}
        </div>
        {e.error ? <div className="text-danger">{str(e.error)}</div> : null}
        <Fold title="input" testid="protocol-input">
          <RawJson value={e.arguments ?? {}} testid="protocol-input-json" />
          {e.dataset_id_from_context === true && (
            <div className="text-fg-muted">dataset_id taken from the open dataset</div>
          )}
        </Fold>
        <Fold title="output" testid="protocol-output">
          <RawJson value={e.output ?? null} testid="protocol-output-json" />
        </Fold>
        {e.shortened_for_model === true && (
          <Fold title="what the model saw">
            <RawJson value={str(e.model_saw)} testid="protocol-model-saw" wrap />
          </Fold>
        )}
        {cypher.length > 0 && (
          <Fold title={`${cypher.length} ${cypher.length === 1 ? "query" : "queries"}`}>
            <ol className="text-fg-muted space-y-1 list-decimal list-inside">
              {cypher.map((q, k) => <li key={k}><span className="whitespace-pre-wrap">{q.cypher}</span></li>)}
            </ol>
          </Fold>
        )}
      </div>
    );
  }
  if (e.kind === "grounding") {
    const nums = Array.isArray(e.numbers) ? (e.numbers as string[]) : [];
    return (
      <div data-testid="protocol-step" data-kind="grounding" data-action={str(e.action)} className="space-y-1">
        <div className="text-fg">Evidence check <span className="text-fg-muted">· mode {str(e.mode)}</span></div>
        <div className={nums.length ? "text-warn" : "text-fg"}>
          {ACTION_TEXT[str(e.action)] ?? str(e.action)}{nums.length ? `: ${nums.join(", ")}` : ""}
        </div>
        {str(e.draft) && (
          <Fold title="the model's answer before the check">
            <div className="whitespace-pre-wrap text-fg">{str(e.draft)}</div>
          </Fold>
        )}
        {str(e.note) && (
          <Fold title="note sent to the model">
            <div className="whitespace-pre-wrap text-fg-muted">{str(e.note)}</div>
          </Fold>
        )}
      </div>
    );
  }
  if (e.kind === "understanding") {
    return (
      <div data-testid="protocol-step" data-kind="understanding" className="space-y-1">
        <div className="text-fg">Question kind: <code className="text-accent">{str(e.question_kind)}</code>
          {str(e.rank) && <span className="text-fg-muted"> · rank {str(e.rank)}</span>}
          <span className="text-fg-muted"> · {str(e.source) || "understood by the model"}</span></div>
      </div>
    );
  }
  if (e.kind === "findings") {
    const fs = Array.isArray(e.findings) ? (e.findings as { id: string; art: string; text: string }[]) : [];
    return (
      <div data-testid="protocol-step" data-kind="findings" className="space-y-1">
        <div className="text-fg">Findings computed from the results ({fs.length})</div>
        <ul className="space-y-0.5">
          {fs.map((f) => (
            <li key={f.id}><span className="text-accent">{f.id}</span>{" "}
              <span className={f.art === "vorbehalt" ? "text-fg-muted" : "text-fg"}>
                {f.art === "vorbehalt" ? "caveat: " : ""}{f.text}</span></li>
          ))}
        </ul>
      </div>
    );
  }
  if (e.kind === "step_limit") {
    return (
      <div data-testid="protocol-step" data-kind="step_limit" className="text-warn">
        Stopped after {String(e.steps)} steps without an answer.
      </div>
    );
  }
  return <div data-testid="protocol-step" data-kind={e.kind} className="text-fg-muted">{e.kind}</div>;
}

export function TurnProtocol({ turnId }: { turnId: number }) {
  const [rec, setRec] = useState<TurnRecord | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    getTurnRecord(turnId).then((r) => { if (alive) setRec(r); })
      .catch((e) => { if (alive) setErr(String((e as Error).message ?? e)); });
    return () => { alive = false; };
  }, [turnId]);

  if (err) return <div data-testid="turn-protocol" className="text-xs text-danger">{err}</div>;
  if (!rec) return <StateNotice state="loading" inline testid="turn-protocol">loading …</StateNotice>;
  const ctx = rec.record.context ?? {};
  const kontext = [ctx.dataset_id && `dataset ${ctx.dataset_id}`, ctx.asv_id && `ASV ${ctx.asv_id}`,
                   ctx.cluster != null && `module ${ctx.cluster}`, ctx.concept && `term ${ctx.concept}`]
    .filter(Boolean).join(" · ");
  const verlauf = rec.record.request?.history_turns ?? 0;
  return (
    <div data-testid="turn-protocol" data-status={rec.status}
      className="rounded border border-line bg-raised/60 p-3 text-2xs space-y-3">
      <dl className="space-y-1">
        <Row label="asked">{when(rec.asked_at)} · took {secs(rec.asked_at, rec.finished_at)}</Row>
        <Row label="model" testid="protocol-model">
          {rec.model || "unknown"} · via {providerText(rec.provider, rec.provider_host)}
        </Row>
        <Row label="status" testid="protocol-status">
          <span className={rec.status === "answered" ? "" : "text-warn"}>
            {STATUS_TEXT[rec.status] ?? rec.status}{rec.error ? `: ${rec.error}` : ""}
          </span>
          {rec.steps != null && <span className="text-fg-muted"> · {rec.steps} model steps</span>}
        </Row>
        <Row label="evidence" testid="protocol-check">{checkText(rec)}</Row>
        <Row label="context">{kontext || "nothing open"}</Row>
        <Row label="history">
          {verlauf ? `${verlauf} earlier turn${verlauf === 1 ? "" : "s"} of this conversation sent along`
                   : "none — first question of the conversation"}
        </Row>
      </dl>
      <div className="space-y-2">
        <SectionHeading as="div">In order</SectionHeading>
        <ol className="space-y-2 border-l border-line pl-3">
          {rec.record.events.map((e, i) => <li key={i}><Step e={e} /></li>)}
        </ol>
      </div>
    </div>
  );
}

function StoredTurnView({ t }: { t: StoredTurn }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="transcript-turn" className="space-y-2">
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg rounded-br-sm bg-accent-soft border border-accent px-3 py-2 text-fg text-sm">
          {t.question}
        </div>
      </div>
      {t.status === "error" ? (
        <div className="rounded border border-danger bg-danger-soft px-3 py-2 text-xs text-danger">{t.error}</div>
      ) : (
        <div className="text-sm text-fg leading-relaxed space-y-2"><AnswerText text={t.answer} /></div>
      )}
      <div className="flex flex-wrap items-baseline gap-x-2 text-2xs text-fg-muted">
        <span>{when(t.asked_at)}{t.model ? ` · ${t.model}` : ""}</span>
        <button data-testid="protocol-toggle" onClick={() => setOpen((v) => !v)}
          className="text-accent hover:underline">
          {open ? "▾" : "▸"} How was this answered?
        </button>
      </div>
      {open && <TurnProtocol turnId={t.id} />}
    </div>
  );
}

export function ConversationView({ id, datasets = [], note }:
  { id: string; datasets?: Dataset[]; note?: React.ReactNode }) {
  const [c, setC] = useState<ConversationDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setC(null); setErr(null);
    getConversation(id).then((r) => { if (alive) setC(r); })
      .catch((e) => { if (alive) setErr(String((e as Error).message ?? e)); });
    return () => { alive = false; };
  }, [id]);
  if (err) return <div data-testid="transcript-view" className="text-xs text-danger">{err}</div>;
  if (!c) return <StateNotice state="loading" inline testid="transcript-view">loading …</StateNotice>;
  const ds = c.conversation.dataset_id;
  const label = ds ? (datasets.find((d) => d.dataset_id === ds)?.region ?? ds) : "no dataset";
  return (
    <div data-testid="transcript-view" data-id={c.conversation.id} className="space-y-3">
      <div className="text-xs text-fg-muted">
        <span className="text-fg">{c.conversation.username}</span> · {label} ·{" "}
        {when(c.conversation.created_at)}
      </div>
      {note}
      {c.turns.map((t) => <StoredTurnView key={t.id} t={t} />)}
    </div>
  );
}
