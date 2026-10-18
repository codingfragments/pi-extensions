import {
  html,
  render,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "/vendor/preact-htm.module.js";
// demo-recording panel — shared helpers (token, API, bus, media, small components).
import { formatRoute, parseRoute } from "./route.js";

// The token arrives once via ?token=; keep it in sessionStorage (this tab only)
// so reloads keep working, and strip it from the visible URL / history.
export const TOKEN_KEY = "demo-rec-token";
export const urlToken = new URLSearchParams(location.search).get("token");
if (urlToken) sessionStorage.setItem(TOKEN_KEY, urlToken);
export const token = urlToken ?? sessionStorage.getItem(TOKEN_KEY) ?? "";
if (urlToken) history.replaceState(null, "", location.pathname + location.hash);

export async function api(path) {
  const res = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 401)
    throw new Error(
      "This panel link has expired (pi restarted). Open the current link from /demo panel.",
    );
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

export async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `${path}: ${res.status}`);
  return json;
}

export const media = (root, rel) => `/media/${root}/${rel}?token=${token}`;
export const screenUrl = (screen) => {
  const [session, id] = String(screen).split("/");
  return media("app", `discovery/${session}/screens/${id}.jpg`);
};

export function useBus() {
  const [events, setEvents] = useState([]);
  const [status, setStatus] = useState("connecting");
  const lastSeq = useRef(0);

  useEffect(() => {
    let ws;
    let retry = 500;
    let stopped = false;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws?token=${token}&after=${lastSeq.current}`);
      ws.onopen = () => {
        setStatus("live");
        retry = 500;
      };
      ws.onmessage = (msg) => {
        const event = JSON.parse(msg.data);
        if (event.seq <= lastSeq.current) return;
        lastSeq.current = event.seq;
        setEvents((prev) => [...prev.slice(-999), event]);
      };
      ws.onclose = () => {
        if (stopped) return;
        setStatus("reconnecting");
        setTimeout(connect, retry);
        retry = Math.min(retry * 2, 8000);
      };
    };
    connect();
    return () => {
      stopped = true;
      ws?.close();
    };
  }, []);
  return { events, status };
}

/** The current route, kept in step with the hash (back, forward and reload work). */
const ROUTE_EVENT = "demo-rec-route";
export function useHashRoute() {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", on);
    window.addEventListener(ROUTE_EVENT, on); // a replace changes the address without a hashchange
    return () => {
      window.removeEventListener("hashchange", on);
      window.removeEventListener(ROUTE_EVENT, on);
    };
  }, []);
  /** Go to a route; `replace` rewrites the current history entry (used for fallbacks and restores). */
  const go = useCallback((next, { replace = false } = {}) => {
    const hash = typeof next === "string" ? next : formatRoute(next);
    if (hash === location.hash) return;
    if (replace) {
      history.replaceState(null, "", location.pathname + location.search + hash);
      setRoute(parseRoute(hash));
      window.dispatchEvent(new Event(ROUTE_EVENT));
    } else location.hash = hash;
  }, []);
  return [route, go];
}

/** The version in the route for this screen (#/<screen>/v<N>), or null: the latest on the production line's input. */
export function useRouteVersion(screen) {
  const [route] = useHashRoute();
  return route?.valid && route.screen === screen && route.version !== undefined
    ? route.version
    : null;
}

/** Refetch `path` whenever a bus event whose type matches `re` arrives. */
export function useApi(path, events, re) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const relevant = events.filter((e) => re.test(e.type)).at(-1)?.seq ?? 0;
  // A reply is only used if it is for the path now asked for and no newer request was made since:
  // a slow reply for a previous path (or an older refetch) must not overwrite what is shown.
  const current = useRef(path);
  const latest = useRef(0);
  current.current = path;
  const reload = useCallback(() => {
    const mine = ++latest.current;
    const stale = () => current.current !== path || latest.current !== mine;
    api(path).then(
      (d) => {
        if (stale()) return;
        setData(d);
        setError(null);
      },
      (e) => {
        if (!stale()) setError(String(e));
      },
    );
  }, [path]);
  // Refetch whenever a relevant bus event arrives (relevant changes).
  useEffect(() => reload(), [reload, relevant]);
  return { data, error, reload };
}

export function summarize(data) {
  if (typeof data.message === "string") return data.message;
  return Object.entries(data)
    .filter(([k]) => k !== "budget")
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join(" ")
    .slice(0, 300);
}

export const mmss = (ms) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

export function SegmentBar({ segments }) {
  // segments: [{ key, label, weight, done (0..1), state: "done"|"current"|"todo", restarted? }]
  return html`<div class="segbar">
    ${segments.map(
      (
        s,
      ) => html`<div key=${s.key} class=${`seg ${s.state}${s.restarted ? " restarted" : ""}`} style=${`flex:${Math.max(0.02, s.weight)}`} title=${s.label}>
        <div class="fill" style=${`width:${Math.round(s.done * 100)}%`}></div>
        <span>${s.label}</span>
      </div>`,
    )}
  </div>`;
}

/**
 * A popup over the panel: × / Esc / a click outside closes it. `size`
 * "large" = 80 % of the window (width and height), "medium" = a dialog.
 * Popups stack (a line opened from the full log sits on top of it).
 */
export function Modal(props) {
  // Rendered into its own element on <body>: a screen area that is a CSS container
  // (container-type) would trap a position:fixed popup inside it.
  // The element is created in an effect, never during render: Preact may throw a render
  // away (it does under load), and a host created in render would stay behind as a second popup.
  const host = useRef(null);
  const latest = useRef(props);
  latest.current = props;
  // Layout effects: this root is rendered from inside another component's effect,
  // where Preact's deferred (after-paint) effects of the new root never run.
  useLayoutEffect(() => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    host.current = el;
    render(html`<${ModalBox} ...${latest.current} />`, el);
    return () => {
      render(null, el);
      el.remove();
      host.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    if (host.current) render(html`<${ModalBox} ...${props} />`, host.current);
  });
  return null;
}

function ModalBox({ title, onClose, size = "medium", actions, footer, children }) {
  const box = useRef(null);
  // A layout effect: this root is rendered from inside another component's effect,
  // where Preact's deferred (after-paint) effects of the new root never run.
  useLayoutEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      // only the top-most popup closes
      const all = document.querySelectorAll(".modal-backdrop");
      if (all[all.length - 1] === box.current?.parentElement) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    box.current?.focus();
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return html`<div class="modal-backdrop ds-backdrop" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <div class=${`modal ${size} ds-dialog${size === "medium" ? " ds-dialog--wide" : ""}`} role="dialog" aria-modal="true" aria-label=${title} tabindex="-1" ref=${box}>
      <header class="modal-head ds-dialog-head">
        <h2>${title}</h2>
        <span class="grow ds-grow"></span>
        ${actions ?? null}
        <button class="ds-btn ds-btn--ghost ds-btn--icon modal-close" title="close (Esc)" aria-label="close" onClick=${onClose}>×</button>
      </header>
      <div class="modal-body ds-dialog-body">${children}</div>
      ${footer ? html`<footer class="modal-foot ds-dialog-foot">${footer}</footer>` : null}
    </div>
  </div>`;
}

/** Copy text to the clipboard; returns true on success. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
