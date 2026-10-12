import { Segmented } from "./controls";

export type Theme = "dark" | "light";

export default function ThemeSwitch({ theme, onTheme }:
  { theme: Theme; onTheme: (t: Theme) => void }) {
  return (
    <div className="flex items-center justify-between gap-2" data-testid="theme-switch">
      <span className="text-xs text-fg-muted">Theme</span>
      <Segmented value={theme} onChange={onTheme}
        options={[{ value: "dark", label: "dark", testid: "theme-dark" },
                  { value: "light", label: "light", testid: "theme-light" }]} />
    </div>
  );
}
