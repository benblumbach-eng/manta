import { Button, StateNotice, SectionHeading } from "./ui";
import { Segmented } from "./controls";
import { useEffect, useMemo, useRef, useState } from "react";
import { MANTA_FIGURE } from "../design/dataColours";
import { askAgent, describeError, errorText, getAgentStatus, getAgentTools, getConcepts,
         type Concept, type Concepts,
         type AgentAnswer, type AgentStatus, type Dataset,
         type ChatTurn, type OwnModel, type ToolHelp, getOwnModel,
         getApplicability, type Applicability,
         AgentAskError, getConversation, getConversations, type ConversationSummary,
         type StoredTurn } from "../api";
import type { AskAssistant } from "./InfoTip";
import { PanelHeader, usePanelStack } from "./PanelFrame";
import { NETWORK, suggestionsFor, useViews } from "../viewContext";
import { OWN_MODEL_EVENT, hostOf } from "./OwnModelSettings";
import { AnswerText, ConversationView, TurnProtocol, checkText } from "./Transcript";

type Turn =
  | { role: "user"; text: string }
  | { role: "agent"; text: string; evidence: AgentAnswer["evidence"]; model?: string;
      steps?: number; ungrounded?: string[]; corrected?: boolean; own_key?: boolean;
      turnId?: number | null; grounding?: string; truncated?: boolean;
      check?: AgentAnswer["check"] | null; findings?: AgentAnswer["findings"] }
  | { role: "error"; text: string; title?: string; kind?: string; todo?: string;
      retry?: { text: string; concept?: string };
      turnId?: number | null };

type Thread = { conversationId: string | null; turns: Turn[] };
const EMPTY_THREAD: Thread = { conversationId: null, turns: [] };

function fromStored(ts: StoredTurn[]): Turn[] {
  const out: Turn[] = [];
  for (const s of ts) {
    out.push({ role: "user", text: s.question });
    if (s.status === "error") out.push({ role: "error", title: "The assistant could not answer.",
                                         text: s.error || "failed", turnId: s.id });
    else out.push({ role: "agent", text: s.answer, evidence: s.evidence, model: s.model,
                    steps: s.steps ?? undefined, ungrounded: s.ungrounded, corrected: s.corrected,
                    own_key: s.own_key, turnId: s.id, grounding: s.grounding,
                    truncated: s.status === "step_limit", check: s.check, findings: s.findings });
  }
  return out;
}

const MODEL_KEY = "manta.agent.model";

const USE_OWN_KEY = "manta.agent.useown";
const OWN_OPTION = "__own__";

const MATCH_LABELS: Record<string, string> = {
  exakt: "exact", enger: "narrower", weiter: "broader", vorschlag: "proposed",
};
const matchLabel = (m: string) => MATCH_LABELS[m] ?? m;

const TOOL_GROUPS: { title: string; names: string[] }[] = [
  { title: "Datasets", names: ["list_datasets", "dataset_summary", "taxa_composition",
                               "summarize_by_taxon", "find_asv"] },
  { title: "One ASV", names: ["asv_detail", "asv_seasonality", "asv_spectrum",
                              "asv_abundance_series", "neighbors", "asv_drivers"] },
  { title: "Modules", names: ["cluster_detail", "cluster_timeseries",
                              "cluster_year_overview", "cluster_interannual_variability"] },
  { title: "Links", names: ["edge", "cluster_bridges", "cluster_network", "keystone_asvs"] },
  { title: "Environment", names: ["environment", "env_variable_links", "cluster_env_links",
                                  "environment_correlation"] },
  { title: "Statistics", names: ["seasonality_test", "trend_test", "pair_proportionality",
                                 "group_comparison_test"] },
  { title: "Advanced", names: ["get_schema", "run_validated_cypher"] },
];

const MCP_SOURCE = "https://github.com/benblumbach-eng/manta/tree/main/apps/manta_mcp";
const MCP_START = "https://github.com/benblumbach-eng/manta/blob/main/apps/manta_mcp/start_mcp.sh";
const EXTERNAL_SOURCES: { name: string; purpose: string; href: string; link: string }[] = [
  { name: "WoRMS",
    purpose: "Per-taxon attributes (e.g. functional group) from the World Register of Marine "
           + "Species. Shown as general knowledge, never as a module's function.",
    href: "https://www.marinespecies.org/rest/", link: "marinespecies.org/rest" },
];

function MantaGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size * 0.8} viewBox="0 4 72 52" aria-hidden="true" className="shrink-0">
      <path d="M36 40 Q34 50 30 57 Q37 52 38 42 Z" fill={MANTA_FIGURE.mid} />
      <path d="M36 7 C 42 7, 50 10, 70 24 C 56 25, 48 29, 44 35 C 42 41, 39 44, 36 44
               C 33 44, 30 41, 28 35 C 24 29, 16 25, 2 24 C 22 10, 30 7, 36 7 Z"
        fill={MANTA_FIGURE.body} />
      <circle cx="30" cy="16" r="2.6" fill={MANTA_FIGURE.eye} />
      <circle cx="42" cy="16" r="2.6" fill={MANTA_FIGURE.eye} />
    </svg>
  );
}

const CHIP = "px-2 py-1 rounded border text-xs";
const CHIP_OFF = "border-line text-fg-muted hover:text-fg hover:border-line-strong";
const FIELD = "w-full bg-surface border rounded px-2 py-1 text-xs text-fg outline-none " +
              "focus:border-accent";

export default function AgentChat({ datasets = [], datasetId, asvId, ask, onClose, signedIn = false }:
  { datasets?: Dataset[]; datasetId?: string; asvId?: string;
    ask?: (AskAssistant & { tick: number }) | null; onClose: () => void;
    signedIn?: boolean }) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [threads, setThreads] = useState<Record<string, Thread>>({});
  const threadKey = datasetId ?? "";
  const thread = threads[threadKey] ?? EMPTY_THREAD;
  const turns = thread.turns;
  const addTurn = (k: string, t: Turn, conversationId?: string | null) =>
    setThreads((cur) => {
      const th = cur[k] ?? EMPTY_THREAD;
      return { ...cur, [k]: { conversationId: conversationId === undefined ? th.conversationId
                                                                         : conversationId,
                              turns: [...th.turns, t] } };
    });
  const [openProtocol, setOpenProtocol] = useState<number | null>(null);
  const [adminsRead, setAdminsRead] = useState<boolean | null>(null);
  const [earlier, setEarlier] = useState<ConversationSummary[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyFilter, setHistoryFilter] = useState("");
  const [historyAll, setHistoryAll] = useState(false);
  const [reading, setReading] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [openEvidence, setOpenEvidence] = useState<number | null>(null);
  const [openFindings, setOpenFindings] = useState<number | null>(null);
  useEffect(() => { setOpenEvidence(null); setOpenFindings(null); setOpenProtocol(null); }, [threadKey]);
  const [caps, setCaps] = useState<{ ds: string; app: Applicability } | null>(null);
  const [whyOpen, setWhyOpen] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [model, setModel] = useState<string>(() => {
    try { return localStorage.getItem(MODEL_KEY) ?? ""; } catch { return ""; }
  });
  const endRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<"chat" | "ontology" | "mcp" | "history">("chat");
  const [stepsOpen, setStepsOpen] = useState(false);
  const [concepts, setConcepts] = useState<Concepts | null>(null);
  const [conceptsError, setConceptsError] = useState<string | null>(null);
  const [conceptFilter, setConceptFilter] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [own, setOwn] = useState<OwnModel | null>(null);
  const [useOwnNow, setUseOwnNow] = useState<boolean>(() => {
    try { return localStorage.getItem(USE_OWN_KEY) === "1"; } catch { return false; }
  });
  const [tools, setTools] = useState<ToolHelp[] | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);

  function chooseOwn(on: boolean) {
    setUseOwnNow(on);
    try { localStorage.setItem(USE_OWN_KEY, on ? "1" : "0"); } catch { }
  }
  useEffect(() => {
    if (!signedIn) return;
    const load = () => getOwnModel().then((o) => setOwn(o.set ? o : null)).catch(() => setOwn(null));
    load();
    window.addEventListener(OWN_MODEL_EVENT, load);
    return () => window.removeEventListener(OWN_MODEL_EVENT, load);
  }, [signedIn]);
  function pickModel(name: string) {
    setModel(name);
    try { localStorage.setItem(MODEL_KEY, name); } catch { }
  }

  useEffect(() => {
    getAgentStatus().then((st) => {
      setStatus(st);
      const names = (st.models ?? []).map((m) => m.name);
      setModel((cur) => (cur && names.includes(cur) ? cur : st.model));
    }).catch(() => setStatus(null));
    getAgentTools().then((r) => setTools(r.tools)).catch((e) => setToolsError(errorText(e)));
    getConcepts().then(setConcepts).catch((e) => setConceptsError(errorText(e)));
  }, []);
  useEffect(() => {
    if (!signedIn) return;
    getConversations().then((r) => setAdminsRead(r.admins_can_read)).catch(() => setAdminsRead(null));
  }, [signedIn]);
  useEffect(() => {
    if (view !== "history" || !signedIn) return;
    let alive = true;
    const t = setTimeout(() => {
      getConversations({ q: historyFilter.trim() || undefined,
                         datasetId: historyAll ? undefined : threadKey })
        .then((r) => { if (alive) { setEarlier(r.conversations); setAdminsRead(r.admins_can_read);
                                    setHistoryError(null); } })
        .catch((e) => { if (alive) setHistoryError(String((e as Error).message ?? e)); });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [view, signedIn, historyFilter, historyAll, threadKey, thread.conversationId]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); },
            [turns, busy]);
  useEffect(() => {
    if (!datasetId) return;
    let alive = true;
    setWhyOpen(null);
    getApplicability(datasetId)
      .then((app) => { if (alive) setCaps({ ds: datasetId, app }); })
      .catch(() => { if (alive) setCaps(null); });
    return () => { alive = false; };
  }, [datasetId]);

  useEffect(() => {
    if (!menuOpen) return;
    const down = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(false); };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down);
                   document.removeEventListener("keydown", key); };
  }, [menuOpen]);

  const maxQ = status?.limits?.question_chars;
  const qLen = input.trim().length;
  const tooLong = maxQ != null && qLen > maxQ;

  async function send(text?: string, concept?: string, questionKind?: string,
                      questionArgs?: Record<string, unknown>) {
    const q = (text ?? input).trim();
    if (!q || busy) return;
    const k = threadKey;
    const fortsetzen = thread.conversationId;
    if (maxQ != null && q.length > maxQ) {
      if (text != null) {
        addTurn(k, { role: "error", text:
          `This question has ${q.length} characters; the server takes at most ${maxQ}.` });
      }
      return;
    }
    setInput("");
    setView("chat");
    addTurn(k, { role: "user", text: q });
    setBusy(true);
    try {
      const viaOwn = ownActive;
      const alle: ChatTurn[] = [];
      for (const t of turns) {
        if (t.role === "user" && t.text.trim()) alle.push({ role: "user", content: t.text });
        else if (t.role === "agent" && t.text.trim())
          alle.push({ role: "assistant", content: t.text,
                      tools: (t.evidence ?? []).filter((e) => !e.error)
                        .map((e) => ({ name: e.tool, arguments: e.arguments ?? {} })) });
      }
      const verlauf = alle.slice(-8);
      const res = await askAgent(q, { dataset_id: datasetId,
                                      asv_id: (questionArgs?.asv_id as string | undefined) ?? asvId,
                                      cluster: questionArgs?.cluster as number | undefined, concept,
                                      question_kind: questionKind, question_args: questionArgs },
                                 model || undefined,
                                 viaOwn, verlauf, fortsetzen);
      addTurn(k, { role: "agent", text: res.answer, evidence: res.evidence,
                   model: res.model, steps: res.steps,
                   ungrounded: res.ungrounded, corrected: res.corrected,
                   own_key: res.own_key, turnId: res.turn_id ?? null,
                   grounding: res.grounding, truncated: res.truncated,
                   check: res.check, findings: res.findings },
              res.conversation_id ?? fortsetzen);
      if (typeof res.admins_can_read === "boolean") setAdminsRead(res.admins_can_read);
    } catch (e) {
      const d = describeError(e);
      setInput((cur) => (cur.trim() ? cur : q));
      const gespeichert = e instanceof AgentAskError ? e : null;
      addTurn(k, { role: "error", title: "The assistant could not answer.",
                   text: d.why, kind: d.kind, todo: d.todo,
                   retry: { text: q, concept }, turnId: gespeichert?.turnId ?? null },
              gespeichert ? (gespeichert.conversationId ?? fortsetzen) : undefined);
    } finally {
      setBusy(false);
    }
  }
  const sendRef = useRef(send);
  sendRef.current = send;
  const erledigterTick = useRef<number | null>(null);
  useEffect(() => {
    if (!ask?.question || erledigterTick.current === ask.tick) return;
    erledigterTick.current = ask.tick;
    void sendRef.current(ask.question, ask.concept);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask?.tick]);

  function newConversation() {
    setThreads((cur) => ({ ...cur, [threadKey]: EMPTY_THREAD }));
    setOpenEvidence(null);
    setOpenProtocol(null);
    setView("chat");
  }
  async function openConversation(c: ConversationSummary) {
    if (c.dataset_id !== threadKey) { setReading(c.id); return; }
    try {
      const d = await getConversation(c.id);
      setThreads((cur) => ({ ...cur, [threadKey]: { conversationId: d.conversation.id,
                                                    turns: fromStored(d.turns) } }));
      setOpenEvidence(null);
      setOpenProtocol(null);
      setReading(null);
      setView("chat");
    } catch (e) {
      setHistoryError(String((e as Error).message ?? e));
    }
  }

  const models = status?.models ?? [];
  const usable = !!status?.ok || !!own;
  const ownActive = !!own && (useOwnNow || !status?.ok);
  const current = models.find((m) => m.name === model);
  const localModel = models.find((m) => !m.remote && m.supports_tools !== false) ?? null;
  const remoteNow = ownActive || !!current?.remote;
  function switchToLocal() {
    if (!localModel) return;
    chooseOwn(false);
    pickModel(localModel.name);
  }
  const modelLabel = ownActive && own
    ? `own · ${own.model}`
    : status?.ok
      ? `${model}${current?.parameter_size ? ` · ${current.parameter_size}` : ""}${current?.remote ? " · remote" : ""}`
      : status ? "no model reachable" : "…";

  const entry = useMemo(() => {
    const passt = (n: ToolHelp["needs"]) =>
      n === "none" || (n === "dataset" && !!datasetId) || (n === "asv" && !!asvId);
    const rang = (n: ToolHelp["needs"]) => (n === "asv" ? 0 : n === "dataset" ? 1 : 2);
    const alle = (tools ?? [])
      .filter((t) => t.question && passt(t.needs))
      .sort((a, b) => rang(a.needs) - rang(b.needs))
      .map((t) => ({ t, a: caps && caps.ds === datasetId ? caps.app.tools[t.name] : undefined }));
    const oben = alle.length ? rang(alle[0].t.needs) : 2;
    return { main: alle.filter((x) => rang(x.t.needs) === oben),
             more: alle.filter((x) => rang(x.t.needs) !== oben) };
  }, [tools, datasetId, asvId, caps]);
  const panelStapel = usePanelStack();
  const ansichten = useViews();
  const ansicht = datasetId
    ? [...panelStapel].reverse().map((id) => ansichten.get(id)).find(Boolean) ?? ansichten.get(NETWORK)
    : undefined;
  const ansichtFragen = useMemo(() => (ansicht ? suggestionsFor(ansicht) : null), [ansicht]);
  const allgemein = [...entry.main, ...entry.more].filter((x) => x.t.needs !== "asv");
  const anwendbar = (tool: string) => (caps && caps.ds === datasetId ? caps.app.tools[tool] : undefined);
  type Zeile = { key: string; text: string; tool: string; a: Applicability["tools"][string] | undefined;
                 ask: () => void };
  const frageZeile = ({ key, text, tool, a, ask }: Zeile) => a?.applicable === "no" ? (
    <div key={key} data-testid="agent-question" data-tool={tool} data-state="no"
      className="text-xs text-fg-muted leading-snug">
      {text}
      <button data-testid="agent-question-why"
        onClick={() => setWhyOpen(whyOpen === key ? null : key)}
        className="ml-2 text-fg-muted hover:text-fg">
        {whyOpen === key ? "not here ▾" : "not here — why?"}
      </button>
      {whyOpen === key && (
        <div data-testid="agent-question-reason" className="mt-1 text-fg-muted">{a.reason}</div>
      )}
    </div>
  ) : (
    <button key={key} data-testid="agent-question" data-tool={tool}
      data-state={a?.applicable ?? "yes"} disabled={busy}
      title={a?.applicable === "subject" && a.subject_condition ? a.subject_condition : undefined}
      onClick={ask}
      className="text-left text-xs text-fg hover:text-accent hover:underline disabled:opacity-50">
      {text}
    </button>
  );
  const toolZeile = ({ t, a }: { t: ToolHelp; a: Applicability["tools"][string] | undefined }) =>
    frageZeile({ key: t.name, text: t.question!, tool: t.name, a,
                 ask: () => send(t.question!, undefined, t.name) });

  const gruppen = useMemo(() => {
    const alle = concepts?.concepts ?? [];
    const f = conceptFilter.trim().toLowerCase();
    const passt = (c: Concept) => !f || c.key.toLowerCase().includes(f)
      || c.label.toLowerCase().includes(f) || c.definition.toLowerCase().includes(f)
      || (c.standard_term?.curie ?? "").toLowerCase().includes(f);
    const treffer = alle.filter(passt);
    const titel: Record<Concept["kind"], string> = {
      klasse: "Things in the graph", beziehung: "Links between them",
      kennzahl: "Numbers MANTA reports", umweltgroesse: "Environmental variables",
    };
    const out: { title: string; items: Concept[] }[] = [
      { title: "Mapped to a published term", items: treffer.filter((c) => c.standard_term) },
      ...(Object.keys(titel) as Concept["kind"][]).map((k) => ({
        title: titel[k],
        items: treffer.filter((c) => !c.standard_term && c.kind === k),
      })),
    ];
    return out.filter((g) => g.items.length > 0);
  }, [concepts, conceptFilter]);

  const termsLoaded = !!concepts && !concepts.note
    && concepts.concepts.some((c) => c.standard_term);

  const grouped = useMemo(() => {
    if (!tools) return [];
    const known = new Set(TOOL_GROUPS.flatMap((g) => g.names));
    const groups = TOOL_GROUPS.map((g) => ({
      title: g.title,
      tools: g.names.map((n) => tools.find((t) => t.name === n)).filter((t): t is ToolHelp => !!t),
    }));
    groups.push({ title: "Other", tools: tools.filter((t) => !known.has(t.name)) });
    return groups.filter((g) => g.tools.length > 0);
  }, [tools]);

  return (
    <div data-testid="agent-chat" className="h-full flex flex-col text-sm">
      <PanelHeader lead={<MantaGlyph />} title="MANTA assistant" onClose={onClose}
        closeTestid="agent-close">
        <span className="flex-1" />
        {turns.length > 0 && (
          <Button data-testid="agent-new-conversation" onClick={newConversation} disabled={busy}
            reason="wait for the answer first"
            title="start an empty conversation on this dataset; this one stays under History">
            New conversation</Button>
        )}
      </PanelHeader>

      <div className="px-4 py-2 border-b border-line flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="relative" ref={menuRef}>
          <button data-testid="model-select" data-value={ownActive ? OWN_OPTION : model}
            disabled={busy} onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu" aria-expanded={menuOpen}
            className="flex items-center gap-2 max-w-[17rem] px-2 py-1 rounded border border-line-strong
                       hover:border-accent text-xs text-fg disabled:opacity-60">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${usable ? "bg-ok-fill" : "bg-warn-fill"}`} />
            <span className="truncate">{modelLabel}</span>
            <span className="text-fg-muted">▾</span>
          </button>
          {menuOpen && (
            <div data-testid="model-menu" role="menu" data-popup=""
              className="absolute left-0 top-full mt-1 z-30 w-80 rounded-md border border-line bg-overlay shadow-2xl py-1 text-xs">
              <div className="px-3 pt-1 pb-1 text-xs font-semibold text-fg-muted">
                Models on this server
              </div>
              {models.length === 0 && (
                <div className="px-3 py-2 text-warn">
                  {status?.remote?.configured
                    ? "the external provider is configured but answered nothing"
                    : "none reachable"}
                </div>
              )}
              {models.map((m) => (
                <button key={m.name} role="menuitemradio" data-testid="model-option" data-value={m.name}
                  aria-checked={!ownActive && model === m.name}
                  disabled={m.supports_tools === false}
                  onClick={() => { chooseOwn(false); pickModel(m.name); setMenuOpen(false); }}
                  className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-control disabled:opacity-40 disabled:hover:bg-transparent">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="w-3 text-accent">{!ownActive && model === m.name ? "✓" : ""}</span>
                    <span className="text-fg truncate">{m.name}</span>
                  </span>
                  <span className="text-fg-muted shrink-0">
                    {[m.parameter_size, m.remote ? "remote" : null,
                      m.supports_tools === false ? "no tool support" : null].filter(Boolean).join(" · ")}
                  </span>
                </button>
              ))}
              <div className="my-1 border-t border-line" />
              <div className="px-3 pt-1 pb-1 text-xs font-semibold text-fg-muted">
                Own model
              </div>
              {own ? (
                <button role="menuitemradio" data-testid="own-key-option" data-value={OWN_OPTION}
                  aria-checked={ownActive}
                  onClick={() => { chooseOwn(true); setMenuOpen(false); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-control">
                  <span className="w-3 text-accent">{ownActive ? "✓" : ""}</span>
                  <span className="text-fg truncate">{own.model} · {hostOf(own.base_url ?? "")}</span>
                </button>
              ) : (
                <div data-testid="own-key-hint" className="px-3 py-2 pl-[1.9rem] text-fg-muted">
                  connect one under ⚙ settings
                </div>
              )}
            </div>
          )}
        </div>
        <div data-testid="agent-context" className="flex items-center gap-2 min-w-0 text-xs">
          <span className="text-fg-muted">Network</span>
          {datasetId ? (
            <span className="truncate text-fg" title={datasetId}>
              {datasets.find((d) => d.dataset_id === datasetId)?.region ?? datasetId}
              <span className="font-mono text-fg-muted"> · {datasetId}</span>
            </span>
          ) : (
            <span className="text-fg-muted">none selected</span>
          )}
          {datasetId && asvId && (
            <span data-testid="agent-context-asv" className="shrink-0 rounded border border-line px-2 font-mono text-accent">
              {asvId}
            </span>
          )}
        </div>
      </div>

      <div className="px-4 pt-3">
        <Segmented full value={view} testid="agent-tabs"
          onChange={(v) => { if (v === "history") setReading(null); setView(v); }}
          options={[{ value: "chat" as const, label: "Chat", testid: "agent-tab-chat" },
                    { value: "ontology" as const, label: "Ontology", testid: "agent-tab-ontology" },
                    { value: "mcp" as const, label: "MCP", testid: "agent-tab-mcp" },
                    ...(signedIn ? [{ value: "history" as const, label: "History",
                                      testid: "agent-tab-history" }] : [])]} />
      </div>

      {view === "history" ? (
        <div data-testid="agent-history" className="flex-1 min-h-0 overflow-auto px-4 py-3 space-y-3">
          {reading ? (
            <>
              <button data-testid="history-back" onClick={() => setReading(null)}
                className="text-xs text-fg-muted hover:text-fg">← all conversations</button>
              <ConversationView id={reading} datasets={datasets} note={
                <p className="text-xs text-fg-muted">
                  Another dataset: open it to continue this conversation.
                </p>} />
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <input data-testid="history-search" value={historyFilter} spellCheck={false}
                  onChange={(e) => setHistoryFilter(e.target.value)}
                  placeholder="Search questions and answers …"
                  className={`${FIELD} border-line flex-1`} />
                <button data-testid="history-scope" onClick={() => setHistoryAll((v) => !v)}
                  className={`${CHIP} ${CHIP_OFF} shrink-0`}>
                  {historyAll ? "all datasets" : "this dataset"}
                </button>
              </div>
              {historyError && <div className="text-xs text-danger">{historyError}</div>}
              {earlier === null && !historyError && <StateNotice state="loading" inline>loading …</StateNotice>}
              {earlier && earlier.length === 0 && (
                <StateNotice state="empty" inline testid="history-empty">
                  {historyFilter.trim() ? "No conversation matches." : "No earlier conversations here."}
                </StateNotice>
              )}
              <div className="space-y-2">
                {(earlier ?? []).map((c) => (
                  <button key={c.id} data-testid="history-item" data-id={c.id}
                    data-dataset={c.dataset_id} onClick={() => openConversation(c)}
                    className={`w-full text-left rounded border px-3 py-2 ${
                      c.id === thread.conversationId ? "border-accent bg-control/50"
                                                     : "border-line hover:border-line-strong"}`}>
                    <div className="text-xs text-fg line-clamp-2">{c.title || "(no question)"}</div>
                    <div className="mt-1 text-2xs text-fg-muted">
                      {new Date(c.updated_at * 1000).toLocaleString()} · {c.n_turns}{" "}
                      {c.n_turns === 1 ? "question" : "questions"} ·{" "}
                      {c.dataset_id ? (datasets.find((d) => d.dataset_id === c.dataset_id)?.region
                                       ?? c.dataset_id) : "no dataset"}
                      {c.id === thread.conversationId ? " · open" : ""}
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      ) : view === "ontology" ? (
        <div data-testid="agent-ontology" className="flex-1 min-h-0 overflow-auto px-4 py-3 space-y-4">
          <input data-testid="ontology-search" value={conceptFilter} spellCheck={false}
            onChange={(e) => setConceptFilter(e.target.value)}
            placeholder={concepts ? `Filter ${concepts.n} terms …` : "Filter terms …"}
            className={`${FIELD} border-line`} />
          <p className="text-xs text-fg-muted leading-snug">
            What a word means here, and which published term it maps to.
          </p>
          {concepts && !termsLoaded && (
            <p data-testid="ontology-terms-note" className="text-xs text-fg-muted leading-snug">
              {concepts.note ?? "The mapping to published standard terms is not available in this installation."}
            </p>
          )}
          {conceptsError && <div className="text-xs text-danger">{conceptsError}</div>}
          {concepts === null && !conceptsError && <StateNotice state="loading" inline>loading …</StateNotice>}
          {gruppen.map((g) => (
            <section key={g.title}>
              <SectionHeading className="mb-2">
                {g.title} · {g.items.length}
              </SectionHeading>
              <div className="space-y-2">
                {g.items.map((c) => (
                  <div key={c.key} data-testid="ontology-term" data-key={c.key}
                    className="rounded border border-line px-3 py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-fg">{c.label}</span>
                      <code className="text-2xs text-fg-muted">{c.key}</code>
                    </div>
                    <div className="text-xs text-fg-muted mt-1 leading-snug">{c.definition}</div>
                    {c.unit && <div className="text-2xs text-fg-muted mt-1">unit: {c.unit}</div>}
                    {c.standard_term ? (
                      <div className="mt-1 text-2xs" data-testid="ontology-standard-term">
                        <span className={`px-1 rounded border mr-1 ${
                          matchLabel(c.standard_term.match) === "exact" ? "border-ok text-ok"
                          : "border-line-strong text-fg-muted"}`}>{matchLabel(c.standard_term.match)}</span>
                        <a href={c.standard_term.uri} target="_blank" rel="noreferrer"
                           className="text-accent hover:underline break-all">
                          {c.standard_term.curie ?? c.standard_term.uri}
                        </a>
                      </div>
                    ) : termsLoaded ? (
                      <div className="mt-1 text-2xs text-fg-muted">
                        no published term covers this — MANTA&rsquo;s own, defined above
                      </div>
                    ) : null}
                    {c.tools.length > 0 && (
                      <div className="mt-1 text-2xs text-fg-muted">
                        tools: {c.tools.join(", ")}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ))}
          {concepts && gruppen.length === 0 && (
            <div className="text-xs text-fg-muted">No term matches “{conceptFilter}”.</div>
          )}
        </div>
      ) : view === "mcp" ? (
        <div data-testid="agent-mcp" className="flex-1 min-h-0 overflow-auto px-4 py-3 space-y-4">
          <p className="text-xs text-fg-muted leading-snug">
            Every source the assistant can query, what it is for, and where to check it.
          </p>
          <section>
            <SectionHeading className="mb-2">Built in · 1</SectionHeading>
            <div data-testid="mcp-source" data-name="manta" className="rounded border border-line px-3 py-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-fg">
                  manta <span className="ml-1 px-1 rounded border border-ok text-ok text-2xs">local</span>
                </span>
                <code className="text-2xs text-fg-muted">{tools ? `${tools.length} tools` : "…"}</code>
              </div>
              <div className="text-xs text-fg-muted mt-1 leading-snug">
                Datasets, ASVs, modules, links and environment from MANTA&rsquo;s Neo4j graph.
                Statistical tests run in MANTA (SciPy) on the stored series; they do not change
                OTTER&rsquo;s network.
              </div>
              <div className="mt-2 flex gap-3 text-2xs">
                <a href={MCP_SOURCE} target="_blank" rel="noreferrer"
                   className="text-accent hover:underline">source ↗</a>
                <a href={MCP_START} target="_blank" rel="noreferrer"
                   className="text-accent hover:underline">use in other AI apps ↗</a>
              </div>
              {toolsError && <div className="mt-2 text-xs text-danger">{toolsError}</div>}
              {tools === null && !toolsError && <StateNotice state="loading" inline>loading …</StateNotice>}
              {grouped.map((g) => (
                <div key={g.title} className="mt-3">
                  <div className="text-2xs font-semibold text-fg-muted">{g.title} · {g.tools.length}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {g.tools.map((t) => (
                      <code key={t.name} data-testid="mcp-tool" data-tool={t.name} title={t.summary}
                        className="px-2 rounded border border-line text-2xs text-fg">{t.name}</code>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
          <section>
            <SectionHeading className="mb-2">External · {EXTERNAL_SOURCES.length} planned</SectionHeading>
            <div className="space-y-2">
              {EXTERNAL_SOURCES.map((x) => (
                <div key={x.name} data-testid="mcp-source" data-name={x.name}
                  className="rounded border border-line px-3 py-2">
                  <span className="text-fg">
                    {x.name} <span className="ml-1 px-1 rounded border border-warn text-warn text-2xs">planned</span>
                  </span>
                  <div className="text-xs text-fg-muted mt-1 leading-snug">{x.purpose}</div>
                  <a href={x.href} target="_blank" rel="noreferrer"
                     className="mt-2 inline-block text-2xs text-accent hover:underline">{x.link} ↗</a>
                </div>
              ))}
            </div>
          </section>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto px-4 py-3 space-y-4">
          {status && !status.ok && !own && (
            <div data-testid="agent-unavailable" className="rounded border border-warn bg-warn-soft p-3">
              <div className="text-warn text-xs font-medium">No model reachable</div>
              <p className="mt-1 text-xs text-fg leading-snug">
                Start a local model with tool support, or connect your own model under ⚙ settings.
              </p>
              {status.error && <p className="mt-1 text-2xs text-fg-muted">{status.error}</p>}
              {status.setup_hint && (
                <p className="mt-2 text-2xs text-fg-muted whitespace-pre-wrap">{status.setup_hint}</p>
              )}
            </div>
          )}

          {turns.length === 0 && (
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <div className="mt-1 rounded-full bg-accent-soft border border-accent p-2">
                  <MantaGlyph size={22} />
                </div>
                <div className="min-w-0">
                  <div className="text-fg font-medium">
                    {ansichtFragen ? "Ask about this view" : asvId ? `Ask about ${asvId}`
                      : datasetId ? "Ask about this dataset" : "Ask about the datasets"}
                  </div>
                  <p className="text-xs text-fg-muted mt-1 leading-snug">
                    Pick a question or ask in your own words. Answers come only from audited tools.
                  </p>
                </div>
              </div>
              <div>
                <div data-testid="agent-entry-title"
                  className="text-xs font-semibold text-fg-muted mb-1">
                  {ansichtFragen ? "What I can tell you about this view"
                    : asvId ? `What I can tell you about ${asvId}`
                    : datasetId ? "What I can tell you about this dataset" : "Where to start"}
                </div>
                <div className="flex flex-col gap-1" data-testid="agent-entry">
                  {ansichtFragen ? ansichtFragen.map((g, i) => (
                    <div key={`${i}:${g.title}`} data-testid="agent-entry-group"
                      className="flex flex-col gap-1">
                      <div className="text-2xs text-fg-muted mt-1">{g.title}</div>
                      {g.questions.map((q) => frageZeile({
                        key: q.text, text: q.text, tool: q.tool, a: anwendbar(q.tool),
                        ask: () => send(q.text, undefined, q.tool, q.args) }))}
                    </div>
                  )) : entry.main.map(toolZeile)}
                  {(ansichtFragen ? allgemein : entry.more).length > 0 && (
                    <button data-testid="agent-entry-more" onClick={() => setMoreOpen((v) => !v)}
                      className="text-left text-xs text-fg-muted hover:text-fg mt-1">
                      {moreOpen ? "▾" : "▸"} {ansichtFragen || asvId ? "about the dataset, and in general" : "in general"} ({(ansichtFragen ? allgemein : entry.more).length})
                    </button>
                  )}
                  {moreOpen && (ansichtFragen ? allgemein : entry.more).map(toolZeile)}
                </div>
              </div>
              <div>
                <button data-testid="agent-steps-toggle" onClick={() => setStepsOpen((v) => !v)}
                  className="text-xs text-fg-muted hover:text-fg">
                  {stepsOpen ? "▾" : "▸"} How an answer is built
                </button>
                {stepsOpen && (
                  <ol data-testid="agent-steps"
                    className="mt-2 list-decimal pl-5 space-y-1 text-xs text-fg-muted leading-snug">
                    <li><span className="text-fg">Question</span> → sorted into a question kind</li>
                    <li><span className="text-fg">Plan</span> → a known kind runs a fixed list of tools;
                      any other question needs a larger model, which picks the tools itself</li>
                    <li><span className="text-fg">Results</span> → each tool result is kept with its
                      query (findings F1, F2 … on a fixed plan)</li>
                    <li><span className="text-fg">Model</span> <code className="text-2xs">{ownActive && own ? own.model : model}</code> →
                      writes the answer from these results</li>
                    <li><span className="text-fg">Check</span> → numbers in the answer are compared with
                      the results</li>
                  </ol>
                )}
              </div>
            </div>
          )}

          {turns.map((t, i) => (
            <div key={i}>
              {t.role === "user" && (
                <div className="flex justify-end">
                  <div className="max-w-[85%] rounded-lg rounded-br-sm bg-accent-soft border border-accent px-3 py-2 text-fg">
                    {t.text}
                  </div>
                </div>
              )}
              {t.role === "error" && (
                <div className="space-y-2">
                  <div data-testid="agent-error" data-kind={t.kind ?? ""} role="alert"
                    className="rounded border border-danger bg-danger-soft px-3 py-2 text-xs text-danger">
                    {t.title && <p className="font-medium text-danger" data-testid="agent-error-what">{t.title}</p>}
                    <p className={t.title ? "mt-1" : ""} data-testid="agent-error-why">{t.text}</p>
                    {t.todo && (
                      <p className="mt-1 flex flex-wrap items-center gap-2 text-fg-muted" data-testid="agent-error-todo">
                        <span>{t.todo}</span>
                        {t.retry && i === turns.length - 1 && (
                          <Button type="button" data-testid="agent-error-retry" disabled={busy}
                            onClick={() => void send(t.retry!.text, t.retry!.concept)}>
                            Try again
                          </Button>
                        )}
                        {t.retry && remoteNow && localModel && i === turns.length - 1 && (
                          <Button type="button" data-testid="agent-error-local" disabled={busy}
                            onClick={switchToLocal}>
                            use the local model {localModel.name}
                          </Button>
                        )}
                      </p>
                    )}
                  </div>
                  {t.turnId != null && (
                    <button data-testid="protocol-toggle"
                      onClick={() => setOpenProtocol(openProtocol === i ? null : i)}
                      className="text-xs text-accent hover:underline">
                      {openProtocol === i ? "▾" : "▸"} What happened?
                    </button>
                  )}
                  {openProtocol === i && t.turnId != null && <TurnProtocol turnId={t.turnId} />}
                </div>
              )}
              {t.role === "agent" && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-2xs text-fg-muted">
                    <MantaGlyph size={14} />
                    <span>assistant{t.model ? ` · ${t.model}` : ""}</span>
                  </div>
                  <div data-testid="agent-answer" className="text-fg leading-relaxed space-y-2">
                    <AnswerText text={t.text} />
                  </div>
                  {t.own_key && (
                    <div data-testid="own-key-mark" className="text-2xs text-ok">
                      via your own model · {t.model}
                    </div>
                  )}
                  {t.ungrounded && t.ungrounded.length > 0 && (
                    <div data-testid="ungrounded" className="text-xs text-danger rounded border border-danger bg-danger-soft px-3 py-2">
                      No tool result contains {t.ungrounded.length === 1 ? "this number" : "these numbers"}:{" "}
                      <span className="font-medium">{t.ungrounded.join(", ")}</span>. They are marked in
                      the text above and must not be used as a result
                      {t.corrected ? " — the model was already asked to correct itself once" : ""}.
                    </div>
                  )}
                  {(t.grounding || t.truncated) && !(t.ungrounded && t.ungrounded.length > 0)
                    && (t.truncated || (t.evidence?.length ?? 0) > 0) && (
                    <div data-testid="answer-check" className="text-2xs text-fg-muted">
                      {t.truncated ? "stopped at the step limit — no complete answer"
                        : `evidence check: ${checkText(t)}`}
                    </div>
                  )}
                  {t.turnId != null && (
                    <div>
                      <button data-testid="protocol-toggle"
                        onClick={() => setOpenProtocol(openProtocol === i ? null : i)}
                        className="text-xs text-accent hover:underline">
                        {openProtocol === i ? "▾" : "▸"} How was this answered?
                      </button>
                      {openProtocol === i && <div className="mt-2"><TurnProtocol turnId={t.turnId} /></div>}
                    </div>
                  )}
                  {(t.findings?.length ?? 0) > 0 && (
                    <div>
                      <button data-testid="findings-toggle"
                        onClick={() => setOpenFindings(openFindings === i ? null : i)}
                        className="text-xs text-accent hover:underline">
                        {openFindings === i ? "▾" : "▸"} show the findings ({t.findings!.length})
                      </button>
                      {openFindings === i && (
                        <ul data-testid="findings-panel" className="mt-2 space-y-1 text-2xs">
                          {t.findings!.map((f) => (
                            <li key={f.id}><span className="text-accent">{f.id}</span>{" "}
                              <span className={f.art === "vorbehalt" ? "text-fg-muted" : "text-fg"}>
                                {f.art === "vorbehalt" ? "caveat: " : ""}{f.text}</span></li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                  {t.evidence?.length > 0 ? (
                    <div>
                      <button data-testid="evidence-toggle"
                        onClick={() => setOpenEvidence(openEvidence === i ? null : i)}
                        className="text-xs text-accent hover:underline">
                        {openEvidence === i ? "▾" : "▸"} show tool call{t.evidence.length === 1 ? "" : "s"} and
                        {" "}{t.evidence.length === 1 ? "query" : `queries (${t.evidence.length})`}
                      </button>
                      {openEvidence === i && (
                        <div data-testid="evidence-panel" className="mt-2 space-y-2">
                          {t.evidence.map((ev, j) => (
                            <div key={j} className="text-2xs rounded border border-line bg-control/40 p-2">
                              <div className="flex items-center gap-2">
                                <code className="text-accent">{ev.tool}</code>
                                {ev.error
                                  ? <span className="text-danger">refused</span>
                                  : <span className="text-fg-muted">{ev.provenance?.n_results} results</span>}
                              </div>
                              {ev.error
                                ? <div className="text-danger mt-1">{ev.error}</div>
                                : Array.isArray(ev.provenance?.cypher)
                                  ? <ol className="text-fg-muted mt-1 space-y-1 list-decimal list-inside">
                                      {ev.provenance!.cypher.map((q, k) => (
                                        <li key={k}><span className="whitespace-pre-wrap">{q.cypher}</span></li>
                                      ))}
                                    </ol>
                                  : <pre className="text-fg-muted whitespace-pre-wrap mt-1">{ev.provenance?.cypher as unknown as string}</pre>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div data-testid="no-evidence" className="text-xs text-warn">
                      no tool evidence — do not use this as a result
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          {busy && (
            <div data-testid="agent-busy" className="flex items-center gap-2 text-xs text-fg-muted">
              <MantaGlyph size={14} /> thinking and calling tools …
            </div>
          )}
          <div ref={endRef} />
        </div>
      )}

      <div className="px-4 py-3 border-t border-line bg-raised">
        <div className="flex items-center gap-2 rounded-lg border border-line-strong bg-surface focus-within:border-accent pl-3 pr-1 py-1">
          <input data-testid="agent-input" value={input} disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") send(); }}
            placeholder={asvId ? `Ask about ${asvId} …` : "Ask about the dataset …"}
            className="flex-1 min-w-0 bg-transparent outline-none py-1 text-sm text-fg placeholder:text-fg-muted disabled:opacity-60" />
          <Button variant="primary" data-testid="agent-send" onClick={() => send()}
            disabled={busy || !input.trim() || tooLong}>
            Send
          </Button>
        </div>
        <div className="mt-1 flex items-baseline gap-2 text-2xs text-fg-muted">
          <span>Enter to send</span>
          {maxQ != null && qLen >= 0.9 * maxQ && (
            <span data-testid="agent-input-count"
              className={`ml-auto shrink-0 tabular-nums ${tooLong ? "text-danger" : ""}`}>
              {qLen} / {maxQ} characters{tooLong ? " — too long, please shorten" : ""}
            </span>
          )}
        </div>
        {signedIn && adminsRead !== null && (
          <div data-testid="agent-transcript-note" className="mt-1 text-2xs text-fg-muted">
            Saved to your account
            {adminsRead && <span data-testid="agent-admins-read"> · administrators can read it</span>}
          </div>
        )}
      </div>
    </div>
  );
}
