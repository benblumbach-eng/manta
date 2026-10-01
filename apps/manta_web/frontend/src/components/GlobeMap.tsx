import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Dataset } from "../api";


export type BathyClass = { key: string; name: string; lo: number | null; hi: number | null };
export type BathyMeta = {
  source: { name: string; citation: string; access: string; licence: string };
  classes: BathyClass[]; land: BathyClass; generated: string;
  coarse: { cell_deg: number }; windows: { file: string; cell_deg: number }[];
};

export const DEPTH_RAMP_DARK = ["#cfe0ef", "#b3cee6", "#98bcdb", "#7fabcf", "#6899c2", "#5488b4",
                                "#4376a4", "#356592", "#2a5079", "#1e3c5e", "#132842", "#0d1a2e"];
export const DEPTH_RAMP_LIGHT = ["#f7fbff", "#e3eef9", "#cfe1f2", "#b9d3ea", "#a1c4e1", "#86b3d6",
                                 "#6aa1cb", "#4f8fc0", "#3a7db4", "#2b6aa6", "#1f5694", "#143f7a"];
export const LAND_DARK = "#3f4756";
export const LAND_LIGHT = "#9aa3ad";
const BG_DARK = "#0b1220";
const BG_LIGHT = "#f6f8fb";

function fillColorExpr(meta: BathyMeta, light: boolean): any {
  const ramp = light ? DEPTH_RAMP_LIGHT : DEPTH_RAMP_DARK;
  const pairs: any[] = [];
  meta.classes.forEach((c, i) => { pairs.push(c.key, ramp[Math.min(i, ramp.length - 1)]); });
  pairs.push("land", light ? LAND_LIGHT : LAND_DARK);
  return ["match", ["get", "name"], ...pairs, light ? BG_LIGHT : BG_DARK];
}

function datasetsGeo(datasets: Dataset[]) {
  const orte = new Map<string, { coords: [number, number]; ds: Dataset[] }>();
  for (const d of datasets) {
    if (!d.coords) continue;
    const c = d.coords as [number, number];
    const schluessel = `${c[0].toFixed(4)},${c[1].toFixed(4)}`;
    const vorhanden = orte.get(schluessel);
    if (vorhanden) vorhanden.ds.push(d);
    else orte.set(schluessel, { coords: c, ds: [d] });
  }
  return {
    type: "FeatureCollection" as const,
    features: [...orte.values()].map(({ coords, ds }) => ({
      type: "Feature" as const,
      properties: {
        id: ds[0].dataset_id,
        ids: ds.map((d) => d.dataset_id).join(","),
        n: ds.length,
        name: ds.length === 1
          ? `${ds[0].region ?? ds[0].dataset_id} (${ds[0].marker ?? "?"})`
          : `${ds.length} datasets`,
      },
      geometry: { type: "Point" as const, coordinates: coords },
    })),
  };
}

declare global {
  interface Window {
    __mantaMapInfo?: () => { projection: string; layers: string[]; bathyFeatures: number;
                             punkte?: { n: number; haufen: boolean }[] };
    __mantaMapPixel?: (id: string) => [number, number] | null;
  }
}

export default function GlobeMap({ datasets, editId, light, onSelect, onHover, onMove, onApi,
                                   onMoveError, onBathy, onHandles, onReady }: {
  datasets: Dataset[]; editId: string | null; light: boolean;
  onSelect: (d: Dataset) => void;
  onHover: (ids: string[]) => void;
  onMove: (id: string, lat: number, lon: number) => Promise<void>;
  onMoveError: (msg: string | null) => void;
  onBathy: (meta: BathyMeta | null) => void;
  onHandles: (n: number) => void;
  onReady?: () => void;
  onApi?: (api: { zoomIn: () => void; zoomOut: () => void; reset: () => void }) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const metaRef = useRef<BathyMeta | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const pickRef = useRef<maplibregl.Popup | null>(null);
  const loaded = useRef(false);
  const nFeatures = useRef(0);
  const cb = useRef({ onSelect, onHover, onMove, onMoveError, onBathy, onHandles, onReady, onApi, datasets });
  cb.current = { onSelect, onHover, onMove, onMoveError, onBathy, onHandles, onReady, onApi, datasets };

  useEffect(() => {
    if (!box.current) return;
    const map = new maplibregl.Map({
      container: box.current,
      style: {
        version: 8,
        projection: { type: "globe" },
        sources: {},
        layers: [{ id: "bg", type: "background", paint: { "background-color": "rgba(0,0,0,0)" } }],
      },
      center: [5, 45], zoom: 1.4, minZoom: 0.6,
      attributionControl: false, dragRotate: false, pitchWithRotate: false,
    });
    mapRef.current = map;
    cb.current.onApi?.({ zoomIn: () => map.zoomIn(), zoomOut: () => map.zoomOut(),
                         reset: () => map.easeTo({ center: [5, 45], zoom: 1.4 }) });

    map.on("load", () => {
      loaded.current = true;
      fetch("/bathymetry.json")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((geo) => {
          if (!Array.isArray(geo?.features) || !geo?.bathymetry?.classes) throw new Error("kein Kopf");
          metaRef.current = geo.bathymetry as BathyMeta;
          nFeatures.current = geo.features.length;
          map.addSource("bathy", { type: "geojson", data: geo });
          map.addLayer({
            id: "bathy-fill", type: "fill", source: "bathy",
            paint: { "fill-color": fillColorExpr(metaRef.current, light), "fill-antialias": false },
          }, "datasets");
          map.addLayer({
            id: "bathy-seam", type: "line", source: "bathy",
            paint: { "line-color": fillColorExpr(metaRef.current, light), "line-width": 1.5 },
          }, "datasets");
          cb.current.onBathy(metaRef.current);
        })
        .catch(() => {
          cb.current.onBathy(null);
        });

      map.addSource("datasets", {
        type: "geojson", data: datasetsGeo(cb.current.datasets),
        cluster: true, clusterRadius: 38, clusterMaxZoom: 7,
        clusterProperties: { n: ["+", ["get", "n"]] },
      });
      map.addLayer({
        id: "datasets", type: "circle", source: "datasets",
        paint: { "circle-radius": ["step", ["get", "n"], 7, 2, 10, 5, 13, 12, 16] as never,
                 "circle-color": "#ef4444",
                 "circle-stroke-color": "#0b1220", "circle-stroke-width": 1.5 },
      });
      map.addLayer({
        id: "datasets-n", type: "symbol", source: "datasets",
        filter: [">", ["get", "n"], 1],
        layout: { "text-field": ["to-string", ["get", "n"]] as never, "text-size": 11,
                  "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
                  "text-allow-overlap": true, "text-ignore-placement": true },
        paint: { "text-color": "#0b1220" },
      });
      popupRef.current = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10,
                                                className: "manta-popup" });
      pickRef.current = new maplibregl.Popup({ closeButton: true, closeOnClick: false, offset: 14,
                                              className: "manta-popup" });

      const name = (d: Dataset) => {
        const b = d.region ?? d.dataset_id;
        return d.marker && !b.includes(d.marker) ? `${b} (${d.marker})` : b;
      };

      const schieber = (auf: () => void) => {
        const spur = document.createElement("div");
        spur.setAttribute("data-testid", "map-card-slider");
        spur.className = "relative mt-2 h-9 w-56 rounded-full border border-slate-600 "
          + "bg-slate-800/80 overflow-hidden select-none";
        const text = document.createElement("div");
        text.className = "absolute inset-0 grid place-items-center text-[11px] text-slate-400 "
          + "pointer-events-none";
        text.textContent = "slide to open network";
        const griff = document.createElement("button");
        griff.setAttribute("data-testid", "map-card-knob");
        griff.setAttribute("aria-label", "slide to open network");
        griff.className = "absolute left-1 top-1 h-7 w-7 rounded-full bg-cyan-500 text-slate-900 "
          + "grid place-items-center cursor-grab active:cursor-grabbing";
        griff.textContent = "›";
        spur.append(text, griff);

        const weg = () => spur.clientWidth - griff.clientWidth - 8;
        let x = 0, zieht = false;
        const setzen = (v: number) => {
          x = Math.max(0, Math.min(weg(), v));
          griff.style.transform = `translateX(${x}px)`;
          text.style.opacity = String(Math.max(0, 1 - x / Math.max(1, weg())));
        };
        const los = (ev: PointerEvent) => {
          zieht = true; griff.setPointerCapture(ev.pointerId);
          ev.preventDefault(); ev.stopPropagation();
        };
        const zug = (ev: PointerEvent) => {
          if (!zieht) return;
          setzen(ev.clientX - spur.getBoundingClientRect().left - griff.clientWidth / 2);
        };
        const ende = () => {
          if (!zieht) return;
          zieht = false;
          if (x >= 0.75 * weg()) { setzen(weg()); auf(); }
          else { griff.style.transition = "transform .15s"; setzen(0);
                 setTimeout(() => { griff.style.transition = ""; }, 160); }
        };
        griff.addEventListener("pointerdown", los);
        griff.addEventListener("pointermove", zug);
        griff.addEventListener("pointerup", ende);
        griff.addEventListener("pointercancel", ende);
        griff.addEventListener("keydown", (ev: KeyboardEvent) => {
          if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); auf(); }
        });
        return spur;
      };

      const karte = (d: Dataset, zurueck?: () => void) => {
        const el = document.createElement("div");
        el.setAttribute("data-testid", "map-card");
        el.setAttribute("data-ds", d.dataset_id);
        el.className = "text-xs";
        if (zurueck) {
          const z = document.createElement("button");
          z.setAttribute("data-testid", "map-card-back");
          z.className = "text-cyan-300 hover:underline mb-1";
          z.textContent = "‹ all datasets here";
          z.onclick = zurueck;
          el.append(z);
        }
        const t = document.createElement("div");
        t.className = "text-sm font-medium text-slate-100"; t.textContent = name(d);
        el.append(t);
        const c = d.coords as number[] | null;
        const zeilen = [
          c ? `${c[1].toFixed(2)}°N ${c[0].toFixed(2)}°E${d.station ? ` · ${d.station}` : ""}` : null,
          `${d.n_sample} samples`,
          `${d.n_network} of ${d.n_asv} ASVs in the network`,
        ].filter(Boolean) as string[];
        for (const z of zeilen) {
          const r = document.createElement("div");
          r.className = "text-slate-300"; r.textContent = z;
          el.append(r);
        }
        el.append(schieber(() => { pickRef.current?.remove(); cb.current.onSelect(d); }));
        return el;
      };

      const liste = (ds: Dataset[]) => {
        const el = document.createElement("div");
        el.setAttribute("data-testid", "map-pick");
        el.className = "text-xs";
        const k = document.createElement("div");
        k.className = "text-slate-400 mb-1";
        k.textContent = `${ds.length} datasets at this station`;
        el.append(k);
        for (const d of ds) {
          const b = document.createElement("button");
          b.setAttribute("data-testid", "map-pick-row");
          b.setAttribute("data-ds", d.dataset_id);
          b.className = "block w-full text-left rounded px-2 py-1 text-slate-100 hover:bg-slate-700";
          b.textContent = name(d);
          b.onclick = () => pickRef.current?.setDOMContent(karte(d, () => {
            pickRef.current?.setDOMContent(liste(ds));
          }));
          el.append(b);
        }
        return el;
      };

      const haufen = (f?: maplibregl.MapGeoJSONFeature) =>
        f?.properties?.cluster ? Number(f.properties.cluster_id) : null;

      const hinter = (f?: maplibregl.MapGeoJSONFeature): Dataset[] => {
        const ids = String(f?.properties?.ids ?? f?.properties?.id ?? "").split(",").filter(Boolean);
        return ids.map((id) => cb.current.datasets.find((x) => x.dataset_id === id))
                  .filter(Boolean) as Dataset[];
      };

      const GRIFF = 16;
      const fenster = (pt: maplibregl.Point) =>
        map.queryRenderedFeatures(
          [[pt.x - GRIFF, pt.y - GRIFF], [pt.x + GRIFF, pt.y + GRIFF]] as unknown as
            [maplibregl.PointLike, maplibregl.PointLike],
          { layers: ["datasets"] });

      let zuletzt = "";
      map.on("mousemove", (e) => {
        const f = fenster(e.point)[0];
        const h = haufen(f);
        const ds = hinter(f);
        if (h != null && f) {
          const schluessel = `haufen:${h}`;
          if (schluessel === zuletzt) return;
          zuletzt = schluessel;
          map.getCanvas().style.cursor = "zoom-in";
          const el = document.createElement("div");
          el.className = "text-xs text-slate-200";
          el.textContent = `${f.properties.n} datasets in this area`;
          const c = document.createElement("div");
          c.className = "text-slate-400"; c.textContent = "click to zoom in";
          el.append(c);
          popupRef.current?.setLngLat((f.geometry as any).coordinates).setDOMContent(el).addTo(map);
          cb.current.onHover([]);
          return;
        }
        if (!ds.length) {
          if (zuletzt) {
            zuletzt = "";
            map.getCanvas().style.cursor = "";
            popupRef.current?.remove();
            cb.current.onHover([]);
          }
          return;
        }
        const schluessel = ds.map((d) => d.dataset_id).join(",");
        if (schluessel === zuletzt) return;
        zuletzt = schluessel;
        map.getCanvas().style.cursor = "pointer";
        if (f && popupRef.current) {
          const el = document.createElement("div");
          el.className = "text-xs space-y-0.5";
          for (const d of ds.slice(0, 4)) {
            const t = document.createElement("div");
            t.className = "text-slate-100";
            t.textContent = name(d);
            el.append(t);
          }
          if (ds.length > 4) {
            const r = document.createElement("div");
            r.className = "text-slate-400"; r.textContent = `and ${ds.length - 4} more`;
            el.append(r);
          }
          const c = document.createElement("div"); c.className = "text-slate-400 pt-0.5";
          c.textContent = ds.length > 1 ? "click to choose" : "click for details";
          el.append(c);
          popupRef.current.setLngLat((f.geometry as any).coordinates).setDOMContent(el).addTo(map);
          cb.current.onHover(ds.map((d) => d.dataset_id));
        }
      });
      map.on("mouseout", () => {
        zuletzt = "";
        map.getCanvas().style.cursor = ""; popupRef.current?.remove(); cb.current.onHover([]);
      });
      map.on("click", (e) => {
        const f = fenster(e.point)[0];
        const h = haufen(f);
        if (h != null && f) {
          popupRef.current?.remove(); pickRef.current?.remove();
          const q = map.getSource("datasets") as maplibregl.GeoJSONSource;
          Promise.resolve(q.getClusterExpansionZoom(h))
            .then((z) => map.easeTo({ center: (f.geometry as any).coordinates, zoom: z }))
            .catch(() => map.easeTo({ center: (f.geometry as any).coordinates,
                                      zoom: Math.min(12, map.getZoom() + 2) }));
          return;
        }
        const ds = hinter(f);
        if (!ds.length) return;
        popupRef.current?.remove();
        const wo = (f!.geometry as any).coordinates;
        pickRef.current?.setLngLat(wo)
          .setDOMContent(ds.length === 1 ? karte(ds[0]) : liste(ds)).addTo(map);
      });
      window.__mantaMapPixel = (id: string) => {
        const d = cb.current.datasets.find((x) => x.dataset_id === id && x.coords);
        if (!d) return null;
        const p = map.project(d.coords as [number, number]);
        return [p.x, p.y];
      };
      window.__mantaMapInfo = () => ({
        projection: (map as any).getProjection?.()?.type ?? "unknown",
        layers: map.getStyle().layers.map((l) => l.id),
        bathyFeatures: map.getSource("bathy") ? nFeatures.current : 0,
        punkte: [...new Map(map.querySourceFeatures("datasets").map((f) => [
          f.properties?.cluster ? `h${f.properties.cluster_id}` : String(f.properties?.ids ?? ""),
          { n: Number(f.properties?.n ?? 1), haufen: !!f.properties?.cluster },
        ])).values()],
      });
      cb.current.onReady?.();
    });

    const ro = new ResizeObserver(() => map.resize());
    ro.observe(box.current);
    return () => {
      ro.disconnect();
      popupRef.current?.remove(); pickRef.current?.remove();
      markerRef.current?.remove(); markerRef.current = null;
      map.remove(); mapRef.current = null; loaded.current = false;
      delete window.__mantaMapInfo; delete window.__mantaMapPixel;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded.current) return;
    pickRef.current?.remove();
    (map.getSource("datasets") as maplibregl.GeoJSONSource | undefined)?.setData(datasetsGeo(datasets));
  }, [datasets]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded.current || !map.getLayer("bathy-fill")) return;
    if (metaRef.current) {
      map.setPaintProperty("bathy-fill", "fill-color", fillColorExpr(metaRef.current, light));
      if (map.getLayer("bathy-seam")) map.setPaintProperty("bathy-seam", "line-color", fillColorExpr(metaRef.current, light));
    } else map.setPaintProperty("bathy-fill", "fill-color", light ? LAND_LIGHT : LAND_DARK);
  }, [light]);

  useEffect(() => {
    const map = mapRef.current;
    markerRef.current?.remove(); markerRef.current = null;
    const d = datasets.find((x) => x.dataset_id === editId && x.coords);
    if (!map || !d) { onHandles(0); return; }
    const m = new maplibregl.Marker({ draggable: true, color: "#f59e0b" })
      .setLngLat(d.coords as [number, number]).addTo(map);
    m.on("dragend", () => {
      const p = m.getLngLat().wrap();
      cb.current.onMove(d.dataset_id, Number(p.lat.toFixed(4)), Number(p.lng.toFixed(4)))
        .then(() => cb.current.onMoveError(null))
        .catch((e) => { cb.current.onMoveError(String(e?.message ?? e)); m.setLngLat(d.coords as [number, number]); });
    });
    markerRef.current = m;
    onHandles(1);
    return () => { m.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId, datasets]);

  return (
    <div className="absolute inset-0" data-testid="globe-map">
      <div ref={box} className="h-full w-full" />
    </div>
  );
}
