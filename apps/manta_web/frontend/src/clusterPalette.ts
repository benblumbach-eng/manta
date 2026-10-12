export const MODULE_PALETTE = {
  dark: ["#318ef7", "#059a7d", "#5943ec", "#a63b5c", "#2bab21", "#e841c3", "#717a02", "#a420b5"],
  light: ["#1184f7", "#079d7f", "#4f32dd", "#8f2a4b", "#0da300", "#b50095", "#646d04", "#b35fbf"],
} as const;
export const MODULE_OTHER = { dark: "#a3a3a3", light: "#9ca3af" } as const;

const themeLight = () =>
  typeof document !== "undefined" && document.documentElement.classList.contains("light");

export function clusterColor(label: number | null | undefined, light = themeLight()): string {
  const pal = light ? MODULE_PALETTE.light : MODULE_PALETTE.dark;
  const grey = light ? MODULE_OTHER.light : MODULE_OTHER.dark;
  if (label == null || !Number.isFinite(label) || label < 0 || label >= pal.length) return grey;
  return pal[label];
}

export const moduleIsGrey = (label: number | null | undefined) =>
  label == null || label < 0 || label >= MODULE_PALETTE.dark.length;

export const CLUSTER_PALETTE_SIZE = MODULE_PALETTE.dark.length;

const FUNCTION_PALETTE = {
  dark: [
    "#E69F00",
    "#56B4E9",
    "#009E73",
    "#F0E442",
    "#0072B2",
    "#D55E00",
    "#CC79A7",
    "#B07AA1",
    "#9C755F",
  ],
  light: ["#a86f00", "#1f7fb8", "#007a59", "#7f7700", "#0072B2", "#b84e00", "#b0507f", "#8e5b81",
          "#7d5c48"],
} as const;
export const FUNCTION_OTHER_COLOURS = { dark: "#f1f5f9", light: "#1e293b" } as const;
export const functionOther = (light = themeLight()) =>
  light ? FUNCTION_OTHER_COLOURS.light : FUNCTION_OTHER_COLOURS.dark;
export const FUNCTION_NONE = "#94a3b8";

export function functionColor(i: number, light = themeLight()): string {
  const pal = light ? FUNCTION_PALETTE.light : FUNCTION_PALETTE.dark;
  return i >= 0 && i < pal.length ? pal[i] : functionOther(light);
}

export const FUNCTION_PALETTE_SIZE = FUNCTION_PALETTE.dark.length;
