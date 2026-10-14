// demo-recording panel — shared helpers (token, API, bus, media, small components).
import { html, useCallback, useEffect, useRef, useState } from "/vendor/preact-htm.module.js";

// The token arrives once via ?token=; keep it in sessionStorage (this tab only)
// so reloads keep working, and strip it from the visible URL / history.
export const TOKEN_KEY = "demo-rec-token";
export const urlToken = new URLSearchParams(location.search).get("token");
if (urlToken) sessionStorage.setItem(TOKEN_KEY, urlToken);
export const token = urlToken ?? sessionStorage.getItem(TOKEN_KEY) ?? "";
if (urlToken) history.replaceState(null, "", location.pathname);

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

/** Refetch `path` whenever a bus event whose type matches `re` arrives. */
export function useApi(path, events, re) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const relevant = events.filter((e) => re.test(e.type)).at(-1)?.seq ?? 0;
  const reload = useCallback(() => {
    api(path).then(
      (d) => {
        setData(d);
        setError(null);
      },
      (e) => setError(String(e)),
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
