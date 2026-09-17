export type Theme = "dark" | "light";

export default function ThemeSwitch({ theme, onTheme }:
  { theme: Theme; onTheme: (t: Theme) => void }) {
  return (
    <div className="flex items-center gap-1 text-xs" data-testid="theme-switch">
      <span className="text-slate-500">Theme</span>
      {(["dark", "light"] as const).map((t) => (
        <button key={t} data-testid={`theme-${t}`} onClick={() => onTheme(t)}
          className={`px-2 py-0.5 rounded border ${theme === t
            ? "border-cyan-400 text-cyan-300"
            : "border-slate-700 text-slate-400 hover:border-slate-500"}`}>
          {t}
        </button>
      ))}
    </div>
  );
}
