import type { EdgeRef } from "../App";
import type { EdgeDirection, Neighbor } from "../api";
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
  neighbors: { con: Neighbor[]; ccm: Neighbor[];
               directions?: Record<string, { out?: EdgeDirection; in?: EdgeDirection }> };
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
      <p className="text-xs text-warn" data-testid="neighbour-net-absent">
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
              <line x1={CX} y1={CY} x2={x} y2={y} stroke="var(--chart-line)" strokeWidth={breite}
                    strokeDasharray={fremd ? "5 3" : undefined}
                    data-testid={fremd ? "neighbour-net-crossing" : undefined} data-asv={p.id}
                    opacity={0.75} />
              {(richtung === "out" || richtung === "both") && (
                <polygon data-testid="neighbour-net-arrow" data-asv={p.id} data-dir="out"
                         points={pfeilPunkte(CX, CY, x, y, 0.66, "hin")} fill="var(--text)"
                         opacity={0.9} />
              )}
              {(richtung === "in" || richtung === "both") && (
                <polygon data-testid="neighbour-net-arrow" data-asv={p.id} data-dir="in"
                         points={pfeilPunkte(CX, CY, x, y, 0.34, "zurueck")} fill="var(--text)"
                         opacity={0.9} />
              )}
              <circle data-testid="neighbour-net-link" data-asv={p.id}
                      cx={(CX + x) / 2} cy={(CY + y) / 2} r={9} fill="var(--raised)" opacity={0.01} />
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
                      stroke="var(--raised)" strokeWidth={1.5} />
              <text x={x + (rechts ? 11 : -11)} y={y + 4} fontSize={11} fill="var(--text)"
                    textAnchor={rechts ? "start" : "end"}>{p.id}</text>
            </g>
          );
        })}
        <circle cx={CX} cy={CY} r={10} fill="var(--accent)" stroke="var(--raised)" strokeWidth={2} />
        <text x={CX} y={CY + 24} fontSize={11} fill="var(--text)" textAnchor="middle">{asvId}</text>
      </svg>
      {/* Draft: the same links as a list, strongest first; a row opens both ASVs in Inspect. */}
      <table className="w-full text-xs mt-1" data-testid="neighbour-list">
        <thead><tr className="text-fg-muted text-left">
          <th className="font-normal py-0.5">linked ASV</th><th className="font-normal">r</th>
          <th className="font-normal" title={`NMI of ${asvId} → linked ASV`}>NMI →</th>
          <th className="font-normal" title={`NMI of linked ASV → ${asvId}`}>NMI ←</th><th /></tr></thead>
        <tbody>
          {alle.map((p) => (
            <tr key={p.id} className="border-t border-line hover:bg-control cursor-pointer"
                onClick={() => onOpenEdge({ source: asvId, target: p.id, type: p.con ? "con" : "ccm" })}>
              <td className="py-1">
                <span className="inline-block w-2 h-2 rounded-full mr-1 align-middle"
                      style={{ background: modules.color(p.cluster) }} />
                <span className="font-mono text-accent">{p.id}</span>
                {p.genus && <span className="text-fg-muted"> {p.genus}</span>}
              </td>
              <td className="tabular-nums">{p.corr != null ? p.corr.toFixed(2) : "—"}</td>
              <td><Nmi d={neighbors.directions?.[p.id]?.out} /></td>
              <td><Nmi d={neighbors.directions?.[p.id]?.in} /></td>
              <td className="text-right text-accent">Inspect ↗</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Green: direction kept by the permutation test; red: tested and rejected; — not tested.
function Nmi({ d }: { d?: EdgeDirection }) {
  if (!d) return <span className="text-fg-muted">—</span>;
  return (
    <span className={`tabular-nums ${d.decision === "rejected" ? "text-danger" : "text-ok"}`}
          title={`${d.decision === "rejected" ? "rejected" : "kept"} · p ${d.p_value ?? "—"}`}>
      {d.nmi.toFixed(2)}
    </span>
  );
}
