import { useRef } from "react";
import type { ECharts } from "echarts";

// Clicking anywhere in the plot picks the nearest time point, not only a hit on its symbol.
export function useNearestPointClick(
  xs: number[], onPick: ((i: number) => void) | undefined,
) {
  const latest = useRef({ xs, onPick });
  latest.current = { xs, onPick };
  return (chart: ECharts) => {
    chart.getZr().on("click", (ev: { offsetX: number; offsetY: number }) => {
      const { xs: punkte, onPick: pick } = latest.current;
      if (!pick || !punkte.length) return;
      if (!chart.containPixel({ gridIndex: 0 }, [ev.offsetX, ev.offsetY])) return;
      const x = (chart.convertFromPixel({ seriesIndex: 0 }, [ev.offsetX, ev.offsetY]) as number[])[0];
      let best = 0;
      for (let i = 1; i < punkte.length; i++) {
        if (Math.abs(punkte[i] - x) < Math.abs(punkte[best] - x)) best = i;
      }
      pick(best);
    });
  };
}
