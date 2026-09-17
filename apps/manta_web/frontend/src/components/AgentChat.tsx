import { useEffect, useMemo, useRef, useState } from "react";
import { askAgent, getAgentStatus, getAgentTools, getAsv, getEnvironment, getNetwork, runTool,
         type AgentAnswer, type AgentStatus, type Dataset, type EnvVariable, type Neighbor,
         type ChatTurn, type NetNode, type OwnProvider, type ToolHelp,
         type ToolRun } from "../api";
import { useModules } from "../modules";

type Turn =
  | { role: "user"; text: string; tool?: { name: string; args: Record<string, unknown> } }
  | { role: "agent"; text: string; evidence: AgentAnswer["evidence"]; model?: string;
      steps?: number; ungrounded?: string[]; corrected?: boolean; own_key?: boolean }
  | { role: "tool"; run: ToolRun }
  | { role: "error"; text: string };

const MODEL_KEY = "manta.agent.model";

const OWN_KEY = "manta.agent.own";
const USE_OWN_KEY = "manta.agent.useown";
const OWN_OPTION = "__own__";
const HELP_WORDS = new Set(["help", "?", "hilfe", "/help"]);

const PRESETS: Record<string, { label: string; base_url: string; model: string }> = {
  anthropic: { label: "Anthropic (Claude)", base_url: "https://api.anthropic.com/v1",
               model: "claude-sonnet-5" },
  openai: { label: "OpenAI", base_url: "https://api.openai.com/v1", model: "" },
  other: { label: "other (OpenAI-compatible)", base_url: "", model: "" },
};

const TOOL_GROUPS: { title: string; names: string[] }[] = [
  { title: "Datasets", names: ["list_datasets", "dataset_summary", "taxa_composition",
                               "summarize_by_taxon", "find_asv"] },
  { title: "One ASV", names: ["asv_detail", "asv_seasonality", "asv_spectrum", "asv_function",
                              "asv_abundance_series", "neighbors", "asv_drivers"] },
  { title: "Modules", names: ["cluster_detail", "cluster_functions", "cluster_timeseries",
                              "cluster_year_overview", "cluster_interannual_variability"] },
  { title: "Links", names: ["edge", "cluster_bridges", "cluster_network"] },
  { title: "Environment", names: ["environment", "env_variable_links", "cluster_env_links",
                                  "environment_correlation"] },
  { title: "Statistics", names: ["seasonality_test", "trend_test", "pair_proportionality",
                                 "group_comparison_test"] },
  { title: "Advanced", names: ["get_schema", "run_validated_cypher"] },
];

function loadOwn(): OwnProvider | null {
  try {
    const raw = sessionStorage.getItem(OWN_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return o && o.key && o.base_url && o.model ? o : null;
  } catch { return null; }
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}


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

function inline(line: string) {
  return line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4)
      return <strong key={i} className="text-slate-100 font-semibold">{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
      return <code key={i} className="rounded bg-slate-800 px-1 text-[0.85em] text-cyan-300">{part.slice(1, -1)}</code>;
    return part.replace(/\*\*/g, "");
  });
}

function AnswerText({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const Tag = list.ordered ? "ol" : "ul";
    blocks.push(
      <Tag key={blocks.length} className={`${list.ordered ? "list-decimal" : "list-disc"} pl-5 space-y-0.5`}>
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
      ? <p key={blocks.length} className="text-slate-100 font-medium">{inline(h[1])}</p>
      : <p key={blocks.length} className="whitespace-pre-wrap">{inline(line)}</p>);
  }
  flush();
  return <>{blocks}</>;
}

function MantaGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size * 0.8} viewBox="0 4 72 52" aria-hidden="true" className="shrink-0">
      <path d="M36 40 Q34 50 30 57 Q37 52 38 42 Z" fill="#0e7490" />
      <path d="M36 7 C 42 7, 50 10, 70 24 C 56 25, 48 29, 44 35 C 42 41, 39 44, 36 44
               C 33 44, 30 41, 28 35 C 24 29, 16 25, 2 24 C 22 10, 30 7, 36 7 Z" fill="#22d3ee" />
      <circle cx="30" cy="16" r="2.6" fill="#0f172a" />
      <circle cx="42" cy="16" r="2.6" fill="#0f172a" />
    </svg>
  );
}

const CHIP = "px-2 py-0.5 rounded border text-xs";
const CHIP_ON = "border-cyan-600 text-cyan-300 bg-cyan-500/10";
const CHIP_OFF = "border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500";
const FIELD = "w-full bg-slate-950 border rounded px-2 py-1 text-xs text-slate-100 outline-none " +
              "focus:border-cyan-600";

export default function AgentChat({ datasets = [], datasetId, asvId, onClose }:
  { datasets?: Dataset[]; datasetId?: string; asvId?: string; onClose: () => void }) {
  const modules = useModules();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [toolBusy, setToolBusy] = useState<string | null>(null);
  const [openEvidence, setOpenEvidence] = useState<number | null>(null);
  const [model, setModel] = useState<string>(() => {
    try { return localStorage.getItem(MODEL_KEY) ?? ""; } catch { return ""; }
  });
  const endRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<"chat" | "tools">("chat");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [own, setOwn] = useState<OwnProvider | null>(loadOwn);
  const [useOwnNow, setUseOwnNow] = useState<boolean>(() => {
    try { return sessionStorage.getItem(USE_OWN_KEY) === "1"; } catch { return false; }
  });
  const [ownForm, setOwnForm] = useState(false);
  const [preset, setPreset] = useState<string>("anthropic");
  const [draft, setDraft] = useState<OwnProvider>({ ...PRESETS.anthropic, key: "" });
  const [tools, setTools] = useState<ToolHelp[] | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [toolFilter, setToolFilter] = useState("");
  const [openTool, setOpenTool] = useState<string | null>(null);
  const [forms, setForms] = useState<Record<string, Record<string, string>>>({});
  const [tried, setTried] = useState<string | null>(null);
  const [nodes, setNodes] = useState<{ ds: string; nodes: NetNode[] } | null>(null);
  const [env, setEnv] = useState<{ ds: string; vars: EnvVariable[] } | null>(null);
  const [neigh, setNeigh] = useState<{ key: string; list: Neighbor[] } | null>(null);

  function pickPreset(name: string) {
    setPreset(name);
    const p = PRESETS[name] ?? PRESETS.other;
    setDraft((d) => ({ base_url: p.base_url, model: p.model, key: d.key }));
  }
  function chooseOwn(on: boolean) {
    setUseOwnNow(on);
    try { sessionStorage.setItem(USE_OWN_KEY, on ? "1" : "0"); } catch { }
  }
  function useOwn() {
    const o = { base_url: draft.base_url.trim(), model: draft.model.trim(), key: draft.key.trim() };
    if (!o.base_url || !o.model || !o.key) return;
    try { sessionStorage.setItem(OWN_KEY, JSON.stringify(o)); } catch { }
    setOwn(o);
    chooseOwn(true);
    setOwnForm(false);
    setDraft((d) => ({ ...d, key: "" }));
  }
  function forgetOwn() {
    try { sessionStorage.removeItem(OWN_KEY); } catch { }
    setOwn(null);
    chooseOwn(false);
    setMenuOpen(false);
  }
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
    getAgentTools().then((r) => setTools(r.tools)).catch((e) => setToolsError(String(e)));
  }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); },
            [turns, busy, toolBusy]);

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

  async function send(text?: string, tool?: { name: string; args: Record<string, unknown> }) {
    const q = (text ?? input).trim();
    if (!q || busy) return;
    setInput("");
    if (HELP_WORDS.has(q.toLowerCase())) { setView("tools"); return; }
    setView("chat");
    setTurns((t) => [...t, { role: "user", text: q, tool }]);
    setBusy(true);
    try {
      const viaOwn = own && ownActive ? own : undefined;
      const alle: ChatTurn[] = [];
      for (const t of turns) {
        if (t.role === "user" && t.text.trim()) alle.push({ role: "user", content: t.text });
        else if (t.role === "agent" && t.text.trim())
          alle.push({ role: "assistant", content: t.text });
      }
      const verlauf = alle.slice(-8);
      const res = await askAgent(q, { dataset_id: datasetId, asv_id: asvId }, model || undefined,
                                 viaOwn, verlauf);
      setTurns((t) => [...t, { role: "agent", text: res.answer, evidence: res.evidence,
                               model: res.model, steps: res.steps,
                               ungrounded: res.ungrounded, corrected: res.corrected,
                               own_key: res.own_key }]);
    } catch (e) {
      setTurns((t) => [...t, { role: "error", text: String(e) }]);
    } finally {
      setBusy(false);
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
    try {
      const run = await runTool(t.name, args);
      setTurns((x) => [...x, { role: "tool", run }]);
    } catch (e) {
      setTurns((x) => [...x, { role: "error", text: String(e) }]);
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
  const modelLabel = ownActive && own
    ? `own key · ${own.model}`
    : status?.ok
      ? `${model}${current?.parameter_size ? ` · ${current.parameter_size}` : ""}${current?.remote ? " · remote" : ""}`
      : status ? "no model reachable" : "…";

  const quickTools = asvId ? ["asv_detail", "asv_seasonality", "neighbors"]
    : datasetId ? ["dataset_summary", "taxa_composition", "cluster_year_overview"]
    : ["list_datasets"];

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
        className={`rounded border ${open ? "border-cyan-700/70 bg-slate-800/50"
                                          : "border-slate-700 hover:border-slate-500"}`}>
        <button data-testid="tool-open" onClick={() => (open ? setOpenTool(null) : openToolForm(t.name))}
          className="w-full text-left px-3 py-2">
          <div className="flex items-start justify-between gap-2">
            <code className="text-xs text-cyan-300 break-words">{t.usage}</code>
            <span className="text-slate-500 text-xs">{open ? "▾" : "▸"}</span>
          </div>
          <div className={`text-xs text-slate-400 mt-0.5 leading-snug ${open ? "" : "line-clamp-2"}`}>
            {t.summary}
          </div>
        </button>
        {open && (
          <div data-testid="tool-form" className="px-3 pb-3 pt-2 space-y-2.5 border-t border-slate-700/70">
            {t.params.length === 0 && (
              <p className="text-xs text-slate-500">No parameters — run it as it is.</p>
            )}
            {t.params.map((p) => {
              const val = form[p.name] ?? "";
              const missing = p.required && tried === t.name && !val.trim();
              const choice = !!p.enum || p.type === "boolean";
              const sugg = choice ? [] : suggestFor(t.name, p, form, ctx);
              const border = missing ? "border-red-500" : "border-slate-700";
              return (
                <div key={p.name} data-testid="tool-param" data-param={p.name}>
                  <div className="flex items-baseline justify-between gap-2 text-xs">
                    <span>
                      <code className="text-slate-200">{p.name}</code>
                      <span className="text-slate-500"> · {p.type}</span>
                    </span>
                    <span className={p.required ? "text-amber-300" : "text-slate-500"}>
                      {p.required ? "required" : "optional"}
                    </span>
                  </div>
                  {p.description && (
                    <div className="text-[11px] text-slate-500 leading-snug">{p.description}</div>
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
                          className={`px-1.5 py-0.5 rounded border text-[11px] max-w-full truncate
                                      ${val === s.value ? CHIP_ON : CHIP_OFF}`}>
                          <span className="font-mono">{s.value}</span>
                          {s.label && <span className="text-slate-500"> {s.label}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {tried === t.name && toArgs(t, form).missing.length > 0 && (
              <p className="text-xs text-red-300">Fill in: {toArgs(t, form).missing.join(", ")}</p>
            )}
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              {t.params.length > 0 && (
                <>
                  <button data-testid="tool-autofill"
                    onClick={() => setForms((f) => ({ ...f, [t.name]: autofill(t, form, ctx) }))}
                    className={`${CHIP} ${CHIP_OFF}`}>Autofill</button>
                  <button data-testid="tool-clear"
                    onClick={() => { setForms((f) => ({ ...f, [t.name]: {} })); setTried(null); }}
                    className={`${CHIP} border-transparent text-slate-500 hover:text-slate-300`}>Clear</button>
                </>
              )}
              <span className="flex-1" />
              <button data-testid="tool-raw" onClick={() => runDirect(t)} disabled={!!toolBusy}
                title="run the tool without the assistant and show its raw result"
                className={`${CHIP} border-transparent text-slate-500 hover:text-slate-300 disabled:opacity-40`}>
                raw result only
              </button>
              <button data-testid="tool-run" onClick={() => (usable ? askAbout(t) : runDirect(t))}
                disabled={busy || !!toolBusy}
                title={usable ? "the assistant runs the tool and answers" : "no model reachable — raw result"}
                className="px-3 py-0.5 rounded bg-cyan-700 hover:bg-cyan-600 text-white text-xs disabled:opacity-50">
                Run
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div data-testid="agent-chat" className="h-full flex flex-col text-sm">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-700 bg-slate-900">
        <span className="flex items-center gap-2 text-slate-100 font-medium">
          <MantaGlyph /> MANTA assistant
        </span>
        <button data-testid="agent-close" aria-label="Close" onClick={onClose}
          className="text-slate-400 hover:text-white">✕</button>
      </div>

      <div className="px-4 py-2 border-b border-slate-700 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="relative" ref={menuRef}>
          <button data-testid="model-select" data-value={ownActive ? OWN_OPTION : model}
            disabled={busy} onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu" aria-expanded={menuOpen}
            className="flex items-center gap-1.5 max-w-[17rem] px-2 py-0.5 rounded border border-slate-600
                       hover:border-cyan-600 text-xs text-slate-200 disabled:opacity-60">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${usable ? "bg-emerald-400" : "bg-amber-400"}`} />
            <span className="truncate">{modelLabel}</span>
            <span className="text-slate-500">▾</span>
          </button>
          {menuOpen && (
            <div data-testid="model-menu" role="menu"
              className="absolute left-0 top-full mt-1 z-30 w-80 rounded border border-slate-600 bg-slate-900 shadow-2xl py-1 text-xs">
              <div className="px-3 pt-1 pb-0.5 text-[10px] uppercase tracking-wide text-slate-500">
                Models on this server
              </div>
              {models.length === 0 && (
                <div className="px-3 py-1.5 text-amber-400">
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
                  className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-slate-800 disabled:opacity-40 disabled:hover:bg-transparent">
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span className="w-3 text-cyan-300">{!ownActive && model === m.name ? "✓" : ""}</span>
                    <span className="text-slate-200 truncate">{m.name}</span>
                  </span>
                  <span className="text-slate-500 shrink-0">
                    {[m.parameter_size, m.remote ? "remote" : null,
                      m.supports_tools === false ? "no tool support" : null].filter(Boolean).join(" · ")}
                  </span>
                </button>
              ))}
              <div className="my-1 border-t border-slate-700" />
              <div className="px-3 pt-1 pb-0.5 text-[10px] uppercase tracking-wide text-slate-500">
                Your own key · this tab only
              </div>
              {own ? (
                <>
                  <button role="menuitemradio" data-testid="own-key-option" data-value={OWN_OPTION}
                    aria-checked={ownActive}
                    onClick={() => { chooseOwn(true); setMenuOpen(false); }}
                    className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left hover:bg-slate-800">
                    <span className="w-3 text-cyan-300">{ownActive ? "✓" : ""}</span>
                    <span className="text-slate-200 truncate">own key · {own.model} · {hostOf(own.base_url)}</span>
                  </button>
                  <button data-testid="own-key-forget" onClick={forgetOwn}
                    title="forget the key (this tab only ever had it)"
                    className="w-full px-3 py-1.5 pl-[1.9rem] text-left text-slate-400 hover:bg-slate-800 hover:text-red-300">
                    forget key
                  </button>
                </>
              ) : (
                <button data-testid="own-key-toggle"
                  onClick={() => { setOwnForm(true); setMenuOpen(false); }}
                  className="w-full px-3 py-1.5 pl-[1.9rem] text-left text-cyan-300 hover:bg-slate-800">
                  Use your own key …
                </button>
              )}
            </div>
          )}
        </div>
        <div data-testid="agent-context" className="flex items-center gap-1.5 min-w-0 text-xs">
          <span className="text-slate-500">Network</span>
          {datasetId ? (
            <span className="truncate text-slate-200" title={datasetId}>
              {datasets.find((d) => d.dataset_id === datasetId)?.region ?? datasetId}
              <span className="font-mono text-slate-500"> · {datasetId}</span>
            </span>
          ) : (
            <span className="text-slate-400">none selected</span>
          )}
          {datasetId && asvId && (
            <span data-testid="agent-context-asv" className="shrink-0 rounded border border-slate-700 px-1.5 font-mono text-cyan-300">
              {asvId}
            </span>
          )}
        </div>
      </div>

      {ownForm && !own && (
        <div data-testid="own-key-form" className="mx-4 mt-3 p-3 rounded border border-slate-700 bg-slate-800/40 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-slate-100 text-sm font-medium">Use your own key</span>
            <button onClick={() => setOwnForm(false)} aria-label="Cancel"
              className="text-slate-400 hover:text-white text-xs">✕</button>
          </div>
          <p className="text-xs text-slate-400 leading-snug">
            Kept in this tab only and sent with each question. The server stores nothing.
          </p>
          {([
            ["Provider", (
              <select data-testid="own-key-preset" value={preset} onChange={(e) => pickPreset(e.target.value)}
                className={`${FIELD} border-slate-700`}>
                {Object.entries(PRESETS).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
              </select>
            )],
            ["Address", (
              <input data-testid="own-key-url" value={draft.base_url} spellCheck={false}
                onChange={(e) => setDraft((d) => ({ ...d, base_url: e.target.value }))}
                placeholder="https://…/v1" className={`${FIELD} border-slate-700 font-mono`} />
            )],
            ["Model", (
              <input data-testid="own-key-model" value={draft.model} spellCheck={false}
                onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
                placeholder="model name" className={`${FIELD} border-slate-700 font-mono`} />
            )],
            ["Key", (
              <input data-testid="own-key-secret" type="password" value={draft.key} autoComplete="off"
                onChange={(e) => setDraft((d) => ({ ...d, key: e.target.value }))}
                onKeyDown={(e) => { if (e.key === "Enter") useOwn(); }}
                placeholder="sk-…" className={`${FIELD} border-slate-700 font-mono`} />
            )],
          ] as const).map(([label, control]) => (
            <label key={label} className="flex items-center gap-2 text-xs text-slate-400">
              <span className="w-16 shrink-0">{label}</span>
              <span className="flex-1 min-w-0">{control}</span>
            </label>
          ))}
          <div className="flex justify-end gap-1.5 pt-0.5">
            <button onClick={() => setOwnForm(false)}
              className="px-2 py-0.5 rounded text-xs text-slate-400 hover:text-slate-200">cancel</button>
            <button data-testid="own-key-save" onClick={useOwn}
              disabled={!draft.base_url.trim() || !draft.model.trim() || !draft.key.trim()}
              className="px-3 py-0.5 rounded bg-cyan-700 hover:bg-cyan-600 text-white text-xs disabled:opacity-50">
              use in this tab
            </button>
          </div>
        </div>
      )}

      <div className="px-4 pt-3 flex items-center gap-1 text-xs">
        <button data-testid="agent-tab-chat" onClick={() => setView("chat")}
          className={`${CHIP} ${view === "chat" ? CHIP_ON : CHIP_OFF}`}>Chat</button>
        <button data-testid="agent-help-toggle" onClick={() => setView(view === "tools" ? "chat" : "tools")}
          className={`${CHIP} ${view === "tools" ? CHIP_ON : CHIP_OFF}`}>
          Tools{tools ? ` · ${tools.length}` : ""}
        </button>
      </div>

      {view === "tools" ? (
        <div data-testid="agent-help" className="flex-1 min-h-0 overflow-auto px-4 py-3 space-y-4">
          <div className="flex items-center gap-2">
            <input data-testid="tool-search" value={toolFilter} spellCheck={false}
              onChange={(e) => setToolFilter(e.target.value)} placeholder="Filter tools …"
              className={`${FIELD} border-slate-700 flex-1`} />
            <button data-testid="agent-help-close" onClick={() => setView("chat")}
              className="text-xs text-slate-400 hover:text-white shrink-0">← chat</button>
          </div>
          <p className="text-xs text-slate-400 leading-snug">
            Click a tool, fill it in or use Autofill, then run it. Every result carries its query.
          </p>
          {toolsError && <div className="text-xs text-red-300">{toolsError}</div>}
          {tools === null && !toolsError && <div className="text-xs text-slate-500">loading …</div>}
          {grouped.map((g) => (
            <section key={g.title}>
              <h3 className="text-[11px] uppercase tracking-wide text-slate-500 mb-1.5">{g.title}</h3>
              <div className="space-y-1.5">{g.tools.map(renderTool)}</div>
            </section>
          ))}
          {tools && grouped.length === 0 && (
            <div className="text-xs text-slate-500">No tool matches “{toolFilter}”.</div>
          )}
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto px-4 py-3 space-y-4">
          {status && !status.ok && !own && (
            <div data-testid="agent-unavailable" className="rounded border border-amber-500/40 bg-amber-500/5 p-3">
              <div className="text-amber-300 text-xs font-medium">No model reachable</div>
              <p className="mt-1 text-xs text-slate-300 leading-snug">
                Start a local model with tool support, or pick “Use your own key” in the model menu.
              </p>
              {status.error && <p className="mt-1 text-[11px] text-slate-500">{status.error}</p>}
              <pre className="mt-1.5 text-[11px] text-slate-400 whitespace-pre-wrap">{`ollama serve
ollama pull ${status.configured_model ?? status.model}`}</pre>
            </div>
          )}

          {turns.length === 0 && (
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 rounded-full bg-cyan-500/10 border border-cyan-700/40 p-1.5">
                  <MantaGlyph size={22} />
                </div>
                <div className="min-w-0">
                  <div className="text-slate-100 font-medium">
                    {asvId ? `Ask about ${asvId}` : datasetId ? "Ask about this dataset" : "Ask about the datasets"}
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5 leading-snug">
                    Pick a tool or ask in your own words. Answers come only from audited tools.
                  </p>
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Start with a tool</div>
                <div className="flex flex-wrap gap-1">
                  {quickTools.map((n) => (
                    <button key={n} data-testid="quick-tool" onClick={() => openToolForm(n, true)}
                      className={`${CHIP} ${CHIP_OFF} font-mono`}>{n}</button>
                  ))}
                  <button onClick={() => setView("tools")} className={`${CHIP} border-transparent text-cyan-300 hover:underline`}>
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
                  <div className="max-w-[85%] rounded-lg rounded-br-sm bg-cyan-500/10 border border-cyan-700/40 px-3 py-2 text-slate-100">
                    {t.tool ? (
                      <span data-testid="user-tool-call" className="flex flex-wrap items-center gap-1">
                        <code className="text-cyan-300 text-xs">{t.tool.name}</code>
                        {Object.entries(t.tool.args).map(([k, v]) => (
                          <span key={k} className="font-mono text-[11px] text-slate-400">
                            {k}=<span className="text-slate-200">{formatArg(v)}</span>
                          </span>
                        ))}
                      </span>
                    ) : t.text}
                  </div>
                </div>
              )}
              {t.role === "error" && (
                <div data-testid="agent-error" className="rounded border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
                  {t.text}
                </div>
              )}
              {t.role === "tool" && (
                <div data-testid="tool-run-result" className="rounded border border-slate-700 bg-slate-800/40">
                  <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-700">
                    <span className="text-[10px] uppercase tracking-wide text-slate-500">tool</span>
                    <code className="text-xs text-cyan-300">{t.run.tool}</code>
                    <span className="ml-auto text-[11px]">
                      {t.run.error
                        ? <span className="text-red-300">refused</span>
                        : <span className="text-slate-500">{t.run.provenance?.n_results ?? "?"} results</span>}
                    </span>
                  </div>
                  <div className="px-3 py-2 space-y-2">
                    {Object.keys(t.run.arguments).length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(t.run.arguments).map(([k, v]) => (
                          <span key={k} className="rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-[11px] font-mono text-slate-300">
                            {k}=<span className="text-slate-100">{formatArg(v)}</span>
                          </span>
                        ))}
                      </div>
                    )}
                    {t.run.error && <div className="text-xs text-red-300 leading-snug">{t.run.error}</div>}
                    {!t.run.error && (
                      <details>
                        <summary className="cursor-pointer text-xs text-cyan-400 hover:underline">result</summary>
                        <pre data-testid="tool-run-json" className="mt-1 max-h-72 overflow-auto rounded bg-slate-950 border border-slate-800 p-2 text-[11px] text-slate-300">
                          {JSON.stringify(Object.fromEntries(Object.entries(t.run.result)
                            .filter(([k]) => k !== "provenance")), null, 2).slice(0, 20000)}
                        </pre>
                      </details>
                    )}
                    {Array.isArray(t.run.provenance?.cypher) && t.run.provenance!.cypher.length > 0 && (
                      <details>
                        <summary className="cursor-pointer text-xs text-cyan-400 hover:underline">
                          {t.run.provenance!.cypher.length} {t.run.provenance!.cypher.length === 1 ? "query" : "queries"}
                        </summary>
                        <ol className="mt-1 text-[11px] text-slate-500 space-y-1 list-decimal list-inside">
                          {t.run.provenance!.cypher.map((q, k) => (
                            <li key={k}><span className="whitespace-pre-wrap">{q.cypher}</span></li>
                          ))}
                        </ol>
                      </details>
                    )}
                    <div className="flex gap-1.5">
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
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
                    <MantaGlyph size={14} />
                    <span>assistant{t.model ? ` · ${t.model}` : ""}</span>
                  </div>
                  <div data-testid="agent-answer" className="text-slate-200 leading-relaxed space-y-1.5">
                    <AnswerText text={t.text} />
                  </div>
                  {t.own_key && (
                    <div data-testid="own-key-mark" className="text-[11px] text-emerald-400">
                      via your own key · {t.model}
                    </div>
                  )}
                  {t.ungrounded && t.ungrounded.length > 0 && (
                    <div data-testid="ungrounded" className="text-xs text-red-300 rounded border border-red-500/40 bg-red-500/5 px-3 py-2">
                      No tool result contains {t.ungrounded.length === 1 ? "this number" : "these numbers"}:{" "}
                      <span className="font-medium">{t.ungrounded.join(", ")}</span>. They are marked in
                      the text above and must not be used as a result
                      {t.corrected ? " — the model was already asked to correct itself once" : ""}.
                    </div>
                  )}
                  {t.evidence?.length > 0 ? (
                    <div>
                      <button data-testid="evidence-toggle"
                        onClick={() => setOpenEvidence(openEvidence === i ? null : i)}
                        className="text-xs text-cyan-400 hover:underline">
                        {openEvidence === i ? "▾" : "▸"} show tool call{t.evidence.length === 1 ? "" : "s"} and
                        {" "}{t.evidence.length === 1 ? "query" : `queries (${t.evidence.length})`}
                      </button>
                      {openEvidence === i && (
                        <div data-testid="evidence-panel" className="mt-1.5 space-y-1.5">
                          {t.evidence.map((ev, j) => (
                            <div key={j} className="text-[11px] rounded border border-slate-700 bg-slate-800/40 p-2">
                              <div className="flex items-center gap-2">
                                <code className="text-cyan-300">{ev.tool}</code>
                                {ev.error
                                  ? <span className="text-red-300">refused</span>
                                  : <span className="text-slate-500">{ev.provenance?.n_results} results</span>}
                                {tools?.some((x) => x.name === ev.tool) && (
                                  <button data-testid="evidence-rerun"
                                    onClick={() => openToolForm(ev.tool, false, Object.fromEntries(
                                      Object.entries(ev.arguments ?? {}).map(([k, v]) => [k, formatArg(v)])))}
                                    className="ml-auto text-slate-400 hover:text-cyan-300">open in tools</button>
                                )}
                              </div>
                              {ev.error
                                ? <div className="text-red-300 mt-0.5">{ev.error}</div>
                                : Array.isArray(ev.provenance?.cypher)
                                  ? <ol className="text-slate-500 mt-1 space-y-0.5 list-decimal list-inside">
                                      {ev.provenance!.cypher.map((q, k) => (
                                        <li key={k}><span className="whitespace-pre-wrap">{q.cypher}</span></li>
                                      ))}
                                    </ol>
                                  : <pre className="text-slate-500 whitespace-pre-wrap mt-1">{ev.provenance?.cypher as unknown as string}</pre>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div data-testid="no-evidence" className="text-xs text-amber-400">
                      no tool evidence — do not use this as a result
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          {busy && (
            <div data-testid="agent-busy" className="flex items-center gap-2 text-xs text-slate-500">
              <MantaGlyph size={14} /> thinking and calling tools …
            </div>
          )}
          {toolBusy && (
            <div data-testid="tool-busy" className="text-xs text-slate-500">
              running <code className="text-cyan-300">{toolBusy}</code> …
            </div>
          )}
          <div ref={endRef} />
        </div>
      )}

      <div className="px-4 py-3 border-t border-slate-700 bg-slate-900">
        <div className="flex items-center gap-2 rounded-lg border border-slate-600 bg-slate-950 focus-within:border-cyan-600 pl-3 pr-1 py-1">
          <input data-testid="agent-input" value={input} disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") send(); }}
            placeholder={asvId ? `Ask about ${asvId} …` : "Ask about the dataset …"}
            className="flex-1 min-w-0 bg-transparent outline-none py-1 text-sm text-slate-100 placeholder:text-slate-500 disabled:opacity-60" />
          <button data-testid="agent-send" onClick={() => send()} disabled={busy || !input.trim()}
            className="px-3 py-1 rounded-md bg-cyan-700 hover:bg-cyan-600 text-white text-xs disabled:opacity-40">
            Send
          </button>
        </div>
        <div className="mt-1 text-[10px] text-slate-500">
          Enter to send · type <code className="text-slate-400">help</code> for all tools
        </div>
      </div>
    </div>
  );
}
