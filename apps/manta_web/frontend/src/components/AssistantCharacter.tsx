export default function AssistantCharacter({ onClick, offset = 0 }: {
  onClick: () => void;
  offset?: number;
}) {
  return (
    <button
      type="button"
      data-testid="agent-character"
      aria-label="Open the assistant"
      title="Ask the assistant"
      onClick={onClick}
      style={{ right: 16 + offset }}
      className="absolute bottom-4 z-40 group flex flex-col items-center focus:outline-none
                 focus-visible:ring-2 focus-visible:ring-cyan-400 rounded-full"
    >
      <span className="mb-1 px-2 py-0.5 rounded-full border border-slate-600 bg-slate-900/95
                       text-[11px] text-slate-200 opacity-0 translate-y-1 transition
                       group-hover:opacity-100 group-hover:translate-y-0 pointer-events-none">
        Ask the assistant
      </span>
      <svg width="72" height="60" viewBox="0 0 72 60" className="manta-float drop-shadow-lg"
        aria-hidden="true">
        <defs>
          <linearGradient id="manta-body" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#67e8f9" />
            <stop offset="1" stopColor="#0e7490" />
          </linearGradient>
        </defs>
        <path d="M36 40 Q34 50 30 57 Q37 52 38 42 Z" fill="#155e75" />
        <path d="M29 10 Q26 4 22 2 Q25 9 28 13 Z" fill="#0e7490" />
        <path d="M43 10 Q46 4 50 2 Q47 9 44 13 Z" fill="#0e7490" />
        <path d="M36 7
                 C 42 7, 50 10, 70 24
                 C 56 25, 48 29, 44 35
                 C 42 41, 39 44, 36 44
                 C 33 44, 30 41, 28 35
                 C 24 29, 16 25, 2 24
                 C 22 10, 30 7, 36 7 Z"
          fill="url(#manta-body)" stroke="#164e63" strokeWidth="1" />
        <circle cx="30" cy="16" r="2.4" fill="#0f172a" />
        <circle cx="42" cy="16" r="2.4" fill="#0f172a" />
        <circle cx="30.9" cy="15.2" r="0.8" fill="#e2e8f0" />
        <circle cx="42.9" cy="15.2" r="0.8" fill="#e2e8f0" />
        <path d="M31 26 q1.6 2 0 4 M35 27 q1.6 2 0 4 M39 26 q-1.6 2 0 4"
          stroke="#164e63" strokeWidth="1" fill="none" strokeLinecap="round"
          transform="translate(-1.5 0)" />
      </svg>
    </button>
  );
}
