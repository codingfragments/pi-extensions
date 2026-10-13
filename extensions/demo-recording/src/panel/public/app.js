// demo-recording side panel (S0: LIVE view). Preact + htm, vendored, no build.
import { html, render, useEffect, useRef, useState } from "/vendor/preact-htm.module.js";

const token = new URLSearchParams(location.search).get("token") ?? "";
// Keep the token out of the visible URL / history once captured.
if (token) history.replaceState(null, "", location.pathname);

const TABS = [
  { id: "live", label: "Live", ready: true },
  { id: "review", label: "Review", ready: false, slice: "S2" },
  { id: "voice", label: "Voice", ready: false, slice: "S4" },
  { id: "export", label: "Export", ready: false, slice: "S5" },
];

async function api(path) {
  const res = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

function useBus() {
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
        setEvents((prev) => [...prev.slice(-499), event]);
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

function useProjectState(events) {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const lastSeq = events.at(-1)?.seq ?? 0;
  // Refetch state whenever new bus events arrive.
  useEffect(() => {
    api("/api/state").then(setState, (e) => setError(String(e)));
  }, [lastSeq]);
  return { state, error };
}

function StatusCard({ state, error }) {
  if (error) return html`<section class="card error">${error}</section>`;
  if (!state) return html`<section class="card muted">loading…</section>`;
  const p = state.project;
  return html`
    <section class="card">
      <h2>${p ? p.slug : "No active project"}</h2>
      ${
        p
          ? html`<dl>
            <dt>App</dt><dd>${p.app.name} <span class="muted">${p.app.baseUrl}</span></dd>
            <dt>Phase</dt><dd><span class="pill">${p.state.phase}</span></dd>
            <dt>Approved</dt><dd>
              storyboard ${p.state.approved.storyboard ? `v${p.state.approved.storyboard}` : "—"} ·
              voice-over ${p.state.approved.vo ? `v${p.state.approved.vo}` : "—"}
            </dd>
            <dt>Folder</dt><dd class="mono">${p.dir}</dd>
          </dl>`
          : html`<p class="muted">Run <code>/demo new</code> or <code>/demo open</code> in pi.</p>`
      }
      <p class="muted small">root: <span class="mono">${state.root}</span></p>
    </section>`;
}

function EventLog({ events }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);
  return html`
    <section class="card grow">
      <h3>Activity</h3>
      <ol class="log" ref=${ref}>
        ${events.map(
          (e) => html`<li key=${e.seq}>
            <time>${new Date(e.at).toLocaleTimeString()}</time>
            <span class="type">${e.type}</span>
            ${e.data ? html`<span class="data">${summarize(e.data)}</span>` : null}
          </li>`,
        )}
      </ol>
    </section>`;
}

function summarize(data) {
  if (typeof data.message === "string") return data.message;
  return Object.entries(data)
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join(" ")
    .slice(0, 300);
}

function App() {
  const [tab, setTab] = useState("live");
  const { events, status } = useBus();
  const { state, error } = useProjectState(events);
  return html`
    <header>
      <strong>demo-recording</strong>
      <nav>
        ${TABS.map(
          (t) => html`<button
            class=${tab === t.id ? "active" : ""}
            disabled=${!t.ready}
            title=${t.ready ? "" : `arrives in slice ${t.slice}`}
            onClick=${() => setTab(t.id)}
          >${t.label}</button>`,
        )}
      </nav>
      <span class=${`conn ${status}`}>${status}</span>
    </header>
    <main>
      <${StatusCard} state=${state} error=${error} />
      <${EventLog} events=${events} />
    </main>`;
}

render(html`<${App} />`, document.getElementById("app"));
