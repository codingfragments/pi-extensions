// Settings search (UX9a, D125): which settings match a text and the quick filters, and how to highlight the
// matches. Pure (no DOM, no imports), tested in Node.
//
// What is searched: key, label, description, the non-secret values of every layer, and source words
// (global, project, env, default, overridden, changed). What is never searched or shown: API keys (they are
// not settings at all: the panel only says set / not set) and the value of any setting whose key looks like
// a secret.

export const SECRET_KEY = /(api[-_]?key|token|secret|password|credential)/i;
export const isSecret = (s) => SECRET_KEY.test(s.key);

export const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** A value as text; a secret's value is never shown, only that there is one. */
export function showValue(s, v) {
  if (v === null || v === undefined) return "—";
  if (isSecret(s)) return "set";
  return Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v);
}

const set = (v) => v !== null && v !== undefined;
export const isChanged = (s) => !same(s.value, s.layers.default);
export const isOverridden = (s, project) => !!project && set(s.layers.project);
export const isFromEnv = (s) => !!s.envSet || s.source === "env";

export const FILTERS = [
  ["changed", "Changed", "differs from the default"],
  ["overridden", "Overridden here", "this project overrides the global value"],
  ["env", "From environment", "an environment variable wins"],
];

/** The lower-cased words of a query. */
export const wordsOf = (q) =>
  String(q ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

/** Everything a setting can be found by, in one lower-cased string. */
export function haystack(s, project) {
  const vals = [s.value, s.layers.default, s.layers.global, s.layers.project].map((v) =>
    showValue(s, v),
  );
  const words = [s.source, s.envSet ? "env environment" : "", s.globalOnly ? "global only" : ""];
  if (isChanged(s)) words.push("changed");
  if (isOverridden(s, project)) words.push("overridden override");
  return [s.label, s.key, s.doc, ...vals, ...words].join(" ").toLowerCase();
}

const quickFilter = {
  changed: (s) => isChanged(s),
  overridden: (s, project) => isOverridden(s, project),
  env: (s) => isFromEnv(s),
};

/**
 * The groups with only the settings that match every word of the query and every selected filter.
 * Without a query and filters nothing is hidden. `settings` of a group keeps its order; empty groups drop out
 * only while searching.
 */
export function filterGroups(groups, { q = "", filters = new Set(), project = null } = {}) {
  const ws = wordsOf(q);
  const searching = ws.length > 0 || filters.size > 0;
  const total = groups.reduce((n, g) => n + g.settings.length, 0);
  if (!searching) return { groups, count: total, total, searching, words: ws };
  const out = [];
  let count = 0;
  for (const g of groups) {
    const settings = g.settings.filter((s) => {
      for (const f of filters) if (quickFilter[f] && !quickFilter[f](s, project)) return false;
      if (!ws.length) return true;
      const hay = haystack(s, project);
      return ws.every((w) => hay.includes(w));
    });
    if (settings.length) {
      out.push({ ...g, settings });
      count += settings.length;
    }
  }
  return { groups: out, count, total, searching, words: ws };
}

/** Text split into segments, the parts that contain a query word marked (for highlighting). */
export function highlight(text, ws) {
  const str = String(text ?? "");
  if (!ws.length || !str) return [{ t: str, hit: false }];
  const lower = str.toLowerCase();
  const mark = new Array(str.length).fill(false);
  for (const w of ws) {
    for (let i = lower.indexOf(w); i >= 0; i = lower.indexOf(w, i + w.length))
      for (let k = i; k < i + w.length; k++) mark[k] = true;
  }
  const out = [];
  for (let i = 0; i < str.length; i++) {
    const hit = mark[i];
    if (out.length && out.at(-1).hit === hit) out.at(-1).t += str[i];
    else out.push({ t: str[i], hit });
  }
  return out;
}

/** The search state in a route: `#/config?q=voice&filter=changed,env`. Unknown filters are ignored. */
export function searchFromQuery(query = {}) {
  const known = new Set(FILTERS.map(([id]) => id));
  return {
    q: query.q ?? "",
    filters: new Set(
      String(query.filter ?? "")
        .split(",")
        .filter((f) => known.has(f)),
    ),
    view: query.view === "brands" ? "brands" : "settings",
  };
}

/** The route query for a search state; defaults are left out. */
export function queryFromSearch({ q = "", filters = new Set(), view = "settings" } = {}) {
  const query = {};
  if (view === "brands") query.view = "brands";
  if (q) query.q = q;
  if (filters.size) query.filter = [...filters].join(",");
  return query;
}
