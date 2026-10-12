export type AskAssistant = { question: string; concept: string };
export const ASK_EVENT = "manta:ask";

export default function InfoTip(_props:
  { title: string; children: React.ReactNode; ask?: AskAssistant }): null {
  return null;
}
