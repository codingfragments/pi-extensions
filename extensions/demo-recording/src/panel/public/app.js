// demo-recording side panel — LIVE + REVIEW (S2). Preact + htm, vendored, no build.
import {
  html,
  render,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "/vendor/preact-htm.module.js";

const token = new URLSearchParams(location.search).get("token") ?? "";
// Keep the token out of the visible URL / history once captured.
if (token) history.replaceState(null, "", location.pathname);

const TABS = [
  { id: "live", label: "Live", ready: true },
  { id: "review", label: "Review", ready: true },
  { id: "voice", label: "Voice", ready: false, slice: "S4" },
  { id: "export", label: "Export", ready: false, slice: "S5" },
];

async function api(path) {
  const res = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `${path}: ${res.status}`);
  return json;
}

const media = (root, rel) => `/media/${root}/${rel}?token=${token}`;
const screenUrl = (screen) => {
  const [session, id] = String(screen).split("/");
  return media("app", `discovery/${session}/screens/${id}.jpg`);
};

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
function useApi(path, events, re) {
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

// ---------------- LIVE ----------------

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
    </section>`;
}

function DiscoveryCard({ events }) {
  const look = events.filter((e) => e.type === "discovery.look").at(-1);
  const opened = events
    .filter((e) => e.type === "discovery.opened" || e.type === "discovery.closed")
    .at(-1);
  const safety = events
    .filter((e) => e.type === "safety.blocked" || e.type === "safety.mutation")
    .slice(-6)
    .reverse();
  if (!look && !opened) return null;
  const closed = opened?.type === "discovery.closed";
  const b = look?.data?.budget;
  return html`
    <section class="card discovery">
      <div class="shot">
        ${look ? html`<img src=${media("app", look.data.media)} alt="current screen" />` : html`<div class="muted">waiting for first look…</div>`}
      </div>
      <div class="side">
        <h3>Discovery ${closed ? html`<span class="pill muted-pill">closed</span>` : html`<span class="pill">live</span>`}</h3>
        ${look ? html`<p class="mono small-text">${look.data.screen}<br />${look.data.title}<br /><span class="muted">${look.data.url}</span></p>` : null}
        ${b ? html`<p class="small-text">screens ${b.screens} · actions ${b.actions} · min ${b.minutes}${b.exhausted ? html` <strong class="warn">exhausted</strong>` : null}</p>` : null}
        <h3>Safety</h3>
        ${
          safety.length
            ? html`<ul class="safety">${safety.map(
                (e) => html`<li class=${e.type === "safety.blocked" ? "blocked" : "mutating"}>
                  <strong>${e.type === "safety.blocked" ? "blocked" : "state change"}</strong> ${e.data.action} ${e.data.name ? `"${e.data.name}"` : ""}
                  <div class="muted small-text">${e.data.reason}</div>
                </li>`,
              )}</ul>`
            : html`<p class="muted small-text">no state-changing actions so far</p>`
        }
      </div>
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
          (
            e,
          ) => html`<li key=${e.seq} class=${e.type.startsWith("safety.") ? e.type.replace(".", "-") : ""}>
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
    .filter(([k]) => k !== "budget")
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join(" ")
    .slice(0, 300);
}

function Live({ events, state, stateError }) {
  return html`
    <${StatusCard} state=${state} error=${stateError} />
    <${DiscoveryCard} events=${events} />
    <${EventLog} events=${events} />`;
}

// ---------------- REVIEW ----------------

function targetLabel(t) {
  if (!t) return "";
  if (t.role) return `${t.role}${t.name ? ` “${t.name}”` : ""}`;
  if (t.text) return `text “${t.text}”`;
  if (t.label) return `label “${t.label}”`;
  return `css ${t.css}`;
}

function stepLabel(s) {
  switch (s.do) {
    case "goto":
      return `go to ${s.url}`;
    case "type":
      return `type “${s.text}”${s.target ? ` into ${targetLabel(s.target)}` : ""}`;
    case "press":
      return `press ${s.key}`;
    case "wait":
      return s.for.ms !== undefined ? `wait ${s.for.ms} ms` : `wait for ${targetLabel(s.for)}`;
    case "pause":
      return `pause ${s.ms} ms`;
    case "scroll":
      return s.target ? `scroll to ${targetLabel(s.target)}` : `scroll ${s.dy}px`;
    case "improvise":
      return `improvise input in ${targetLabel(s.target)}: ${s.prompt}`;
    default:
      return `${s.do} ${targetLabel(s.target)}`;
  }
}

const STATUS_LABEL = { approved: "Approve", changes: "Request changes", rerun: "Re-run" };

function SceneCard({ scene, index, review, diffKind, readOnly, onReview }) {
  const r = review?.scenes?.[scene.id];
  const [note, setNote] = useState(r?.note ?? "");
  useEffect(() => setNote(r?.note ?? ""), [r?.note]);
  const set = (status) => onReview(scene.id, r?.status === status ? null : status, note);
  return html`
    <article class=${`scene card ${r ? `st-${r.status}` : ""}`}>
      <div class="thumb">
        ${scene.screen ? html`<img src=${screenUrl(scene.screen)} alt="" loading="lazy" />` : html`<div class="muted">no screen</div>`}
      </div>
      <div class="body">
        <header>
          <span class="idx">${index + 1}</span>
          <h3 class="title">${scene.title}</h3>
          <span class="mono muted">${scene.id}</span>
          ${diffKind ? html`<span class=${`badge ${diffKind}`}>${diffKind}</span>` : null}
        </header>
        ${scene.takeaway ? html`<p class="takeaway">${scene.takeaway}</p>` : null}
        ${
          scene.narration_outline?.length
            ? html`<ul class="outline">${scene.narration_outline.map((o) => html`<li>${o}</li>`)}</ul>`
            : null
        }
        <ol class="steps">
          ${scene.steps.map(
            (s) => html`<li>
              ${stepLabel(s)}
              ${s.mark ? html` <span class="mark">@${s.mark}</span>` : null}
              ${s.zoom ? html` <span class="flag">zoom</span>` : null}
              ${s.callout ? html` <span class="flag">“${s.callout}”</span>` : null}
            </li>`,
          )}
        </ol>
        ${
          readOnly
            ? null
            : html`<div class="actions">
              ${Object.entries(STATUS_LABEL).map(
                ([st, label]) =>
                  html`<button class=${`st ${st} ${r?.status === st ? "on" : ""}`} onClick=${() => set(st)}>${label}</button>`,
              )}
              <textarea
                placeholder="Notes for this scene (what to change, what to re-explore)…"
                value=${note}
                onInput=${(e) => setNote(e.target.value)}
                onBlur=${() => r && note !== (r.note ?? "") && onReview(scene.id, r.status, note)}
              ></textarea>
            </div>`
        }
      </div>
    </article>`;
}

function Review({ events }) {
  const [version, setVersion] = useState(null);
  const path = version ? `/api/storyboard?version=${version}` : "/api/storyboard";
  const { data, error, reload } = useApi(path, events, /^(storyboard\.|review\.|project\.)/);
  const [overall, setOverall] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  useEffect(() => setOverall(data?.review?.note ?? ""), [data?.version, data?.review?.note]);

  if (error) return html`<section class="card error">${error}</section>`;
  if (!data) return html`<section class="card muted">loading…</section>`;
  if (!data.project) return html`<section class="card muted">No active project.</section>`;
  if (!data.storyboard) {
    return html`<section class="card muted">No storyboard yet. Run <code>/demo discover</code> in pi; it appears here as soon as the agent writes one.</section>`;
  }

  const latest = data.versions.at(-1);
  const readOnly = data.version !== latest;
  const isApproved = data.approved === data.version;
  const diffKind = (id) => {
    if (!data.diff) return null;
    if (data.diff.added.includes(id)) return "new";
    if (data.diff.changed.includes(id)) return "changed";
    return null;
  };
  const run = async (fn, ok) => {
    setBusy(true);
    try {
      await fn();
      if (ok) setFlash(ok);
      reload();
    } catch (e) {
      setFlash(`⚠ ${e.message}`);
    } finally {
      setBusy(false);
      setTimeout(() => setFlash(null), 4000);
    }
  };
  const onReview = (scene, status, note) =>
    run(() => post("/api/review", { version: data.version, scene, status, note }));
  const marked = Object.keys(data.review?.scenes ?? {}).length;

  return html`
    <section class="card review-head">
      <div class="row">
        <h2>Storyboard v${data.version}</h2>
        ${isApproved ? html`<span class="badge approved">approved</span>` : null}
        ${readOnly ? html`<span class="badge old">older version (read-only)</span>` : null}
        <select value=${data.version} onChange=${(e) => setVersion(Number(e.target.value))}>
          ${data.versions.map((v) => html`<option value=${v}>v${v}${v === data.approved ? " ✓" : ""}</option>`)}
        </select>
      </div>
      ${data.storyboard.summary ? html`<p>${data.storyboard.summary}</p>` : null}
      ${
        data.diff
          ? html`<p class="muted small-text">since v${data.diff.from}:
            ${data.diff.added.length ? ` added ${data.diff.added.join(", ")};` : ""}
            ${data.diff.changed.length ? ` changed ${data.diff.changed.join(", ")};` : ""}
            ${data.diff.removed.length ? ` removed ${data.diff.removed.join(", ")};` : ""}
            ${data.diff.reordered ? " reordered;" : ""}</p>`
          : null
      }
    </section>
    <div class="scenes">
      ${data.storyboard.scenes.map(
        (scene, i) => html`<${SceneCard}
          key=${`${data.version}-${scene.id}`}
          scene=${scene}
          index=${i}
          review=${data.review}
          diffKind=${diffKind(scene.id)}
          readOnly=${readOnly}
          onReview=${onReview}
        />`,
      )}
    </div>
    ${
      readOnly
        ? null
        : html`<section class="card review-foot">
          <textarea
            placeholder="Overall notes (ordering, tone, scenes to add or drop)…"
            value=${overall}
            onInput=${(e) => setOverall(e.target.value)}
            onBlur=${() => overall !== (data.review?.note ?? "") && run(() => post("/api/review-note", { version: data.version, note: overall }))}
          ></textarea>
          <div class="row">
            <span class="muted small-text">${marked}/${data.storyboard.scenes.length} scenes marked${data.review?.submittedAt ? ` · last sent ${new Date(data.review.submittedAt).toLocaleTimeString()}` : ""}</span>
            <span class="grow"></span>
            ${flash ? html`<span class="flash">${flash}</span>` : null}
            <button disabled=${busy} onClick=${() =>
              run(async () => {
                if (overall !== (data.review?.note ?? ""))
                  await post("/api/review-note", { version: data.version, note: overall });
                await post("/api/review-submit", { version: data.version });
              }, "review sent to the agent")}>Send review to agent</button>
            <button class="primary" disabled=${busy || isApproved} onClick=${() =>
              confirm(`Approve storyboard v${data.version}? Recording will be unlocked.`) &&
              run(
                () => post("/api/approve", { artifact: "storyboard", version: data.version }),
                `v${data.version} approved`,
              )}>
              ${isApproved ? "Approved" : `Approve v${data.version}`}
            </button>
          </div>
        </section>`
    }`;
}

// ---------------- APP ----------------

function App() {
  const [tab, setTab] = useState("live");
  const { events, status } = useBus();
  const { data: state, error: stateError } = useApi("/api/state", events, /./);
  // Jump to Review when a new storyboard arrives.
  const lastWrite = events.filter((e) => e.type === "storyboard.written").at(-1)?.seq;
  useEffect(() => {
    if (lastWrite) setTab("review");
  }, [lastWrite]);
  return html`
    <header class="top">
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
    <main class=${tab}>
      ${tab === "live" ? html`<${Live} events=${events} state=${state} stateError=${stateError} />` : html`<${Review} events=${events} />`}
    </main>`;
}

render(html`<${App} />`, document.getElementById("app"));
