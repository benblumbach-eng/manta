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
  return {
    type: "FeatureCollection" as const,
    features: datasets.filter((d) => d.coords).map((d) => ({
      type: "Feature" as const,
      properties: { id: d.dataset_id, name: `${d.region ?? d.dataset_id} (${d.marker ?? "?"})` },
      geometry: { type: "Point" as const, coordinates: d.coords as [number, number] },
    })),
  };
}

declare global {
  interface Window {
    __mantaMapInfo?: () => { projection: string; layers: string[]; bathyFeatures: number };
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

      map.addSource("datasets", { type: "geojson", data: datasetsGeo(cb.current.datasets) });
      map.addLayer({
        id: "datasets", type: "circle", source: "datasets",
        paint: { "circle-radius": 7, "circle-color": "#ef4444",
                 "circle-stroke-color": "#0b1220", "circle-stroke-width": 1.5 },
      });
      popupRef.current = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10,
                                                className: "manta-popup" });
      map.on("mouseenter", "datasets", (e) => {
        map.getCanvas().style.cursor = "pointer";
        const f = e.features?.[0];
        const ids = Array.from(new Set((e.features ?? []).map((x) => String(x.properties?.id))));
        const ds = ids.map((id) => cb.current.datasets.find((x) => x.dataset_id === id)).filter(Boolean) as Dataset[];
        if (f && ds.length && popupRef.current) {
          const el = document.createElement("div");
          el.className = "text-xs space-y-1";
          for (const d of ds) {
            const b = document.createElement("div");
            const t = document.createElement("div"); t.className = "font-medium text-slate-100"; t.textContent = d.region ?? d.dataset_id;
            const l = document.createElement("div"); l.className = "text-slate-300";
            l.textContent = `Marker ${d.marker ?? "?"} · ${d.n_network} of ${d.n_asv} in the network · ${d.n_sample} samples`
              + (d.station ? ` · ${d.station}` : "");
            b.append(t, l); el.append(b);
          }
          const d0 = ds[0];
          const c = document.createElement("div"); c.className = "text-slate-400";
          c.textContent = `${(d0.coords as number[])[1].toFixed(2)}°N ${(d0.coords as number[])[0].toFixed(2)}°E · click to open`;
          el.append(c);
          popupRef.current.setLngLat((f.geometry as any).coordinates).setDOMContent(el).addTo(map);
          cb.current.onHover(ds.map((d) => d.dataset_id));
        }
      });
      map.on("mouseleave", "datasets", () => {
        map.getCanvas().style.cursor = ""; popupRef.current?.remove(); cb.current.onHover([]);
      });
      map.on("click", "datasets", (e) => {
        const ids = Array.from(new Set((e.features ?? []).map((x) => String(x.properties?.id))));
        const d = ids.map((id) => cb.current.datasets.find((x) => x.dataset_id === id)).find(Boolean);
        if (d) { popupRef.current?.remove(); cb.current.onSelect(d); }
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
      });
      cb.current.onReady?.();
    });

    const ro = new ResizeObserver(() => map.resize());
    ro.observe(box.current);
    return () => {
      ro.disconnect();
      markerRef.current?.remove(); markerRef.current = null;
      map.remove(); mapRef.current = null; loaded.current = false;
      delete window.__mantaMapInfo; delete window.__mantaMapPixel;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded.current) return;
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
