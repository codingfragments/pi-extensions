export interface Stoppable {
  route: string;
  body: Record<string, unknown>;
  label: string;
  ask?: string;
}
export const STOPPABLE: Record<
  "take" | "tts" | "edit" | "render" | "design" | "discovery" | "director",
  Stoppable
>;
