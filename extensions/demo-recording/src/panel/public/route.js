// The panel's location lives in the URL hash (UX2, D111): #/<screen>[/v<N>[/<item>]][?query].
// Pure parsing and formatting only (tested in Node, no imports); the hook that listens to the hash is useHashRoute in core.js.
// Changing a route never changes project state, and an unknown route explains its fallback.

/** The screens of this panel. `map` is parsed but not available yet (UX4). */
export const SCREENS = [
  "project",
  "storyboard",
  "recording",
  "voice",
  "annotations",
  "render",
  "config",
];
const COMING = ["map"];

/**
 * Parse a hash. null = no route at all. Otherwise { screen, version?, item?, query, raw, valid, reason? };
 * an invalid route says why, so the panel can explain the fallback instead of showing something else silently.
 */
export function parseRoute(hash) {
  const raw = String(hash ?? "").replace(/^#/, "");
  if (raw === "" || raw === "/") return null;
  const [pathPart, ...q] = raw.split("?");
  const query = Object.fromEntries(new URLSearchParams(q.join("?")));
  const safe = (s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const parts = String(pathPart).split("/").filter(Boolean).map(safe);
  const screen = parts[0] ?? "";
  const base = { screen, query, raw: `#${raw}` };
  if (!SCREENS.includes(screen))
    return {
      ...base,
      valid: false,
      reason: COMING.includes(screen)
        ? `“${screen}” is not available yet`
        : `“${screen}” is not a screen of this panel`,
    };
  const route = { ...base, valid: true };
  if (parts[1] !== undefined) {
    const m = /^v(\d+)$/.exec(parts[1]);
    if (!m) return { ...base, valid: false, reason: `“${parts[1]}” is not a version (write v3)` };
    route.version = Number(m[1]);
  }
  if (parts[2] !== undefined) route.item = parts.slice(2).join("/");
  return route;
}

/** The hash for a route: formatRoute({ screen: "voice", version: 3, item: "01-dash" }) → "#/voice/v3/01-dash". */
export function formatRoute({ screen, version, item, query } = {}) {
  let out = `#/${screen}`;
  if (version !== undefined) out += `/v${version}`;
  if (item !== undefined && item !== "")
    out += `/${String(item).split("/").map(encodeURIComponent).join("/")}`;
  const q = new URLSearchParams(
    Object.entries(query ?? {}).filter(([, v]) => v !== undefined && v !== ""),
  ).toString();
  return q ? `${out}?${q}` : out;
}

const LAST_PREFIX = "demo-rec-last:";

/** The place the user was last at in a project, if it is still a valid route. */
export function readLastPlace(slug, storage = globalThis.localStorage) {
  try {
    const r = parseRoute(storage?.getItem(LAST_PREFIX + slug));
    return r?.valid ? r : null;
  } catch {
    return null;
  }
}
export function writeLastPlace(slug, route, storage = globalThis.localStorage) {
  try {
    if (slug && route?.valid) storage?.setItem(LAST_PREFIX + slug, formatRoute(route));
  } catch {
    // no storage: the place is simply not remembered
  }
}
