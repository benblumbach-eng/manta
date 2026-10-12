
type Pair<T> = { dark: T; light: T };
const pick = <T,>(p: Pair<T>, light: boolean): T => (light ? p.light : p.dark);

const SERIES: Pair<readonly string[]> = {
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
};
export const seriesColour = (i: number, light: boolean) => {
  const p = pick(SERIES, light);
  return p[Math.min(Math.max(0, i), p.length - 1)];
};
export const SERIES_SIZE = SERIES.dark.length;

export const primarySeries = (light: boolean) => seriesColour(0, light);

const YEAR_RAMP: Pair<readonly string[]> = {
  dark: ["#1c5cab", "#256abf", "#2a78d6", "#3987e5", "#5598e7", "#6da7ec", "#86b6ef", "#9ec5f4",
         "#b7d3f6", "#cde2fb"],
  light: ["#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95",
          "#104281", "#0d366b"],
};
export function yearColour(i: number, n: number, light: boolean): string {
  const r = pick(YEAR_RAMP, light);
  if (n <= 1) return r[r.length - 1];
  const k = Math.round((i / (n - 1)) * (r.length - 1));
  return r[Math.min(r.length - 1, Math.max(0, k))];
}

export const envColour = (light: boolean) => (light ? "#047857" : "#34d399");
export const envLabelColour = (light: boolean) => (light ? "#065f46" : "#a7f3d0");

export const sunColours = (light: boolean) => ({
  night: light ? "#4338ca" : "#818cf8",
  nightBand: light ? "#6366f1" : "#4338ca",
  day: light ? "#d97706" : "#fbbf24",
  twilight: light ? "#94a3b8" : "#64748b",
});

export const mixedLayerColours = (light: boolean) => ({
  within: light ? "#0e7490" : "#22d3ee",
  below: light ? "#c2410c" : "#f97316",
  unknown: light ? "#94a3b8" : "#64748b",
  band: light ? "#0284c7" : "#38bdf8",
});

const MARKER_RINGS: Pair<readonly string[]> = {
  dark: ["#e879f9", "#fb7185", "#a3e635", "#c084fc", "#34d399"],
  light: ["#a21caf", "#be123c", "#4d7c0f", "#7e22ce", "#047857"],
};
export const markerRings = (light: boolean) => pick(MARKER_RINGS, light);

export const glowRing = (light: boolean) =>
  light ? { ring: "#b45309", glow: "#d97706" } : { ring: "#fde68a", glow: "#fbbf24" };

export const DEPTH_RAMP_DARK = ["#cfe0ef", "#b3cee6", "#98bcdb", "#7fabcf", "#6899c2", "#5488b4",
                                "#4376a4", "#356592", "#2a5079", "#1e3c5e", "#132842", "#0d1a2e"];
export const DEPTH_RAMP_LIGHT = ["#f7fbff", "#e3eef9", "#cfe1f2", "#b9d3ea", "#a1c4e1", "#86b3d6",
                                 "#6aa1cb", "#4f8fc0", "#3a7db4", "#2b6aa6", "#1f5694", "#143f7a"];
export const LAND_DARK = "#3f4756";
export const LAND_LIGHT = "#9aa3ad";

export const MAP_POINT = { fill: "#ef4444", label: "#0b1220", newPoint: "#f59e0b" } as const;

export const MANTA_FIGURE = {
  light: "#67e8f9", body: "#22d3ee", mid: "#0e7490", deep: "#155e75", edge: "#164e63",
  eye: "#0f172a", glint: "#e2e8f0",
} as const;
