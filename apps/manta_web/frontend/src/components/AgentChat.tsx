import { Button, StateNotice, ToggleButton, SectionHeading } from "./ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { MANTA_FIGURE } from "../design/dataColours";
import { askAgent, describeError, errorText, getAgentStatus, getAgentTools, getAsv, getConcepts,
         getEnvironment, getNetwork, runTool, type Concept, type Concepts,
         type AgentAnswer, type AgentStatus, type Dataset, type EnvVariable, type Neighbor,
         type ChatTurn, type NetNode, type OwnModel, type ToolHelp, getOwnModel,
         type ToolRun , getApplicability, type Applicability,
         AgentAskError, getConversation, getConversations, type ConversationSummary,
         type StoredTurn } from "../api";
import type { AskAssistant } from "./InfoTip";
import { PanelHeader } from "./PanelFrame";
import { useModules } from "../modules";
import { OWN_MODEL_EVENT, hostOf } from "./OwnModelSettings";
import { AnswerText, ConversationView, RawJson, TurnProtocol, checkText } from "./Transcript";

type Turn =
  | { role: "user"; text: string; tool?: { name: string; args: Record<string, unknown> } }
  | { role: "agent"; text: string; evidence: AgentAnswer["evidence"]; model?: string;
      steps?: number; ungrounded?: string[]; corrected?: boolean; own_key?: boolean;
      turnId?: number | null; grounding?: string; truncated?: boolean;
      check?: AgentAnswer["check"] | null; findings?: AgentAnswer["findings"] }
  | { role: "tool"; run: ToolRun }
  | { role: "error"; text: string; title?: string; kind?: string; todo?: string;
      retry?: { text: string; tool?: { name: string; args: Record<string, unknown> };
                concept?: string };
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
const HELP_WORDS = new Set(["help", "?", "hilfe", "/help"]);

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
  { title: "Links", names: ["edge", "cluster_bridges", "cluster_network"] },
  { title: "Environment", names: ["environment", "env_variable_links", "cluster_env_links",
                                  "environment_correlation"] },
  { title: "Statistics", names: ["seasonality_test", "trend_test", "pair_proportionality",
                                 "group_comparison_test"] },
  { title: "Advanced", names: ["get_schema", "run_validated_cypher"] },
];

type Param = ToolHelp["params"][number];
type Sugg = { value: string; label?: string };
type Ctx = {
  datasets: Dataset[]; datasetId?: string; asvId?: string;
  nodes: NetNode[]; neighbours: Neighbor[]; env: EnvVariable[];
  modules: { value: string; label: string }[];
};
const RANKS = ["kingdom", "phylum", "class", "order", "family", "genus", "species"] as const;

function uniq(xs: (Sugg | null | undefined)[], max = 6): Sugg[] {
  const seen = new Set<string>();
  const out: Sugg[] = [];
  for (const s of xs) {
    if (!s || !s.value || seen.has(s.value)) continue;
    seen.add(s.value);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function statedDefault(p: Param): string | null {
  if (p.default !== null && p.default !== undefined) return String(p.default);
  const m = /default\s+([A-Za-z0-9_.-]+)/.exec(p.description ?? "");
  return m ? m[1] : null;
}

function suggestFor(tool: string, p: Param, form: Record<string, string>, c: Ctx): Sugg[] {
  const byAbundance = [...c.nodes].sort((a, b) =>
    (b.size ?? 0) - (a.size ?? 0) || b.n_samples_present - a.n_samples_present);
  const asvs = byAbundance.map((n) => ({ value: n.id, label: n.genus ?? undefined }));
  const openNode = c.nodes.find((n) => n.id === c.asvId);
  const neighbours = [...c.neighbours]
    .sort((a, b) => (b.corr ?? b.nmi ?? 0) - (a.corr ?? a.nmi ?? 0))
    .map((n) => ({ value: n.id, label: n.genus ?? undefined }));
  const envKeys = c.env.map((v) => ({ value: v.key, label: v.label }));

  switch (p.name) {
    case "dataset_id":
      return uniq([
        c.datasetId ? { value: c.datasetId, label: "open" } : null,
        ...c.datasets.map((d) => ({ value: d.dataset_id, label: d.region ?? undefined })),
      ]);
    case "asv_id": case "asv_a": case "source":
      return uniq([c.asvId ? { value: c.asvId, label: "open" } : null, ...asvs]);
    case "target": case "asv_b": {
      const other = form[p.name === "target" ? "source" : "asv_a"];
      return uniq([...neighbours, ...asvs].filter((s) => s.value !== other));
    }
    case "cluster":
      return uniq([
        openNode ? { value: String(openNode.cluster), label: "of the open ASV" } : null,
        ...c.modules,
      ]);
    case "genus": {
      const n = new Map<string, number>();
      for (const x of c.nodes) if (x.genus) n.set(x.genus, (n.get(x.genus) ?? 0) + 1);
      return uniq([...n.entries()].sort((a, b) => b[1] - a[1])
        .map(([g, k]) => ({ value: g, label: `${k} ASVs` })));
    }
    case "name":
      if (tool === "summarize_by_taxon") {
        const rank = (form.rank || "genus") as typeof RANKS[number];
        const n = new Map<string, number>();
        for (const x of c.nodes) {
          const v = (x as unknown as Record<string, string | null>)[rank];
          if (v) n.set(v, (n.get(v) ?? 0) + 1);
        }
        return uniq([...n.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => ({ value: v })));
      }
      return uniq(envKeys);
    case "variable":
      return uniq(envKeys);
    case "limit":
      return uniq([{ value: "10" }, { value: "25" }, { value: "50" }]);
    case "by":
      return uniq([{ value: "month" }, { value: "year" }]);
    case "group_a":
      return form.by === "month" ? uniq([{ value: "6,7,8", label: "summer" },
                                         { value: "3,4,5", label: "spring" }]) : [];
    case "group_b":
      return form.by === "month" ? uniq([{ value: "12,1,2", label: "winter" },
                                         { value: "9,10,11", label: "autumn" }]) : [];
    case "query":
      return [{ value: "MATCH (a:ASV {dataset_id: $dataset_id}) RETURN a.id, a.genus LIMIT 10" }];
  }
  if (p.enum) {
    const d = statedDefault(p);
    return uniq([...(d ? [{ value: d, label: "default" }] : []), ...p.enum.map((v) => ({ value: v }))]);
  }
  if (p.type === "boolean") return [{ value: "true" }, { value: "false" }];
  return [];
}

function autofill(t: ToolHelp, form: Record<string, string>, c: Ctx): Record<string, string> {
  const next = { ...form };
  for (const p of t.params) {
    if ((next[p.name] ?? "").trim()) continue;
    const d = p.enum || p.type === "boolean" ? statedDefault(p) : null;
    const v = d ?? suggestFor(t.name, p, next, c)[0]?.value ?? statedDefault(p);
    if (v) next[p.name] = v;
  }
  return next;
}

function toArgs(t: ToolHelp, form: Record<string, string>) {
  const args: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const p of t.params) {
    const raw = (form[p.name] ?? "").trim();
    if (!raw) { if (p.required) missing.push(p.name); continue; }
    if (p.type === "integer") args[p.name] = /^-?\d+$/.test(raw) ? Number(raw) : raw;
    else if (p.type === "number") args[p.name] = Number.isFinite(Number(raw)) ? Number(raw) : raw;
    else if (p.type === "boolean") args[p.name] = raw === "true";
    else if (p.type === "array") {
      args[p.name] = raw.split(/[,\s]+/).filter(Boolean)
        .map((x) => (/^-?\d+(\.\d+)?$/.test(x) ? Number(x) : x));
    } else args[p.name] = raw;
  }
  return { args, missing };
}

function formatArg(v: unknown): string {
  return Array.isArray(v) ? v.join(",") : String(v);
}

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
const CHIP_ON = "border-accent text-accent bg-accent-soft";
const CHIP_OFF = "border-line text-fg-muted hover:text-fg hover:border-line-strong";
const FIELD = "w-full bg-surface border rounded px-2 py-1 text-xs text-fg outline-none " +
              "focus:border-accent";

export default function AgentChat({ datasets = [], datasetId, asvId, ask, onClose, signedIn = false }:
  { datasets?: Dataset[]; datasetId?: string; asvId?: string;
    ask?: (AskAssistant & { tick: number }) | null; onClose: () => void;
    signedIn?: boolean }) {
  const modules = useModules();
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
  const [toolBusy, setToolBusy] = useState<string | null>(null);
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
  const [view, setView] = useState<"chat" | "tools" | "ontology" | "history">("chat");
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
  const [toolFilter, setToolFilter] = useState("");
  const [openTool, setOpenTool] = useState<string | null>(null);
  const [forms, setForms] = useState<Record<string, Record<string, string>>>({});
  const [tried, setTried] = useState<string | null>(null);
  const [nodes, setNodes] = useState<{ ds: string; nodes: NetNode[] } | null>(null);
  const [env, setEnv] = useState<{ ds: string; vars: EnvVariable[] } | null>(null);
  const [neigh, setNeigh] = useState<{ key: string; list: Neighbor[] } | null>(null);

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
            [turns, busy, toolBusy]);
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

  useEffect(() => {
    if (view !== "tools" || !datasetId) return;
    let alive = true;
    if (nodes?.ds !== datasetId) {
      getNetwork(datasetId, "con")
        .then((n) => { if (alive) setNodes({ ds: datasetId, nodes: n.nodes }); })
        .catch(() => { if (alive) setNodes({ ds: datasetId, nodes: [] }); });
    }
    if (env?.ds !== datasetId) {
      getEnvironment(datasetId)
        .then((e) => { if (alive) setEnv({ ds: datasetId, vars: e.variables }); })
        .catch(() => { if (alive) setEnv({ ds: datasetId, vars: [] }); });
    }
    const k = `${datasetId}/${asvId}`;
    if (asvId && neigh?.key !== k) {
      getAsv(datasetId, asvId)
        .then((d) => { if (alive) setNeigh({ key: k, list: [...d.neighbors.con, ...d.neighbors.ccm] }); })
        .catch(() => { if (alive) setNeigh({ key: k, list: [] }); });
    }
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, datasetId, asvId]);

  const ctx: Ctx = {
    datasets, datasetId, asvId,
    nodes: nodes && nodes.ds === datasetId ? nodes.nodes : [],
    env: env && env.ds === datasetId ? env.vars : [],
    neighbours: asvId && neigh?.key === `${datasetId}/${asvId}` ? neigh.list : [],
    modules: modules.all.map((m) => ({ value: String(m.louvain_label), label: m.display })),
  };

  const maxQ = status?.limits?.question_chars;
  const qLen = input.trim().length;
  const tooLong = maxQ != null && qLen > maxQ;

  async function send(text?: string, tool?: { name: string; args: Record<string, unknown> },
                      concept?: string, questionKind?: string) {
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
    if (HELP_WORDS.has(q.toLowerCase())) { setView("tools"); return; }
    setView("chat");
    addTurn(k, { role: "user", text: q, tool });
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
      const res = await askAgent(q, { dataset_id: datasetId, asv_id: asvId, concept,
                                      question_kind: questionKind },
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
      if (!tool) setInput((cur) => (cur.trim() ? cur : q));
      const gespeichert = e instanceof AgentAskError ? e : null;
      addTurn(k, { role: "error", title: "The assistant could not answer.",
                   text: d.why, kind: d.kind, todo: d.todo,
                   retry: { text: q, tool, concept }, turnId: gespeichert?.turnId ?? null },
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
    void sendRef.current(ask.question, undefined, ask.concept);
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

  function openToolForm(name: string, fill = false, preset?: Record<string, string>) {
    setView("tools");
    setOpenTool(name);
    setTried(null);
    const t = tools?.find((x) => x.name === name);
    if (!t) return;
    setForms((f) => {
      const base = preset ?? f[name] ?? {};
      return { ...f, [name]: fill ? autofill(t, base, ctx) : base };
    });
  }
  function setField(tool: string, param: string, value: string) {
    setForms((f) => ({ ...f, [tool]: { ...(f[tool] ?? {}), [param]: value } }));
  }

  async function runDirect(t: ToolHelp) {
    const { args, missing } = toArgs(t, forms[t.name] ?? {});
    if (missing.length) { setTried(t.name); return; }
    setView("chat");
    setToolBusy(t.name);
    const k = threadKey;
    try {
      const run = await runTool(t.name, args);
      addTurn(k, { role: "tool", run });
    } catch (e) {
      const d = describeError(e);
      addTurn(k, { role: "error", title: "The tool could not run.", text: d.why,
                   kind: d.kind, todo: d.todo });
    } finally {
      setToolBusy(null);
    }
  }
  function askAbout(t: ToolHelp) {
    const { args, missing } = toArgs(t, forms[t.name] ?? {});
    if (missing.length) { setTried(t.name); return; }
    const with_ = Object.entries(args).map(([k, v]) => `${k}=${formatArg(v)}`).join(", ");
    send(`Use the tool ${t.name}${with_ ? ` with ${with_}` : ""} and tell me what the result shows.`,
         { name: t.name, args });
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
  type Zeile = { t: ToolHelp; a: Applicability["tools"][string] | undefined };
  const frageZeile = ({ t, a }: Zeile) => a?.applicable === "no" ? (
    <div key={t.name} data-testid="agent-question" data-tool={t.name} data-state="no"
      className="text-xs text-fg-muted leading-snug">
      {t.question}
      <button data-testid="agent-question-why"
        onClick={() => setWhyOpen(whyOpen === t.name ? null : t.name)}
        className="ml-2 text-fg-muted hover:text-fg">
        {whyOpen === t.name ? "not here ▾" : "not here — why?"}
      </button>
      {whyOpen === t.name && (
        <div data-testid="agent-question-reason" className="mt-1 text-fg-muted">{a.reason}</div>
      )}
    </div>
  ) : (
    <button key={t.name} data-testid="agent-question" data-tool={t.name}
      data-state={a?.applicable ?? "yes"} disabled={busy}
      title={a?.applicable === "subject" && a.subject_condition ? a.subject_condition : undefined}
      onClick={() => send(t.question!, undefined, undefined, t.name)}
      className="text-left text-xs text-fg hover:text-accent hover:underline disabled:opacity-50">
      {t.question}
    </button>
  );

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
    const f = toolFilter.trim().toLowerCase();
    const match = (t: ToolHelp) => !f || t.name.includes(f) || t.summary.toLowerCase().includes(f);
    const known = new Set(TOOL_GROUPS.flatMap((g) => g.names));
    const groups = TOOL_GROUPS.map((g) => ({
      title: g.title,
      tools: g.names.map((n) => tools.find((t) => t.name === n)).filter((t): t is ToolHelp => !!t && match(t)),
    }));
    groups.push({ title: "Other", tools: tools.filter((t) => !known.has(t.name) && match(t)) });
    return groups.filter((g) => g.tools.length > 0);
  }, [tools, toolFilter]);

  const renderTool = (t: ToolHelp) => {
    const open = openTool === t.name;
    const form = forms[t.name] ?? {};
    return (
      <div key={t.name} data-testid="agent-help-tool" data-tool={t.name}
        className={`rounded border ${open ? "border-accent bg-control/50"
                                          : "border-line hover:border-line-strong"}`}>
        <button data-testid="tool-open" onClick={() => (open ? setOpenTool(null) : openToolForm(t.name))}
          className="w-full text-left px-3 py-2">
          <div className="flex items-start justify-between gap-2">
            <code className="text-xs text-accent break-words">{t.usage}</code>
            <span className="text-fg-muted text-xs">{open ? "▾" : "▸"}</span>
          </div>
          <div className={`text-xs text-fg-muted mt-1 leading-snug ${open ? "" : "line-clamp-2"}`}>
            {t.summary}
          </div>
        </button>
        {open && (
          <div data-testid="tool-form" className="px-3 pb-3 pt-2 space-y-3 border-t border-line">
            {t.params.length === 0 && (
              <p className="text-xs text-fg-muted">No parameters — run it as it is.</p>
            )}
            {t.params.map((p) => {
              const val = form[p.name] ?? "";
              const missing = p.required && tried === t.name && !val.trim();
              const choice = !!p.enum || p.type === "boolean";
              const sugg = choice ? [] : suggestFor(t.name, p, form, ctx);
              const border = missing ? "border-danger" : "border-line";
              return (
                <div key={p.name} data-testid="tool-param" data-param={p.name}>
                  <div className="flex items-baseline justify-between gap-2 text-xs">
                    <span>
                      <code className="text-fg">{p.name}</code>
                      <span className="text-fg-muted"> · {p.type}</span>
                    </span>
                    <span className={p.required ? "text-warn" : "text-fg-muted"}>
                      {p.required ? "required" : "optional"}
                    </span>
                  </div>
                  {p.description && (
                    <div className="text-2xs text-fg-muted leading-snug">{p.description}</div>
                  )}
                  <div className="mt-1">
                    {choice ? (
                      <select data-testid="tool-input" value={val}
                        onChange={(e) => setField(t.name, p.name, e.target.value)}
                        className={`${FIELD} ${border}`}>
                        <option value="">{p.required ? "choose …" : `default${statedDefault(p) ? ` (${statedDefault(p)})` : ""}`}</option>
                        {(p.enum ?? ["true", "false"]).map((v) => <option key={v} value={v}>{v}</option>)}
                      </select>
                    ) : p.name === "query" ? (
                      <textarea data-testid="tool-input" value={val} rows={3} spellCheck={false}
                        onChange={(e) => setField(t.name, p.name, e.target.value)}
                        className={`${FIELD} ${border} font-mono`} />
                    ) : (
                      <input data-testid="tool-input" value={val} spellCheck={false}
                        onChange={(e) => setField(t.name, p.name, e.target.value)}
                        placeholder={p.type === "array" ? "comma-separated" : statedDefault(p) ?? ""}
                        className={`${FIELD} ${border} font-mono`} />
                    )}
                  </div>
                  {sugg.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {sugg.map((s) => (
                        <button key={s.value} data-testid="param-suggestion"
                          onClick={() => setField(t.name, p.name, s.value)}
                          className={`px-2 py-1 rounded border text-2xs max-w-full truncate
                                      ${val === s.value ? CHIP_ON : CHIP_OFF}`}>
                          <span className="font-mono">{s.value}</span>
                          {s.label && <span className="text-fg-muted"> {s.label}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {tried === t.name && toArgs(t, form).missing.length > 0 && (
              <p className="text-xs text-danger">Fill in: {toArgs(t, form).missing.join(", ")}</p>
            )}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {t.params.length > 0 && (
                <>
                  <button data-testid="tool-autofill"
                    onClick={() => setForms((f) => ({ ...f, [t.name]: autofill(t, form, ctx) }))}
                    className={`${CHIP} ${CHIP_OFF}`}>Autofill</button>
                  <button data-testid="tool-clear"
                    onClick={() => { setForms((f) => ({ ...f, [t.name]: {} })); setTried(null); }}
                    className={`${CHIP} border-transparent text-fg-muted hover:text-fg`}>Clear</button>
                </>
              )}
              <span className="flex-1" />
              <button data-testid="tool-raw" onClick={() => runDirect(t)} disabled={!!toolBusy}
                title="run the tool without the assistant and show its raw result"
                className={`${CHIP} border-transparent text-fg-muted hover:text-fg disabled:opacity-40`}>
                raw result only
              </button>
              <Button variant="primary" data-testid="tool-run" onClick={() => (usable ? askAbout(t) : runDirect(t))}
                disabled={busy || !!toolBusy}
                title={usable ? "the assistant runs the tool and answers" : "no model reachable — raw result"}>
                Run
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div data-testid="agent-chat" className="h-full flex flex-col text-sm">
      <PanelHeader lead={<MantaGlyph />} title="MANTA assistant" onClose={onClose}
        closeTestid="agent-close" />

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

      <div className="px-4 pt-3 flex items-center gap-1 text-xs">
        <ToggleButton data-testid="agent-tab-chat" pressed={view === "chat"} onClick={() => setView("chat")}>
          Chat</ToggleButton>
        <ToggleButton data-testid="agent-help-toggle" pressed={view === "tools"}
          onClick={() => setView(view === "tools" ? "chat" : "tools")}>
          Tools{tools ? ` · ${tools.length}` : ""}
        </ToggleButton>
        <ToggleButton data-testid="agent-ontology-toggle" pressed={view === "ontology"}
          onClick={() => setView(view === "ontology" ? "chat" : "ontology")}>
          Ontology{concepts ? ` · ${concepts.n}` : ""}
        </ToggleButton>
        {signedIn && (
          <ToggleButton data-testid="agent-history-tab" pressed={view === "history"}
            onClick={() => { setReading(null); setView(view === "history" ? "chat" : "history"); }}>
            History</ToggleButton>
        )}
        {turns.length > 0 && (
          <Button data-testid="agent-new-conversation" onClick={newConversation} disabled={busy}
            reason="wait for the answer first"
            title="start an empty conversation on this dataset; this one stays under History"
            className="ml-auto">New conversation</Button>
        )}
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
          <div className="flex items-center gap-2">
            <input data-testid="ontology-search" value={conceptFilter} spellCheck={false}
              onChange={(e) => setConceptFilter(e.target.value)} placeholder="Filter terms …"
              className={`${FIELD} border-line flex-1`} />
            <button data-testid="agent-ontology-close" onClick={() => setView("chat")}
              className="text-xs text-fg-muted hover:text-fg shrink-0">← chat</button>
          </div>
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
      ) : view === "tools" ? (
        <div data-testid="agent-help" className="flex-1 min-h-0 overflow-auto px-4 py-3 space-y-4">
          <div className="flex items-center gap-2">
            <input data-testid="tool-search" value={toolFilter} spellCheck={false}
              onChange={(e) => setToolFilter(e.target.value)} placeholder="Filter tools …"
              className={`${FIELD} border-line flex-1`} />
            <button data-testid="agent-help-close" onClick={() => setView("chat")}
              className="text-xs text-fg-muted hover:text-fg shrink-0">← chat</button>
          </div>
          <p className="text-xs text-fg-muted leading-snug">
            Click a tool, fill it in or use Autofill, then run it. Every result carries its query.
          </p>
          {toolsError && <div className="text-xs text-danger">{toolsError}</div>}
          {tools === null && !toolsError && <StateNotice state="loading" inline>loading …</StateNotice>}
          {grouped.map((g) => (
            <section key={g.title}>
              <SectionHeading className="mb-2">{g.title}</SectionHeading>
              <div className="space-y-2">{g.tools.map(renderTool)}</div>
            </section>
          ))}
          {tools && grouped.length === 0 && (
            <div className="text-xs text-fg-muted">No tool matches “{toolFilter}”.</div>
          )}
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
                    {asvId ? `Ask about ${asvId}` : datasetId ? "Ask about this dataset" : "Ask about the datasets"}
                  </div>
                  <p className="text-xs text-fg-muted mt-1 leading-snug">
                    Pick a question or ask in your own words. Answers come only from audited tools.
                  </p>
                </div>
              </div>
              <div>
                <div data-testid="agent-entry-title"
                  className="text-xs font-semibold text-fg-muted mb-1">
                  {asvId ? `What I can tell you about ${asvId}`
                    : datasetId ? "What I can tell you about this dataset" : "Where to start"}
                </div>
                <div className="flex flex-col gap-1" data-testid="agent-entry">
                  {entry.main.map(frageZeile)}
                  {entry.more.length > 0 && (
                    <button data-testid="agent-entry-more" onClick={() => setMoreOpen((v) => !v)}
                      className="text-left text-xs text-fg-muted hover:text-fg mt-1">
                      {moreOpen ? "▾" : "▸"} {asvId ? "about the dataset, and in general" : "in general"} ({entry.more.length})
                    </button>
                  )}
                  {moreOpen && entry.more.map(frageZeile)}
                  <button onClick={() => setView("tools")}
                    className="text-left text-xs text-accent hover:underline mt-1">
                    all tools →
                  </button>
                </div>
              </div>
            </div>
          )}

          {turns.map((t, i) => (
            <div key={i}>
              {t.role === "user" && (
                <div className="flex justify-end">
                  <div className="max-w-[85%] rounded-lg rounded-br-sm bg-accent-soft border border-accent px-3 py-2 text-fg">
                    {t.tool ? (
                      <span data-testid="user-tool-call" className="flex flex-wrap items-center gap-1">
                        <code className="text-accent text-xs">{t.tool.name}</code>
                        {Object.entries(t.tool.args).map(([k, v]) => (
                          <span key={k} className="font-mono text-2xs text-fg-muted">
                            {k}=<span className="text-fg">{formatArg(v)}</span>
                          </span>
                        ))}
                      </span>
                    ) : t.text}
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
                            onClick={() => void send(t.retry!.text, t.retry!.tool, t.retry!.concept)}>
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
              {t.role === "tool" && (
                <div data-testid="tool-run-result" className="rounded border border-line bg-control/40">
                  <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
                    <span className="text-xs font-semibold text-fg-muted">tool</span>
                    <code className="text-xs text-accent">{t.run.tool}</code>
                    <span className="ml-auto text-2xs">
                      {t.run.error
                        ? <span className="text-danger">refused</span>
                        : <span className="text-fg-muted">{t.run.provenance?.n_results ?? "?"} results</span>}
                    </span>
                  </div>
                  <div className="px-3 py-2 space-y-2">
                    {Object.keys(t.run.arguments).length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(t.run.arguments).map(([k, v]) => (
                          <span key={k} className="rounded border border-line bg-surface px-2 py-1 text-2xs font-mono text-fg">
                            {k}=<span className="text-fg">{formatArg(v)}</span>
                          </span>
                        ))}
                      </div>
                    )}
                    {t.run.error && <div className="text-xs text-danger leading-snug">{t.run.error}</div>}
                    {!t.run.error && (
                      <details>
                        <summary className="cursor-pointer text-xs text-accent hover:underline">result</summary>
                        <RawJson value={Object.fromEntries(Object.entries(t.run.result)
                          .filter(([k]) => k !== "provenance"))} />
                      </details>
                    )}
                    {Array.isArray(t.run.provenance?.cypher) && t.run.provenance!.cypher.length > 0 && (
                      <details>
                        <summary className="cursor-pointer text-xs text-accent hover:underline">
                          {t.run.provenance!.cypher.length} {t.run.provenance!.cypher.length === 1 ? "query" : "queries"}
                        </summary>
                        <ol className="mt-1 text-2xs text-fg-muted space-y-1 list-decimal list-inside">
                          {t.run.provenance!.cypher.map((q, k) => (
                            <li key={k}><span className="whitespace-pre-wrap">{q.cypher}</span></li>
                          ))}
                        </ol>
                      </details>
                    )}
                    <div className="flex gap-2">
                      <button data-testid="tool-run-edit"
                        onClick={() => openToolForm(t.run.tool, false, Object.fromEntries(
                          Object.entries(t.run.arguments).map(([k, v]) => [k, formatArg(v)])))}
                        className={`${CHIP} ${CHIP_OFF}`}>edit &amp; run again</button>
                      {usable && !t.run.error && (
                        <button data-testid="tool-run-explain" disabled={busy}
                          onClick={() => {
                            const with_ = Object.entries(t.run.arguments).map(([k, v]) => `${k}=${formatArg(v)}`).join(", ");
                            send(`Use the tool ${t.run.tool}${with_ ? ` with ${with_}` : ""} and tell me what the result shows.`,
                                 { name: t.run.tool, args: t.run.arguments });
                          }}
                          className={`${CHIP} ${CHIP_OFF} disabled:opacity-40`}>ask the assistant about it</button>
                      )}
                    </div>
                  </div>
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
                                {tools?.some((x) => x.name === ev.tool) && (
                                  <button data-testid="evidence-rerun"
                                    onClick={() => openToolForm(ev.tool, false, Object.fromEntries(
                                      Object.entries(ev.arguments ?? {}).map(([k, v]) => [k, formatArg(v)])))}
                                    className="ml-auto text-fg-muted hover:text-accent">open in tools</button>
                                )}
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
          {toolBusy && (
            <div data-testid="tool-busy" className="text-xs text-fg-muted">
              running <code className="text-accent">{toolBusy}</code> …
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
          <span>Enter to send · type <code className="text-fg-muted">help</code> for all tools</span>
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
