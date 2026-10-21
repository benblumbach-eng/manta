import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts";
import ReactECharts from "echarts-for-react";
import { getFastqPreflight, getImportTools, uploadFastq, uploadImport, PRODUCTION_THRESHOLDS,
         type FastqPreflight, type ImportTools, type ThresholdInput } from "../api";
import InfoTip from "./InfoTip";
import { Button, Dialog, StateNotice } from "./ui";
import { Segmented } from "./controls";
import { useTokens } from "../design/tokens";
import { MAP_POINT } from "../design/dataColours";

type Source = "dada2" | "otterout" | "fastq";

const RDATA = /\.(rdata|rda)$/i;
const FASTA = /\.(fa|fasta|fna)$/i;
const CSVNAME = /\.csv$/i;

const FASTQ_PAIR = /^(.+)_R([12])_001\.fastq\.gz$/;
const READ_FILE = /\.(gz|fastq|fq)$/i;

function fastqPairs(files: File[]): { n: number; unpaired: string[]; offPattern: string[] } {
  const stems = new Map<string, Set<string>>();
  const offPattern: string[] = [];
  for (const f of files) {
    const m = FASTQ_PAIR.exec(f.name);
    if (!m) { if (READ_FILE.test(f.name)) offPattern.push(f.name); continue; }
    if (!stems.has(m[1])) stems.set(m[1], new Set());
    stems.get(m[1])!.add(m[2]);
  }
  const unpaired = [...stems].filter(([, r]) => r.size !== 2).map(([s]) => s).sort();
  return { n: stems.size - unpaired.length, unpaired, offPattern };
}

const kurz = (xs: string[], n = 5) =>
  xs.slice(0, n).join(", ") + (xs.length > n ? ` (+${xs.length - n} more)` : "");
const TABLES_REQUIRED = ["abundance.csv", "taxa_info.csv", "environment_info.csv"];
const OTTER_OUT_REQUIRED = ["abundance.csv", "environment_info.csv"];
const OTTER_OUT_MANIFEST = "manta_manifest.json";
const OTTER_OUT_DEFAULT_TABLES = [
  "PyTest_Hellinger_False_14_Enriched_Hellinger_14_complete_network_table_meta_CON_CCM.csv",
  "PyTest_Hellinger_False_14_Pearson_FFT__complete_network_table_0.7_0.05.csv",
  "PyTest_Hellinger_False_14_Pruned_CCM_CON_MAP_Network.csv",
];

const SOURCE_LINE: Record<Source, string> = {
  fastq: "Stage 0 — raw paired-end reads (gzipped FASTQ, ≥ 8 samples)",
  dada2: "Stage 1 — a finished sample inference: DADA2 artefacts, or the three otter tables",
  otterout: "Stage 2 — a finished otter community network analysis",
};

const SOURCE_DETAIL: Record<Source, React.ReactNode> = {
  fastq: <>
    <p>Illumina naming <code>&lt;sample&gt;_S&lt;n&gt;_L001_R1_001.fastq.gz</code>.</p>
    <p>Processing: cutadapt removes the primer sequences; DADA2 performs sample inference at
    single-nucleotide resolution — amplicon sequence variants with chimera removal and read
    tracking; the otter framework then runs the community network analysis (Co-Occurrence
    network, Louvain clustering, Convergent Cross Mapping; Oldenburg et al. 2024); the result
    is loaded into the graph.</p>
  </>,
  dada2: <>
    <p><strong>Either</strong> the DADA2 artefacts, as .Rdata or .csv: raw ASV × sample count
    matrix (RawAbundanceMat), taxonomic assignments (assignTaxonomy; PR2 ranks are mapped,
    Division to Phylum), representative ASV sequences (FASTA), sample metadata
    (sample;date;environment…) — optional if the sample names are dates (YYYY.MM.DD) — and,
    optionally, read tracking across the pipeline steps (input … nonchim) — if present, MANTA
    checks that each sample kept enough of its reads. Taxonomy rows for ASVs that are not in the
    count matrix and samples without any reads are left out; the import lists what was
    adjusted.</p>
    <p><strong>Or</strong> the three otter tables: abundance (sampling date × ASV read counts),
    taxa_info (ASV; Kingdom…Species), environment_info (date-indexed environmental variables; may
    hold dates only). An optional id_map.csv attaches the representative ASV sequences. No read
    tracking is required for them — it does not exist for external tables and is not fabricated.</p>
    <p>Processing: for the artefacts, format conversion first (with read-retention QC if read
    tracking is present); then, for
    both, the otter community network analysis (Co-Occurrence network, Louvain clustering,
    Convergent Cross Mapping), then graph ingest.</p>
  </>,
  otterout: <>
    <p>The Co-Occurrence network table, the enriched meta table (CON + CCM), and the pruned CCM
    map, named by the run&rsquo;s manta_manifest.json — plus the abundance and environment_info
    tables it was computed from. If the PV table (all tested CCM directions with their p-values)
    is present, the rejected directions are loaded too; without it they stay unrecorded.</p>
    <p>Nothing is recomputed; the network is loaded into the graph with the run&rsquo;s recorded
    parameters, or marked as unrecorded if the manifest is missing.</p>
  </>,
};

const inputCls = "w-full mt-1 px-2 py-1 rounded-md bg-control border border-line-strong text-sm " +
                 "text-fg focus:border-accent focus:outline-none";

function Field({ label, children, tip }:
  { label: string; children: React.ReactNode; tip?: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-fg-muted flex items-center">
        {label}{tip && <InfoTip title={label}>{tip}</InfoTip>}
      </span>
      {children}
    </label>
  );
}

function LocationPicker({ lat, lon, onPick }:
  { lat: string; lon: string; onPick: (lat: number, lon: number) => void }) {
  const [ready, setReady] = useState(false);
  const tok = useTokens();
  const bound = useRef(false);
  const pick = useRef(onPick);
  pick.current = onPick;

  useEffect(() => {
    if ((echarts as any).getMap?.("world")) { setReady(true); return; }
    fetch("/bathymetry.json").then((r) => r.json())
      .then((geo) => {
        const land = { type: "FeatureCollection",
          features: (geo.features ?? []).filter((f: any) => f.properties?.name === "land") };
        echarts.registerMap("world", land as any); setReady(true);
      })
      .catch(() => setReady(false));
  }, []);

  if (!ready) return <div className="h-40 grid place-items-center"><StateNotice state="loading" inline>loading map …</StateNotice></div>;

  const has = lat.trim() !== "" && lon.trim() !== "" &&
              !Number.isNaN(Number(lat)) && !Number.isNaN(Number(lon));
  const option = {
    backgroundColor: "transparent",
    geo: { map: "world", roam: true, silent: true,
           itemStyle: { areaColor: tok.control, borderColor: tok.border } },
    series: [{
      type: "scatter", coordinateSystem: "geo", symbolSize: 14,
      itemStyle: { color: MAP_POINT.newPoint, borderColor: tok.surface, borderWidth: 1 },
      data: has ? [{ value: [Number(lon), Number(lat)] }] : [],
    }],
  };

  return (
    <div data-testid="import-map" className="h-40 rounded border border-line cursor-crosshair">
      <ReactECharts
        option={option} style={{ height: "100%", width: "100%" }} notMerge
        onChartReady={(chart: any) => {
          if (bound.current) return;
          bound.current = true;
          chart.getZr().on("click", (e: any) => {
            const p = chart.convertFromPixel({ geoIndex: 0 }, [e.offsetX, e.offsetY]);
            if (!p || Number.isNaN(p[0]) || Number.isNaN(p[1])) return;
            const wrapped = ((p[0] + 180) % 360 + 360) % 360 - 180;
            pick.current(Math.round(p[1] * 1e4) / 1e4, Math.round(wrapped * 1e4) / 1e4);
          });
        }}
      />
    </div>
  );
}

const DEFAULT_THRESHOLDS: ThresholdInput = PRODUCTION_THRESHOLDS;

export default function ImportDialog({ onClose, onStarted }:
  { onClose: () => void; onStarted: (jobId: string) => void }) {
  const [source, setSource] = useState<Source>("dada2");
  const [datasetId, setDatasetId] = useState("");
  const [region, setRegion] = useState("");
  const [marker, setMarker] = useState("18S");
  const [station, setStation] = useState("");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [metadata, setMetadata] = useState<File | null>(null);
  const [pre, setPre] = useState<FastqPreflight | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showThresholds, setShowThresholds] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const [thr, setThr] = useState<ThresholdInput>(DEFAULT_THRESHOLDS);
  const [keepOtter, setKeepOtter] = useState(false);

  const [tools, setTools] = useState<ImportTools | null>(null);

  useEffect(() => { getFastqPreflight().then(setPre).catch(() => setPre(null)); }, []);
  useEffect(() => { getImportTools().then(setTools).catch(() => setTools(null)); }, []);
  const entryState = tools?.entries[source];

  const idOk = /^[a-z0-9_]{3,}$/.test(datasetId);
  const fq = fastqPairs(files);
  const nFastqPairs = fq.n;
  const fastqOk = nFastqPairs >= 8 && fq.unpaired.length === 0 && fq.offPattern.length === 0;
  const has = (n: string) => files.some((f) => f.name === n);
  const dada2Missing = [
    files.filter((f) => RDATA.test(f.name) || CSVNAME.test(f.name)).length >= 2 ? ""
      : "abundance matrix and taxonomy as .Rdata or .csv (read tracking optional)",
    files.some((f) => FASTA.test(f.name)) ? "" : "a FASTA with the ASV sequences",
  ].filter(Boolean);
  const tablesMissing = TABLES_REQUIRED.filter((n) => !has(n));
  const otterOutMissing = OTTER_OUT_REQUIRED.filter((n) => !has(n));
  const otterOutTablesOk = has(OTTER_OUT_MANIFEST) || OTTER_OUT_DEFAULT_TABLES.every(has);
  const stage1Ok = dada2Missing.length === 0 || tablesMissing.length === 0;
  const canStart = idOk && !busy && files.length > 0 && entryState?.ok !== false &&
    (source === "fastq" ? fastqOk
      : source === "dada2" ? stage1Ok
      : otterOutMissing.length === 0 && otterOutTablesOk);

  async function start() {
    setErr(null); setBusy(true);
    try {
      const opts = {
        region: region.trim() || datasetId,
        marker,
        station: station.trim() || undefined,
        lat: lat.trim() ? Number(lat) : undefined,
        lon: lon.trim() ? Number(lon) : undefined,
      };
      const res = source === "fastq"
        ? await uploadFastq(files, datasetId, opts.region,
            { metadata, station: opts.station, lat: opts.lat, lon: opts.lon, marker,
              thresholds: thr, keep_otter: keepOtter })
        : await uploadImport(files, datasetId, opts.region,
            { station: opts.station, lat: opts.lat, lon: opts.lon, marker,
              thresholds: source === "otterout" ? undefined : thr,
              keep_otter: source === "otterout" ? undefined : keepOtter });
      onStarted(res.job_id);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  }

  const input = inputCls;

  const num = (key: keyof ThresholdInput, label: string, step: number, tip: React.ReactNode) => (
    <Field label={label} tip={tip}>
      <input data-testid={`import-${key}`} type="number" step={step} value={thr[key]} className={input}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (!Number.isNaN(v)) setThr({ ...thr, [key]: v });
        }} />
    </Field>
  );

  return (
    <Dialog title="Import a dataset" onClose={onClose} testid="import-dialog" closeTestid="import-cancel"
      width="max-w-[560px]" footer={<>
        <Button size="md" onClick={onClose}>Cancel</Button>
        <Button size="md" variant="primary" data-testid="import-start" onClick={start} disabled={!canStart}
          reason={busy ? "the import is starting" : "complete the files and the name first (see the line above)"}>
          {busy ? "starting …" : "Start import"}
        </Button>
      </>}>
      <div className="space-y-3">
        <Segmented value={source} onChange={(v) => { setSource(v); setFiles([]); }}
          options={([["fastq", "Raw reads (FASTQ)"], ["dada2", "DADA2 output (ASVs)"],
                     ["otterout", "OTTER output (network)"]] as [Source, string][]).map(([v, l]) => (
            { value: v, label: l, testid: `source-${v}` }))} />

        <div data-testid="source-declaration"
          className="flex items-start gap-1 rounded-md border border-line bg-surface p-2 text-xs text-fg-muted">
          <span>{SOURCE_LINE[source]}</span>
          <InfoTip title="What this entrance needs and what will run">
            {SOURCE_DETAIL[source]}
          </InfoTip>
        </div>

        {entryState && !entryState.ok && (
          <div data-testid="import-unavailable" className="rounded border border-warn bg-warn-soft p-2 text-xs text-warn">
            This entrance cannot run here — missing analysis tools: {entryState.missing.join(", ")}.{" "}
            {tools?.hint}
          </div>
        )}
        {source === "fastq" && entryState?.ok !== false && pre && !pre.ok && (
          <div data-testid="fastq-unavailable" className="rounded border border-warn bg-warn-soft p-2 text-xs text-warn">
            FASTQ import is not possible on this server — {pre.error}.
            The route via DADA2 output still works.
          </div>
        )}
        {source === "fastq" && pre?.ok && (
          <div className="text-xs text-fg-muted">
            DADA2 {pre.dada2_version} ready. <span className="text-warn">Runs for a long
            time</span> — about 20 minutes for 24 samples, and the machine is busy throughout.
          </div>
        )}
        {source !== "otterout" && (
          <div data-testid="import-all-asvs" className="text-xs text-fg-muted space-y-1">
            <p>All ASVs are computed — none are dropped.</p>
            <p>Run time and memory are estimated once the ASVs are known; too little memory stops
            the import there.</p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Name (unique)" tip={
            <><p>Becomes the key in the graph: lowercase letters, digits, underscore.</p>
            <p>A name already taken is rejected — otherwise two studies would silently merge
            into one.</p></>}>
            <input data-testid="import-id" value={datasetId} className={input}
              onChange={(e) => setDatasetId(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))}
              placeholder="e.g. station_a_2021" />
          </Field>
          <Field label="Label (display)">
            <input data-testid="import-region" value={region} className={input}
              onChange={(e) => setRegion(e.target.value)} placeholder="free text" />
          </Field>
          <Field label="Marker" tip={<p>Decides the primers for the FASTQ run and the naming scheme of the ASVs.</p>}>
            <select data-testid="import-marker" value={marker} onChange={(e) => setMarker(e.target.value)} className={input}>
              <option value="18S">18S (eukaryotes)</option>
              <option value="16S">16S (prokaryotes)</option>
            </select>
          </Field>
        </div>

        <fieldset className="border border-line rounded-md p-2">
          <legend className="text-xs font-semibold text-fg-muted px-1 flex items-center">
            Origin
            <InfoTip title="Why the origin matters">
              <p>Without it the dataset does <strong>not</strong> appear on the world map — on
              purpose. Better no dot than a wrong one.</p>
              <p>MANTA never assigns a default location, so imported datasets cannot pile up at
              one spot on the map.</p>
            </InfoTip>
          </legend>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Station"><input data-testid="import-station" value={station} className={input}
              onChange={(e) => setStation(e.target.value)} placeholder="optional" /></Field>
            <Field label="Latitude (°N)"><input data-testid="import-lat" value={lat} className={input}
              onChange={(e) => setLat(e.target.value)} placeholder="79.0" /></Field>
            <Field label="Longitude (°E)"><input data-testid="import-lon" value={lon} className={input}
              onChange={(e) => setLon(e.target.value)} placeholder="4.17" /></Field>
          </div>
          <button type="button" data-testid="import-map-toggle"
            onClick={() => setShowMap((v) => !v)}
            className="mt-2 text-xs text-accent hover:underline">
            {showMap ? "hide map" : "or pick it on the map …"}
          </button>
          {showMap && (
            <div className="mt-1 space-y-1">
              <LocationPicker lat={lat} lon={lon}
                onPick={(la, lo) => { setLat(String(la)); setLon(String(lo)); }} />
              <div className="text-2xs text-fg-muted">
                Click to place the dot; drag and scroll to zoom. Typing in the fields still works.
              </div>
            </div>
          )}
        </fieldset>

        {source !== "otterout" && (
          <fieldset className="border border-line rounded p-2" data-testid="import-thresholds">
            <legend className="text-xs font-semibold text-fg-muted px-1 flex items-center gap-2">
              Network thresholds
              <InfoTip title="What these decide">
                <p>Which correlated pairs become links at all. In practice the correlation cut
                does the work — the CON p-value is a statistic over the Fourier coefficients and
                weak on its own.</p>
                <p>The permutation count sets how fine the CCM p-values can be: p moves in steps
                of one over permutations × sampled pairs × 2 (at most the number of directions
                tested). With 2 permutations and 10 pairs that is 1/40, so below the 0.05 cut only
                0.0 and 0.025 remain. They can also be changed later on an existing dataset.</p>
              </InfoTip>
              <button type="button" data-testid="import-thresholds-toggle"
                onClick={() => setShowThresholds((v) => !v)}
                className="normal-case tracking-normal text-accent hover:underline">
                {showThresholds ? "hide" : `defaults (Pearson ≥ ${thr.con_tr}) — change …`}
              </button>
            </legend>
            {showThresholds && (
              <div className="grid grid-cols-3 gap-2">
                {num("con_tr", "CON corr ≥", 0.01,
                  <p>Higher means fewer, tighter links; lower opens the network up.</p>)}
                {num("con_alpha", "CON p <", 0.005,
                  <p>Benjamini-Hochberg corrected, and weak on its own here.</p>)}
                {num("num_permutations", "permutations", 1,
                  <p>Caps the resolution of the CCM p-values. More costs time in proportion.</p>)}
                {num("fft_coeffs", "Fourier coeff.", 1,
                  <p>Calibrated for roughly 100 sampling points; on a short series the upper
                  coefficients become redundant.</p>)}
                {num("louvain_res", "Louvain res.", 0.1,
                  <p>Higher values split the network into more, smaller clusters.</p>)}
              </div>
            )}
          </fieldset>
        )}

        {source !== "otterout" && (
          <label className="flex items-center gap-2 text-xs" data-testid="import-keep-otter">
            <input type="checkbox" checked={keepOtter} onChange={(e) => setKeepOtter(e.target.checked)} />
            Keep a copy of OTTER&rsquo;s input and output in ~/otter_sicherung on the server
          </label>
        )}

        <Field label={source === "fastq" ? "FASTQ files (paired _R1_/_R2_)"
            : source === "dada2" ? "DADA2 output — .Rdata or .csv tables and a FASTA, or 3 tables"
            : "OTTER output — network tables + abundance/environment (manta_manifest.json recommended)"}
          tip={source === "dada2" ? <p>The abundance matrix and taxonomy as .Rdata or .csv
            (optionally read tracking), a FASTA with the ASV sequences and a .csv with sample and
            date — not needed if the sample names are dates (YYYY.MM.DD); the file names do not
            matter. Or the 3 tables abundance.csv, taxa_info.csv and
            environment_info.csv (id_map.csv optional).</p> : undefined}>
          <input data-testid="import-files" type="file" multiple className={input + " file:mr-2 file:text-xs"}
            accept={source === "fastq" ? ".gz" : undefined}
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              setFiles((prev) => {
                const merged = [...prev];
                for (const f of picked) {
                  const i = merged.findIndex((x) => x.name === f.name);
                  if (i >= 0) merged[i] = f; else merged.push(f);
                }
                return merged;
              });
              e.target.value = "";
            }} />
          {files.length > 0 && (
            <ul data-testid="import-file-list" className="mt-1 max-h-32 overflow-auto space-y-1">
              {files.map((f) => (
                <li key={f.name} className="flex items-center justify-between text-xs text-fg-muted">
                  <span className="truncate">{f.name}</span>
                  <button type="button" data-testid={`import-file-remove-${f.name}`}
                    title={`remove ${f.name}`} aria-label={`remove ${f.name}`}
                    onClick={() => setFiles((prev) => prev.filter((x) => x.name !== f.name))}
                    className="ml-2 text-fg-muted hover:text-danger">✕</button>
                </li>
              ))}
            </ul>
          )}
        </Field>
        {source === "fastq" && (
          <Field label="metadata.csv (optional)" tip={
            <><p>Holds the real sampling dates. <strong>Without it</strong> MANTA knows only the
            order of the samples and shows no month, year or season statements.</p></>}>
            <input data-testid="import-metadata" type="file" accept=".csv" className={input + " file:mr-2 file:text-xs"}
              onChange={(e) => setMetadata(e.target.files?.[0] ?? null)} />
          </Field>
        )}

        <div className="text-xs text-fg-muted" data-testid="import-summary">
          {files.length === 0 ? "no files selected"
            : source === "fastq"
              ? `${files.length} files · ${nFastqPairs} samples`
                + (fq.offPattern.length > 0 ? ` — not named <sample>_R1_001.fastq.gz / `
                    + `<sample>_R2_001.fastq.gz: ${kurz(fq.offPattern)}` : "")
                + (fq.unpaired.length > 0 ? ` — without partner: ${kurz(fq.unpaired)}` : "")
                + (nFastqPairs < 8 ? " — too few for a network (min. 8)" : "")
              : source === "otterout"
                ? `${files.length} files${otterOutMissing.length > 0 ? ` — missing: ${otterOutMissing.join(", ")}`
                    : !otterOutTablesOk ? ` — missing: ${OTTER_OUT_MANIFEST} (or the default-named network tables)` : ""}`
                :
                  `${files.length} files${stage1Ok ? ""
                    : tablesMissing.length < dada2Missing.length
                      ? ` — missing: ${tablesMissing.join(", ")}`
                      : ` — missing: ${dada2Missing.join("; ")}`}`}
          {datasetId && !idOk && <span className="text-warn"> · name needs at least 3 characters (a–z, 0–9, _)</span>}
          {source === "fastq" && !metadata && <span> · without metadata.csv: no season statements</span>}
        </div>

        {err && <div data-testid="import-error" className="text-xs text-danger">{err}</div>}
      </div>
    </Dialog>
  );
}
