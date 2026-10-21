// The words of the Login card (S7, D147): pure, so a test can import them without the panel's modules.

/** "3 min ago", "2 h ago", "5 days ago", else the date. */
export function whenWords(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  if (s < 14 * 86400) return `${Math.round(s / 86400)} days ago`;
  return new Date(t).toISOString().slice(0, 10);
}

const cap = (t) => (t ? `${t[0]?.toUpperCase()}${t.slice(1)}` : "");

/** What the card says and which actions it offers, from the state of the login. `windowOpen`: the login window is up. */
export function loginView(data, now = Date.now()) {
  if (!data?.project) return null;
  const s = data.session ?? { state: "none" };
  const base = { app: data.app.name };
  if (data.windowOpen)
    return {
      ...base,
      tone: "info",
      icon: "◔",
      title: "A browser window is open",
      text: `Log in by hand in the window on ${data.app.baseUrl} (a password, OAuth, an e-mail link, a one-time code). When you are in, come back and press “I'm logged in”.`,
      actions: ["confirm", "cancel"],
    };
  if (s.state === "none")
    return {
      ...base,
      tone: "neutral",
      icon: "○",
      title: "No saved login",
      text: "An app that needs no login can ignore this. Otherwise log in once by hand: the session is saved for this app and reused by discovery and recordings.",
      actions: ["start"],
    };
  const when = `saved ${whenWords(s.savedAt, now)}${s.checkedAt ? `, checked ${whenWords(s.checkedAt, now)}` : ""}`;
  if (s.state === "expired")
    return {
      ...base,
      tone: "warn",
      icon: "!",
      title: "The saved login has expired",
      text: `${cap(s.reason)}. Log in again; discovery and recordings are refused until you do. (${when})`,
      actions: ["start", "check", "forget"],
    };
  if (s.state === "unknown")
    return {
      ...base,
      tone: "warn",
      icon: "?",
      title: "Could not check the saved login",
      text: `${cap(s.reason)}. (${when})`,
      actions: ["check", "start", "forget"],
    };
  return {
    ...base,
    tone: "ok",
    icon: "✓",
    title: "Logged in",
    text: `${s.reason ? `${s.reason[0]?.toUpperCase()}${s.reason.slice(1)}. ` : ""}(${when}). Discovery and recordings use it.`,
    actions: ["check", "start", "forget"],
  };
}

export const ACTION_LABEL = {
  start: "Log in…",
  confirm: "I'm logged in",
  cancel: "Cancel",
  check: "Check now",
  forget: "Forget…",
};

/** The text a saved state cannot keep, said once where you set the rule. */
export const SESSION_STORAGE_NOTE =
  "A saved login keeps cookies, localStorage and IndexedDB. An app that keeps its login only in sessionStorage cannot be reused: after saving, a fresh browser checks it and says so.";
