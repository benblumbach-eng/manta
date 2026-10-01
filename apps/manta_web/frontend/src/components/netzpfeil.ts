export function pfeilPunkte(x1: number, y1: number, x2: number, y2: number,
                            t: number, ziel: "hin" | "zurueck", groesse = 5): string {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = (dx / len) * (ziel === "hin" ? 1 : -1), uy = (dy / len) * (ziel === "hin" ? 1 : -1);
  const px = x1 + dx * t, py = y1 + dy * t;
  const sx = px + ux * groesse, sy = py + uy * groesse;
  const nx = -uy, ny = ux;
  return [`${sx},${sy}`,
          `${px + nx * groesse * 0.55},${py + ny * groesse * 0.55}`,
          `${px - nx * groesse * 0.55},${py - ny * groesse * 0.55}`].join(" ");
}
