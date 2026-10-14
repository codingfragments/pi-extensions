// demo-recording side panel — the control room (S5 part 4): stage tabs
// Storyboard · Recording · Voice over · Annotations · Render · Config, each
// with a shared stage header, plus the collapsible Live panel. Preact + htm,
// vendored, no build.
import { html, render, useEffect, useState } from "/vendor/preact-htm.module.js";
import { Settings } from "./config.js";
import { api, media, post, screenUrl, token, useApi, useBus } from "./core.js";
import { LivePanel } from "./live.js";
import { Project } from "./project.js";
import { Recording } from "./recording.js";
import { StageHeader, VersionActions, stageOf, useStages } from "./stages.js";

const TABS = [
  { id: "project", label: "Project", stage: null },
  { id: "storyboard", label: "Storyboard", stage: "storyboard" },
  { id: "recording", label: "Recording", stage: "recording" },
  { id: "voice", label: "Voice over", stage: "vo" },
  { id: "annotations", label: "Annotations", stage: "annotations" },
  { id: "render", label: "Render", stage: "render" },
];

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
        ${scene.emphasis ? html`<p class="emphasis" title="the director's intent — annotations are chosen later, in the Annotations stage">✦ ${scene.emphasis}</p>` : null}
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
              ${s.emphasis ? html` <span class="flag emphasis" title="emphasis — a hint for the annotation designer">✦ ${s.emphasis}</span>` : null}
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

function Review({ events, stages }) {
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
  const mark = (v) => `${data.accepted?.includes(v) ? " ✓" : ""}${v === data.selected ? " ●" : ""}`;
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
    <${StageHeader} stages=${stages} stage="storyboard" />
    <section class="card review-head">
      <div class="row">
        <h2>Storyboard v${data.version}</h2>
        ${readOnly ? html`<span class="badge old">older version (read-only)</span>` : null}
        <select value=${data.version} title="✓ accepted · ● working line" onChange=${(e) => setVersion(Number(e.target.value))}>
          ${data.versions.map((v) => html`<option value=${v}>v${v}${mark(v)}</option>`)}
        </select>
        <span class="grow"></span>
        <${VersionActions} stages=${stages} stage="storyboard" version=${data.version} unlocks="Takes can be recorded from it." onDone=${reload} />
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

function Voice({ events, stages }) {
  const [version, setVersion] = useState(null);
  const input = stageOf(stages, "vo")?.input;
  useEffect(() => setVersion(null), [input]);
  const q = [input !== undefined ? `take=${input}` : "", version ? `version=${version}` : ""]
    .filter(Boolean)
    .join("&");
  const path = `/api/vo${q ? `?${q}` : ""}`;
  const { data, error, reload } = useApi(path, events, /^(vo\.|review\.|project\.|take\.|tts\.)/);
  const [overall, setOverall] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  useEffect(() => setOverall(data?.review?.note ?? ""), [data?.version, data?.review?.note]);
  // Keep the stage header (with its input picker) visible whatever the content does.
  const head = html`<${StageHeader} stages=${stages} stage="vo" />`;
  if (error) return html`${head}<section class="card error">${error}</section>`;
  if (!data) return html`${head}<section class="card muted">loading…</section>`;
  if (!data.project) return html`<section class="card muted">No active project.</section>`;
  if (data.error) return html`${head}<section class="card error">${data.error}</section>`;
  if (!data.sections) {
    return html`<${StageHeader} stages=${stages} stage="vo" />
      <section class="card muted">${input !== undefined ? `No voice-over for take-${String(input).padStart(3, "0")} yet — ask the agent to write one (/demo voiceover); it appears here.` : "Accept a take first (Recording tab); its voice-overs show up here."}</section>`;
  }
  const latest = data.versions.at(-1);
  const readOnly = data.version !== latest;
  const mark = (v) => `${data.accepted?.includes(v) ? " ✓" : ""}${v === data.selected ? " ●" : ""}`;
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
    <${StageHeader} stages=${stages} stage="vo" />
    <section class="card review-head">
      <div class="row">
        <h2>Voice-over v${data.version}</h2>
        <span class="muted small-text">for ${data.take} · ${data.fit ? `${data.fit.reduce((n, f) => n + (f.voiceSec ?? 0), 0).toFixed(0)}s voice (real)` : `~${totalSpeech.toFixed(0)}s speech (estimate)`} / ${totalFootage.toFixed(0)}s footage</span>
        ${data.fit?.some((f) => f.level === "warn") ? html`<span class="badge changed">${data.fit.filter((f) => f.level === "warn").length} fit warning(s)</span>` : null}
        ${readOnly ? html`<span class="badge old">older version (read-only)</span>` : null}
        <select value=${data.version} title="✓ accepted · ● working line" onChange=${(e) => setVersion(Number(e.target.value))}>
          ${data.versions.map((v) => html`<option value=${v}>v${v}${mark(v)}</option>`)}
        </select>
        <${VersionActions} stages=${stages} stage="vo" version=${data.version} disabled=${hasErrors} disabledWhy=${hasErrors ? "fix the errors first" : ""}
          unlocks="Voice synthesis is unlocked for it (uses TTS credits)." onDone=${reload} />
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
  {
    group: "Frame",
    path: "frame.border.width",
    label: "Rim width (px)",
    type: "range",
    min: 0,
    max: 4,
    step: 0.5,
  },
  {
    group: "Frame",
    path: "frame.border.color",
    label: "Rim color",
    type: "hex",
    placeholder: "auto | #RRGGBBAA",
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
        ? html`<input type="text" class="hex" value=${value ?? ""} placeholder=${f.placeholder ?? ""} disabled=${disabled} onChange=${(e) => onChange(e.target.value.trim())} />
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
    </div>`;
}

// ---------------- RENDER ----------------

/** Render stage (part 9 brings draft/final versions): rendered variants + re-render with a brand. */
function Render({ events, stages }) {
  const { data, error, reload } = useApi(
    "/api/brands",
    events,
    /^(brand\.|config\.|edit\.|project\.)/,
  );
  const [brand, setBrand] = useState(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  if (error) return html`<section class="card error">${error}</section>`;
  if (!data) return html`<section class="card muted">loading…</section>`;
  const selected = brand ?? data.default;
  const running = data.job?.status === "running";
  const lastProgress = events.filter((e) => e.type === "edit.progress").at(-1);
  const rerender = async () => {
    setBusy(true);
    try {
      await post("/api/export-render", { brand: selected });
      setFlash(`re-rendering with ${selected} — no new voice, takes a minute`);
      reload();
    } catch (e) {
      setFlash(`⚠ ${e.message}`);
    } finally {
      setBusy(false);
      setTimeout(() => setFlash(null), 6000);
    }
  };
  return html`
    <${StageHeader} stages=${stages} stage="render" />
    <section class="card">
      <div class="row">
        <h2>Rendered videos${data.edit ? ` · edit v${data.edit.version}` : ""}</h2><span class="grow"></span>
        ${flash ? html`<span class="flash">${flash}</span>` : null}
        ${running ? html`<span class="muted small-text">${lastProgress?.data?.message ?? "rendering…"}</span>` : null}
        <label class="small-text">brand <select value=${selected} onChange=${(e) => setBrand(e.target.value)}>
          ${data.brands.filter((b) => !b.error).map((b) => html`<option value=${b.name}>${b.name}${b.name === data.default ? " (default)" : ""}</option>`)}
        </select></label>
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
      <p class="muted small-text">Brands are edited under Config → Brands. Draft and final renders with QA arrive in S5 part 9.</p>
    </section>`;
}

// ---------------- ANNOTATIONS / CONFIG ----------------

function Annotations({ stages }) {
  return html`
    <${StageHeader} stages=${stages} stage="annotations" />
    <section class="card muted">
      <h2>Annotations</h2>
      <p>After the voice is generated, the annotation designer suggests zooms, callouts, highlights and more; you toggle, edit and approve them here. This stage arrives in S5 parts 7–8.</p>
    </section>`;
}

function Config({ events }) {
  const [view, setView] = useState("settings");
  return html`
    <div class="subtabs">${[
      ["settings", "Settings"],
      ["brands", "Brands"],
    ].map(
      ([id, label]) =>
        html`<button class=${`chip ${view === id ? "on" : ""}`} onClick=${() => setView(id)}>${label}</button>`,
    )}</div>
    ${view === "settings" ? html`<${Settings} events=${events} />` : html`<${Brand} events=${events} />`}`;
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

const LIVE_OPEN_KEY = "demo-rec-live-open";

function App() {
  const [tab, setTab] = useState("project");
  const [liveOpen, setLiveOpenState] = useState(localStorage.getItem(LIVE_OPEN_KEY) !== "false");
  const setLiveOpen = (v) => {
    localStorage.setItem(LIVE_OPEN_KEY, String(v));
    setLiveOpenState(v);
  };
  const { events, status } = useBus();
  const { data: state, error: stateError } = useApi("/api/state", events, /./);
  const { data: stages } = useStages(events);
  // Jump to the stage where something new arrived.
  const lastWrite = events.filter((e) => e.type === "storyboard.written").at(-1)?.seq;
  useEffect(() => {
    if (lastWrite) setTab("storyboard");
  }, [lastWrite]);
  const lastVo = events.filter((e) => e.type === "vo.written" && e.data?.by !== "user").at(-1)?.seq;
  useEffect(() => {
    if (lastVo) setTab("voice");
  }, [lastVo]);
  const lastTake = events
    .filter((e) => e.type === "take.finished" || e.type === "take.analyzed")
    .at(-1)?.seq;
  useEffect(() => {
    if (lastTake) setTab("recording");
  }, [lastTake]);
  const waiting = stages?.next?.who === "user" ? stages.next.stage : null;
  const body =
    tab === "project"
      ? html`<${Project} events=${events} />`
      : tab === "storyboard"
        ? html`<${Review} events=${events} stages=${stages} />`
        : tab === "recording"
          ? html`<${Recording} events=${events} stages=${stages} />`
          : tab === "voice"
            ? html`<${Voice} events=${events} stages=${stages} />`
            : tab === "annotations"
              ? html`<${Annotations} stages=${stages} />`
              : tab === "render"
                ? html`<${Render} events=${events} stages=${stages} />`
                : html`<${Config} events=${events} />`;
  return html`
    <header class="top">
      <strong>demo-recording</strong>
      ${state?.project ? html`<span class="muted small-text">${state.project.slug}</span>` : null}
      <nav class="steps" aria-label="process steps">
        ${TABS.map(
          (
            t,
            i,
          ) => html`${i ? html`<span class="step-sep" aria-hidden="true">›</span>` : null}<button
            class=${`${tab === t.id ? "active" : ""} ${waiting && waiting === t.stage ? "waiting" : ""}`}
            title=${waiting && waiting === t.stage ? `waiting for you: ${stages.next.text}` : ""}
            onClick=${() => setTab(t.id)}
          >${t.label}${waiting && waiting === t.stage ? html` <span class="dot"></span>` : null}</button>`,
        )}
      </nav>
      <button class=${`config-btn ${tab === "config" ? "active" : ""}`} title="Settings and brands (not a process step)" onClick=${() => setTab("config")}>⚙ Config</button>
      <${ThemeToggle} />
      <span class=${`conn ${status}`}>${status}</span>
    </header>
    <div class=${`shell ${liveOpen ? "live-open" : "live-closed"}`}>
      <main class=${tab}>${stateError ? html`<section class="card error">${stateError}</section>` : null}${body}</main>
      <${LivePanel} events=${events} state=${state} stages=${stages} tab=${tab} open=${liveOpen} setOpen=${setLiveOpen} status=${status} />
    </div>`;
}

render(html`<${App} />`, document.getElementById("app"));
