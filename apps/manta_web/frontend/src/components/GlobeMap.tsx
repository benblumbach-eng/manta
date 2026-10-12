import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Dataset } from "../api";


export type BathyClass = { key: string; name: string; lo: number | null; hi: number | null };
export type BathyMeta = {
  source: { name: string; citation: string; access: string; licence: string };
  classes: BathyClass[]; land: BathyClass; generated: string;
  coarse: { cell_deg: number }; windows: { file: string; cell_deg: number }[];
};

export { DEPTH_RAMP_DARK, DEPTH_RAMP_LIGHT, LAND_DARK, LAND_LIGHT } from "../design/dataColours";
import { DEPTH_RAMP_DARK, DEPTH_RAMP_LIGHT, LAND_DARK, LAND_LIGHT, MAP_POINT } from "../design/dataColours";
import { readTokens } from "../design/tokens";

function fillColorExpr(meta: BathyMeta, light: boolean): any {
  const ramp = light ? DEPTH_RAMP_LIGHT : DEPTH_RAMP_DARK;
  const pairs: any[] = [];
  meta.classes.forEach((c, i) => { pairs.push(c.key, ramp[Math.min(i, ramp.length - 1)]); });
  pairs.push("land", light ? LAND_LIGHT : LAND_DARK);
  return ["match", ["get", "name"], ...pairs, readTokens().surface];
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
                             bathyFill?: string | null;
                             punkte?: { n: number; haufen: boolean }[] };
    __mantaMapPixel?: (id: string) => [number, number] | null;
  }
}

export default function GlobeMap({ datasets, editId, light, onSelect, onHover, onMove, onApi,
                                   onMoveError, onBathy, onHandles, onReady, onUnavailable }: {
  datasets: Dataset[]; editId: string | null; light: boolean;
  onSelect: (d: Dataset) => void;
  onHover: (ids: string[]) => void;
  onMove: (id: string, lat: number, lon: number) => Promise<void>;
  onMoveError: (msg: string | null) => void;
  onBathy: (meta: BathyMeta | null) => void;
  onHandles: (n: number) => void;
  onReady?: () => void;
  onUnavailable?: () => void;
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
  const cb = useRef({ onSelect, onHover, onMove, onMoveError, onBathy, onHandles, onReady, onApi,
                      onUnavailable, datasets });
  cb.current = { onSelect, onHover, onMove, onMoveError, onBathy, onHandles, onReady, onApi,
                 onUnavailable, datasets };
  const lightRef = useRef(light);
  lightRef.current = light;

  const [noGl, setNoGl] = useState(false);

  useEffect(() => {
    if (!box.current) return;
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
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
    } catch (e) {
      console.error("MANTA: the globe could not start (WebGL?)", e);
      setNoGl(true);
      cb.current.onUnavailable?.();
      return;
    }
    mapRef.current = map;
    cb.current.onApi?.({ zoomIn: () => map.zoomIn(), zoomOut: () => map.zoomOut(),
                         reset: () => map.easeTo({ center: [5, 45], zoom: 1.4 }) });

    const bathyAbort = new AbortController();

    map.on("load", () => {
      loaded.current = true;
      fetch("/bathymetry.json", { signal: bathyAbort.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((geo) => {
          if (bathyAbort.signal.aborted || mapRef.current !== map || !map.getLayer("datasets")) return;
          if (!Array.isArray(geo?.features) || !geo?.bathymetry?.classes) throw new Error("bathymetry.json has no header");
          metaRef.current = geo.bathymetry as BathyMeta;
          nFeatures.current = geo.features.length;
          map.addSource("bathy", { type: "geojson", data: geo });
          map.addLayer({
            id: "bathy-fill", type: "fill", source: "bathy",
            paint: { "fill-color": fillColorExpr(metaRef.current, lightRef.current), "fill-antialias": false },
          }, "datasets");
          map.addLayer({
            id: "bathy-seam", type: "line", source: "bathy",
            paint: { "line-color": fillColorExpr(metaRef.current, lightRef.current), "line-width": 1.5 },
          }, "datasets");
          cb.current.onBathy(metaRef.current);
        })
        .catch((e) => {
          if (bathyAbort.signal.aborted || e?.name === "AbortError") return;
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
                 "circle-color": MAP_POINT.fill,
                 "circle-stroke-color": readTokens().surface, "circle-stroke-width": 1.5 },
      });
      map.addLayer({
        id: "datasets-n", type: "symbol", source: "datasets",
        filter: [">", ["get", "n"], 1],
        layout: { "text-field": ["to-string", ["get", "n"]] as never, "text-size": 11,
                  "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
                  "text-allow-overlap": true, "text-ignore-placement": true },
        paint: { "text-color": MAP_POINT.label },
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
        spur.className = "relative mt-2 h-9 w-56 rounded-full border border-line-strong "
          + "bg-control/80 overflow-hidden select-none";
        const text = document.createElement("div");
        text.className = "absolute inset-0 grid place-items-center text-2xs text-fg-muted "
          + "pointer-events-none";
        text.textContent = "slide to open network";
        const griff = document.createElement("button");
        griff.setAttribute("data-testid", "map-card-knob");
        griff.setAttribute("aria-label", "slide to open network");
        griff.className = "absolute left-1 top-1 h-7 w-7 rounded-full bg-accent-fill text-on-warn "
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
          z.className = "text-accent hover:underline mb-1";
          z.textContent = "‹ all datasets here";
          z.onclick = zurueck;
          el.append(z);
        }
        const t = document.createElement("div");
        t.className = "text-sm font-medium text-fg"; t.textContent = name(d);
        el.append(t);
        const c = d.coords as number[] | null;
        const p = d.derived?.params;
        const zeilen = [
          c ? `${c[1].toFixed(2)}°N ${c[0].toFixed(2)}°E${d.station ? ` · ${d.station}` : ""}` : null,
          `${d.n_sample} samples`,
          `${d.n_asv} ASVs · ${d.n_network} in the network`,
          d.derived ? `recomputed ${(d.derived.at ?? "").slice(0, 10) || "—"}`
            + (p ? ` · CON r ≥ ${p.con_tr} · α ${p.con_alpha} · ${p.num_permutations} permutations` : "")
            : null,
        ].filter(Boolean) as string[];
        for (const z of zeilen) {
          const r = document.createElement("div");
          r.className = "text-fg"; r.textContent = z;
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
        k.className = "text-fg-muted mb-1";
        k.textContent = `${ds.length} datasets at this station`;
        el.append(k);
        const hier = new Set(ds.map((d) => d.dataset_id));
        const von = (d: Dataset) => (d.derived?.from && hier.has(d.derived.from) ? d.derived.from : null);
        const geordnet: { d: Dataset; tiefe: number }[] = [];
        const drin = new Set<string>();
        const haenge = (d: Dataset, tiefe: number) => {
          if (drin.has(d.dataset_id)) return;
          drin.add(d.dataset_id); geordnet.push({ d, tiefe });
          ds.filter((x) => von(x) === d.dataset_id)
            .sort((a, b) => (a.derived?.at ?? "").localeCompare(b.derived?.at ?? ""))
            .forEach((x) => haenge(x, tiefe + 1));
        };
        ds.filter((d) => !von(d)).forEach((d) => haenge(d, 0));
        ds.forEach((d) => haenge(d, 0));
        for (const { d, tiefe } of geordnet) {
          const b = document.createElement("button");
          b.setAttribute("data-testid", "map-pick-row");
          b.setAttribute("data-ds", d.dataset_id);
          b.className = "block w-full text-left rounded px-2 py-1 text-fg hover:bg-control-hover";
          if (tiefe > 0) b.style.paddingLeft = `${8 + Math.min(tiefe, 4) * 12}px`;
          b.textContent = (tiefe > 0 ? "↳ " : "") + name(d);
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
          el.className = "text-xs text-fg";
          el.textContent = `${f.properties.n} datasets in this area`;
          const c = document.createElement("div");
          c.className = "text-fg-muted"; c.textContent = "click to zoom in";
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
          el.className = "text-xs space-y-1";
          for (const d of ds.slice(0, 4)) {
            const t = document.createElement("div");
            t.className = "text-fg";
            t.textContent = name(d);
            el.append(t);
          }
          if (ds.length > 4) {
            const r = document.createElement("div");
            r.className = "text-fg-muted"; r.textContent = `and ${ds.length - 4} more`;
            el.append(r);
          }
          const c = document.createElement("div"); c.className = "text-fg-muted pt-1";
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
        bathyFill: map.getLayer("bathy-fill")
          ? JSON.stringify(map.getPaintProperty("bathy-fill", "fill-color")) : null,
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
      bathyAbort.abort();
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
    const m = new maplibregl.Marker({ draggable: true, color: MAP_POINT.newPoint })
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
      {noGl && (
        <div data-testid="globe-unavailable"
          className="absolute inset-0 grid place-items-center p-6 text-sm text-fg-muted">
          <p className="max-w-sm text-center leading-snug">
            The globe needs WebGL, which this browser does not provide — pick a dataset from
            the list on the left.
          </p>
        </div>
      )}
    </div>
  );
}
