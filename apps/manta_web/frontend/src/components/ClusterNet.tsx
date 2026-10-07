import type { EdgeRef } from "../App";
import type { ClusterDetail } from "../api";
import { useModules } from "../modules";
import { pfeilPunkte } from "./netzpfeil";

type Buendel = {
  partner: number; total: number; edges: ClusterDetail["bridge_edges"];
  raus?: number; rein?: number;
};

const MAX_GEZEIGT = 12;

export default function ClusterNet({ label, partners, onOpenCluster, onOpenEdge }: {
  label: number;
  partners: Buendel[];
  onOpenCluster?: (label: number) => void;
  onOpenEdge?: (e: EdgeRef) => void;
}) {
  const modules = useModules();
  const alle = [...partners].sort((a, b) => b.total - a.total || a.partner - b.partner);
  const gezeigt = alle.slice(0, MAX_GEZEIGT);
  if (alle.length === 0) return null;

  const W = 460, H = 260, CX = W / 2, CY = H / 2, R = 92;
  const maxT = Math.max(...gezeigt.map((b) => b.total), 1);
  const winkel = (i: number) => (i / gezeigt.length) * 2 * Math.PI - Math.PI / 2;
  const punkt = (i: number) => [CX + R * Math.cos(winkel(i)), CY + R * Math.sin(winkel(i))] as const;

  return (
    <div data-testid="cluster-net" data-n={alle.length} data-shown={gezeigt.length}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img"
           aria-label={`the clusters ${modules.label(label)} is connected to`}>
        {gezeigt.map((b, i) => {
          const [x, y] = punkt(i);
          const breite = 1 + 3 * (b.total / maxT);
          const stark = b.edges[0];
          const mx = (CX + x) / 2, my = (CY + y) / 2;
          const raus = b.raus ?? 0, rein = b.rein ?? 0;
          return (
            <g key={b.partner} className={stark ? "cursor-pointer" : undefined}
               onClick={() => stark && onOpenEdge?.({ source: stark.mine, target: stark.other,
                                                      type: "con" })}>
              <title>{`${b.total} link${b.total === 1 ? "" : "s"} to ${modules.label(b.partner)}`
                + (raus || rein
                   ? ` · directed (CCM): ${raus} out, ${rein} in` : "")
                + (stark ? ` — opens the strongest of them (r ${stark.corr.toFixed(2)})`
                         : " — the individual links are not in this answer")}</title>
              <line x1={CX} y1={CY} x2={x} y2={y} stroke="transparent" strokeWidth={14} />
              <line x1={CX} y1={CY} x2={x} y2={y} stroke="#64748b" strokeWidth={breite}
                    opacity={0.75} />
              {raus > 0 && (
                <polygon data-testid="cluster-net-arrow" data-partner={b.partner} data-dir="out"
                         points={pfeilPunkte(CX, CY, x, y, 0.72, "hin")} fill="#e2e8f0"
                         opacity={0.9} />
              )}
              {rein > 0 && (
                <polygon data-testid="cluster-net-arrow" data-partner={b.partner} data-dir="in"
                         points={pfeilPunkte(CX, CY, x, y, 0.28, "zurueck")} fill="#e2e8f0"
                         opacity={0.9} />
              )}
              <circle cx={mx} cy={my} r={8.5} fill="#0f172a" opacity={0.85} />
              <text x={mx} y={my + 3} fontSize={8} fill="#cbd5e1" textAnchor="middle"
                    className="pointer-events-none tabular-nums">{b.total}</text>
              <circle data-testid="cluster-net-link" data-partner={b.partner}
                      cx={mx} cy={my} r={10} fill="#0f172a" opacity={0.01} />
            </g>
          );
        })}
        {gezeigt.map((b, i) => {
          const [x, y] = punkt(i);
          const rechts = x >= CX;
          return (
            <g key={`n-${b.partner}`} className="cursor-pointer"
               onClick={() => onOpenCluster?.(b.partner)}>
              <title>{`${modules.label(b.partner)} — open this cluster`}</title>
              <circle data-testid="cluster-net-node" data-partner={b.partner}
                      cx={x} cy={y} r={9} fill={modules.color(b.partner)}
                      stroke="#0f172a" strokeWidth={1.5} />
              <text x={x + (rechts ? 13 : -13)} y={y + 3} fontSize={9} fill="#cbd5e1"
                    textAnchor={rechts ? "start" : "end"}>{modules.label(b.partner)}</text>
            </g>
          );
        })}
        <circle cx={CX} cy={CY} r={12} fill={modules.color(label)} stroke="#0f172a" strokeWidth={2} />
        <text x={CX} y={CY + 26} fontSize={9} fill="#e2e8f0" textAnchor="middle">
          {modules.label(label)}
        </text>
      </svg>
      <p className="text-[10px] text-slate-500">
        Every line leaves this module · width and number = links · arrow = a directed link (CCM)
      </p>
      <p className="text-[10px] text-slate-500">
        A click opens the strongest link of that bundle
      </p>
      {alle.length > gezeigt.length && (
        <p className="text-[10px] text-amber-400/90" data-testid="cluster-net-truncated">
          Showing the {gezeigt.length} strongest of {alle.length} connected clusters.
        </p>
      )}
    </div>
  );
}
