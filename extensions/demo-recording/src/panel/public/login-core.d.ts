export function whenWords(iso: string | undefined, now?: number): string;
export interface LoginData {
  project: string | null;
  app?: { slug: string; name: string; baseUrl: string };
  rule?: { url?: string; expectText?: string; expectSelector?: string } | null;
  session?: {
    state: "none" | "valid" | "expired" | "unknown";
    savedAt?: string;
    checkedAt?: string;
    reason?: string;
  };
  windowOpen?: boolean;
}
export interface LoginView {
  app: string;
  tone: "neutral" | "info" | "ok" | "warn";
  icon: string;
  title: string;
  text: string;
  actions: ("start" | "confirm" | "cancel" | "check" | "forget")[];
}
export function loginView(data: LoginData, now?: number): LoginView | null;
export const ACTION_LABEL: Record<string, string>;
export const SESSION_STORAGE_NOTE: string;
