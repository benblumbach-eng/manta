import type { EdgeRef } from "../App";
import type { Neighbor } from "../api";
import { useModules } from "../modules";
import { pfeilPunkte } from "./netzpfeil";

type Partner = {
  id: string; genus: string | null; cluster: number | null;
  corr?: number; nmi?: number; con: boolean; ccm: boolean;
  direction?: "out" | "in" | "both" | null;
};

const MAX_GEZEIGT = 16;

export default function NeighbourNet({ asvId, cluster, neighbors, onOpenAsv, onOpenEdge }: {
  asvId: string;
  cluster: number | null;
  neighbors: { con: Neighbor[]; ccm: Neighbor[] };
  onOpenAsv: (id: string) => void;
  onOpenEdge: (e: EdgeRef) => void;
}) {
  const modules = useModules();
  const zusammen = new Map<string, Partner>();
  for (const n of neighbors.con) {
    zusammen.set(n.id, { id: n.id, genus: n.genus, cluster: n.cluster, corr: n.corr,
                         con: true, ccm: false });
  }
  for (const n of neighbors.ccm) {
    const vorhanden = zusammen.get(n.id);
    if (vorhanden) { vorhanden.ccm = true; vorhanden.nmi = n.nmi; vorhanden.direction = n.direction; }
    else zusammen.set(n.id, { id: n.id, genus: n.genus, cluster: n.cluster, nmi: n.nmi,
                              con: false, ccm: true, direction: n.direction });
  }
  const staerke = (p: Partner) => p.corr ?? p.nmi ?? 0;
  const alle = [...zusammen.values()].sort((a, b) => staerke(b) - staerke(a));
  const gezeigt = alle.slice(0, MAX_GEZEIGT);

  if (alle.length === 0) {
    return (
      <p className="text-xs text-amber-400/90" data-testid="neighbour-net-absent">
        No links at the current thresholds. That is a result, not a gap.
      </p>
    );
  }

  const W = 460, H = 260, CX = W / 2, CY = H / 2, R = 96;
  const maxS = Math.max(...gezeigt.map(staerke), 1e-9);
  const winkel = (i: number) => (i / gezeigt.length) * 2 * Math.PI - Math.PI / 2;
  const punkt = (i: number) => [CX + R * Math.cos(winkel(i)), CY + R * Math.sin(winkel(i))] as const;

  return (
    <div data-testid="neighbour-net" data-n={alle.length} data-shown={gezeigt.length}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img"
           aria-label={`the direct neighbours of ${asvId}`}>
        {gezeigt.map((p, i) => {
          const [x, y] = punkt(i);
          const breite = 1 + 3 * (staerke(p) / maxS);
          const art = p.con ? "con" : "ccm";
          const wert = p.corr != null ? `r ${p.corr.toFixed(2)}`
                     : p.nmi != null ? `NMI ${p.nmi.toFixed(2)}` : "";
          const fremd = p.cluster != null && cluster != null && p.cluster !== cluster;
          const richtung = p.ccm ? (p.direction ?? null) : null;
          return (
            <g key={p.id} className="cursor-pointer"
               onClick={() => onOpenEdge({ source: asvId, target: p.id, type: art })}>
              <title>{`${p.id} · ${wert}`
                + (fremd ? ` · leaves this module (${modules.label(p.cluster)})` : "")
                + (richtung === "both" ? " · directed both ways (CCM)"
                   : richtung === "out" ? " · directed link (CCM) from this ASV"
                   : richtung === "in" ? " · directed link (CCM) to this ASV"
                   : p.ccm ? " · with a directed link (CCM)" : "")
                + " — open the link"}</title>
              <line x1={CX} y1={CY} x2={x} y2={y} stroke="transparent" strokeWidth={14} />
              <line x1={CX} y1={CY} x2={x} y2={y} stroke="#64748b" strokeWidth={breite}
                    strokeDasharray={fremd ? "5 3" : undefined}
                    data-testid={fremd ? "neighbour-net-crossing" : undefined} data-asv={p.id}
                    opacity={0.75} />
              {(richtung === "out" || richtung === "both") && (
                <polygon data-testid="neighbour-net-arrow" data-asv={p.id} data-dir="out"
                         points={pfeilPunkte(CX, CY, x, y, 0.66, "hin")} fill="#e2e8f0"
                         opacity={0.9} />
              )}
              {(richtung === "in" || richtung === "both") && (
                <polygon data-testid="neighbour-net-arrow" data-asv={p.id} data-dir="in"
                         points={pfeilPunkte(CX, CY, x, y, 0.34, "zurueck")} fill="#e2e8f0"
                         opacity={0.9} />
              )}
              <circle data-testid="neighbour-net-link" data-asv={p.id}
                      cx={(CX + x) / 2} cy={(CY + y) / 2} r={9} fill="#0f172a" opacity={0.01} />
            </g>
          );
        })}
        {gezeigt.map((p, i) => {
          const [x, y] = punkt(i);
          const rechts = x >= CX;
          return (
            <g key={`n-${p.id}`} className="cursor-pointer" onClick={() => onOpenAsv(p.id)}>
              <title>{`${p.id}${p.genus ? ` · ${p.genus}` : ""} · ${modules.label(p.cluster)} — open this ASV`}</title>
              <circle data-testid="neighbour-net-node" data-asv={p.id}
                      cx={x} cy={y} r={7} fill={modules.color(p.cluster)}
                      stroke="#0f172a" strokeWidth={1.5} />
              <text x={x + (rechts ? 11 : -11)} y={y + 3} fontSize={9} fill="#cbd5e1"
                    textAnchor={rechts ? "start" : "end"}>{p.id}</text>
            </g>
          );
        })}
        <circle cx={CX} cy={CY} r={10} fill="#22d3ee" stroke="#0f172a" strokeWidth={2} />
        <text x={CX} y={CY + 22} fontSize={9} fill="#e2e8f0" textAnchor="middle">{asvId}</text>
      </svg>
      <p className="text-[10px] text-slate-500">
        Width = strength · dashed = leaves this module · arrow = a directed link (CCM), as stored
      </p>
      {alle.length > gezeigt.length && (
        <p className="text-[10px] text-amber-400/90" data-testid="neighbour-net-truncated">
          Showing the {gezeigt.length} strongest of {alle.length} neighbours.
        </p>
      )}
    </div>
  );
}
