import { useEffect, useState } from "react";
import { getDatasets, getMe, logout, type Dataset, type Me } from "./api";
import LoginScreen from "./components/LoginScreen";
import AdminPanel from "./components/AdminPanel";
import MapView from "./components/MapView";
import ImportTray from "./components/ImportTray";
import NetworkView from "./components/NetworkView";
import AsvDrawer from "./components/AsvDrawer";
import EdgeDrawer from "./components/EdgeDrawer";
import EnvironmentPanel from "./components/EnvironmentPanel";
import StarredPanel from "./components/StarredPanel";
import WheelPanel from "./components/WheelPanel";
import ElaPanel from "./components/ElaPanel";
import ComparePanel from "./components/ComparePanel";
import TaxonPanel from "./components/TaxonPanel";
import AgentChat from "./components/AgentChat";
import AssistantCharacter from "./components/AssistantCharacter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ModulesProvider } from "./modules";
import PanelFrame from "./components/PanelFrame";
import ThemeSwitch, { type Theme } from "./components/ThemeSwitch";

export type EdgeRef = { source: string; target: string; type: "con" | "ccm" };

type RightPanel =
  | { kind: "asv"; id: string }
  | { kind: "edge"; edge: EdgeRef }
  | { kind: "environment" }
  | { kind: "starred" }
  | { kind: "taxon"; asvId: string }
  | { kind: "wheel" }
  | { kind: "ela" }
  | { kind: "compare"; seed?: string };

const HEADER_BTN = "text-sm rounded px-2 py-0.5 border";

const PANEL_WIDTH: Record<string, number> = { asv: 560, edge: 560, environment: 480, starred: 480, wheel: 520, ela: 560, compare: 560, taxon: 520, agent: 460 };

export default function App() {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [selected, setSelected] = useState<Dataset | null>(null);
  const [offen, setOffen] = useState<RightPanel[]>([]);
  const setRight = (p: RightPanel | null) => setOffen((cur) => {
    if (p == null) return [];
    const ohne = cur.filter((x) => x.kind !== p.kind);
    return [...ohne, p];
  });
  const schliesse = (kind: RightPanel["kind"]) =>
    setOffen((cur) => cur.filter((x) => x.kind !== kind));
  const istOffen = (kind: RightPanel["kind"]) => offen.some((x) => x.kind === kind);
  const finde = <K extends RightPanel["kind"]>(kind: K) =>
    offen.find((x) => x.kind === kind) as Extract<RightPanel, { kind: K }> | undefined;
  const [error, setError] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [theme, setTheme] = useState<Theme>(() => {
    try { return localStorage.getItem("manta-theme") === "light" ? "light" : "dark"; }
    catch { return "dark"; }
  });
  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
    try { localStorage.setItem("manta-theme", theme); } catch { }
  }, [theme]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [asGuest, setAsGuest] = useState(() => {
    try { return sessionStorage.getItem("manta-as-guest") === "1"; } catch { return false; }
  });
  const [adminOpen, setAdminOpen] = useState(false);
  const [focusRequest, setFocusRequest] = useState<number | null>(() => {
    const raw = new URLSearchParams(window.location.search).get("request");
    const id = raw ? Number(raw) : NaN;
    return Number.isInteger(id) && id > 0 ? id : null;
  });
  useEffect(() => {
    if (focusRequest === null) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("request");
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
  }, [focusRequest]);
  const [starredCluster, setStarredCluster] = useState<{ label: number; tick: number } | null>(null);
  const wishCluster = (l: number) =>
    setStarredCluster((p) => ({ label: l, tick: (p?.tick ?? 0) + 1 }));
  const openAsv = (id: string) => setRight({ kind: "asv", id });
  const openEdge = (edge: EdgeRef) => setRight({ kind: "edge", edge });
  const closeRight = () => setRight(null);

  const selectDataset = (d: Dataset | null) => {
    setSelected(d);
    const u = new URL(window.location.href);
    if (d) u.searchParams.set("ds", d.dataset_id);
    else { u.searchParams.delete("ds"); u.searchParams.delete("f"); }
    window.history.replaceState(null, "", u);
  };
  const [dsRestored, setDsRestored] = useState(false);
  useEffect(() => {
    if (dsRestored || selected || datasets.length === 0) return;
    setDsRestored(true);
    const want = new URLSearchParams(window.location.search).get("ds");
    if (!want) return;
    const d = datasets.find((x) => x.dataset_id === want);
    if (d) setSelected(d);
    else selectDataset(null);
  }, [datasets, dsRestored, selected]);

  const asvId = finde("asv")?.id;

  const refresh = () =>
    getDatasets().then((r) => { setDatasets(r.datasets); setError(null); })
                 .catch((e) => setError(String(e)));

  const [authError, setAuthError] = useState<string | null>(null);
  useEffect(() => {
    getMe().then((m) => { setMe(m); setAuthError(null); })
           .catch((e) => setAuthError(String(e?.message ?? e)));
  }, []);
  useEffect(() => { if (me) refresh(); }, [me]);

  const enterAsGuest = () => {
    try { sessionStorage.setItem("manta-as-guest", "1"); } catch { }
    setAsGuest(true);
  };
  const signOut = async () => {
    await logout();
    try { sessionStorage.removeItem("manta-as-guest"); } catch { }
    setAsGuest(false);
    selectDataset(null);
    setMe(await getMe());
  };

  if (authError) {
    return (
      <div className="fixed inset-0 grid place-items-center bg-slate-900 p-6">
        <div data-testid="auth-unreachable"
             className="max-w-md rounded border border-red-800 bg-red-950/40 p-4 text-sm text-red-200">
          <p className="font-medium">The server is not reachable.</p>
          <p className="mt-1 text-red-300/80">{authError}</p>
          <p className="mt-2 text-xs text-red-300/60">
            MANTA keeps its data in a backend; without it there is nothing to show. Reload once it
            is back.
          </p>
        </div>
      </div>
    );
  }
  if (me === null) return null;
  if (me.role === "guest" && !asGuest) {
    return <LoginScreen onDone={(m) => { setMe(m); setSelected(null); }} onGuest={enterAsGuest} />;
  }

  return (
    <ModulesProvider datasetId={selected?.dataset_id ?? null}>
    <div className="h-full flex flex-col">
      <header className="relative z-40 px-4 py-2 border-b border-slate-700 flex items-center gap-3">
        <span className="text-cyan-300 font-semibold tracking-wide">MANTA</span>
        <span className="text-slate-400 text-sm">
          Marine Amplicon Network Time-series Analysis
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button data-testid="settings-open" onClick={() => setSettingsOpen((v) => !v)}
                  className={`${HEADER_BTN} ${settingsOpen
                    ? "text-cyan-300 border-cyan-700"
                    : "text-slate-300 hover:text-white border-slate-600"}`}>
            ⚙ settings
          </button>
          {me.role === "admin" && (
            <button data-testid="admin-open" onClick={() => setAdminOpen(true)}
                    className={`${HEADER_BTN} text-slate-300 hover:text-white border-slate-600`}>
              admin
            </button>
          )}
          {me.username
            ? <button data-testid="signout" onClick={signOut}
                      className={`${HEADER_BTN} text-slate-300 hover:text-white border-slate-600`}>
                sign out
              </button>
            : <button data-testid="signin" onClick={() => setAsGuest(false)}
                      className={`${HEADER_BTN} text-cyan-300 hover:text-white border-cyan-700`}>
                sign in / leave guest view
              </button>}
          {selected && (
            <button
              data-testid="back-to-map"
              onClick={() => { selectDataset(null); closeRight(); }}
              className="text-sm text-slate-300 hover:text-white border border-slate-600 rounded px-2 py-0.5"
            >
              ← Map
            </button>
          )}
        </div>
      </header>

      {error && <div className="bg-red-900/60 text-red-200 px-4 py-2 text-sm" data-testid="error">{error}</div>}

      <main className="flex-1 min-h-0 relative">
        {settingsOpen && !selected && (
          <div data-testid="settings-panel"
            className="fixed right-2 top-11 z-50 w-80 rounded border border-slate-600 bg-slate-900/95 px-2 py-1.5 shadow-xl">
            <ThemeSwitch theme={theme} onTheme={setTheme} />
          </div>
        )}
        {!selected ? (
          <ErrorBoundary label="the dataset map"><MapView datasets={datasets} light={theme === "light"} onSelect={selectDataset} onRefresh={refresh}
            canImport={me.role === "admin"} orderKey={me.username ?? "guest"} /></ErrorBoundary>
        ) : (
          <ErrorBoundary label="the network"><NetworkView dataset={selected} onOpenAsv={openAsv} onOpenEdge={openEdge}
            openAsvId={asvId ?? null}
            isAdmin={me.role === "admin"}
            onOpenTaxon={(asvId) => setRight({ kind: "taxon", asvId })}
            onCloseView={(k) => schliesse(k as RightPanel["kind"])}
            onShowNet={closeRight}
            settingsOpen={settingsOpen}
            theme={theme} onTheme={setTheme}
            onOpenStarred={() => { setStarredCluster(null); setRight({ kind: "starred" }); }}
            clusterVonAussen={starredCluster}
            starredOpen={istOffen("starred")}
            onOpenEnvironment={() => setRight({ kind: "environment" })}
            environmentOpen={istOffen("environment")}
            onOpenWheel={() => setRight({ kind: "wheel" })}
            wheelOpen={istOffen("wheel")}
            onOpenEla={() => setRight({ kind: "ela" })}
            elaOpen={istOffen("ela")}
            onOpenCompare={() => setRight({ kind: "compare" })}
            compareOpen={istOffen("compare")}
            onRefresh={refresh} /></ErrorBoundary>
        )}

        {me.username && !chatOpen && (
          <AssistantCharacter offset={Math.max(0, ...offen.map((o) => PANEL_WIDTH[o.kind] ?? 0))}
            onClick={() => setChatOpen(true)} />
        )}

        <PanelFrame id="agent" defaultWidth={PANEL_WIDTH.agent} hidden={!chatOpen} testid="agent-frame">
          <ErrorBoundary label="the assistant"><AgentChat datasets={datasets} datasetId={selected?.dataset_id}
            asvId={asvId} onClose={() => setChatOpen(false)} /></ErrorBoundary>
        </PanelFrame>

        {selected && finde("asv") && (
          <PanelFrame id="asv" defaultWidth={PANEL_WIDTH.asv}><ErrorBoundary label="the ASV detail"><AsvDrawer datasetId={selected.dataset_id} asvId={finde("asv")!.id} onClose={() => schliesse("asv")}
            onOpenAsv={openAsv} onOpenEdge={openEdge}
            onOpenTaxon={(id) => setRight({ kind: "taxon", asvId: id })}
            onCompare={(id) => setRight({ kind: "compare", seed: id })} /></ErrorBoundary></PanelFrame>
        )}
        {selected && finde("edge") && (
          <PanelFrame id="edge" defaultWidth={PANEL_WIDTH.edge}><ErrorBoundary label="the link detail"><EdgeDrawer datasetId={selected.dataset_id} source={finde("edge")!.edge.source}
            target={finde("edge")!.edge.target} type={finde("edge")!.edge.type} onClose={() => schliesse("edge")}
            onOpenAsv={openAsv} /></ErrorBoundary></PanelFrame>
        )}
        {selected && istOffen("environment") && (
          <PanelFrame id="environment" defaultWidth={PANEL_WIDTH.environment}><ErrorBoundary label="the environment panel"><EnvironmentPanel datasetId={selected.dataset_id} onClose={() => schliesse("environment")} /></ErrorBoundary></PanelFrame>
        )}
        {selected && istOffen("wheel") && (
          <PanelFrame id="wheel" defaultWidth={PANEL_WIDTH.wheel}><ErrorBoundary label="the year wheel">
            <WheelPanel datasetId={selected.dataset_id} onClose={() => schliesse("wheel")}
              onOpenCluster={wishCluster} />
          </ErrorBoundary></PanelFrame>
        )}
        {selected && istOffen("ela") && (
          <PanelFrame id="ela" defaultWidth={PANEL_WIDTH.ela}><ErrorBoundary label="the energy landscape">
            <ElaPanel datasetId={selected.dataset_id} onClose={() => schliesse("ela")} onOpenAsv={openAsv} />
          </ErrorBoundary></PanelFrame>
        )}
        {selected && finde("compare") && (
          <PanelFrame id="compare" defaultWidth={PANEL_WIDTH.compare}><ErrorBoundary label="the seasonal comparison">
            <ComparePanel datasetId={selected.dataset_id} initialAsvId={finde("compare")!.seed}
              onClose={() => schliesse("compare")} onOpenAsv={openAsv} />
          </ErrorBoundary></PanelFrame>
        )}
        {selected && finde("taxon") && (
          <PanelFrame id="taxon" defaultWidth={PANEL_WIDTH.taxon}><ErrorBoundary label="the taxon page">
            <TaxonPanel datasetId={selected.dataset_id} asvId={finde("taxon")!.asvId}
              onClose={() => schliesse("taxon")} onOpenAsv={openAsv} />
          </ErrorBoundary></PanelFrame>
        )}
        {selected && istOffen("starred") && (
          <PanelFrame id="starred" defaultWidth={PANEL_WIDTH.starred}><ErrorBoundary label="the starred panel">
            <StarredPanel datasetId={selected.dataset_id} onClose={() => schliesse("starred")}
              onOpenAsv={openAsv} onOpenCluster={(l) => { wishCluster(l); schliesse("starred"); }} />
          </ErrorBoundary></PanelFrame>
        )}
        <ImportTray isAdmin={me.role === "admin"} onJobDone={refresh} />
      </main>
      {(adminOpen || (focusRequest !== null && me.role === "admin")) && (
        <AdminPanel datasets={datasets} focusRequest={focusRequest}
                    onClose={() => { setAdminOpen(false); setFocusRequest(null); }}
                    onDatasetsChanged={refresh} />
      )}
    </div>
    </ModulesProvider>
  );
}
