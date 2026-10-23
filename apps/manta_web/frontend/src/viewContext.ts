import { useEffect, useSyncExternalStore } from "react";

// What an open view shows, so the assistant can suggest questions about exactly that.
// Each view publishes under its panel id; the network publishes under NETWORK.

export type Subject =
  | { kind: "asv"; id: string; label: string }
  | { kind: "cluster"; n: number; label: string }
  | { kind: "env"; key: string; label: string };

export type ViewContext =
  | { view: "network"; points: "asvs" | "taxa"; rank: string; selected: Subject | null;
      taxon: { rank: string; name: string } | null }
  | { view: "cluster"; module: Subject & { kind: "cluster" } }
  | { view: "asv"; asv: string }
  | { view: "edge"; source: string; target: string }
  | { view: "taxon"; rank: string; name: string; label: string }
  | { view: "inspect"; subjects: Subject[]; year: number | null; years: number[] }
  | { view: "wheel"; subjects: Subject[]; year: number | null; years: number[] };

export const NETWORK = "network";

export const subject = (kind: "asv" | "cluster" | "env", id: string, label: string): Subject =>
  kind === "asv" ? { kind, id, label } : kind === "cluster" ? { kind, n: Number(id), label }
    : { kind, key: id, label };

let stand: ReadonlyMap<string, ViewContext> = new Map();
const abos = new Set<() => void>();
const abonnieren = (f: () => void) => { abos.add(f); return () => { abos.delete(f); }; };
const lesen = () => stand;

function setzen(id: string, c: ViewContext | null) {
  const neu = new Map(stand);
  if (c) neu.set(id, c); else neu.delete(id);
  stand = neu;
  abos.forEach((f) => f());
}

export function usePublishView(id: string, c: ViewContext | null) {
  const key = JSON.stringify(c);
  useEffect(() => {
    setzen(id, c);
    return () => setzen(id, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, key]);
}

export const useViews = () => useSyncExternalStore(abonnieren, lesen);

export type Suggestion = { text: string; tool: string; args: Record<string, unknown> };
export type SuggestionGroup = { title: string; questions: Suggestion[] };

const asvFragen = (s: { id: string; label: string }, tools: string[]): Suggestion[] => {
  const l = s.label, a = { asv_id: s.id };
  const alle: Record<string, Suggestion> = {
    asv_detail: { text: `What is ${l} — taxonomy, module, size, is it central in its module?`,
                  tool: "asv_detail", args: a },
    neighbors: { text: `Who is ${l} linked to in the network?`, tool: "neighbors", args: a },
    asv_seasonality: { text: `When is ${l} present, and does it come back every year?`,
                       tool: "asv_seasonality", args: a },
    asv_spectrum: { text: `Which rhythms does ${l} carry — a year, half a year, longer?`,
                    tool: "asv_spectrum", args: a },
    asv_drivers: { text: `Which measured variables does ${l} move with, and with what lag?`,
                   tool: "asv_drivers", args: a },
    asv_abundance_series: { text: `How does the share of ${l} run, sample by sample?`,
                            tool: "asv_abundance_series", args: a },
    trend_test: { text: `Is ${l} rising or falling over the years?`, tool: "trend_test", args: a },
    seasonality_test: { text: `Does the calendar month make a difference for ${l}?`,
                        tool: "seasonality_test", args: a },
  };
  return tools.map((t) => alle[t]);
};

const modulFragen = (s: { n: number; label: string }, tools: string[]): Suggestion[] => {
  const l = s.label, a = { cluster: s.n };
  const alle: Record<string, Suggestion> = {
    cluster_detail: { text: `What does ${l} consist of, and who dominates it?`,
                      tool: "cluster_detail", args: a },
    cluster_env_links: { text: `Which measured variables is ${l} linked to?`,
                         tool: "cluster_env_links", args: a },
    seasonality_test: { text: `Does the calendar month make a difference for ${l}?`,
                        tool: "seasonality_test", args: a },
    trend_test: { text: `Is ${l} rising or falling over the years?`, tool: "trend_test", args: a },
  };
  return tools.map((t) => alle[t]);
};

const envFrage = (s: { key: string; label: string }): Suggestion =>
  ({ text: `Which ASVs follow ${s.label}?`, tool: "env_variable_links", args: { name: s.key } });

const jahrFrage = (s: Subject, year: number, years: number[]): Suggestion | null => {
  const andere = years.filter((y) => y !== year);
  if (s.kind === "env" || andere.length === 0) return null;
  const wer = s.kind === "asv" ? { asv_id: s.id } : { cluster: s.n };
  return { text: `Does ${s.label} differ between ${year} and the other years?`,
           tool: "group_comparison_test",
           args: { by: "year", group_a: [year], group_b: andere, ...wer } };
};

export function suggestionsFor(c: ViewContext): SuggestionGroup[] {
  switch (c.view) {
    case "network": {
      const gruppen: SuggestionGroup[] = [{ title: "Network", questions: [
        { text: "How strongly are the modules linked to each other?", tool: "cluster_bridges", args: {} },
        { text: "Which module predicts which, and how strongly?", tool: "cluster_network", args: {} },
        c.points === "taxa"
          ? { text: `Which ${c.rank === "species" ? "species" : "genera"} dominate this dataset?`,
              tool: "taxa_composition", args: { rank: c.rank } }
          : { text: "Which are the largest ASVs here?", tool: "find_asv", args: {} },
      ] }];
      const s = c.selected;
      if (s?.kind === "asv") {
        gruppen.push({ title: s.label, questions: asvFragen(s, ["asv_detail", "neighbors", "asv_seasonality"]) });
      } else if (s?.kind === "cluster") {
        gruppen.push({ title: s.label, questions: modulFragen(s, ["cluster_detail", "cluster_env_links"]) });
      } else if (c.taxon) {
        gruppen.push({ title: c.taxon.name, questions: [taxonFrage(c.taxon.rank, c.taxon.name)] });
      }
      return gruppen;
    }
    case "cluster":
      return [{ title: c.module.label, questions: modulFragen(c.module,
        ["cluster_detail", "cluster_env_links", "seasonality_test", "trend_test"]) }];
    case "asv":
      return [{ title: c.asv, questions: asvFragen({ id: c.asv, label: c.asv },
        ["asv_detail", "neighbors", "asv_seasonality", "asv_drivers", "asv_spectrum", "trend_test"]) }];
    case "edge":
      return [{ title: `${c.source} and ${c.target}`, questions: paarFragen(c.source, c.target) }];
    case "taxon":
      return [{ title: c.label, questions: [taxonFrage(c.rank, c.name)] }];
    case "inspect":
    case "wheel": {
      const basis: Suggestion[] = c.view === "inspect"
        ? [{ text: "How do the modules rise and fall across the samples?", tool: "cluster_timeseries", args: {} }]
        : [{ text: "When in the year is each module active, and does that repeat?", tool: "cluster_year_overview", args: {} },
           { text: "In which months do the years differ most?", tool: "cluster_interannual_variability", args: {} }];
      const gruppen: SuggestionGroup[] = [{ title: c.view === "inspect" ? "Inspect" : "Year wheel", questions: basis }];
      const asvs = c.subjects.filter((s): s is Subject & { kind: "asv" } => s.kind === "asv");
      const envs = c.subjects.filter((s): s is Subject & { kind: "env" } => s.kind === "env");
      const ringModule = c.view === "wheel"
        ? c.subjects.filter((s): s is Subject & { kind: "cluster" } => s.kind === "cluster") : [];
      if (ringModule.length) {
        gruppen.push({ title: "Modules", questions: ringModule.flatMap((s) => {
          const j = c.year != null ? jahrFrage(s, c.year, c.years) : null;
          return [...modulFragen(s, ["seasonality_test"]), ...(j ? [j] : [])];
        }) });
      }
      for (const s of c.subjects) {
        if (c.view === "wheel" && s.kind === "cluster") continue;
        let q: Suggestion[];
        if (s.kind === "asv") {
          q = c.view === "inspect"
            ? [...asvFragen(s, ["asv_abundance_series", "asv_drivers", "trend_test"]),
               ...envs.map((e) => ({ text: `How does the share of ${s.label} correlate with ${e.label}?`,
                                     tool: "environment_correlation",
                                     args: { asv_id: s.id, variable: e.key } }))]
            : asvFragen(s, ["asv_seasonality", "asv_spectrum", "seasonality_test"]);
        } else if (s.kind === "cluster") {
          q = modulFragen(s, ["cluster_detail", "cluster_env_links"]);
        } else {
          q = [envFrage(s)];
        }
        const j = c.year != null ? jahrFrage(s, c.year, c.years) : null;
        gruppen.push({ title: s.label, questions: j ? [...q, j] : q });
      }
      if (c.view === "inspect" && asvs.length === 2) {
        gruppen.push({ title: `${asvs[0].label} and ${asvs[1].label}`,
                       questions: paarFragen(asvs[0].id, asvs[1].id, asvs[0].label, asvs[1].label) });
      }
      return gruppen;
    }
  }
}

function taxonFrage(rank: string, name: string): Suggestion {
  return { text: `How many ASVs does ${name} have, and how are they spread across the modules?`,
           tool: "summarize_by_taxon", args: { rank, name } };
}

function paarFragen(a: string, b: string, la = a, lb = b): Suggestion[] {
  return [
    { text: `How strong is the link between ${la} and ${lb}, in both CCM directions?`,
      tool: "edge", args: { source: a, target: b } },
    { text: `Does the ratio of ${la} and ${lb} stay constant across the samples?`,
      tool: "pair_proportionality", args: { asv_a: a, asv_b: b } },
  ];
}
