const BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";


export type ErrorKind = string;

export class ApiError extends Error {
  status: number | null;
  detail: string | null;
  kind: ErrorKind;
  constructor(message: string, status: number | null, detail: string | null, kind: ErrorKind) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.kind = kind;
  }
}

export class HttpError extends ApiError {}

const OFFLINE_TEXT = "The MANTA server did not answer — it may be restarting, or the connection dropped.";

const STATUS_TEXT: Record<number, string> = {
  400: "The server did not accept the request.",
  401: "You are not signed in, or your session has ended.",
  403: "Your account is not allowed to do this.",
  404: "Not found — it may have been deleted or renamed.",
  409: "This conflicts with something that is running right now.",
  413: "This is larger than the server accepts.",
  422: "The server did not accept the input.",
  429: "Too many requests in a short time.",
  500: "The server ran into an internal error.",
  502: "The server cannot be reached behind its proxy.",
  503: "The server cannot answer right now.",
  504: "The server took too long to answer.",
};

function kindOf(status: number): ErrorKind {
  if (status === 401) return "signed_out";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 400 || status === 422) return "invalid";
  if (status === 409) return "conflict";
  if (status === 413) return "too_large";
  if (status === 429) return "too_many";
  if (status === 500) return "server";
  if (status >= 502 && status <= 504) return "unavailable";
  return "http";
}

function detailOf(body: unknown): string | null {
  const d = (body as { detail?: unknown } | null)?.detail;
  if (typeof d === "string") return d.trim() || null;
  if (Array.isArray(d)) {
    const teile = d.map((x) => {
      const msg = typeof x?.msg === "string" ? x.msg : null;
      const loc = Array.isArray(x?.loc) ? x.loc[x.loc.length - 1] : null;
      return msg ? (loc != null && loc !== "body" ? `${loc}: ${msg}` : msg) : null;
    }).filter(Boolean);
    return teile.length ? teile.join("; ") : null;
  }
  return null;
}

export async function failFrom(r: Response): Promise<never> {
  const body = await r.json().catch(() => null);
  const detail = detailOf(body);
  const own = (body as { kind?: unknown } | null)?.kind;
  const kind = typeof own === "string" && own ? own : kindOf(r.status);
  throw new HttpError(detail ?? STATUS_TEXT[r.status] ?? `The server answered with HTTP ${r.status}.`,
                      r.status, detail, kind);
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message || String(e);
  return String(e);
}

const TODO: Record<string, string> = {
  offline: "Check that the MANTA server is running, then try again.",
  signed_out: "Sign in again, then try again.",
  forbidden: "Ask an administrator if you need this.",
  not_found: "Go back to the map to see what is there now.",
  invalid: "Check the input and send it again.",
  conflict: "Wait until the running job has finished, then try again.",
  too_large: "Use a smaller file.",
  too_many: "Wait a moment, then try again.",
  server: "Try again; if it keeps failing, the server log names the cause.",
  unavailable: "Try again in a moment.",
  credit: "Top up that account, or switch to a local model.",
  auth: "Check the key and the address of the provider.",
  rate_limit: "Wait a moment, then try again.",
  timeout: "Try again; a smaller model answers faster.",
  unreachable: "Check that the model service is running, then try again.",
  model_missing: "Pick another model in the menu.",
  provider: "Try again later, or switch to a local model.",
};

export type ErrorDescription = { why: string; todo: string; kind: ErrorKind; status: number | null };

export function describeError(e: unknown): ErrorDescription {
  const a = e instanceof ApiError ? e : null;
  const kind = a?.kind ?? "unknown";
  return { why: errorText(e), todo: TODO[kind] ?? "Try again.", kind, status: a?.status ?? null };
}

export const SESSION_EVENT = "manta-session-changed";
export type SessionChange = { before: Me; after: Me };

let bekannt: Me | null = null;
let pruefung: Promise<void> | null = null;
let zuletztGeprueft = 0;
let kanal: BroadcastChannel | null = null;

export function checkSession(): Promise<void> {
  if (pruefung) return pruefung;
  if (!bekannt) return Promise.resolve();
  const vorher = bekannt;
  pruefung = fetch(`${BASE}/auth/me`, { credentials: "include" })
    .then((r) => (r.ok ? (r.json() as Promise<Me>) : null))
    .then((nachher) => {
      if (!nachher || typeof nachher.role !== "string") return;
      bekannt = nachher;
      if (nachher.username !== vorher.username || nachher.role !== vorher.role) {
        window.dispatchEvent(new CustomEvent<SessionChange>(SESSION_EVENT,
          { detail: { before: vorher, after: nachher } }));
      }
    })
    .catch(() => undefined)
    .finally(() => { pruefung = null; zuletztGeprueft = Date.now(); });
  return pruefung;
}

function ablehnungGesehen(url: string) {
  if (url.includes("/auth/")) return;
  if (Date.now() - zuletztGeprueft < 3000) return;
  void checkSession();
}

export function watchSession(): () => void {
  const sichtbar = () => { if (document.visibilityState === "visible") void checkSession(); };
  document.addEventListener("visibilitychange", sichtbar);
  try { kanal ??= new BroadcastChannel("manta-auth"); } catch { kanal = null; }
  const signal = () => { void checkSession(); };
  kanal?.addEventListener("message", signal);
  return () => {
    document.removeEventListener("visibilitychange", sichtbar);
    kanal?.removeEventListener("message", signal);
  };
}

export const currentUsername = (): string | null => bekannt?.username ?? null;

function anmeldungGeaendert() {
  try { (kanal ??= new BroadcastChannel("manta-auth")).postMessage("changed"); } catch { }
}

const F = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
  let r: Response;
  try {
    r = await fetch(input, { credentials: "include", ...init });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new HttpError(OFFLINE_TEXT, null, null, "offline");
  }
  if (r.status === 401 || r.status === 403 || r.status === 404) ablehnungGesehen(String(input));
  return r;
};

export async function okJson<T>(r: Response): Promise<T> {
  if (!r.ok) return failFrom(r);
  return r.json() as Promise<T>;
}

export type Me = { username: string | null; role: string; can_see_internal: boolean };

export const getMe = (): Promise<Me> =>
  F(`${BASE}/auth/me`).then(okJson<Me>).then((m) => { bekannt = m; return m; });

export async function login(username: string, password: string): Promise<Me> {
  const r = await F(`${BASE}/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) {
    const detail = (await r.json().catch(() => ({}))).detail;
    if (typeof detail === "string" && detail) throw new Error(detail);
    throw new Error(r.status === 429 ? "Too many attempts — try again later." : `HTTP ${r.status}`);
  }
  anmeldungGeaendert();
  return getMe();
}

export const logout = (): Promise<void> => {
  bekannt = null;
  return F(`${BASE}/auth/logout`, { method: "POST" }).then(() => { anmeldungGeaendert(); });
};

export type AdminUser = {
  username: string; role: string; created_at: number; disabled: number; sessions: number;
};

type AdminUsersAnswer = { users: AdminUser[]; roles: string[]; visibilities?: string[];
                          min_password_len?: number };
export const adminUsers = (): Promise<AdminUsersAnswer> =>
  F(`${BASE}/admin/users`).then(okJson<AdminUsersAnswer>);

async function adminSend(path: string, method: string, body?: unknown) {
  const r = await F(`${BASE}${path}`, {
    method, headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) return failFrom(r);
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
  started_at?: number; stage_detail?: string; notes?: string[];
};
export const importJobs = (): Promise<{ jobs: ImportJob[]; hinweis: string }> =>
  F(`${BASE}/imports`).then(okJson<{ jobs: ImportJob[]; hinweis: string }>);

export type AuditEntry = {
  at: number; who: string; what: string; detail: string;
};
export const auditLog = (): Promise<{ entries: AuditEntry[] }> =>
  F(`${BASE}/admin/audit`).then(okJson<{ entries: AuditEntry[] }>);

export type AdminStatus = {
  ok: boolean;
  checks: Record<"database" | "mail" | "assistant" | "analysis_tools",
                 { ok: boolean; detail: string }>;
};
export const adminStatus = (): Promise<AdminStatus> =>
  F(`${BASE}/admin/status`).then(okJson<AdminStatus>);

export type MailSettingsView = {
  values: {
    smtp_host: string; smtp_port: string; smtp_tls: string; smtp_user: string;
    mail_from: string; request_mailto: string; public_url: string;
    ollama_model: string; grounding: string; openai_base_url: string;
    openai_models: string; openai_timeout: string;
    provider_hosts?: string;
    admins_read_transcripts?: string;
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
  "openai_models" | "openai_timeout" | "provider_hosts" | "admins_read_transcripts", string>>;

export const agentSettings = (): Promise<MailSettingsView> =>
  F(`${BASE}/admin/settings/agent`).then(okJson<MailSettingsView>);
export const saveAgentSettings = (patch: AgentSettingsPatch) =>
  adminSend("/admin/settings/agent", "PUT", patch) as Promise<MailSettingsView>;
export const resetAgentSettings = (keys: string[]) =>
  adminSend("/admin/settings/agent/reset", "POST", { keys }) as Promise<MailSettingsView>;

export const mailSettings = (): Promise<MailSettingsView> =>
  F(`${BASE}/admin/settings/mail`).then(okJson<MailSettingsView>);
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
  F(`${BASE}/signup/options`).then(okJson<SignupOptions>);

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
  if (!r.ok) return failFrom(r);
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
  derived?: DerivedInfo | null;
};

export type DerivedInfo = {
  from: string | null; from_available: boolean; at: string | null;
  params: { con_tr: number | null; con_alpha: number | null; num_permutations: number | null;
            n_asv: number | null } | null;
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
  rel_abundance?: number | null;
  n_samples_present: number;
  peak_month: number | null;
  starred?: boolean;
  criterion2?: Criterion2Node | null;
};

export type Criterion2Node = {
  module: number | null; module_size: number | null; closeness: number | null;
  p: number | null; q: number | null; passes: boolean; testable: boolean;
  reason: string | null; reason_text: string | null;
};

export type Criterion2Texts = {
  label: string;
  title: string;
  mark: string;
  glow: string;
  method: string;
  formula: string;
  not_keystone: string;
  selection_note: string;
  source: string; source_doi: string; source_location: string;
};

export type Criterion2Summary = Criterion2Texts & {
  alpha: number; n_network: number; n_modules: number; n_testable: number; n_pass: number;
  n_not_testable: number;
  not_testable: { reason: string; reason_text: string; n_asv: number; n_modules: number;
                  modules: number[] }[];
  ids: string[];
  statement: string;
};

export type Criterion2Asv = Criterion2Node & Criterion2Texts & {
  verdict: string;
  module_mean_closeness?: number | null;
};

export type Criterion2Module = Criterion2Texts & {
  module: number; module_size: number; testable: boolean; reason: string | null;
  reason_text: string | null; mean_closeness: number | null; sd_closeness: number | null;
  n_pass: number; verdict: string;
  members_meeting: { asv_id: string; closeness: number | null; p: number | null;
                     q: number | null }[];
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
  n_samples?: number;
  partition: Partition;
  marker: string | null;
  edge: "con" | "ccm";
  directed: boolean;
  thresholds: Thresholds;
  layers: Layers;
  criterion2?: Criterion2Summary;
  edge_width_legend: { con: string; ccm: string; rejected: string };
  edge_width_scale?: { con: [number, number]; ccm: [number, number]; rejected: [number, number] };
  nodes: NetNode[];
  edges: NetEdge[];
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
  caveat?: string | null;
  members: { id: string; genus: string | null; count: number;
             share_of_sample: number | null; share_of_cluster: number | null }[];
};

export type SampleList = {
  dataset_id: string; time_axis: "dates" | "ordinal";
  samples: { sample: string; date: string | null }[];
};

export type SampleDetail = {
  sample: string; date: string | null; sample_total: number; quantity: Quantity;
  asvs: { id: string; cluster: number | null; count: number; share: number | null;
          rank: number; label: string; taxa: string[] }[];
  modules: { cluster: number; count: number; n_asv: number; share: number | null }[];
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
  direction?: "out" | "in" | "both" | null;
};

export type NetworkScope = {
  recorded: boolean;
  n_in_run: number | null;
  n_dataset: number;
  subset: boolean | null;
  run_id?: string | null;
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
  in_network_run?: boolean | null;
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
  environment_profile: EnvironmentProfile;
  criterion2?: Criterion2Asv;
  neighbors: { con: Neighbor[]; ccm: Neighbor[] };
  funktion: string;
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
  ccm_p_resolution?: { denominator: number | null; exact: boolean; short: string; statement: string };
  source_publication: SourcePublication;
};

export type ClusterDetail = {
  dataset_id: string;
  louvain_label: number;
  frequency: Frequency;
  environment_profile: EnvironmentProfile & { series_definition: string; series_note: string };
  cohesion: { innen: number; aussen: number; corr_innen: number | null; corr_aussen: number | null };
  bridge_partners: {
    partner: number; kanten: number;
    gerichtet_raus?: number; gerichtet_rein?: number;
  }[];
  bridge_edges: { mine: string; mine_genus: string | null; other: string;
                  other_genus: string | null; other_cluster: number; corr: number }[];
  activity: { axis: string; window: string[]; peak: string | null; n_min: number;
              statement: string | null };
  note: { n: string | null; t: string | null };
  criterion2?: Criterion2Module;
  members: { id: string; genus: string | null; family: string | null;
             read_count_total: number | null; n_samples_present: number;
             peak_month: number | null; criterion2?: Criterion2Node | null }[];
  taxa_breakdown: { genus: Record<string, number>; family: Record<string, number> };
  source_publication: SourcePublication;
  starred: boolean;
};

export type EnvironmentProfile = {
  items: { key: string; label: string; unit: string | null; unit_note?: string | null;
           weighted_mean: number;
           weighted_sd?: number | null;
           p10: number; p90: number; n_samples_used: number; n_samples_present: number;
           p25?: number | null; median?: number | null; p75?: number | null;
           dataset_min?: number | null; dataset_max?: number | null }[];
  method: string;
  caveat: string;
};

export type EnvVariable = {
  key: string;
  source_column: string;
  label: string;
  unit: string | null;
  unit_note: string | null;
  scale?: "ratio" | "interval";
  n: number;
  total: number;
  min: number;
  max: number;
  mean: number;
  points: { sample: string; date: string | null; value: number | null }[];
  monthly?: { month: number; label: string; mean: number; n: number }[];
  monthly_by_year?: Record<string, { month: number; label: string; mean: number; n: number }[]>;
};

export type SamplerPosition = {
  n_within: number; n_below: number; n_unknown: number; n_total: number;
  statement: string; note: string;
  samples: { sample: string; date: string | null; depth: number; mld: number | null;
             position: "within" | "below" | "unknown" }[];
};
export type Environment = {
  dataset_id: string;
  time_axis: "dates" | "ordinal";
  n_sample: number;
  variables: EnvVariable[];
  absent: { key: string; label: string; source_column: string }[];
  sampler: SamplerPosition | null;
  provenance: string;
  units_note: string;
  absent_reason: string;
};

async function get<T>(path: string): Promise<T> {
  return okJson<T>(await F(`${BASE}${path}`));
}

export type ImportStatus = {
  job_id: string; status: "running" | "done" | "error"; stage: string;
  dataset_id: string; stages?: string[]; error?: string;
  started_at?: number; stage_started_at?: number; finished_at?: number;
  progress?: number; stage_detail?: string;
  kind?: "import" | "recompute"; source_dataset_id?: string; label?: string;
  estimate?: OtterEstimate | null;
  notes?: string[];
};

export type OtterEstimate = {
  n_asv: number; n_samples: number; minutes_low: number; minutes_high: number;
  memory_gb: number; memory_budget_gb: number | null; machine_memory_gb: number | null;
  fits: boolean; extrapolated: boolean; basis: string; refusal: string | null;
};

export const fmtMinutes = (e: Pick<OtterEstimate, "minutes_low" | "minutes_high">) =>
  e.minutes_high <= 1 ? "about a minute"
    : `${e.minutes_low}–${e.minutes_high} min`;

export const pastEstimate = (e: Pick<OtterEstimate, "minutes_high"> | null | undefined,
                             startedAt: number | undefined, nowSeconds: number) =>
  !!e && !!startedAt && nowSeconds - startedAt > e.minutes_high * 60;
export const STILL_RUNNING = "still running — this can take longer";

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
  setup_hint?: string;
  remote?: { configured: boolean; models: string[] };
  local_error?: string;
  limits?: { question_chars: number; history_turns: number };
};
export type AgentContext = {
  dataset_id?: string; asv_id?: string; cluster?: number | null;
  concept?: string; question_kind?: string;
};
export type Finding = { id: string; art: "befund" | "vorbehalt"; text: string;
                        werte: number[]; namen: string[] };
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
  conversation_id?: string | null;
  turn_id?: number | null;
  admins_can_read?: boolean;
  question_kind?: string | null;
  findings?: Finding[];
  check?: "cited" | "listed" | "numbers" | "off" | "failed" | "none";
};

export type OwnProvider = { base_url: string; model: string; key: string };

export type ToolHelp = {
  name: string; usage: string; summary: string;
  question: string | null; needs: "none" | "dataset" | "asv" | "cluster" | null;
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
    if (!r.ok) return failFrom(r);
    return r.json() as Promise<ToolRun>;
  });
export type ChatTurn = {
  role: "user" | "assistant"; content: string;
  tools?: { name: string; arguments: Record<string, unknown> }[];
};

export class AgentAskError extends ApiError {
  turnId: number | null;
  conversationId: string | null;
  constructor(e: ApiError, turnId?: number | null, conversationId?: string | null) {
    super(e.message, e.status, e.detail, e.kind);
    this.name = "AgentAskError";
    this.turnId = turnId ?? null;
    this.conversationId = conversationId ?? null;
  }
}

export const askAgent = (question: string, ctx: AgentContext, model?: string,
                         own?: OwnProvider, history?: ChatTurn[], conversationId?: string | null) =>
  F(`${BASE}/agent/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json",
               ...(own ? { "X-MANTA-Provider-Key": own.key } : {}) },
    body: JSON.stringify({ question, model: own ? own.model : model,
                           provider_url: own ? own.base_url : undefined,
                           dataset_id: ctx.dataset_id,
                           asv_id: ctx.asv_id, cluster: ctx.cluster ?? null,
                           concept: ctx.concept, question_kind: ctx.question_kind,
                           history: history?.length ? history : undefined,
                           conversation_id: conversationId ?? undefined }),
  }).then(async (r) => {
    if (!r.ok) {
      const body = await r.clone().json().catch(() => null);
      return failFrom(r).catch((e: ApiError) => {
        throw new AgentAskError(e, body?.turn_id, body?.conversation_id);
      });
    }
    return r.json() as Promise<AgentAnswer>;
  });


export type ConversationSummary = {
  id: string; username: string; dataset_id: string; title: string;
  created_at: number; updated_at: number; n_turns: number;
  earlier_account?: boolean;
};
export type StoredTurn = {
  id: number; seq: number; asked_at: number; finished_at: number;
  question: string; answer: string;
  status: "answered" | "step_limit" | "error"; error: string;
  model: string; provider: "local" | "operator" | "own" | ""; provider_host: string;
  grounding: string; ungrounded: string[]; corrected: boolean; own_key: boolean;
  steps: number | null; evidence: AgentEvidence[];
  check?: AgentAnswer["check"] | null; findings?: Finding[];
};
export type TranscriptEvent = { kind: string; at: number; step?: number } & Record<string, unknown>;
export type TurnRecord = StoredTurn & {
  conversation_id: string;
  conversation: { id: string; username: string; dataset_id: string; title: string };
  record: {
    context?: { dataset_id?: string | null; asv_id?: string | null; cluster?: number | null;
                concept?: string | null };
    request?: { model_requested?: string | null; history_turns?: number; own_key?: boolean };
    provider?: { kind?: string; host?: string };
    grounding?: TranscriptEvent | null;
    events: TranscriptEvent[];
    stored_truncated?: boolean;
  };
};
export type ConversationDetail = {
  conversation: Omit<ConversationSummary, "earlier_account">;
  turns: StoredTurn[];
  own: boolean;
};

export const getConversations = (opts: { q?: string; datasetId?: string } = {}) => {
  const p = new URLSearchParams();
  if (opts.q) p.set("q", opts.q);
  if (opts.datasetId != null) p.set("dataset_id", opts.datasetId);
  const qs = p.toString();
  return F(`${BASE}/agent/conversations${qs ? `?${qs}` : ""}`)
    .then(okJson<{ admins_can_read: boolean; conversations: ConversationSummary[] }>);
};
export const getConversation = (id: string) =>
  F(`${BASE}/agent/conversations/${encodeURIComponent(id)}`).then(okJson<ConversationDetail>);
export const getTurnRecord = (turnId: number) =>
  F(`${BASE}/agent/turns/${turnId}`).then(okJson<TurnRecord>);
export const adminTranscripts = (opts: { q?: string; user?: string } = {}) => {
  const p = new URLSearchParams();
  if (opts.q) p.set("q", opts.q);
  if (opts.user) p.set("user", opts.user);
  const qs = p.toString();
  return F(`${BASE}/admin/transcripts${qs ? `?${qs}` : ""}`)
    .then(okJson<{ enabled: boolean; conversations: ConversationSummary[] }>);
};

export const getDatasets = () => get<{ datasets: Dataset[] }>("/datasets");
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
  F(`${BASE}/datasets/${id}`, { method: "DELETE" })
    .then(okJson<{ deleted: string; kept_derived?: string[] }>);
export const moveDataset = (id: string, lat: number, lon: number, moveStation = false) =>
  F(`${BASE}/datasets/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(moveStation ? { lat, lon, move_station: true } : { lat, lon }),
  }).then(async (r) => {
    if (!r.ok) {
      const detail = (await r.json().catch(() => ({}))).detail;
      const satz = typeof detail === "string" ? detail : `move → ${r.status}`;
      if (r.status === 409 && satz.includes("move_station")) throw new SharedStationError(satz);
      throw new Error(satz);
    }
    return r.json() as Promise<{ dataset_id: string; lat: number; lon: number;
                                 moved_with_station?: string[] }>;
  });

export class SharedStationError extends Error {
  get reason(): string {
    return this.message.replace(/\s*Send the same request[\s\S]*$/, "");
  }
}

export const renameDataset = (id: string, region: string) =>
  F(`${BASE}/datasets/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ region }),
  }).then((r) => {
    if (!r.ok) return failFrom(r);
    return r.json() as Promise<{ dataset_id: string; region: string }>;
  });
export const getNetwork = (ds: string, edge: "con" | "ccm", marker?: string | null) =>
  get<Network>(`/datasets/${ds}/network?edge=${edge}${marker ? `&marker=${marker}` : ""}`);
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
export const getCapabilities = (ds: string) => get<Capabilities>(`/datasets/${ds}/capabilities`);
export const getEnvironment = (ds: string) => get<Environment>(`/datasets/${ds}/environment`);

export type LightBand = {
  kind: "polar_night" | "polar_day";
  start: string; end: string;
  clipped_start: boolean; clipped_end: boolean;
};
export type Light = {
  available: boolean;
  absent_reason: string | null;
  station: { station_id: string; lat: number; lon: number } | null;
  from: string | null; to: string | null;
  bands: LightBand[];
  legend: string; method: string; reference: string; caveat: string;
  per_sample: { sample: string; date: string; day_length_h: number; polar_night: boolean;
                polar_day: boolean }[];
  year: LightYear | null;
};
export const getLight = (ds: string) => get<Light>(`/datasets/${ds}/light`);

export type Concept = {
  key: string; label: string; kind: "klasse" | "beziehung" | "kennzahl" | "umweltgroesse";
  definition: string; source: string | null; caveats: string[];
  formula: string | null; unit: string | null; inputs: string[]; tools: string[];
  note: string | null;
  standard_term: { curie: string | null; uri: string; match: string; label?: string } | null;
};
export type Concepts = {
  concepts_version: string; kinds: Concept["kind"][]; kind: string | null;
  n: number; concepts: Concept[]; note?: string;
};
export const getConcepts = () => get<Concepts>("/concepts");

export type Applicability = {
  dataset_id: string;
  tools: Record<string, {
    applicable: "yes" | "no" | "subject";
    reason: string | null; requires: string[]; subject_condition: string | null;
  }>;
  conditions: Record<string, { met: boolean; reason: string | null }>;
  time_structure: {
    time_axis: string; n_samples: number; first: string | null; last: string | null;
    n_distinct_days?: number; median_gap_days: number | null; largest_gap_days: number | null;
    years: { year: string; n_samples: number }[]; sample_dates: string[];
    note: string | null;
  };
  states: Record<string, string>;
};
export const getApplicability = (ds: string) =>
  get<Applicability>(`/datasets/${ds}/applicability`);

export type ChainLink = {
  step: string; label: string; present: boolean; detail: string | null;
  params: Record<string, unknown>;
};
export type ProvenanceChain = {
  dataset_id: string; note: string; n_recorded: number; n_links: number; chain: ChainLink[];
};
export const getProvenanceChain = (ds: string) =>
  get<ProvenanceChain>(`/datasets/${ds}/provenance-chain`);

export type WheelCluster = {
  louvain_label: number;
  n_members: number;
  window: string[];
  window_months: number[];
  peak: string | null;
  peak_month: number | null;
  by_month?: { month: number; mean: number; n: number }[];
  n_min: number;
  statement: string | null;
};
export type WheelEnvMonth = { month: number; mean: number | null; n: number };
export type Wheel = {
  dataset_id: string;
  time_axis: "dates" | "ordinal";
  months: string[];
  clusters: WheelCluster[];
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
export type LightYear = {
  available: boolean; absent_reason?: string; lat: number | null; reference_year?: number;
  bands: { kind: "polar_night" | "polar_day"; start_doy: number; end_doy: number }[];
  shortest_day_doy: number | null; sun_return_doy?: number | null; legend?: string;
  day_length_doy?: number[];
  solar_marks?: SeasonMark[];
};

export type SeasonMark = { doy: number; label: string };
export type Seasons = {
  dataset_id: string; available: boolean; absent_reason: string | null;
  astronomical: SeasonMark[]; light: SeasonMark[]; water: SeasonMark[];
  water_note: string; method: string; caveat: string;
};
export const getSeasons = (ds: string) => get<Seasons>(`/datasets/${ds}/seasons`);

export const getWheel = (ds: string, year?: string | null) =>
  get<Wheel>(`/datasets/${ds}/wheel${year ? `?year=${encodeURIComponent(year)}` : ""}`);


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
export const PRODUCTION_THRESHOLDS: ThresholdInput = {
  con_tr: 0.7, con_alpha: 0.05, ccmn_tr: 0, louvain_res: 1,
  fft_coeffs: 14, num_permutations: 999, num_samples: 10,
};
export type RecomputeAck = {
  job_id: string; dataset_id: string; new_dataset_id: string; new_label: string; run_id: string;
  thresholds: ThresholdInput; n_asv: number; n_samples: number; estimate: OtterEstimate;
  note: string;
};
export type RecomputePreview = {
  dataset_id: string; new_dataset_id: string; new_label: string; estimate: OtterEstimate;
};
export const getRecomputeEstimate = (ds: string, num_permutations: number, num_samples: number) =>
  get<RecomputePreview>(`/datasets/${ds}/recompute/estimate?num_permutations=${num_permutations}`
    + `&num_samples=${num_samples}`);
export const recompute = (ds: string, t: ThresholdInput) =>
  F(`${BASE}/datasets/${ds}/recompute`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(t),
  }).then(async (r) => {
    if (!r.ok) throw new Error(((await r.json().catch(() => null))?.detail) ?? `recompute → ${r.status}`);
    return r.json() as Promise<RecomputeAck>;
  });

export const setAsvNote = (ds: string, id: string, note: string, opts?: { keepalive?: boolean }) =>
  F(`${BASE}/datasets/${ds}/asv/${id}/note`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note }),
    keepalive: opts?.keepalive,
  }).then(okJson<{ note: string; note_at: string }>);
export const setClusterNote = (ds: string, label: number, note: string,
                               opts?: { keepalive?: boolean }) =>
  F(`${BASE}/datasets/${ds}/cluster/${label}/note`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note }),
    keepalive: opts?.keepalive,
  }).then(okJson<{ note: string; note_at: string }>);

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
  limits?: { ncores_max?: number };
};
export const getImportTools = () => get<ImportTools>("/import/tools");

export const uploadFastq = (
  fastq: File[], dataset_id: string, region: string,
  opts?: { metadata?: File | null; ncores?: number; taxonomy_ref?: string;
           station?: string; lat?: number; lon?: number; marker?: string;
           thresholds?: ThresholdInput },
) => {
  const fd = new FormData();
  fd.append("dataset_id", dataset_id);
  fd.append("region", region);
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
    .then(okJson<ClusterAtSample>);

export const getAsvList = (ds: string) =>
  get<{ asvs: { id: string; cluster: number | null; label: string }[] }>(`/datasets/${ds}/asvs`);
export const getSamples = (ds: string) => get<SampleList>(`/datasets/${ds}/samples`);
export const getSample = (ds: string, sample: string) =>
  get<SampleDetail>(`/datasets/${ds}/sample/${encodeURIComponent(sample)}`);

export const getStarred = (ds: string) =>
  F(`${BASE}/datasets/${ds}/starred`).then(okJson<Starred>);

export const setAsvStar = (ds: string, id: string, starred: boolean) =>
  F(`${BASE}/datasets/${ds}/asv/${id}/star`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ starred }),
  }).then(okJson<{ starred: boolean; starred_at: string | null }>);

export const setClusterStar = (ds: string, label: number, starred: boolean) =>
  F(`${BASE}/datasets/${ds}/cluster/${label}/star`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ starred }),
  }).then(okJson<{ starred: boolean; starred_at: string | null }>);

export type SearchHit = {
  id: string; label: string; genus: string | null; cluster: number | null;
  n_samples_present: number;
  id_match: boolean; matched_ranks: string[];
};
export type SearchTaxon = { rank: string; value: string; n_asv: number; asvs: SearchHit[] };
export type SearchResult = {
  dataset_id: string; query: string; n_samples: number;
  taxon_searched: boolean; min_taxon_chars: number; limit: number;
  in_network: { n_asv: number; asvs: SearchHit[] };
  outside_network: { n_asv: number; asvs: SearchHit[]; n_taxa: number; taxa: SearchTaxon[] };
  sentence: string | null;
};
export const searchDataset = (ds: string, q: string, limit = 25, signal?: AbortSignal) =>
  F(`${BASE}/datasets/${encodeURIComponent(ds)}/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    { signal }).then(okJson<SearchResult>);
