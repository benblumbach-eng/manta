from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

import numpy as np

try:
    import shapely
    import contourpy
    import netCDF4
    from shapely import make_valid
    from shapely.geometry import MultiPolygon, Polygon, mapping
    from shapely.ops import unary_union
except ImportError as e:
    sys.exit(f"fehlende Abhaengigkeit ({e}) — tools/bathymetry/.venv anlegen, s. README")

DEPTH_BOUNDS = [0, 50, 100, 200, 300, 400, 500, 1000, 2000, 3000, 4000, 6000]
DEEPEST = 12000
HIGHEST = 9500

SOURCE = {
    "name": "GEBCO_2020 Grid",
    "citation": ("GEBCO Compilation Group (2020). GEBCO 2020 Grid. "
                 "doi:10.5285/a29c5465-b138-234d-e053-6c86abc040b9"),
    "access": ("subsets via NOAA CoastWatch ERDDAP, dataset GEBCO_2020 "
               "(https://coastwatch.pfeg.noaa.gov/erddap/griddap/GEBCO_2020)"),
    "licence": "public domain (GEBCO terms of use)",
}


def depth_classes() -> list[dict]:
    out = []
    for lo, hi in zip(DEPTH_BOUNDS, DEPTH_BOUNDS[1:] + [None]):
        name = f"{lo}–{hi} m" if hi is not None else f"> {lo} m"
        out.append({"key": f"depth_{lo}", "name": name, "lo": lo, "hi": hi})
    return out


def class_for_elevation(z: float) -> str:
    if np.isnan(z):
        return "none"
    if z >= 0:
        return "land"
    depth = -z
    for lo, hi in zip(DEPTH_BOUNDS, DEPTH_BOUNDS[1:] + [None]):
        if hi is None or depth < hi:
            return f"depth_{lo}"
    raise AssertionError("unreachable")


def read_grid(path: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    with netCDF4.Dataset(path) as d:
        lon = np.asarray(d["longitude"][:], dtype=float)
        lat = np.asarray(d["latitude"][:], dtype=float)
        z = np.ma.filled(d["elevation"][:].astype(float), np.nan)
    if lat[0] > lat[-1]:
        lat, z = lat[::-1], z[::-1, :]
    if lon[0] > lon[-1]:
        lon, z = lon[::-1], z[:, ::-1]
    return lon, lat, z


def _polys_from_filled(points_list, offsets_list) -> list[Polygon]:
    out = []
    for pts, offs in zip(points_list, offsets_list):
        if pts is None or len(pts) < 4:
            continue
        rings = [pts[offs[k]:offs[k + 1]] for k in range(len(offs) - 1)]
        rings = [r for r in rings if len(r) >= 4]
        if not rings:
            continue
        poly = Polygon(rings[0], rings[1:])
        if not poly.is_valid:
            poly = make_valid(poly)
        out.append(poly)
    return out


def bands_for_grid(lon, lat, z, mask: np.ndarray | None = None) -> dict[str, list[Polygon]]:
    zz = np.ma.array(z, mask=np.isnan(z) if mask is None else (np.isnan(z) | mask))
    gen = contourpy.contour_generator(x=lon, y=lat, z=zz, fill_type=contourpy.FillType.OuterOffset,
                                      corner_mask=True)
    bands: dict[str, list[Polygon]] = {}
    for lo, hi in zip(DEPTH_BOUNDS, DEPTH_BOUNDS[1:] + [DEEPEST]):
        lower, upper = -float(hi) + 1e-9, -float(lo) + 1e-9
        if lo == 0:
            upper = 0.0
        pts, offs = gen.filled(lower, upper)
        bands[f"depth_{lo}"] = _polys_from_filled(pts, offs)
    pts, offs = gen.filled(0.0, float(HIGHEST))
    bands["land"] = _polys_from_filled(pts, offs)
    return bands


def _round_coords(geom, ndigits: int):
    snapped = shapely.set_precision(geom, 10.0 ** (-ndigits))
    if snapped.geom_type == "Polygon":
        snapped = MultiPolygon([snapped])
    elif snapped.geom_type == "GeometryCollection":
        snapped = MultiPolygon([g for g in snapped.geoms if g.geom_type == "Polygon"]
                               + [q for g in snapped.geoms if g.geom_type == "MultiPolygon" for q in g.geoms])
    return json.loads(json.dumps(mapping(snapped)), parse_float=lambda s: round(float(s), ndigits))


def build(coarse: Path, fines: list[Path], simplify: float, simplify_fine: float,
          ndigits: int = 4) -> dict:
    lon, lat, z = read_grid(coarse)
    windows = []
    mask = np.zeros_like(z, dtype=bool)
    fine_bands: list[dict[str, list[Polygon]]] = []
    for f in fines:
        flon, flat, fz = read_grid(f)
        win = {"file": f.name, "lon": [float(flon.min()), float(flon.max())],
               "lat": [float(flat.min()), float(flat.max())],
               "cell_deg": round(float(abs(flon[1] - flon[0])), 5)}
        windows.append(win)
        dc = float(abs(lon[1] - lon[0]))
        inside = ((lon[None, :] > win["lon"][0] + dc) & (lon[None, :] < win["lon"][1] - dc) &
                  (lat[:, None] > win["lat"][0] + dc) & (lat[:, None] < win["lat"][1] - dc))
        mask |= inside
        fine_bands.append({k: [p.simplify(simplify_fine, preserve_topology=True) for p in v]
                           for k, v in bands_for_grid(flon, flat, fz).items()})
    coarse_bands = {k: [p.simplify(simplify, preserve_topology=True) for p in v]
                    for k, v in bands_for_grid(lon, lat, z, mask).items()}

    features = []
    land = {"key": "land", "name": "land", "lo": None, "hi": None}
    classes = depth_classes()
    for c in classes + [land]:
        polys = list(coarse_bands.get(c["key"], []))
        for fb in fine_bands:
            polys += fb.get(c["key"], [])
        polys = [p for p in polys if not p.is_empty]
        if not polys:
            continue
        geom = unary_union(polys)
        if not geom.is_valid:
            geom = make_valid(geom)
        if geom.geom_type == "Polygon":
            geom = MultiPolygon([geom])
        elif geom.geom_type == "GeometryCollection":
            geom = MultiPolygon([g for g in geom.geoms if g.geom_type == "Polygon"]
                                + [q for g in geom.geoms if g.geom_type == "MultiPolygon" for q in g.geoms])
        features.append({"type": "Feature",
                         "properties": {"name": c["key"], "label": c["name"],
                                        "lo": c["lo"], "hi": c["hi"]},
                         "geometry": _round_coords(geom, ndigits)})
    return {
        "type": "FeatureCollection",
        "features": features,
        "bathymetry": {
            "source": SOURCE,
            "generated": date.today().isoformat(),
            "coarse": {"file": coarse.name, "cell_deg": round(float(abs(lon[1] - lon[0])), 5)},
            "windows": windows,
            "classes": classes,
            "land": land,
            "unit": "m below sea level; 'land' = elevation >= 0 in the same grid",
        },
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--coarse", required=True, type=Path, help="globales Gitter (netCDF)")
    ap.add_argument("--fine", action="append", default=[], type=Path,
                    help="feines Fenster (netCDF), mehrfach moeglich")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--simplify", type=float, default=0.1, help="Toleranz grob, Grad")
    ap.add_argument("--simplify-fine", type=float, default=0.004, help="Toleranz fein, Grad")
    ap.add_argument("--digits", type=int, default=3, help="Nachkommastellen der Koordinaten (3 = ~100 m)")
    a = ap.parse_args()
    out = build(a.coarse, a.fine, a.simplify, a.simplify_fine, ndigits=a.digits)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(out, separators=(",", ":")) + "\n", encoding="utf-8")
    size = a.out.stat().st_size
    print(f"{a.out}: {len(out['features'])} Stufen, {size/1e6:.1f} MB, "
          f"{len(out['bathymetry']['windows'])} feine Fenster")
    return 0


if __name__ == "__main__":
    sys.exit(main())
