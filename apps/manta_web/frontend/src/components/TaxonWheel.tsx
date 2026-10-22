import { useEffect, useState } from "react";
import type { NetNode } from "../api";

const GAP = 0.035;

function sektor(cx: number, cy: number, ri: number, ro: number, a0: number, a1: number): string {
  const p = (r: number, a: number) => `${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`;
  const gross = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${p(ro, a0)} A ${ro} ${ro} 0 ${gross} 1 ${p(ro, a1)} `
       + `L ${p(ri, a1)} A ${ri} ${ri} 0 ${gross} 0 ${p(ri, a0)} Z`;
}

export default function TaxonWheel({ x, y, label, members, colorOf, moduleOf, onPick, onCenter, onClose }: {
  x: number;
  y: number;
  label: string;
  members: NetNode[];
  colorOf: (n: NetNode) => string;
  moduleOf: (n: NetNode) => string | null;
  onPick: (id: string) => void;
  onCenter: () => void;
  onClose: () => void;
}) {
  const n = members.length;
  const ro = Math.min(200, Math.max(120, 70 + 7 * n));
  const ri = ro * 0.5;
  const pad = 16;
  const size = 2 * (ro + pad);
  const c = size / 2;
  const [hover, setHover] = useState<number | null>(null);
  const [offen, setOffen] = useState(false);
  useEffect(() => { const t = requestAnimationFrame(() => setOffen(true)); return () => cancelAnimationFrame(t); }, []);

  const schritt = (2 * Math.PI) / Math.max(1, n);
  const h = hover != null ? members[hover] : null;
  const zeigeIds = n <= 16;

  return (
    <div className="absolute inset-0 z-10" data-testid="taxon-wheel"
      style={{ background: `radial-gradient(circle at ${x}px ${y}px, transparent ${ro}px, var(--scrim) ${ro + 160}px)`,
               opacity: offen ? 1 : 0, transition: "opacity 140ms ease-out" }}
      onClick={onClose} onWheel={onClose}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}
        className="absolute" onClick={(e) => e.stopPropagation()}
        style={{ left: x - c, top: y - c, overflow: "visible",
                 transform: `scale(${offen ? 1 : 0.7})`, transformOrigin: "center",
                 transition: "transform 180ms cubic-bezier(.2,1.4,.4,1)" }}>
        <defs>
          <filter id="wheel-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="6" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <circle cx={c} cy={c} r={ro + 6} fill="var(--surface)" stroke="var(--border)" strokeOpacity={0.6} />
        {members.map((m, i) => {
          const a0 = -Math.PI / 2 - schritt / 2 + i * schritt + (n > 1 ? GAP : 0);
          const a1 = a0 + schritt - (n > 1 ? 2 * GAP : 0);
          const mitte = (a0 + a1) / 2;
          const aktiv = hover === i;
          const raus = aktiv ? 8 : 0;
          const dx = raus * Math.cos(mitte), dy = raus * Math.sin(mitte);
          const farbe = colorOf(m);
          const rt = (ri + ro) / 2;
          return (
            <g key={m.id} data-testid="taxon-wheel-slot" style={{ cursor: "pointer",
                 transform: `translate(${dx}px, ${dy}px)`, transition: "transform 120ms ease-out" }}
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover((v) => (v === i ? null : v))}
              onClick={() => onPick(m.id)}>
              <path d={sektor(c, c, ri, ro, a0, a1)}
                fill={aktiv ? "var(--accent-soft)" : "var(--raised)"}
                stroke={aktiv ? "var(--accent)" : "var(--border)"} strokeWidth={aktiv ? 1.5 : 1}
                filter={aktiv ? "url(#wheel-glow)" : undefined} />
              <path d={sektor(c, c, ro - 5, ro, a0, a1)} fill={farbe} pointerEvents="none" />
              {zeigeIds ? (
                <text x={c + rt * Math.cos(mitte)} y={c + rt * Math.sin(mitte)}
                  textAnchor="middle" dominantBaseline="central" pointerEvents="none"
                  fontSize={11} fontFamily="ui-monospace, monospace"
                  fill={aktiv ? "var(--accent)" : "var(--text-muted)"}>
                  {m.id}
                </text>
              ) : (
                <circle cx={c + rt * Math.cos(mitte)} cy={c + rt * Math.sin(mitte)} r={3}
                  fill={aktiv ? "var(--accent)" : farbe} pointerEvents="none" />
              )}
            </g>
          );
        })}
        <g style={{ cursor: "pointer" }} onClick={onCenter} data-testid="taxon-wheel-center">
          <circle cx={c} cy={c} r={ri - 8} fill="var(--surface)" stroke="var(--border-strong)" />
          <foreignObject x={c - (ri - 14)} y={c - (ri - 14)} width={2 * (ri - 14)} height={2 * (ri - 14)}>
            <div className="h-full w-full flex flex-col items-center justify-center text-center leading-tight px-1">
              {h ? (
                <>
                  <div className="font-mono text-sm text-accent">{h.id}</div>
                  <div className="text-2xs text-fg-muted mt-1">{moduleOf(h) ?? "no module"}</div>
                  <div className="text-2xs text-fg-muted">{h.n_samples_present ?? "–"} samples</div>
                </>
              ) : (
                <>
                  <div className="text-xs font-medium text-fg break-words">{label}</div>
                  <div className="text-2xs text-fg-muted mt-1">{n} ASVs</div>
                </>
              )}
            </div>
          </foreignObject>
        </g>
      </svg>
    </div>
  );
}
