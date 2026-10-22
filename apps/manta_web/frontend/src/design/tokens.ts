import { useEffect, useState } from "react";


export type Tokens = {
  light: boolean;
  surface: string; raised: string; overlay: string;
  control: string; controlHover: string; controlStrong: string;
  text: string; textMuted: string; textDisabled: string;
  border: string; borderStrong: string; borderSubtle: string;
  accent: string; accentFill: string; accentSoft: string; onAccent: string;
  warn: string; warnFill: string; danger: string; dangerFill: string; ok: string;
  chartGrid: string; chartAxis: string; chartLine: string;
  netLink: string; netNodeOutline: string; netLabel: string;
  mark: string; crossLink: string;
};

const NAMES: Record<Exclude<keyof Tokens, "light">, string> = {
  surface: "--surface", raised: "--raised", overlay: "--overlay",
  control: "--control", controlHover: "--control-hover", controlStrong: "--control-strong",
  text: "--text", textMuted: "--text-muted", textDisabled: "--text-disabled",
  border: "--border", borderStrong: "--border-strong", borderSubtle: "--border-subtle",
  accent: "--accent", accentFill: "--accent-fill", accentSoft: "--accent-soft",
  onAccent: "--on-accent",
  warn: "--warn", warnFill: "--warn-fill", danger: "--danger", dangerFill: "--danger-fill",
  ok: "--ok",
  chartGrid: "--chart-grid", chartAxis: "--chart-axis", chartLine: "--chart-line",
  netLink: "--net-link", netNodeOutline: "--net-node-outline", netLabel: "--net-label",
  mark: "--mark", crossLink: "--cross-link",
};

export const isLight = () =>
  typeof document !== "undefined" && document.documentElement.classList.contains("light");

export function readTokens(): Tokens {
  const out = { light: isLight() } as Tokens;
  const cs = typeof document !== "undefined"
    ? getComputedStyle(document.documentElement) : null;
  for (const [k, v] of Object.entries(NAMES)) {
    (out as Record<string, unknown>)[k] = cs?.getPropertyValue(v).trim() || "#888888";
  }
  return out;
}

export function useTokens(): Tokens {
  const [t, setT] = useState<Tokens>(readTokens);
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => {
      setT((alt) => (alt.light === isLight() ? alt : readTokens()));
    });
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    setT((alt) => (alt.light === isLight() ? alt : readTokens()));
    return () => obs.disconnect();
  }, []);
  return t;
}

export const FONT = { xs2: 11, xs: 12, sm: 14, base: 16, xl: 20 } as const;

export function chartTooltip(t: Tokens) {
  return {
    backgroundColor: t.overlay,
    borderColor: t.border,
    borderWidth: 1,
    textStyle: { color: t.text, fontSize: FONT.xs },
    extraCssText: "box-shadow: 0 4px 16px rgb(0 0 0 / 0.25); border-radius: 6px;",
  };
}

export function chartAxis(t: Tokens) {
  return {
    axisLine: { lineStyle: { color: t.chartAxis } },
    axisTick: { lineStyle: { color: t.chartAxis } },
    axisLabel: { color: t.textMuted, fontSize: FONT.xs2 },
    splitLine: { lineStyle: { color: t.chartGrid } },
    nameTextStyle: { color: t.textMuted, fontSize: FONT.xs2 },
  };
}
