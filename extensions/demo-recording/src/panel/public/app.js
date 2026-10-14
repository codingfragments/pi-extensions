// demo-recording side panel — LIVE + REVIEW (S2). Preact + htm, vendored, no build.
import {
  html,
  render,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "/vendor/preact-htm.module.js";

// The token arrives once via ?token=; keep it in sessionStorage (this tab only)
// so reloads keep working, and strip it from the visible URL / history.
const TOKEN_KEY = "demo-rec-token";
const urlToken = new URLSearchParams(location.search).get("token");
if (urlToken) sessionStorage.setItem(TOKEN_KEY, urlToken);
const token = urlToken ?? sessionStorage.getItem(TOKEN_KEY) ?? "";
if (urlToken) history.replaceState(null, "", location.pathname);

const TABS = [
  { id: "live", label: "Live", ready: true },
  { id: "review", label: "Review", ready: true },
  { id: "voice", label: "Voice", ready: true },
  { id: "brand", label: "Brand", ready: true },
  { id: "export", label: "Export", ready: false, slice: "S5" },
];

async function api(path) {
  const res = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 401)
    throw new Error(
      "This panel link has expired (pi restarted). Open the current link from /demo panel.",
    );
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

const mmss = (ms) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

function SegmentBar({ segments }) {
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

function RecordingProgress({ events }) {
  const last = events
    .filter(
      (e) => e.type === "take.progress" || e.type === "take.started" || e.type === "take.finished",
    )
    .at(-1);
  if (!last || last.type === "take.started")
    return last
      ? html`<section class="card progress"><h3>Recording</h3><p class="muted">starting…</p></section>`
      : null;
  if (last.type === "take.finished") {
    return html`<section class="card progress"><h3>Recording <span class=${`pill ${last.data.status === "done" ? "" : "muted-pill"}`}>${last.data.status}</span></h3><p class="small-text">${last.data.message}</p></section>`;
  }
  const p = last.data.progress;
  const segments = p.scenes.map((s, i) => ({
    key: s.id,
    label: `${i + 1}. ${s.title}${s.attempt > 1 ? ` (retry ${s.attempt - 1})` : ""}`,
    weight: s.weight,
    done: s.done,
    state: s.done >= 0.999 ? "done" : i + 1 === p.scene.index ? "current" : "todo",
    restarted: s.attempt > 1,
  }));
  return html`<section class="card progress">
    <h3>Recording <span class="pill">${Math.round(p.fraction * 100)}%</span> ${p.phase !== "recording" ? html`<span class="muted small-text">${p.phase}</span>` : null}</h3>
    <${SegmentBar} segments=${segments} />
    <p class="small-text">scene ${p.scene.index}/${p.scene.total} · step ${p.step.index}/${p.step.total} · ${p.step.label}
      <span class="muted"> · ${mmss(p.elapsedMs)} elapsed · ~${mmss(p.etaMs)} left</span></p>
  </section>`;
}

function DiscoveryProgress({ events }) {
  const last = events
    .filter((e) => e.type === "discovery.progress" || e.type === "discovery.opened")
    .at(-1);
  if (!last || last.type !== "discovery.progress") return null;
  // Once a take has started, discovery is over — don't show a stale bar.
  const takeStarted = events.filter((e) => e.type === "take.started").at(-1);
  if (takeStarted && takeStarted.seq > last.seq) return null;
  const p = last.data.progress;
  const exploreShare = 0.88;
  const segments =
    p.mode === "plan"
      ? [
          ...p.areas.map((a) => ({
            key: a.name,
            label: a.name,
            weight: exploreShare / p.areas.length,
            done: a.status === "done" ? 1 : 0,
            state: a.status,
          })),
          {
            key: "_write",
            label: "storyboard",
            weight: 1 - exploreShare,
            done: p.fraction >= 1 ? 1 : 0,
            state: p.fraction >= 1 ? "done" : "todo",
          },
        ]
      : [
          {
            key: "_budget",
            label: "budget used (upper bound)",
            weight: 1,
            done: p.budgetFraction,
            state: "current",
          },
        ];
  return html`<section class="card progress">
    <h3>Discovery <span class="pill">${Math.round(p.fraction * 100)}%</span></h3>
    <${SegmentBar} segments=${segments} />
    <p class="small-text">${last.data.message}</p>
  </section>`;
}

function Live({ events, state, stateError }) {
  return html`
    <${StatusCard} state=${state} error=${stateError} />
    <${RecordingProgress} events=${events} />
    <${DiscoveryProgress} events=${events} />
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

// ---------------- VOICE ----------------

const KIND_LABEL = {
  intro: "intro · full video",
  outro: "outro · full video",
  bridge: "bridge · full video",
  scene: "scene",
};

function TimingBar({ timing, fit }) {
  if (!timing) return null;
  // After the voice exists: REAL narration length vs the rendered scene; before: an estimate from word count.
  if (fit && fit.voiceSec !== null) {
    const pct = Math.min(100, Math.round((fit.voiceSec / Math.max(0.1, timing.usableSec)) * 100));
    const cls = fit.level === "warn" ? "over" : fit.level === "info" ? "under" : "ok";
    return html`<div class="timing-wrap">
      <div class="timing" title="real voice length vs usable footage (dead time removed)">
        <div class=${`bar ${cls}`}><div style=${`width:${pct}%`}></div></div>
        <span class="small-text"><strong>${fit.voiceSec.toFixed(1)}s voice</strong> (real) / ${timing.usableSec}s footage → scene ${fit.sceneSec.toFixed(1)}s</span>
      </div>
      <p class=${`fit ${fit.level}`}>${fit.message}</p>
    </div>`;
  }
  const pct = Math.min(100, Math.round((timing.speechSec / Math.max(0.1, timing.usableSec)) * 100));
  const cls = timing.ratio > 1.35 ? "over" : timing.ratio < 0.35 ? "under" : "ok";
  return html`<div class="timing" title="estimated speech (from word count) vs usable footage">
    <div class=${`bar ${cls}`}><div style=${`width:${pct}%`}></div></div>
    <span class="small-text">~${timing.speechSec}s speech (estimate) / ${timing.usableSec}s footage${timing.ratio > 1.35 ? " — frames will be held" : ""}</span>
  </div>`;
}

const ANCHOR_SPLIT = /(\[@[a-z0-9-]+\])/g;
function Spoken({ text }) {
  return html`<p class="spoken">${text.split(ANCHOR_SPLIT).map((part) => (ANCHOR_SPLIT.test(part) ? html`<span class="mark">${part.slice(1, -1)}</span>` : part))}</p>`;
}

function VoSection({ section, timing, fit, issues, review, readOnly, onReview, onEdit, audio }) {
  const r = review?.scenes?.[section.key];
  const [draft, setDraft] = useState(section.written);
  const [note, setNote] = useState(r?.note ?? "");
  const [editing, setEditing] = useState(false);
  useEffect(() => setDraft(section.written), [section.written]);
  useEffect(() => setNote(r?.note ?? ""), [r?.note]);
  const set = (status) => onReview(section.key, r?.status === status ? null : status, note);
  const spokenWithAnchors = section.segments
    .map((seg) => `${seg.anchor ? `[@${seg.anchor}] ` : ""}${seg.text}`)
    .join(" ");
  return html`<article class=${`scene card vo ${r ? `st-${r.status}` : ""}`}>
    <div class="body">
      <header>
        <h3 class="title">${section.key}</h3>
        <span class="badge">${KIND_LABEL[section.kind]}</span>
      </header>
      ${section.kind === "scene" ? html`<${TimingBar} timing=${timing} fit=${fit} />` : null}
      ${
        editing
          ? html`<textarea class="vo-edit" value=${draft} onInput=${(e) => setDraft(e.target.value)}></textarea>
            <div class="actions">
              <button class="st" onClick=${() => onEdit(section.key, draft).then((ok) => ok && setEditing(false))}>Save as new version</button>
              <button class="st" onClick=${() => {
                setDraft(section.written);
                setEditing(false);
              }}>Cancel</button>
            </div>`
          : html`<${Spoken} text=${spokenWithAnchors} />`
      }
      ${issues.map((i) => html`<p class=${`issue ${i.level}`}>${i.level === "error" ? "✖" : "⚠"} ${i.message}</p>`)}
      ${audio ? html`<audio controls preload="none" src=${audio}></audio>` : null}
      ${
        readOnly
          ? null
          : html`<div class="actions">
            ${Object.entries(STATUS_LABEL).map(
              ([st, label]) =>
                html`<button class=${`st ${st} ${r?.status === st ? "on" : ""}`} onClick=${() => set(st)}>${label}</button>`,
            )}
            ${editing ? null : html`<button class="st" onClick=${() => setEditing(true)}>Edit text</button>`}
            <textarea placeholder="Notes for this section…" value=${note} onInput=${(e) => setNote(e.target.value)}
              onBlur=${() => r && note !== (r.note ?? "") && onReview(section.key, r.status, note)}></textarea>
          </div>`
      }
    </div>
  </article>`;
}

function Voice({ events }) {
  const [version, setVersion] = useState(null);
  const path = version ? `/api/vo?version=${version}` : "/api/vo";
  const { data, error, reload } = useApi(path, events, /^(vo\.|review\.|project\.|take\.|tts\.)/);
  const [overall, setOverall] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  useEffect(() => setOverall(data?.review?.note ?? ""), [data?.version, data?.review?.note]);
  if (error) return html`<section class="card error">${error}</section>`;
  if (!data) return html`<section class="card muted">loading…</section>`;
  if (!data.project) return html`<section class="card muted">No active project.</section>`;
  if (data.error) return html`<section class="card error">${data.error}</section>`;
  if (!data.sections) {
    return html`<section class="card muted">No voice-over yet. After a take is recorded, ask the agent to write the voice-over; it appears here.</section>`;
  }
  const latest = data.versions.at(-1);
  const readOnly = data.version !== latest;
  const isApproved = data.approved === data.version;
  const hasErrors = data.issues.some((i) => i.level === "error");
  const run = async (fn, ok) => {
    setBusy(true);
    try {
      const r = await fn();
      if (ok) setFlash(ok);
      reload();
      return r ?? true;
    } catch (e) {
      setFlash(`⚠ ${e.message}`);
      return false;
    } finally {
      setBusy(false);
      setTimeout(() => setFlash(null), 5000);
    }
  };
  const onReview = (scene, status, note) =>
    run(() => post("/api/review", { artifact: "vo", version: data.version, scene, status, note }));
  const onEdit = (section, text) =>
    run(async () => {
      const r = await post("/api/vo-edit", { version: data.version, section, text });
      setVersion(null);
      return r;
    }, "saved as a new version");
  const totalSpeech = data.timing.reduce((n, t) => n + t.speechSec, 0);
  const totalFootage = data.timing.reduce((n, t) => n + t.usableSec, 0);
  return html`
    <section class="card review-head">
      <div class="row">
        <h2>Voice-over v${data.version}</h2>
        <span class="muted small-text">for ${data.take} · ${data.fit ? `${data.fit.reduce((n, f) => n + (f.voiceSec ?? 0), 0).toFixed(0)}s voice (real)` : `~${totalSpeech.toFixed(0)}s speech (estimate)`} / ${totalFootage.toFixed(0)}s footage</span>
        ${data.fit?.some((f) => f.level === "warn") ? html`<span class="badge changed">${data.fit.filter((f) => f.level === "warn").length} fit warning(s)</span>` : null}
        ${isApproved ? html`<span class="badge approved">approved</span>` : null}
        ${readOnly ? html`<span class="badge old">older version (read-only)</span>` : null}
        <select value=${data.version} onChange=${(e) => setVersion(Number(e.target.value))}>
          ${data.versions.map((v) => html`<option value=${v}>v${v}${v === data.approved ? " ✓" : ""}</option>`)}
        </select>
      </div>
    </section>
    <div class="scenes">
      ${data.sections.map(
        (s) => html`<${VoSection}
          key=${`${data.version}-${s.key}`}
          section=${s}
          timing=${data.timing.find((t) => t.section === s.key)}
          issues=${data.issues.filter((i) => i.section === s.key && !(data.fit && /of speech for ~/.test(i.message)))}
          review=${data.review}
          readOnly=${readOnly}
          onReview=${onReview}
          onEdit=${onEdit}
          audio=${data.audio?.[s.key] ? media("project", data.audio[s.key]) : null}
          fit=${data.fit?.find((f) => f.scene === s.key) ?? null}
        />`,
      )}
    </div>
    ${
      readOnly
        ? null
        : html`<section class="card review-foot">
          <textarea placeholder="Overall notes (tone, density, stance)…" value=${overall} onInput=${(e) => setOverall(e.target.value)}
            onBlur=${() => overall !== (data.review?.note ?? "") && run(() => post("/api/review-note", { artifact: "vo", version: data.version, note: overall }))}></textarea>
          <div class="row">
            <span class="muted small-text">${Object.keys(data.review?.scenes ?? {}).length}/${data.sections.length} sections marked · approving unlocks voice synthesis (uses TTS credits)</span>
            <span class="grow"></span>
            ${flash ? html`<span class="flash">${flash}</span>` : null}
            <button disabled=${busy} onClick=${() =>
              run(async () => {
                if (overall !== (data.review?.note ?? ""))
                  await post("/api/review-note", {
                    artifact: "vo",
                    version: data.version,
                    note: overall,
                  });
                await post("/api/review-submit", { artifact: "vo", version: data.version });
              }, "review sent to the agent")}>Send review to agent</button>
            <button class="primary" disabled=${busy || isApproved || hasErrors} title=${hasErrors ? "fix errors first" : ""} onClick=${() =>
              confirm(`Approve voice-over v${data.version}? Voice synthesis will be unlocked.`) &&
              run(
                () => post("/api/approve", { artifact: "vo", version: data.version }),
                `v${data.version} approved`,
              )}>
              ${isApproved ? "Approved" : `Approve v${data.version}`}
            </button>
          </div>
        </section>`
    }`;
}

// ---------------- BRAND ----------------

/** Get/set a dotted path ("colors.accent") in a plain object. */
const getPath = (o, p) => p.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
function setPath(o, p, v) {
  const keys = p.split(".");
  const out = { ...o };
  let cur = out;
  for (const k of keys.slice(0, -1)) {
    cur[k] = { ...(cur[k] ?? {}) };
    cur = cur[k];
  }
  cur[keys.at(-1)] = v;
  return out;
}

const BRAND_FIELDS = [
  { group: "Colors", path: "colors.backdrop", label: "Backdrop", type: "color" },
  { group: "Colors", path: "colors.backdropTo", label: "Backdrop (to)", type: "color" },
  { group: "Colors", path: "colors.accent", label: "Accent", type: "color" },
  { group: "Colors", path: "colors.text", label: "Text", type: "color" },
  { group: "Colors", path: "colors.muted", label: "Muted", type: "color" },
  { group: "Colors", path: "colors.pill", label: "Callout pill", type: "hex" },
  { group: "Colors", path: "colors.pillText", label: "Pill text", type: "color" },
  {
    group: "Frame",
    path: "frame.mode",
    label: "Mode",
    type: "select",
    options: ["inset", "fullbleed"],
  },
  {
    group: "Frame",
    path: "frame.inset",
    label: "Inset",
    type: "range",
    min: 0.8,
    max: 1,
    step: 0.01,
  },
  {
    group: "Frame",
    path: "frame.radius",
    label: "Corner radius",
    type: "range",
    min: 0,
    max: 40,
    step: 1,
  },
  {
    group: "Frame",
    path: "frame.shadow",
    label: "Shadow",
    type: "range",
    min: 0,
    max: 1,
    step: 0.05,
  },
  { group: "Title card", path: "title.enabled", label: "Show", type: "bool" },
  {
    group: "Title card",
    path: "title.durationMs",
    label: "Hold (ms)",
    type: "range",
    min: 1000,
    max: 5000,
    step: 100,
  },
  {
    group: "Title card",
    path: "title.dissolveMs",
    label: "Dissolve (ms)",
    type: "range",
    min: 0,
    max: 2000,
    step: 100,
  },
  {
    group: "Title card",
    path: "title.logoPosition",
    label: "Logo",
    type: "select",
    options: ["inline", "top-left", "top-right", "bottom-left", "bottom-right", "none"],
  },
  { group: "Logo bug", path: "logoBug.enabled", label: "Show", type: "bool" },
  {
    group: "Logo bug",
    path: "logoBug.position",
    label: "Corner",
    type: "select",
    options: ["bottom-right", "bottom-left", "top-right", "top-left"],
  },
  {
    group: "Logo bug",
    path: "logoBug.opacity",
    label: "Opacity",
    type: "range",
    min: 0.2,
    max: 1,
    step: 0.05,
  },
  {
    group: "Logo bug",
    path: "logoBug.heightPx",
    label: "Height (px)",
    type: "range",
    min: 16,
    max: 80,
    step: 2,
  },
];

function BrandField({ f, value, onChange, disabled }) {
  const input =
    f.type === "color"
      ? html`<input type="color" value=${String(value ?? "#000000").slice(0, 7)} disabled=${disabled} onInput=${(e) => onChange(e.target.value)} />
          <code class="small-text">${value}</code>`
      : f.type === "hex"
        ? html`<input type="text" class="hex" value=${value ?? ""} disabled=${disabled} onChange=${(e) => onChange(e.target.value.trim())} />
            <span class="swatch" style=${`background:${value}`}></span>`
        : f.type === "bool"
          ? html`<input type="checkbox" checked=${!!value} disabled=${disabled} onChange=${(e) => onChange(e.target.checked)} />`
          : f.type === "select"
            ? html`<select value=${value} disabled=${disabled} onChange=${(e) => onChange(e.target.value)}>${f.options.map((o) => html`<option value=${o}>${o}</option>`)}</select>`
            : html`<input type="range" min=${f.min} max=${f.max} step=${f.step} value=${value} disabled=${disabled} onInput=${(e) => onChange(Number(e.target.value))} />
                <code class="small-text">${value}</code>`;
  return html`<label class="brand-field"><span>${f.label}</span>${input}</label>`;
}

function Brand({ events }) {
  const { data, error, reload } = useApi(
    "/api/brands",
    events,
    /^(brand\.|config\.|edit\.|project\.)/,
  );
  const [name, setName] = useState(null);
  const [patch, setPatch] = useState({});
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const selected = name ?? data?.default;
  const entry = data?.brands.find((b) => b.name === selected);
  const dirty = Object.keys(patch).length > 0;
  const say = (m) => {
    setFlash(m);
    setTimeout(() => setFlash(null), 6000);
  };
  const run = async (fn) => {
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      say(`⚠ ${e.message}`);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const refresh = (p = patch) =>
    run(async () => setPreview(await post("/api/brand-preview", { name: selected, patch: p })));
  // Preview when the brand changes (not on every tweak — rendering takes ~1 s).
  useEffect(() => {
    if (selected) {
      setPatch({});
      refresh({});
    }
  }, [selected]);
  if (error) return html`<section class="card error">${error}</section>`;
  if (!data) return html`<section class="card muted">loading…</section>`;
  const value = (p) =>
    getPath(patch, p) !== undefined ? getPath(patch, p) : getPath(entry?.brand, p);
  const groups = [...new Set(BRAND_FIELDS.map((f) => f.group))];
  const save = () =>
    run(async () => {
      const plan = await post("/api/brand-save", { name: selected, patch });
      if (
        !confirm(
          `Save brand "${selected}"?\n\n${plan.diff}${plan.warnings?.length ? `\n\nwarnings:\n- ${plan.warnings.join("\n- ")}` : ""}`,
        )
      )
        return;
      await post("/api/brand-save", { name: selected, patch, confirm: true });
      setPatch({});
      say(`saved ${selected}`);
      reload();
    });
  const duplicate = () =>
    run(async () => {
      const to = prompt("Name for the copy (lowercase, digits, dashes):", `${selected}-custom`);
      if (!to) return;
      await post("/api/brand-duplicate", { name: selected, to });
      if (dirty) await post("/api/brand-save", { name: to, patch, confirm: true });
      setName(to);
      say(`created ${to}${dirty ? " with your tweaks" : ""}`);
      reload();
    });
  const makeDefault = (scope) =>
    run(async () => {
      const plan = await post("/api/brand-use", { name: selected, scope });
      if (
        !confirm(
          `Set the default brand (${scope})?\n\n${plan.diff}${plan.shadowedBy ? `\n\n⚠ overridden by ${plan.shadowedBy}` : ""}`,
        )
      )
        return;
      await post("/api/brand-use", { name: selected, scope, confirm: true });
      say(`default brand: ${selected}`);
      reload();
    });
  const rerender = () =>
    run(async () => {
      if (dirty) return say("save your tweaks first — renders use the saved brand");
      await post("/api/export-render", { brand: selected });
      say(`re-rendering with ${selected} — no new voice, takes a minute`);
    });
  const running = data.job?.status === "running";
  const lastProgress = events.filter((e) => e.type === "edit.progress").at(-1);
  return html`
    <section class="card review-head">
      <div class="row">
        <h2>Brand</h2>
        <select value=${selected} onChange=${(e) => setName(e.target.value)}>
          ${data.brands.map((b) => html`<option value=${b.name}>${b.name}${b.builtin ? " (built-in)" : ""}${b.name === data.default ? " ✓ default" : ""}</option>`)}
        </select>
        ${entry?.error ? html`<span class="badge changed">invalid: ${entry.error}</span>` : null}
        <span class="grow"></span>
        ${flash ? html`<span class="flash">${flash}</span>` : null}
        <button disabled=${busy || selected === data.default} onClick=${() => makeDefault("global")}>Set as default</button>
        <button disabled=${busy || !data.project} title=${data.project ? `writes projects/${data.project}/config.json` : "no active project"} onClick=${() => makeDefault("project")}>Default for this project</button>
      </div>
      <p class="muted small-text">New brand from your logos/colors: ask the agent (<code>/demo brand new path/to/brand.zip</code>). User brands live in ${data.userDir}.</p>
    </section>
    <div class="brand-grid">
      <section class="card brand-preview">
        <div class="row"><h3>Preview</h3><span class="grow"></span>
          <button disabled=${busy} onClick=${() => refresh()}>${busy ? "rendering…" : dirty ? "Preview tweaks" : "Refresh"}</button></div>
        ${preview?.title ? html`<img src=${`${preview.title}&token=${token}`} alt="title card" />` : null}
        ${preview?.framed ? html`<img src=${`${preview.framed}&token=${token}`} alt="framed sample frame" />` : html`<p class="muted">rendering…</p>`}
        ${preview?.warnings?.length ? html`<ul class="issues">${preview.warnings.map((w) => html`<li class="warn">${w}</li>`)}</ul>` : null}
      </section>
      <section class="card brand-form">
        ${entry?.builtin ? html`<p class="muted small-text">Built-in brands are read-only: tweak, then <b>Save as copy</b>.</p>` : null}
        ${groups.map(
          (g) => html`<fieldset><legend>${g}</legend>
            ${BRAND_FIELDS.filter((f) => f.group === g).map(
              (
                f,
              ) => html`<${BrandField} f=${f} value=${value(f.path)} disabled=${busy || !entry?.brand}
                onChange=${(v) => setPatch((p) => setPath(p, f.path, v))} />`,
            )}</fieldset>`,
        )}
        <div class="row">
          <span class="muted small-text">${dirty ? "unsaved tweaks" : "no changes"}</span><span class="grow"></span>
          <button disabled=${busy || !dirty} onClick=${() => setPatch({})}>Reset</button>
          <button disabled=${busy} onClick=${duplicate}>Save as copy…</button>
          <button class="primary" disabled=${busy || !dirty || entry?.builtin} onClick=${save}>Save</button>
        </div>
      </section>
    </div>
    <section class="card">
      <div class="row">
        <h3>Rendered videos${data.edit ? ` · edit v${data.edit.version}` : ""}</h3><span class="grow"></span>
        ${running ? html`<span class="muted small-text">${lastProgress?.data?.message ?? "rendering…"}</span>` : null}
        <button class="primary" disabled=${busy || running || !data.edit} title=${data.edit ? "" : "no edit yet"} onClick=${rerender}>Re-render with ${selected}</button>
      </div>
      ${
        data.edit?.variants.length
          ? html`<div class="variants">${data.edit.variants.map(
              (v) =>
                html`<figure><figcaption>${v.name}</figcaption><video controls preload="metadata" src=${`${media("project", v.full)}&v=${Math.round(v.mtime)}`}></video></figure>`,
            )}</div>`
          : html`<p class="muted small-text">${data.edit ? "No branded render of this edit yet." : "No edit yet — once the voice-over is rendered, the videos show up here."} Re-rendering only redoes the picture: same timeline, same voice, no LLM or TTS.</p>`
      }
    </section>`;
}

// ---------------- APP ----------------

const THEME_KEY = "demo-rec-theme";

function ThemeToggle() {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme || "macchiato");
  const next = theme === "macchiato" ? "latte" : "macchiato";
  const flip = () => {
    document.documentElement.dataset.theme = next;
    localStorage.setItem(THEME_KEY, next);
    setTheme(next);
  };
  return html`<button class="theme-toggle" title=${`Switch to ${next === "latte" ? "Latte (light)" : "Macchiato (dark)"}`} onClick=${flip}>
    ${theme === "macchiato" ? "☾ Macchiato" : "☀ Latte"}
  </button>`;
}

function App() {
  const [tab, setTab] = useState("live");
  const { events, status } = useBus();
  const { data: state, error: stateError } = useApi("/api/state", events, /./);
  // Jump to Review when a new storyboard arrives.
  const lastWrite = events.filter((e) => e.type === "storyboard.written").at(-1)?.seq;
  useEffect(() => {
    if (lastWrite) setTab("review");
  }, [lastWrite]);
  // Jump to Voice when the agent writes a voice-over (not on the user's own inline edits).
  const lastVo = events.filter((e) => e.type === "vo.written" && e.data?.by !== "user").at(-1)?.seq;
  useEffect(() => {
    if (lastVo) setTab("voice");
  }, [lastVo]);
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
      <${ThemeToggle} />
      <span class=${`conn ${status}`}>${status}</span>
    </header>
    <main class=${tab}>
      ${tab === "live" ? html`<${Live} events=${events} state=${state} stateError=${stateError} />` : tab === "voice" ? html`<${Voice} events=${events} />` : tab === "brand" ? html`<${Brand} events=${events} />` : html`<${Review} events=${events} />`}
    </main>`;
}

render(html`<${App} />`, document.getElementById("app"));
