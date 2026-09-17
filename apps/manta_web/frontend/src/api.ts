const BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";

const F = (input: RequestInfo | URL, init: RequestInit = {}) =>
  fetch(input, { credentials: "include", ...init });

export type Me = { username: string | null; role: string; can_see_internal: boolean };

export const getMe = (): Promise<Me> =>
  F(`${BASE}/auth/me`).then((r) => r.json());

export async function login(username: string, password: string): Promise<Me> {
  const r = await F(`${BASE}/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? `HTTP ${r.status}`);
  return getMe();
}

export const logout = (): Promise<void> =>
  F(`${BASE}/auth/logout`, { method: "POST" }).then(() => undefined);

export type AdminUser = {
  username: string; role: string; created_at: number; disabled: number; sessions: number;
};

export const adminUsers = ():
  Promise<{ users: AdminUser[]; roles: string[]; visibilities?: string[] }> =>
  F(`${BASE}/admin/users`).then((r) => r.json());

async function adminSend(path: string, method: string, body?: unknown) {
  const r = await F(`${BASE}${path}`, {
    method, headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? `HTTP ${r.status}`);
  return r.json();
}

export const adminCreateUser = (username: string, password: string, role: string) =>
  adminSend("/admin/users", "POST", { username, password, role });
export const adminPatchUser = (
  username: string, patch: { password?: string; role?: string; disabled?: boolean }) =>
  adminSend(`/admin/users/${encodeURIComponent(username)}`, "PATCH", patch);
export const adminDeleteUser = (username: string) =>
  adminSend(`/admin/users/${encodeURIComponent(username)}`, "DELETE");

export type ImportJob = {
  job_id: string; status: string; stage: string; stages?: string[];
  dataset_id?: string; progress?: number; error?: string;
  started_at?: number; stage_detail?: string;
};
export const importJobs = (): Promise<{ jobs: ImportJob[]; hinweis: string }> =>
  F(`${BASE}/imports`).then((r) => r.json());

export type AuditEntry = {
  at: number; who: string; what: string; detail: string;
};
export const auditLog = (): Promise<{ entries: AuditEntry[] }> =>
  F(`${BASE}/admin/audit`).then((r) => r.json());

export type AdminStatus = {
  ok: boolean;
  checks: Record<"database" | "mail" | "assistant" | "analysis_tools",
                 { ok: boolean; detail: string }>;
};
export const adminStatus = (): Promise<AdminStatus> =>
  F(`${BASE}/admin/status`).then((r) => r.json());

export type MailSettingsView = {
  values: {
    smtp_host: string; smtp_port: string; smtp_tls: string; smtp_user: string;
    mail_from: string; request_mailto: string; public_url: string;
    ollama_model: string; grounding: string; openai_base_url: string;
    openai_models: string; openai_timeout: string;
    smtp_password_set: boolean; openai_api_key_set: boolean;
  };
  source: Record<string, "panel" | "env" | "unset">;
  updated_at: number | null;
  updated_by: string | null;
  mail: { configured: boolean; sender: string | null; collect_to: string[] };
};
export type MailSettingsPatch = Partial<Record<
  "smtp_host" | "smtp_port" | "smtp_tls" | "smtp_user" | "smtp_password" |
  "mail_from" | "request_mailto" | "public_url", string>>;

export type AgentSettingsPatch = Partial<Record<
  "ollama_model" | "grounding" | "openai_base_url" | "openai_api_key" |
  "openai_models" | "openai_timeout", string>>;

export const agentSettings = (): Promise<MailSettingsView> =>
  F(`${BASE}/admin/settings/agent`).then((r) => r.json());
export const saveAgentSettings = (patch: AgentSettingsPatch) =>
  adminSend("/admin/settings/agent", "PUT", patch) as Promise<MailSettingsView>;
export const resetAgentSettings = (keys: string[]) =>
  adminSend("/admin/settings/agent/reset", "POST", { keys }) as Promise<MailSettingsView>;

export const mailSettings = (): Promise<MailSettingsView> =>
  F(`${BASE}/admin/settings/mail`).then((r) => r.json());
export const saveMailSettings = (patch: MailSettingsPatch) =>
  adminSend("/admin/settings/mail", "PUT", patch) as Promise<MailSettingsView>;
export const resetMailSettings = (keys: string[]) =>
  adminSend("/admin/settings/mail/reset", "POST", { keys }) as Promise<MailSettingsView>;
export const testMail = (to: string) =>
  adminSend("/admin/settings/mail/test", "POST", { to }) as Promise<{ status: string; to: string }>;
export const adminRevokeSessions = (username: string) =>
  adminSend(`/admin/users/${encodeURIComponent(username)}/revoke`, "POST");
export const setVisibility = (dataset_id: string, visibility: "public" | "internal") =>
  adminSend(`/datasets/${encodeURIComponent(dataset_id)}/visibility`, "PUT", { visibility });


export type SignupTopic = { key: string; label: string };

export type SignupOptions = { topics: SignupTopic[]; mail_configured: boolean };

export const signupOptions = (): Promise<SignupOptions> =>
  F(`${BASE}/signup/options`).then((r) => r.json());

export type SignupInput = {
  full_name: string; email: string; reason: string;
  institution?: string; topic?: string; wanted_username?: string;
  website?: string;
};

export async function submitSignup(data: SignupInput): Promise<{ ok: boolean; id: number | null }> {
  const r = await F(`${BASE}/signup`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? `HTTP ${r.status}`);
  return r.json();
}

export type AccessRequest = {
  id: number; created_at: number; full_name: string; email: string; institution: string;
  topic: string; wanted_username: string; reason: string;
  status: "open" | "approved" | "rejected";
  decided_at: number | null; decided_by: string | null; note: string;
  created_user: string | null;
  mail_status: string; mail_to: string;
};

export type RequestRoute = { topic: string; label: string; email: string; sort?: number };

export const adminRequests = async (): Promise<{
  requests: AccessRequest[]; routes: RequestRoute[]; roles: string[];
  mail: { configured: boolean; sender: string | null; collect_to: string[] };
}> => {
  const r = await F(`${BASE}/admin/requests`);
  if (!r.ok) {
    const detail = (await r.json().catch(() => ({}))).detail;
    throw new Error(r.status === 404
      ? "This server does not know access requests yet (restart the API after updating)."
      : detail ?? `HTTP ${r.status}`);
  }
  const d = await r.json();
  return {
    requests: Array.isArray(d?.requests) ? d.requests : [],
    routes: Array.isArray(d?.routes) ? d.routes : [],
    roles: Array.isArray(d?.roles) && d.roles.length ? d.roles : ["viewer", "admin"],
    mail: d?.mail ?? { configured: false, sender: null, collect_to: [] },
  };
};

export const adminApproveRequest = (
  id: number, body: { username: string; password: string; role: string; notify: boolean }) =>
  adminSend(`/admin/requests/${id}/approve`, "POST", body);
export const adminRejectRequest = (id: number, body: { note: string; notify: boolean }) =>
  adminSend(`/admin/requests/${id}/reject`, "POST", body);
export const adminDeleteRequest = (id: number) =>
  adminSend(`/admin/requests/${id}`, "DELETE");
export const adminSetRoutes = (routes: RequestRoute[]) =>
  adminSend("/admin/request-routes", "PUT", { routes });

export type Dataset = {
  dataset_id: string;
  region: string | null;
  visibility?: string;
  marker: string | null;
  n_asv: number;
  n_network: number;
  n_sample: number;
  station: string | null;
  coords: [number, number] | null;
};

export type NetNode = {
  id: string;
  genus: string | null;
  kingdom: string | null;
  phylum: string | null;
  class: string | null;
  order: string | null;
  family: string | null;
  species: string | null;
  cluster: number;
  color: string;
  size: number | null;
  n_samples_present: number;
  peak_month: number | null;
  starred?: boolean;
  trait_group?: string | null;
  trait_rank?: string | null;
};

export type NetEdge = {
  source: string; target: string; corr?: number; nmi?: number; p_value: number;
  p_adj_fdr?: number | null; from_clu?: number | null; to_clu?: number | null;
  ccm_forward?: boolean; ccm_backward?: boolean; ccm_dirs?: number;
  nmi_forward?: number | null; nmi_backward?: number | null;
  rejected_forward?: boolean; rejected_backward?: boolean; rejected_dirs?: number;
  nmi_rejected_forward?: number | null; nmi_rejected_backward?: number | null;
};

export type Layers = {
  n_con: number; n_con_with_ccm: number;
  n_ccm_directions: number; n_con_both_directions: number;
  n_asv_con: number; n_asv_ccm: number;
  n_ccm_rejected: number; n_con_with_rejected: number; n_asv_rejected: number;
  n_ccm_tested: number | null; ccm_tested_recorded: boolean;
};

export type Thresholds = {
  con_tr: number; con_alpha: number; ccmn_tr: number; ccmn_alpha: string | number;
  num_permutations: number; num_samples: number; louvain_res: number; fft_coeffs: number;
  run_id: string | null; computed_at: string | null; recorded: boolean;
};

export type Partition = {
  n_clusters: number; n_components: number;
  n_crossing_edges: number; clusters_are_components: boolean;
};

export type Network = {
  dataset_id: string;
  partition: Partition;
  marker: string | null;
  traits?: TraitRun;
  edge: "con" | "ccm";
  directed: boolean;
  thresholds: Thresholds;
  layers: Layers;
  hubs: HubCriterion;
  edge_width_legend: { con: string; ccm: string; rejected: string };
  nodes: NetNode[];
  edges: NetEdge[];
};

export type HubCriterion = {
  measure: string; measure_label: string; k: number;
  mu: number | null; sigma: number | null; threshold: number | null;
  sigma_kind: string;
  n_network: number; n_with_value: number; n_marked: number; n_zero: number;
  ids: string[];
  statement: string;
  zero_caveat: string | null;
  measure_caveat: string;
  why_not_keystone: string;
  node_tooltip: string;
  title: string;
  source: string;
  controls: {
    measures: { key: string; label: string }[];
    default_measure: string; default_k: number;
    k_min: number; k_max: number; k_step: number;
  };
};

export type Quantity = {
  value_kind: "reads" | "transformed" | "unknown";
  basis: string;
  unit: string; denominator: string; numerator: string; not: string;
  frame: string;
  share_caveat: string;
  min_value: number | null;
};

export type SourcePublication = { citation: string; doi: string };

export type ClusterAtSample = {
  sample: string;
  cluster_total: number;
  note: string | null;
  members: { id: string; genus: string | null; count: number;
             share_of_sample: number | null; share_of_cluster: number | null }[];
};

export type Starred = {
  dataset_id: string; n: number;
  asvs: { id: string; genus: string | null; cluster: number | null; at: string | null }[];
  clusters: { louvain_label: number; at: string | null }[];
  note?: string | null;
};

export type ClimMonth = {
  month: number; label: string; mean: number | null; std: number;
  lo: number | null; hi: number | null; lo_clipped: boolean;
  n: number; n_years: number;
};
export type YearMonth = { month: number; label: string; mean: number; n: number };

export type SeasonalYear = {
  year: string; n: number; months_covered: number; months: number[];
  note: string | null;
  mean: number; std: number; anomaly: number;
  by_month: { month: number; label: string; mean: number }[];
};
export type PeakWindow = {
  window_days: number;
  window: { start_doy: number; end_doy: number; label: string } | null;
  n_years_in_window: number;
  n_years_considered: number;
  n_years_detected: number;
  n_years_sampled: number;
  years: { year: string; peak_date: string | null; peak_doy: number | null;
           detected: boolean; covers_window: boolean; in_window: boolean }[];
  definition: string;
  reference: string;
  note: string;
};

export type Seasonal = {
  climatology: ClimMonth[];
  years: SeasonalYear[];
  peak_window: PeakWindow;
  trend_per_year: number | null;
  trend_method: string;
  full_years: string[];
  partial_years: string[];
};

export type Where = { date: string | null; index: number | null };

export type FreqPoint = {
  sample: string | null; date: string | null;
  share: number | null;
  sample_total: number | null;
  rank: number | null; n_present: number | null;
};

export type FreqSummary = {
  n_samples: number;
  n_detected: number;
  max_share: number | null;
  max_at: Where;
  max_count: number | null;
  max_sample_total: number | null;
  max_rank: number | null;
  median_share_when_detected: number | null;
  best_rank: number | null;
  best_rank_at: Where;
  median_rank_when_detected: number | null;
  rank_pool: number | null;
  statement?: string;
};

export type Oscillation = {
  years: { year: string; n_samples: number; n_peaks: number; counted: boolean }[];
  n_years_counted: number;
  modal_peaks: number | null;
  annually_oscillating: boolean | null;
  fft_coeffs: number;
  min_samples_per_year: number;
  method: string;
  reference: string;
};

export type Frequency = {
  time_axis: "dates" | "ordinal";
  quantity: Quantity;
  points: FreqPoint[];
  summary: FreqSummary;
  seasonal: Seasonal | null;
  oscillation: Oscillation | null;
};

export type Capability = {
  key: "time_axis" | "value_kind" | "taxonomy" | "sequence" | "network" | "environment";
  label: string;
  available: boolean;
  value: string;
  detail: string;
  n?: number;
  total?: number;
  per_rank?: Record<string, number>;
  n_sample?: number;
};
export type Capabilities = {
  dataset_id: string;
  time_axis: "dates" | "ordinal";
  value_kind: string;
  items: Capability[];
};

export type Neighbor = {
  id: string; genus: string | null; cluster: number | null;
  corr?: number; nmi?: number; p_value: number | null;
};

export type NetworkScope = {
  recorded: boolean;
  n_in_run: number | null;
  n_dataset: number;
  subset: boolean | null;
  run_id?: string | null;
  note: string;
};

export type TraitAnnotation = {
  annotated: boolean;
  functions: string[];
  sources: string[];
  rank: string | null;
  group: string;
  run_id: string | null;
  note: string;
};

export type TraitRun = {
  available: boolean;
  run_id: string | null;
  computed_by?: string;
  method?: string;
  marker?: string | null;
  sources: string[];
  source_citations?: string[];
  coverage: number | null;
  n_annotated: number;
  n_with_lineage: number;
  n_asv: number;
  n_by_rank?: Record<string, number>;
  absent_reason?: string | null;
  statement: string | null;
  note: string;
  mdb_categories?: Record<string, string>;
};

export type FunctionBreakdown = {
  n_members: number;
  n_annotated: number;
  functions: { label: string; n_asv: number; share: number | null }[];
  note: string;
};

export type Spectrum = {
  available: boolean;
  absent_reason?: string;
  harmonics: number[] | null;
  amplitudes: number[] | null;
  n: number;
  fft_coeffs: number;
  params_recorded: boolean;
  hellinger: boolean | null;
  method: string;
  caveat: string;
};

export type AsvDetail = {
  id: string;
  dataset_id: string;
  network_scope: NetworkScope;
  spectrum?: Spectrum | null;
  frequency: Frequency;
  capabilities: Capabilities;
  lineage: Record<string, string | null>;
  cluster: number;
  color: string;
  centralities: Record<string, number | null>;
  note: string | null;
  note_at: string | null;
  sequence: string | null;
  seq_length: number | null;
  seq_hash: string | null;
  starred: boolean;
  peak_environment: PeakEnvironment;
  environment_profile: EnvironmentProfile;
  hub_glow: boolean;
  hub_tooltip: string;
  neighbors: { con: Neighbor[]; ccm: Neighbor[] };
  funktion: string;
  trait?: TraitAnnotation | null;
  trait_run?: TraitRun;
  bild: string | null;
};

export type EdgeEndpoint = {
  id: string;
  lineage: Record<string, string | null>;
  cluster: number | null;
  has_sequence: boolean;
  summary: FreqSummary;
};

export type EdgeDirection = { nmi: number; p_value: number | null; decision?: "kept" | "rejected" };

export type EdgeDetail = {
  dataset_id: string;
  type: "con" | "ccm";
  directed: boolean;
  source: EdgeEndpoint;
  target: EdgeEndpoint;
  edge: { corr?: number; nmi?: number; p_value: number | null; p_adj_fdr?: number | null;
          from_clu?: number | null; to_clu?: number | null };
  run_id: string | null;
  reverse: { nmi: number; p_value: number | null } | null;
  directions?: { forward: EdgeDirection | null; backward: EdgeDirection | null };
  ccm_tested_recorded?: boolean;
  decision_note?: string;
  cross_cluster: boolean;
  strength_context: { n_edges: number; min_strength: number; max_strength: number;
                      n_stronger: number; rank: number };
  co_detected_in: number;
  n_samples: number;
  pattern: {
    n_rhythms: number; fft_coeffs: number; recorded: boolean;
    time_axis: "dates" | "ordinal";
    samples: { sample: string | null; date: string | null }[];
    source_raw: number[]; target_raw: number[];
    source_pattern: number[]; target_pattern: number[];
    method: string; caveat: string;
  } | null;
  thresholds: Thresholds;
  source_publication: SourcePublication;
};

export type ClusterDetail = {
  dataset_id: string;
  louvain_label: number;
  frequency: Frequency;
  environment_profile: {
    items: { key: string; label: string; unit: string | null; weighted_mean: number;
             p10: number; p90: number; n_samples_used: number; n_samples_present: number }[];
    method: string; caveat: string; series_definition: string; series_note: string;
  };
  cohesion: { innen: number; aussen: number; corr_innen: number | null; corr_aussen: number | null };
  bridge_partners: { partner: number; kanten: number }[];
  bridge_edges: { mine: string; mine_genus: string | null; other: string;
                  other_genus: string | null; other_cluster: number; corr: number }[];
  activity: { axis: string; window: string[]; peak: string | null; n_min: number;
              statement: string | null };
  note: { n: string | null; t: string | null };
  hub_tooltip: string;
  members: { id: string; genus: string | null; family: string | null;
             read_count_total: number | null; n_samples_present: number;
             peak_month: number | null; hub: boolean }[];
  taxa_breakdown: { genus: Record<string, number>; family: Record<string, number> };
  function_breakdown?: FunctionBreakdown;
  trait_run?: TraitRun;
  source_publication: SourcePublication;
  starred: boolean;
};

export type PeakEnvironment = {
  items: { key: string; label: string; unit: string | null; unit_note?: string | null;
           value: number }[];
  at_date: string | null;
  caveat: string;
};

export type EnvironmentProfile = {
  items: { key: string; label: string; unit: string | null; unit_note?: string | null;
           weighted_mean: number;
           p10: number; p90: number; n_samples_used: number; n_samples_present: number }[];
  method: string;
  caveat: string;
};

export type EnvVariable = {
  key: string;
  source_column: string;
  label: string;
  unit: string | null;
  unit_note: string | null;
  n: number;
  total: number;
  min: number;
  max: number;
  mean: number;
  points: { sample: string; date: string | null; value: number | null }[];
  monthly?: { month: number; label: string; mean: number; n: number }[];
};

export type Environment = {
  dataset_id: string;
  time_axis: "dates" | "ordinal";
  n_sample: number;
  variables: EnvVariable[];
  absent: { key: string; label: string; source_column: string }[];
  provenance: string;
  units_note: string;
  absent_reason: string;
};

async function get<T>(path: string): Promise<T> {
  const r = await F(`${BASE}${path}`);
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json() as Promise<T>;
}

export type ImportStatus = {
  job_id: string; status: "running" | "done" | "error"; stage: string;
  dataset_id: string; stages?: string[]; error?: string;
  started_at?: number; stage_started_at?: number; finished_at?: number;
  progress?: number; stage_detail?: string;
};

export const getImports = () =>
  get<{ jobs: ImportStatus[]; hinweis: string }>("/imports");

export type AgentModel = {
  name: string; size_gb: number | null; parameter_size?: string | null;
  supports_tools: boolean | null;
  remote?: boolean;
};
export type AgentStatus = {
  ok: boolean; url: string; model: string; configured_model?: string;
  models?: AgentModel[]; models_available?: string[];
  num_ctx?: number; error?: string; note?: string;
  remote?: { configured: boolean; models: string[] };
  local_error?: string;
};
export type AgentContext = { dataset_id?: string; asv_id?: string; cluster?: number | null };
export type AgentEvidence = {
  tool: string;
  arguments: Record<string, unknown>;
  provenance?: {
    cypher: string | { cypher: string; params?: Record<string, unknown> }[];
    n_results: number; retrieved_at: string; tool: string; truncated?: boolean;
  };
  error?: string;
};
export type AgentAnswer = {
  answer: string; evidence: AgentEvidence[]; model: string; steps: number; truncated?: boolean;
  ungrounded?: string[];
  grounding?: string;
  corrected?: boolean;
  own_key?: boolean;
};

export type OwnProvider = { base_url: string; model: string; key: string };

export type ToolHelp = {
  name: string; usage: string; summary: string;
  params: { name: string; type: string; required: boolean; description: string;
            enum?: string[] | null; default?: unknown }[];
};

export const getAgentStatus = () => get<AgentStatus>("/agent/status");
export const getAgentTools = () => get<{ n: number; tools: ToolHelp[] }>("/agent/tools");
export type ToolRun = {
  tool: string; arguments: Record<string, unknown>; result: Record<string, unknown>;
  provenance: AgentEvidence["provenance"] | null; error: string | null;
};
export const runTool = (name: string, args: Record<string, unknown>) =>
  F(`${BASE}/agent/tools/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ arguments: args }),
  }).then(async (r) => {
    if (!r.ok) {
      const detail = await r.json().catch(() => null);
      throw new Error(detail?.detail ?? `${name} → ${r.status}`);
    }
    return r.json() as Promise<ToolRun>;
  });
export type ChatTurn = { role: "user" | "assistant"; content: string };

export const askAgent = (question: string, ctx: AgentContext, model?: string,
                         own?: OwnProvider, history?: ChatTurn[]) =>
  F(`${BASE}/agent/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json",
               ...(own ? { "X-MANTA-Provider-Key": own.key } : {}) },
    body: JSON.stringify({ question, model: own ? own.model : model,
                           provider_url: own ? own.base_url : undefined,
                           dataset_id: ctx.dataset_id,
                           asv_id: ctx.asv_id, cluster: ctx.cluster ?? null,
                           history: history?.length ? history : undefined }),
  }).then(async (r) => {
    if (!r.ok) {
      const detail = await r.json().catch(() => null);
      throw new Error(detail?.detail ?? `agent → ${r.status}`);
    }
    return r.json() as Promise<AgentAnswer>;
  });

export const getDatasets = () => get<{ datasets: Dataset[] }>("/datasets");
export const startImport = (dataset_id: string, region?: string) =>
  F(`${BASE}/import`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataset_id, region }),
  }).then((r) => r.json() as Promise<{ job_id: string; dataset_id: string }>);
export const getImportStatus = (jobId: string) => get<ImportStatus>(`/import/${jobId}`);
export const uploadImport = (files: File[], dataset_id: string, region?: string,
  opts?: { station?: string; lat?: number; lon?: number; marker?: string;
           thresholds?: ThresholdInput }) => {
  const fd = new FormData();
  fd.append("dataset_id", dataset_id);
  if (region) fd.append("region", region);
  if (opts?.marker) fd.append("marker", opts.marker);
  if (opts?.station) fd.append("station", opts.station);
  if (opts?.lat != null) fd.append("lat", String(opts.lat));
  if (opts?.lon != null) fd.append("lon", String(opts.lon));
  if (opts?.thresholds) {
    Object.entries(opts.thresholds).forEach(([k, v]) => fd.append(k, String(v)));
  }
  files.forEach((f) => fd.append("files", f));
  return F(`${BASE}/import/upload`, { method: "POST", body: fd }).then(async (r) => {
    if (!r.ok) throw new Error(((await r.json().catch(() => null))?.detail) ?? `upload → ${r.status}`);
    return r.json() as Promise<{ job_id: string; dataset_id: string }>;
  });
};
export const deleteDataset = (id: string) =>
  F(`${BASE}/datasets/${id}`, { method: "DELETE" }).then((r) => r.json());
export const moveDataset = (id: string, lat: number, lon: number) =>
  F(`${BASE}/datasets/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lat, lon }),
  }).then(async (r) => {
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? `move → ${r.status}`);
    return r.json() as Promise<{ dataset_id: string; lat: number; lon: number }>;
  });

export const renameDataset = (id: string, region: string) =>
  F(`${BASE}/datasets/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ region }),
  }).then((r) => {
    if (!r.ok) throw new Error(`rename → ${r.status}`);
    return r.json() as Promise<{ dataset_id: string; region: string }>;
  });
export const getNetwork = (ds: string, edge: "con" | "ccm", marker?: string | null) =>
  get<Network>(`/datasets/${ds}/network?edge=${edge}${marker ? `&marker=${marker}` : ""}`);
export const getHubCriterion = (ds: string, measure: string, k: number) =>
  get<HubCriterion>(`/datasets/${ds}/hub-criterion?measure=${encodeURIComponent(measure)}&k=${k}`);
export const getAsv = (ds: string, id: string) => get<AsvDetail>(`/datasets/${ds}/asv/${id}`);
export const getSpectrum = (ds: string, id: string) =>
  get<{ dataset_id: string; asv_id: string; spectrum: Spectrum }>(
    `/datasets/${ds}/asv/${encodeURIComponent(id)}/spectrum`);
export type TaxonDetail = {
  dataset_id: string;
  asv_id: string;
  path: Record<string, string | null>;
  label: string;
  groupable: boolean;
  members: { id: string; cluster: number | null; read_count_total: number | null;
             n_samples_present: number }[];
  n_asv: number;
  clusters?: number[];
  reason: string | null;
  series: { sample: string; date: string | null; sum_count?: number; share?: number | null;
            n_members_present: number; sample_total?: number }[];
  series_absent_reason: string | null;
  value_declaration: { value_kind: string; unit: string; frame: string;
                       applies_to: string; note?: string };
  time_axis: "dates" | "ordinal";
  note: string;
};

export const getTaxon = (ds: string, asvId: string) =>
  get<TaxonDetail>(`/datasets/${ds}/taxon?asv=${encodeURIComponent(asvId)}`);

export const getEdge = (ds: string, source: string, target: string, type: "con" | "ccm") =>
  get<EdgeDetail>(`/datasets/${ds}/edge?source=${encodeURIComponent(source)}`
    + `&target=${encodeURIComponent(target)}&type=${type}`);
export type ModuleLabel = {
  louvain_label: number;
  name: string | null;
  color: string | null;
  display: string;
};

export const getModules = (ds: string) =>
  get<{ modules: ModuleLabel[] }>(`/datasets/${ds}/modules`);

export const setClusterLabel = (ds: string, label: number,
                                body: { name?: string; color?: string }) =>
  adminSend(`/datasets/${encodeURIComponent(ds)}/cluster/${label}/label`, "PUT", body);

export const getCluster = (ds: string, label: number) => get<ClusterDetail>(`/datasets/${ds}/cluster/${label}`);
export type ClusterTimeseries = {
  dataset_id: string;
  time_axis: "dates" | "ordinal";
  clusters: number[];
  samples: { sample: string; date: string | null; sample_total: number; in_modules: number;
             outside: number; values: Record<string, number> }[];
  value_declaration: { value_kind: string; unit: string; frame: string; applies_to: string };
  method: string;
  caveat: string;
  cluster_caveat: string;
};
export const getClusterTimeseries = (ds: string) =>
  get<ClusterTimeseries>(`/datasets/${ds}/cluster-timeseries`);
export const getCapabilities = (ds: string) => get<Capabilities>(`/datasets/${ds}/capabilities`);
export const getEnvironment = (ds: string) => get<Environment>(`/datasets/${ds}/environment`);

export type WheelCluster = {
  louvain_label: number;
  n_members: number;
  window: string[];
  window_months: number[];
  peak: string | null;
  peak_month: number | null;
  n_min: number;
  statement: string | null;
};
export type WheelEnvMonth = { month: number; mean: number | null; n: number };
export type WheelPair = {
  ca: number; cb: number; n_con: number; n_with_ccm: number; n_ccm_directions: number;
  mean_nmi: number | null;
};
export type Wheel = {
  dataset_id: string;
  time_axis: "dates" | "ordinal";
  months: string[];
  clusters: WheelCluster[];
  pairs: WheelPair[];
  environment: {
    variables: { key: string; label: string; unit: string; unit_note: string | null }[];
    monthly: Record<string, WheelEnvMonth[]>;
    units_note: string;
  } | null;
  absent_reason: string | null;
  source_publication: SourcePublication;
  years?: WheelYear[];
  year?: WheelYear | null;
};
export type WheelYear = { year: string; n: number; months_covered: number; note: string | null };
export const getWheel = (ds: string, year?: string | null) =>
  get<Wheel>(`/datasets/${ds}/wheel${year ? `?year=${encodeURIComponent(year)}` : ""}`);

export type ElaState = {
  state_id: string; energy: number; recurrence: number | null; n_active: number;
  barrier: number | null;
  majority_cluster: number | null;
  cluster_counts: Record<string, number>;
  active: { id: string; genus: string | null; cluster: number | null }[];
};
export type ElaObserved = {
  samples: { sample: string; date: string | null; energy: number; basin: string }[];
  method: string; reference: string; absent_reason: string | null;
};
export type ElaTree =
  | { state_id: string; energy?: never; children?: never }
  | { state_id?: never; energy: number; children: ElaTree[] };
export type Ela = {
  dataset_id: string;
  run: {
    ela_run_id: string; seed: number; ath: number; minoc: number; maxoc: number;
    nmax: number; rep: number; totalit: number; boot: number;
    n_species_model: number; tool: string; reference: string; model: string;
  } | null;
  states: ElaState[];
  tipping_points: { ss1: string; ss2: string; energy: number }[];
  disconnectivity: ElaTree | null;
  observed: ElaObserved | null;
  value_declaration: { value_kind: string; unit: string; frame: string; applies_to: string };
  caveats: string[];
  absent_reason: string | null;
};
export const getEla = (ds: string) => get<Ela>(`/datasets/${ds}/ela`);

export type Params = {
  dataset_id: string; thresholds: Thresholds; defaults: Record<string, number | string>;
  counts: { n_asv: number; n_sample: number };
  retrieved_at: string;
};
export const getParams = (ds: string) => get<Params>(`/datasets/${ds}/params`);

export type ThresholdInput = {
  con_tr: number; con_alpha: number; ccmn_tr: number;
  louvain_res: number; fft_coeffs: number; num_permutations: number; num_samples: number;
};
export type RecomputeAck = {
  job_id: string; dataset_id: string; run_id: string; thresholds: ThresholdInput;
  n_asv: number; estimated_minutes: number; warning: string;
};
export const recompute = (ds: string, t: ThresholdInput) =>
  F(`${BASE}/datasets/${ds}/recompute`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(t),
  }).then(async (r) => {
    if (!r.ok) throw new Error(((await r.json().catch(() => null))?.detail) ?? `recompute → ${r.status}`);
    return r.json() as Promise<RecomputeAck>;
  });

export const setAsvNote = (ds: string, id: string, note: string) =>
  F(`${BASE}/datasets/${ds}/asv/${id}/note`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note }),
  }).then((r) => r.json() as Promise<{ note: string; note_at: string }>);
export const setClusterNote = (ds: string, label: number, note: string) =>
  F(`${BASE}/datasets/${ds}/cluster/${label}/note`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note }),
  }).then((r) => r.json() as Promise<{ note: string; note_at: string }>);

export type FastqPreflight = {
  ok: boolean; rscript: boolean; cutadapt: boolean; dada2: boolean;
  dada2_version: string | null; error?: string; hinweis: string;
};
export const getFastqPreflight = () => get<FastqPreflight>("/import/fastq/preflight");

export type ImportEntry = "fastq" | "dada2" | "tables" | "otterout" | "recompute";
export type ImportTools = {
  tools: Record<"convert" | "otter" | "ingest", boolean>;
  entries: Record<ImportEntry, { ok: boolean; missing: string[] }>;
  hint: string;
};
export const getImportTools = () => get<ImportTools>("/import/tools");

export const uploadFastq = (
  fastq: File[], dataset_id: string, region: string,
  opts?: { metadata?: File | null; top_n?: number; ncores?: number; taxonomy_ref?: string;
           station?: string; lat?: number; lon?: number; marker?: string;
           thresholds?: ThresholdInput },
) => {
  const fd = new FormData();
  fd.append("dataset_id", dataset_id);
  fd.append("region", region);
  if (opts?.top_n) fd.append("top_n", String(opts.top_n));
  if (opts?.ncores) fd.append("ncores", String(opts.ncores));
  if (opts?.taxonomy_ref) fd.append("taxonomy_ref", opts.taxonomy_ref);
  if (opts?.marker) fd.append("marker", opts.marker);
  if (opts?.station) fd.append("station", opts.station);
  if (opts?.lat != null) fd.append("lat", String(opts.lat));
  if (opts?.lon != null) fd.append("lon", String(opts.lon));
  if (opts?.metadata) fd.append("metadata", opts.metadata);
  if (opts?.thresholds) {
    Object.entries(opts.thresholds).forEach(([k, v]) => fd.append(k, String(v)));
  }
  fastq.forEach((f) => fd.append("files", f));
  return F(`${BASE}/import/fastq`, { method: "POST", body: fd }).then(async (r) => {
    if (!r.ok) throw new Error(((await r.json().catch(() => null))?.detail) ?? `upload → ${r.status}`);
    return r.json() as Promise<{ job_id: string; dataset_id: string; n_samples: number; time_axis: string }>;
  });
};


export const getClusterAtSample = (ds: string, label: number, sample: string) =>
  F(`${BASE}/datasets/${ds}/cluster/${label}/at/${encodeURIComponent(sample)}`)
    .then((r) => r.json() as Promise<ClusterAtSample>);

export const getStarred = (ds: string) =>
  F(`${BASE}/datasets/${ds}/starred`).then((r) => r.json() as Promise<Starred>);

export const setAsvStar = (ds: string, id: string, starred: boolean) =>
  F(`${BASE}/datasets/${ds}/asv/${id}/star`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ starred }),
  }).then((r) => r.json() as Promise<{ starred: boolean; starred_at: string | null }>);

export const setClusterStar = (ds: string, label: number, starred: boolean) =>
  F(`${BASE}/datasets/${ds}/cluster/${label}/star`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ starred }),
  }).then((r) => r.json() as Promise<{ starred: boolean; starred_at: string | null }>);
