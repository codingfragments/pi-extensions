// demo-recording panel — Live control room (S5 part 4, D39): a collapsible
// side panel (bottom drawer on narrow windows) with progress rows for every
// running activity, a frame preview, safety, project summary and the log.
// Collapsed it is a one-line strip: stage · activity / waiting-for · progress.
import { html, useEffect, useRef, useState } from "/vendor/preact-htm.module.js";
import { SegmentBar, api, media, mmss, summarize } from "./core.js";

const last = (events, types) => events.filter((e) => types.includes(e.type)).at(-1);

function discoveryRow(events) {
  const ev = last(events, ["discovery.opened", "discovery.progress", "discovery.closed"]);
  if (!ev) return null;
  const takeStarted = last(events, ["take.started"]);
  const over = ev.type === "discovery.closed" || (takeStarted && takeStarted.seq > ev.seq);
  if (ev.type !== "discovery.progress")
    return {
      key: "discovery",
      title: "Discovery",
      state: over ? "done" : "running",
      fraction: over ? 1 : 0,
      detail: over ? "closed" : "starting…",
      at: ev.seq,
    };
  const p = ev.data.progress;
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
  return {
    key: "discovery",
    title: "Discovery",
    state: over ? "done" : "running",
    fraction: p.fraction,
    segments,
    detail: ev.data.message,
    at: ev.seq,
  };
}

function recordingRow(events) {
  const ev = last(events, ["take.started", "take.progress", "take.finished"]);
  if (!ev) return null;
  if (ev.type === "take.started")
    return {
      key: "take",
      title: "Recording",
      state: "running",
      fraction: 0,
      detail: "starting…",
      at: ev.seq,
    };
  if (ev.type === "take.finished")
    return {
      key: "take",
      title: "Recording",
      state: ev.data.status === "done" ? "done" : "failed",
      fraction: 1,
      detail: ev.data.message,
      at: ev.seq,
    };
  const p = ev.data.progress;
  const segments = p.scenes.map((s, i) => ({
    key: s.id,
    label: `${i + 1}. ${s.title}${s.attempt > 1 ? ` (retry ${s.attempt - 1})` : ""}`,
    weight: s.weight,
    done: s.done,
    state: s.done >= 0.999 ? "done" : i + 1 === p.scene.index ? "current" : "todo",
    restarted: s.attempt > 1,
  }));
  return {
    key: "take",
    title: "Recording",
    state: "running",
    fraction: p.fraction,
    segments,
    detail: `scene ${p.scene.index}/${p.scene.total} · step ${p.step.index}/${p.step.total} · ${p.step.label} · ${mmss(p.elapsedMs)} elapsed · ~${mmss(p.etaMs)} left`,
    at: ev.seq,
  };
}

function jobRow(events, key, title, progressType, finishedType) {
  const ev = last(events, [progressType, finishedType]);
  if (!ev) return null;
  if (ev.type === finishedType)
    return {
      key,
      title,
      state: ev.data.status === "done" ? "done" : "failed",
      fraction: 1,
      detail: ev.data.message,
      at: ev.seq,
    };
  const d = ev.data;
  return {
    key,
    title,
    state: "running",
    fraction: d.total ? d.done / d.total : 0,
    detail: d.message,
    at: ev.seq,
  };
}

function analysisRow(events) {
  const ev = last(events, ["take.analyzing", "take.analyzed"]);
  if (!ev) return null;
  return {
    key: "analysis",
    title: "Analysis",
    state: ev.type === "take.analyzing" ? "running" : "done",
    fraction: ev.type === "take.analyzing" ? null : 1,
    detail: ev.data?.message ?? "",
    at: ev.seq,
  };
}

/** All activity rows; running ones first, then the most recent finished one. */
export function activityRows(events) {
  const rows = [
    discoveryRow(events),
    recordingRow(events),
    analysisRow(events),
    jobRow(events, "tts", "Voice", "tts.progress", "tts.finished"),
    jobRow(events, "edit", "Render", "edit.progress", "edit.finished"),
  ].filter(Boolean);
  const running = rows.filter((r) => r.state === "running").sort((a, b) => a.at - b.at);
  const finished = rows.filter((r) => r.state !== "running").sort((a, b) => b.at - a.at);
  return running.length ? running : finished.slice(0, 1);
}

function ProgressRows({ rows }) {
  if (!rows.length) return html`<p class="muted small-text">nothing running</p>`;
  return html`${rows.map(
    (r) => html`<div class=${`prow ${r.state}`} key=${r.key}>
      <div class="prow-head"><strong>${r.title}</strong>
        ${r.state === "running" ? (r.fraction !== null ? html`<span class="pill">${Math.round(r.fraction * 100)}%</span>` : html`<span class="pill">…</span>`) : html`<span class=${`pill ${r.state === "failed" ? "fail-pill" : "muted-pill"}`}>${r.state}</span>`}</div>
      ${r.segments ? html`<${SegmentBar} segments=${r.segments} />` : r.fraction !== null ? html`<div class="minibar"><div style=${`width:${Math.round(r.fraction * 100)}%`}></div></div>` : null}
      ${r.detail ? html`<p class="small-text muted">${r.detail}</p>` : null}
    </div>`,
  )}`;
}

function FramePreview({ events, recording }) {
  const [frame, setFrame] = useState(null);
  useEffect(() => {
    if (!recording) {
      setFrame(null);
      return;
    }
    let stop = false;
    const tick = () =>
      api("/api/live-frame").then(
        (d) => !stop && setFrame(d.frame),
        () => {},
      );
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [recording]);
  const look = last(events, ["discovery.look"]);
  if (frame)
    return html`<figure class="frame"><img src=${`${media("project", frame.media)}`} alt="live frame" /><figcaption>${frame.take} · live</figcaption></figure>`;
  if (look)
    return html`<figure class="frame"><img src=${media("app", look.data.media)} alt="current screen" /><figcaption class="mono">${look.data.screen} · ${look.data.title}</figcaption></figure>`;
  return html`<p class="muted small-text">no frame yet — screens appear during discovery and recording</p>`;
}

function Safety({ events }) {
  const safety = events
    .filter((e) => e.type === "safety.blocked" || e.type === "safety.mutation")
    .slice(-6)
    .reverse();
  const look = last(events, ["discovery.look"]);
  const b = look?.data?.budget;
  if (!safety.length && !b)
    return html`<p class="muted small-text">no state-changing actions so far</p>`;
  return html`
    ${b ? html`<p class="small-text">screens ${b.screens} · actions ${b.actions} · min ${b.minutes}${b.exhausted ? html` <strong class="warn">exhausted</strong>` : null}</p>` : null}
    <ul class="safety">${safety.map(
      (e) => html`<li class=${e.type === "safety.blocked" ? "blocked" : "mutating"}>
        <strong>${e.type === "safety.blocked" ? "blocked" : "state change"}</strong> ${e.data.action} ${e.data.name ? `"${e.data.name}"` : ""}
        <div class="muted small-text">${e.data.reason}</div>
      </li>`,
    )}</ul>`;
}

function Project({ state, stages }) {
  const p = state?.project;
  if (!p)
    return html`<p class="muted small-text">No active project. Run <code>/demo new</code> or <code>/demo open</code> in pi.</p>`;
  return html`<dl class="small-text">
    <dt>Project</dt><dd><strong>${p.slug}</strong> · ${p.app.name}</dd>
    <dt>Phase</dt><dd><span class="pill">${p.state.phase}</span></dd>
    <dt>Working line</dt><dd>${stages?.lineText ?? "—"}</dd>
    <dt>Folder</dt><dd class="mono">${p.dir}</dd>
  </dl>`;
}

function Log({ events }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);
  return html`<ol class="log" ref=${ref}>
    ${events.slice(-300).map(
      (
        e,
      ) => html`<li key=${e.seq} class=${e.type.startsWith("safety.") ? e.type.replace(".", "-") : ""}>
        <time>${new Date(e.at).toLocaleTimeString()}</time>
        <span class="type">${e.type}</span>
        ${e.data ? html`<span class="data">${summarize(e.data)}</span>` : null}
      </li>`,
    )}
  </ol>`;
}

export const LIVE_SECTIONS = [
  { id: "progress", label: "Progress" },
  { id: "preview", label: "Preview" },
  { id: "safety", label: "Safety" },
  { id: "project", label: "Project" },
  { id: "log", label: "Log" },
];

/** What each tab shows in the Live panel by default (the user can toggle per tab). */
export const LIVE_DEFAULTS = {
  storyboard: ["progress", "preview", "safety", "project", "log"],
  recording: ["progress", "preview", "project", "log"],
  voice: ["progress", "project", "log"],
  annotations: ["progress", "project", "log"],
  render: ["progress", "project", "log"],
  config: ["project", "log"],
};

function useSections(tab) {
  const key = `demo-rec-live:${tab}`;
  const read = () => {
    try {
      const v = JSON.parse(localStorage.getItem(key) ?? "null");
      return Array.isArray(v) ? v : (LIVE_DEFAULTS[tab] ?? LIVE_DEFAULTS.storyboard);
    } catch {
      return LIVE_DEFAULTS[tab] ?? LIVE_DEFAULTS.storyboard;
    }
  };
  const [sections, setSections] = useState(read);
  useEffect(() => setSections(read()), [tab]);
  const toggle = (id) => {
    const next = sections.includes(id) ? sections.filter((s) => s !== id) : [...sections, id];
    localStorage.setItem(key, JSON.stringify(next));
    setSections(next);
  };
  return [sections, toggle];
}

/** One-line summary: the running activity, else what the project waits for. */
export function liveSummary(rows, stages) {
  const running = rows.find((r) => r.state === "running");
  if (running)
    return {
      text: `${running.title}${running.fraction !== null ? ` ${Math.round(running.fraction * 100)}%` : ""}`,
      fraction: running.fraction,
      waiting: null,
    };
  const next = stages?.next;
  if (next?.who === "user")
    return { text: `waiting for you: ${next.text}`, fraction: null, waiting: "user" };
  if (next?.who === "agent")
    return { text: `agent: ${next.text}`, fraction: null, waiting: "agent" };
  return { text: next?.text ?? "idle", fraction: null, waiting: null };
}

export function LivePanel({ events, state, stages, tab, open, setOpen, status }) {
  const rows = activityRows(events);
  const [sections, toggle] = useSections(tab);
  const sum = liveSummary(rows, stages);
  const recording = rows.some((r) => r.key === "take" && r.state === "running");
  const stageLabel = stages?.next?.stage
    ? (stages.stages.find((s) => s.stage === stages.next.stage)?.label ?? stages.next.stage)
    : (state?.project?.state?.phase ?? "");
  if (!open)
    return html`<button class=${`live-strip ${sum.waiting === "user" ? "attention" : ""}`} onClick=${() => setOpen(true)} title="open the Live panel">
      <span class=${`conn-dot ${status}`}></span>
      <strong>Live</strong>
      ${stageLabel ? html`<span class="pill">${stageLabel}</span>` : null}
      <span class="live-strip-text">${sum.text}</span>
      ${sum.fraction !== null ? html`<span class="minibar strip"><span style=${`width:${Math.round(sum.fraction * 100)}%`}></span></span>` : null}
      <span class="grow"></span><span class="muted">▲ open</span>
    </button>`;
  const show = (id) => sections.includes(id);
  return html`<aside class="live">
    <div class="live-head">
      <span class=${`conn-dot ${status}`}></span><strong>Live</strong>
      ${stageLabel ? html`<span class="pill">${stageLabel}</span>` : null}
      <span class="grow"></span>
      <button class="ghost" title="collapse" onClick=${() => setOpen(false)}>▼ collapse</button>
    </div>
    <p class=${`live-summary ${sum.waiting === "user" ? "attention" : ""}`}>${sum.text}</p>
    <div class="live-toggles">${LIVE_SECTIONS.map(
      (s) =>
        html`<button class=${`chip ${show(s.id) ? "on" : ""}`} onClick=${() => toggle(s.id)}>${s.label}</button>`,
    )}</div>
    ${show("progress") ? html`<section class="live-sec"><h3>Progress</h3><${ProgressRows} rows=${rows} /></section>` : null}
    ${show("preview") ? html`<section class="live-sec"><h3>Preview</h3><${FramePreview} events=${events} recording=${recording} /></section>` : null}
    ${show("safety") ? html`<section class="live-sec"><h3>Safety</h3><${Safety} events=${events} /></section>` : null}
    ${show("project") ? html`<section class="live-sec"><h3>Project</h3><${Project} state=${state} stages=${stages} /></section>` : null}
    ${show("log") ? html`<section class="live-sec grow"><h3>Log</h3><${Log} events=${events} /></section>` : null}
  </aside>`;
}
