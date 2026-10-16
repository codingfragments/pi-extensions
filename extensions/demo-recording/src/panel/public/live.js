import { html, useEffect, useRef, useState } from "/vendor/preact-htm.module.js";
import { Modal, SegmentBar, api, copyText, media, mmss, summarize } from "./core.js";
// demo-recording panel — the building blocks of the Activity drawer (UX2, D101): progress rows
// for what runs, a frame preview, safety, and the log with its popups. The strip and the
// drawer that arrange them are in frame.js.
import { collapseProgress } from "./logview.js";

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
    fraction: d.total ? d.done / d.total : null, // unknown progress is not shown as 0 %
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
    jobRow(events, "edit", "Edit and draft render", "edit.progress", "edit.finished"),
    jobRow(events, "design", "Annotation designer", "design.progress", "design.finished"),
    jobRow(events, "render", "Render", "render.progress", "render.finished"),
  ].filter(Boolean);
  const running = rows.filter((r) => r.state === "running").sort((a, b) => a.at - b.at);
  const finished = rows.filter((r) => r.state !== "running").sort((a, b) => b.at - a.at);
  return running.length ? running : finished.slice(0, 1);
}

export function ProgressRows({ rows }) {
  if (!rows.length) return html`<p class="muted small-text">nothing running</p>`;
  return html`${rows.map(
    (r) => html`<div class=${`prow ${r.state}`} key=${r.key}>
      <div class="prow-head"><strong>${r.title}</strong>
        ${r.state === "running" ? (r.fraction !== null ? html`<span class="ds-badge" data-tone="info">${Math.round(r.fraction * 100)}%</span>` : html`<span class="ds-badge" data-tone="info">…</span>`) : html`<span class="ds-badge" data-tone=${r.state === "failed" ? "err" : "neutral"}>${r.state}</span>`}</div>
      ${r.segments ? html`<${SegmentBar} segments=${r.segments} />` : r.fraction !== null ? html`<div class="minibar"><div style=${`width:${Math.round(r.fraction * 100)}%`}></div></div>` : null}
      ${r.detail ? html`<p class="small-text muted">${r.detail}</p>` : null}
    </div>`,
  )}`;
}

export function FramePreview({ events, recording }) {
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

export function Safety({ events }) {
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

const logClass = (e) => (e.type.startsWith("safety.") ? e.type.replace(".", "-") : "");

/** The log list (side panel and full log): click a line for the whole event. */
function LogList({ events, onPick, follow = true, className = "log" }) {
  const ref = useRef(null);
  const onKey = (k, e) => {
    if (k.key !== "Enter" && k.key !== " ") return;
    k.preventDefault();
    onPick(e);
  };
  useEffect(() => {
    const el = ref.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [events.length, follow]);
  return html`<ol class=${className} ref=${ref}>
    ${events.map(
      (
        e,
      ) => html`<li key=${e.seq} class=${`log-line ${logClass(e)}`} tabindex="0" title="click for the whole event"
        onClick=${() => onPick(e)} onKeyDown=${(k) => onKey(k, e)}>
        <time>${new Date(e.at).toLocaleTimeString()}</time>
        <span class="type">${e.type}</span>
        ${e.ticks > 1 ? html`<span class="ticks" title=${`${e.ticks} progress updates since ${new Date(e.firstAt).toLocaleTimeString()}`}>×${e.ticks}</span>` : null}
        ${e.data ? html`<span class="data">${summarize(e.data)}</span>` : null}
      </li>`,
    )}
  </ol>`;
}

const eventText = (e) =>
  `${e.at}  #${e.seq}  ${e.type}${e.project ? `  [${e.project}]` : ""}${e.data ? `\n${JSON.stringify(e.data, null, 2)}` : ""}`;

/** One event, whole: time, type, project, message and all of its data. */
export function LogLineModal({ e, onClose }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    setCopied(await copyText(eventText(e)));
    setTimeout(() => setCopied(false), 1500);
  };
  const msg = typeof e.data?.message === "string" ? e.data.message : null;
  return html`<${Modal} title=${e.type} onClose=${onClose}
      actions=${html`<button class="ds-btn ds-btn--ghost" onClick=${copy}>${copied ? "copied ✓" : "Copy"}</button>`}>
    <dl class="kv log-detail">
      <dt>Time</dt><dd class="mono">${new Date(e.at).toLocaleString()} <span class="muted">(${e.at})</span></dd>
      <dt>Event</dt><dd class="mono">#${e.seq} · ${e.type}</dd>
      ${e.project ? html`<dt>Project</dt><dd>${e.project}</dd>` : null}
      ${e.ticks > 1 ? html`<dt>Progress</dt><dd>latest of ${e.ticks} updates since ${new Date(e.firstAt).toLocaleTimeString()}</dd>` : null}
      ${msg ? html`<dt>Message</dt><dd class="log-msg">${msg}</dd>` : null}
    </dl>
    ${e.data ? html`<h3 class="small-text muted">Data</h3><pre class="log-json">${JSON.stringify(e.data, null, 2)}</pre>` : html`<p class="muted">No data.</p>`}
  </${Modal}>`;
}

/** The whole log in a large popup: filter by text and type, follow the newest. */
export function FullLogModal({ events, onClose, onPick }) {
  const [q, setQ] = useState("");
  const [prefix, setPrefix] = useState("");
  const [follow, setFollow] = useState(true);
  const [copied, setCopied] = useState(false);
  const [allTicks, setAllTicks] = useState(false);
  const prefixes = [...new Set(events.map((e) => e.type.split(".")[0]))].sort();
  const needle = q.trim().toLowerCase();
  const shown = (allTicks ? events : collapseProgress(events)).filter(
    (e) =>
      (!prefix || e.type.startsWith(`${prefix}.`)) &&
      (!needle ||
        `${e.type} ${e.project ?? ""} ${JSON.stringify(e.data ?? {})}`
          .toLowerCase()
          .includes(needle)),
  );
  const copy = async () => {
    setCopied(await copyText(shown.map(eventText).join("\n\n")));
    setTimeout(() => setCopied(false), 1500);
  };
  return html`<${Modal} title=${`Log · ${shown.length} line(s) · ${events.length} event(s)`} size="large" onClose=${onClose}
      actions=${html`<button class="ds-btn ds-btn--ghost" onClick=${copy} title="copy the shown events">${copied ? "copied ✓" : "Copy"}</button>`}>
    <div class="row log-filters">
      <input class="note" type="search" placeholder="filter: text, type, project …" value=${q} onInput=${(e) => setQ(e.target.value)} aria-label="filter the log" />
      <select value=${prefix} onChange=${(e) => setPrefix(e.target.value)} aria-label="event type">
        <option value="">all types</option>
        ${prefixes.map((p) => html`<option value=${p}>${p}.*</option>`)}
      </select>
      <label class="ds-check small-text" title="every progress update as its own line, instead of one line per job"><input type="checkbox" checked=${allTicks} onChange=${(e) => setAllTicks(e.target.checked)} /> show all progress</label>
      <label class="ds-check small-text"><input type="checkbox" checked=${follow} onChange=${(e) => setFollow(e.target.checked)} /> follow newest</label>
      <span class="muted small-text">click a line for the whole event</span>
    </div>
    <${LogList} events=${shown} onPick=${onPick} follow=${follow} className="log log-full" />
  </${Modal}>`;
}

export function Log({ events, onPick }) {
  // working-draft autosaves are bookkeeping, not news: they stay out of the log
  const shown = events.filter((e) => e.type !== "draft.changed");
  return html`<${LogList} events=${collapseProgress(shown).slice(-300)} onPick=${onPick} />`;
}
