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

export const NO_MODULE_COLOUR = "#94a3b8";
