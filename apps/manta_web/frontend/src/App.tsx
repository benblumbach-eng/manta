import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getDatasets, getMe, logout, watchSession, SESSION_EVENT,
         type Dataset, type Me, type SessionChange } from "./api";
import LoginScreen from "./components/LoginScreen";
import AdminPanel from "./components/AdminPanel";
import OwnModelSettings from "./components/OwnModelSettings";
import MapView from "./components/MapView";
import ImportTray from "./components/ImportTray";
import NetworkView from "./components/NetworkView";
import AsvDrawer from "./components/AsvDrawer";
import EdgeDrawer from "./components/EdgeDrawer";
import StarredPanel from "./components/StarredPanel";
import WheelPanel from "./components/WheelPanel";
import ComparePanel, { type InspectMark } from "./components/ComparePanel";
import { EXTRA_VIEWS, extraKind } from "./extraViews";
import TaxonPanel from "./components/TaxonPanel";
import AgentChat from "./components/AgentChat";
import { ASK_EVENT, type AskAssistant } from "./components/InfoTip";
import AssistantCharacter from "./components/AssistantCharacter";
import NotesPanel, { NOTES_EVENT, NotesBar, type NoteTarget } from "./components/NotesPanel";
import ErrorBoundary from "./components/ErrorBoundary";
import ErrorNotice from "./components/ErrorNotice";
import { ModulesProvider } from "./modules";
import PanelFrame from "./components/PanelFrame";
import ThemeSwitch, { type Theme } from "./components/ThemeSwitch";
import { Button } from "./components/ui";
import { Z } from "./design/layers";
import { usePublishView } from "./viewContext";

export type EdgeRef = { source: string; target: string; type: "con" | "ccm" };

type RightPanel =
  | { kind: "asv"; id: string }
  | { kind: "edge"; edge: EdgeRef }
  | { kind: "starred" }
  | { kind: "notes"; target: NoteTarget; tick: number }
  | { kind: "taxon"; asvId: string }
  | { kind: "wheel" }
  | { kind: `view:${string}` }
  | { kind: "compare"; seed?: string; sample?: string; mark?: InspectMark; link?: EdgeRef; tick?: number };

const PANEL_WIDTH: Record<string, number> = { asv: 560, edge: 560, starred: 480, notes: 480, wheel: 520, compare: 560, taxon: 520, agent: 460 };

export default function App() {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [selected, setSelected] = useState<Dataset | null>(null);
  const [offen, setOffen] = useState<RightPanel[]>([]);
  const setRight = (p: RightPanel | null) => setOffen((cur) => {
    if (p == null) return [];
    const ohne = cur.filter((x) => x.kind !== p.kind);
    return [...ohne, p];
  });
  const inspectAt = (sample: string, mark?: InspectMark) =>
    setRight({ kind: "compare", sample, mark, tick: Date.now() });
  const schliesse = (kind: RightPanel["kind"]) =>
    setOffen((cur) => cur.filter((x) => x.kind !== kind));
  const istOffen = (kind: RightPanel["kind"]) => offen.some((x) => x.kind === kind);
  const finde = <K extends RightPanel["kind"]>(kind: K) =>
    offen.find((x) => x.kind === kind) as Extract<RightPanel, { kind: K }> | undefined;
  const [error, setError] = useState<unknown>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [pendingAsk, setPendingAsk] = useState<(AskAssistant & { tick: number }) | null>(null);
  useEffect(() => {
    const auf = (e: Event) => {
      const d = (e as CustomEvent<AskAssistant>).detail;
      if (!d?.question) return;
      setChatOpen(true);
      setPendingAsk({ ...d, tick: Date.now() });
    };
    window.addEventListener(ASK_EVENT, auf);
    return () => window.removeEventListener(ASK_EVENT, auf);
  }, []);
  const notizHier = (): NoteTarget => {
    const asv = finde("asv"), inspect = finde("compare");
    return asv ? { kind: "asv", key: asv.id }
      : inspect?.sample ? { kind: "sample", key: inspect.sample } : { kind: "dataset", key: "" };
  };
  const openNotes = (target?: NoteTarget) =>
    setRight({ kind: "notes", target: target ?? notizHier(), tick: Date.now() });
  const openNotesRef = useRef(openNotes);
  openNotesRef.current = openNotes;
  useEffect(() => {
    const auf = (e: Event) => openNotesRef.current((e as CustomEvent<NoteTarget | undefined>).detail);
    window.addEventListener(NOTES_EVENT, auf);
    return () => window.removeEventListener(NOTES_EVENT, auf);
  }, []);
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
  useEffect(() => {
    if (!settingsOpen) return;
    const taste = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector("[data-testid=infotip-panel], [role=dialog][aria-modal=true]")) return;
      e.stopPropagation();
      setSettingsOpen(false);
    };
    const daneben = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.("[data-testid=settings-panel], [data-testid=settings-open]")) return;
      setSettingsOpen(false);
    };
    document.addEventListener("keydown", taste, true);
    document.addEventListener("mousedown", daneben, true);
    return () => {
      document.removeEventListener("keydown", taste, true);
      document.removeEventListener("mousedown", daneben, true);
    };
  }, [settingsOpen]);
  const [asGuest, setAsGuest] = useState(() => {
    try { return sessionStorage.getItem("manta-as-guest") === "1"; } catch { return false; }
  });
  const [adminOpen, setAdminOpen] = useState(false);
  useEffect(() => { setSettingsOpen(false); }, [offen.length, adminOpen, chatOpen]);
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
  const [vonInspect, setVonInspect] =
    useState<{ modules: number[]; asvs: string[]; tick: number } | null>(null);
  const [starredCluster, setStarredCluster] =
    useState<{ label: number; tick: number; ds?: string } | null>(null);
  const wishCluster = (l: number) =>
    setStarredCluster((p) => ({ label: l, tick: (p?.tick ?? 0) + 1, ds: selected?.dataset_id }));
  const openAsv = (id: string) => setRight({ kind: "asv", id });
  const openEdge = (edge: EdgeRef) => setRight({ kind: "compare", link: edge, tick: Date.now() });
  const openEdgeDetails = (edge: EdgeRef) => setRight({ kind: "edge", edge });
  const closeRight = () => setRight(null);

  const selectDataset = (d: Dataset | null) => {
    const wechsel = (d?.dataset_id ?? null) !== (selected?.dataset_id ?? null);
    if (wechsel) { setStarredCluster(null); setOffen([]); }
    setSelected(d);
    const u = new URL(window.location.href);
    if (d) {
      u.searchParams.set("ds", d.dataset_id);
      if (wechsel) u.searchParams.delete("f");
    } else { u.searchParams.delete("ds"); u.searchParams.delete("f"); }
    window.history.replaceState(null, "", u);
  };
  const [dsRestored, setDsRestored] = useState(false);
  const listSeq = useRef(0);
  const [datasetsFor, setDatasetsFor] = useState<string | null>(null);
  useEffect(() => {
    if (dsRestored || selected || datasets.length === 0 || !me) return;
    if (me.role === "guest" && !asGuest) return;
    if (datasetsFor !== (me.username ?? "guest")) return;
    setDsRestored(true);
    const want = new URLSearchParams(window.location.search).get("ds");
    if (!want) return;
    const d = datasets.find((x) => x.dataset_id === want);
    if (d) setSelected(d);
    else selectDataset(null);
  }, [datasets, datasetsFor, dsRestored, selected, me, asGuest]);

  useEffect(() => {
    document.title = selected
      ? `${selected.region ?? selected.dataset_id} · MANTA`
      : "MANTA — Marine Amplicon Network Time-series Analysis";
  }, [selected]);

  const asvId = finde("asv")?.id;
  const kante = finde("edge")?.edge;
  usePublishView("asv", asvId ? { view: "asv", asv: asvId } : null);
  usePublishView("edge", kante ? { view: "edge", source: kante.source, target: kante.target } : null);

  const refresh = () => {
    const seq = ++listSeq.current;
    const fuer = me?.username ?? "guest";
    return getDatasets().then((r) => {
      if (seq !== listSeq.current) return;
      setDatasets(r.datasets); setDatasetsFor(fuer); setError(null);
    }).catch((e) => { if (seq === listSeq.current) setError(e); });
  };

  const [authError, setAuthError] = useState<unknown>(null);
  const [meTick, setMeTick] = useState(0);
  useEffect(() => {
    getMe().then((m) => { setMe(m); setAuthError(null); })
           .catch((e) => setAuthError(e));
  }, [meTick]);

  const [signedOutNote, setSignedOutNote] = useState<string | null>(null);
  useEffect(() => watchSession(), []);
  useEffect(() => {
    const wechsel = (e: Event) => {
      const { before, after } = (e as CustomEvent<SessionChange>).detail;
      setOffen([]); setStarredCluster(null); setAdminOpen(false);
      if (!after.username) {
        setSignedOutNote(before.username
          ? `You were signed out (as ${before.username}): the session ended in another tab, `
            + "expired, or an administrator ended it. Sign in again to continue."
          : null);
        try { sessionStorage.removeItem("manta-as-guest"); } catch { }
        setAsGuest(false);
        setSelected(null);
        setDsRestored(false);
      }
      setMe(after);
    };
    window.addEventListener(SESSION_EVENT, wechsel);
    return () => window.removeEventListener(SESSION_EVENT, wechsel);
  }, []);
  useEffect(() => { if (me) refresh(); }, [me]);

  const enterAsGuest = () => {
    try { sessionStorage.setItem("manta-as-guest", "1"); } catch { }
    setAsGuest(true);
    setSignedOutNote(null);
  };
  const signOut = async () => {
    await logout();
    try { sessionStorage.removeItem("manta-as-guest"); } catch { }
    setAsGuest(false);
    selectDataset(null);
    setOffen([]); setStarredCluster(null);
    setMe(await getMe());
  };

  if (authError != null) {
    return (
      <div className="fixed inset-0 grid place-items-center bg-raised p-6">
        <div className="max-w-md w-full text-sm">
          <ErrorNotice error={authError} testid="auth-unreachable" inline
            what="The server is not reachable — MANTA keeps its data there."
            onRetry={() => setMeTick((n) => n + 1)} />
        </div>
      </div>
    );
  }
  if (me === null) return null;
  if (me.role === "guest" && !asGuest) {
    return <LoginScreen notice={signedOutNote} onDone={(m) => {
      setMe(m); setSignedOutNote(null);
      if (selected) selectDataset(null);
      setOffen([]); setStarredCluster(null);
      setDsRestored(false);
    }} onGuest={enterAsGuest} />;
  }

  return (
    <ModulesProvider datasetId={selected?.dataset_id ?? null}>
    <div className="h-full flex flex-col">
      <header style={{ zIndex: Z.header }}
        className="relative px-4 py-2 border-b border-line bg-surface flex items-center gap-3">
        <nav aria-label="location" className="flex min-w-0 items-center gap-2 text-sm">
          <span className="text-accent font-semibold tracking-wide">MANTA</span>
          {selected ? (
            <>
              <span aria-hidden className="text-fg-muted">›</span>
              <button data-testid="back-to-map"
                onClick={() => { selectDataset(null); closeRight(); }}
                className="rounded-md px-1 text-fg-muted hover:bg-control hover:text-fg">
                ← Map
              </button>
              <span aria-hidden className="text-fg-muted">›</span>
              <span data-testid="header-dataset" className="truncate font-medium text-fg">
                {selected.region ?? selected.dataset_id}
              </span>
            </>
          ) : (
            <span className="truncate text-fg-muted">Marine Amplicon Network Time-series Analysis</span>
          )}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button data-testid="settings-open" aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((v) => !v)}
            className={settingsOpen ? "bg-control" : ""}>
            ⚙ settings
          </Button>
          {me.role === "admin" && (
            <Button data-testid="admin-open" onClick={() => setAdminOpen(true)}>admin</Button>
          )}
          {me.username
            ? <Button data-testid="signout" onClick={signOut}>sign out</Button>
            : <Button data-testid="signin" variant="primary" onClick={() => setAsGuest(false)}>
                sign in / leave guest view
              </Button>}
        </div>
      </header>

      {error != null && (
        <div className="px-4 pt-2">
          <ErrorNotice error={error} inline what="Could not load the dataset list." onRetry={refresh} />
        </div>
      )}

      <main className="flex-1 min-h-0 relative isolate">
        {settingsOpen && !selected && createPortal(
          <div data-testid="settings-panel" role="dialog" aria-label="Display settings" data-popup=""
            style={{ zIndex: Z.popover }}
            className="fixed right-2 top-12 w-80 rounded-md border border-line bg-overlay p-3 shadow-xl space-y-2">
            <h2 className="text-xs font-semibold text-fg-muted">Display</h2>
            <ThemeSwitch theme={theme} onTheme={setTheme} />
            {me.username && <OwnModelSettings />}
          </div>, document.body)}
        {!selected ? (
          <ErrorBoundary key="map" label="the dataset map"><MapView datasets={datasets} light={theme === "light"} onSelect={selectDataset} onRefresh={refresh}
            canImport={me.role === "admin"} orderKey={me.username ?? "guest"} /></ErrorBoundary>
        ) : (
          <ErrorBoundary key={`net:${selected.dataset_id}`} label="the network"><NetworkView dataset={selected} onOpenAsv={openAsv} onOpenEdge={openEdge}
            openAsvId={asvId ?? null}
            isAdmin={me.role === "admin"}
            signedIn={!!me.username}
            onOpenTaxon={(asvId) => setRight({ kind: "taxon", asvId })}
            onCloseView={(k) => schliesse(k as RightPanel["kind"])}
            onShowNet={closeRight}
            settingsOpen={settingsOpen} onCloseSettings={() => setSettingsOpen(false)}
            theme={theme} onTheme={setTheme}
            onOpenStarred={() => { setStarredCluster(null); setRight({ kind: "starred" }); }}
            clusterVonAussen={starredCluster} vonInspect={vonInspect}
            starredOpen={istOffen("starred")}
            onOpenWheel={() => setRight({ kind: "wheel" })}
            wheelOpen={istOffen("wheel")}
            extraViews={EXTRA_VIEWS.map((view) => ({ view, kind: extraKind(view.key),
              open: istOffen(extraKind(view.key)),
              onOpen: () => setRight({ kind: extraKind(view.key) }) }))}
            onOpenCompare={() => setRight({ kind: "compare" })}
            onInspectAt={inspectAt}
            compareOpen={istOffen("compare")}
            onRefresh={refresh}
            onOpenDataset={(id) => getDatasets().then((r) => {
              setDatasets(r.datasets);
              const d = r.datasets.find((x) => x.dataset_id === id);
              if (d) { closeRight(); selectDataset(d); }
            }).catch((e) => setError(String(e)))} /></ErrorBoundary>
        )}

        {me.username && !chatOpen && (
          <div className="absolute bottom-4 flex flex-col items-center gap-1"
            style={{ right: 16, zIndex: Z.figure }}>
            <AssistantCharacter onClick={() => setChatOpen(true)} />
            {selected && <NotesBar onOpen={() => openNotes()} />}
          </div>
        )}

        <PanelFrame id="agent" title="MANTA assistant" onClose={() => setChatOpen(false)}
          defaultWidth={PANEL_WIDTH.agent} hidden={!chatOpen} testid="agent-frame"
          figureGap={false} fit={false}>
          <ErrorBoundary label="the assistant"><AgentChat key={me.username ?? "guest"}
            datasets={datasets} datasetId={selected?.dataset_id}
            asvId={asvId} ask={pendingAsk} onClose={() => setChatOpen(false)}
            signedIn={!!me.username} /></ErrorBoundary>
        </PanelFrame>

        {selected && finde("asv") && (
          <PanelFrame id="asv" title="ASV" onClose={() => schliesse("asv")} defaultWidth={PANEL_WIDTH.asv}><ErrorBoundary label="the ASV detail"><AsvDrawer
            key={`${selected.dataset_id}/${finde("asv")!.id}`}
            datasetId={selected.dataset_id} asvId={finde("asv")!.id} onClose={() => schliesse("asv")}
            onOpenAsv={openAsv} onOpenEdge={openEdge}
            onOpenTaxon={(id) => setRight({ kind: "taxon", asvId: id })}
            onOpenCluster={wishCluster}
            onCompare={(id) => setRight({ kind: "compare", seed: id })}
            onInspectAt={(sample) => inspectAt(sample, { kind: "asv", id: finde("asv")!.id })}
            signedIn={!!me.username} /></ErrorBoundary></PanelFrame>
        )}
        {selected && finde("edge") && (
          <PanelFrame id="edge" title="Link" onClose={() => schliesse("edge")} defaultWidth={PANEL_WIDTH.edge}><ErrorBoundary label="the link detail"><EdgeDrawer datasetId={selected.dataset_id} source={finde("edge")!.edge.source}
            target={finde("edge")!.edge.target} type={finde("edge")!.edge.type} onClose={() => schliesse("edge")}
            onOpenAsv={openAsv} /></ErrorBoundary></PanelFrame>
        )}
        {selected && istOffen("wheel") && (
          <PanelFrame id="wheel" title="The year wheel" onClose={() => schliesse("wheel")} defaultWidth={PANEL_WIDTH.wheel}><ErrorBoundary label="the year wheel">
            <WheelPanel datasetId={selected.dataset_id} onClose={() => schliesse("wheel")}
              onOpenCluster={wishCluster} />
          </ErrorBoundary></PanelFrame>
        )}
        {selected && EXTRA_VIEWS.filter((v) => istOffen(extraKind(v.key))).map((v) => (
          <PanelFrame key={v.key} id={v.key} title={v.title} onClose={() => schliesse(extraKind(v.key))} defaultWidth={v.width}><ErrorBoundary label={v.errorLabel}>
            <v.Panel datasetId={selected.dataset_id} onClose={() => schliesse(extraKind(v.key))} onOpenAsv={openAsv} />
          </ErrorBoundary></PanelFrame>
        ))}
        {selected && finde("compare") && (
          <PanelFrame id="compare" title="Inspect" onClose={() => schliesse("compare")} defaultWidth={PANEL_WIDTH.compare}><ErrorBoundary label="the seasonal comparison">
            <ComparePanel datasetId={selected.dataset_id} initialAsvId={finde("compare")!.seed}
              initialSample={finde("compare")!.sample} mark={finde("compare")!.mark}
              sampleTick={finde("compare")!.tick} link={finde("compare")!.link}
              onOpenEdge={openEdgeDetails}
              onToNetwork={(modules, asvs) => setVonInspect({ modules, asvs, tick: Date.now() })}
              onClose={() => schliesse("compare")} onOpenAsv={openAsv} />
          </ErrorBoundary></PanelFrame>
        )}
        {selected && finde("taxon") && (
          <PanelFrame id="taxon" title="Taxon" onClose={() => schliesse("taxon")} defaultWidth={PANEL_WIDTH.taxon}><ErrorBoundary label="the taxon page">
            <TaxonPanel datasetId={selected.dataset_id} asvId={finde("taxon")!.asvId}
              onClose={() => schliesse("taxon")} onOpenAsv={openAsv} />
          </ErrorBoundary></PanelFrame>
        )}
        {selected && istOffen("starred") && (
          <PanelFrame id="starred" title="Starred" onClose={() => schliesse("starred")} defaultWidth={PANEL_WIDTH.starred}><ErrorBoundary label="the starred panel">
            <StarredPanel datasetId={selected.dataset_id} onClose={() => schliesse("starred")}
              onOpenAsv={openAsv} onOpenCluster={(l) => { wishCluster(l); schliesse("starred"); }} />
          </ErrorBoundary></PanelFrame>
        )}
        {selected && finde("notes") && (
          <PanelFrame id="notes" title="Notes" onClose={() => schliesse("notes")} defaultWidth={PANEL_WIDTH.notes}><ErrorBoundary label="the notes">
            <NotesPanel key={selected.dataset_id} datasetId={selected.dataset_id}
              target={finde("notes")!.target} tick={finde("notes")!.tick}
              onClose={() => schliesse("notes")} onOpenAsv={openAsv} onOpenCluster={wishCluster}
              onOpenSample={(s) => inspectAt(s)} />
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
