const PALETTE = [
  "#4477AA",
  "#EE6677",
  "#228833",
  "#CCBB44",
  "#AA3377",
  "#66CCEE",
  "#EE8866",
  "#44BB99",
  "#FFAABB",
  "#99DDFF",
  "#BBCC33",
  "#AA4499",
  "#DDCC77",
  "#882255",
];

export function clusterColor(label: number | null | undefined): string {
  if (label == null || !Number.isFinite(label)) return "#94a3b8";
  return PALETTE[((label % PALETTE.length) + PALETTE.length) % PALETTE.length];
}

export const CLUSTER_PALETTE_SIZE = PALETTE.length;
