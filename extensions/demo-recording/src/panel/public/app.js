import { html, render, useEffect, useMemo, useRef, useState } from "/vendor/preact-htm.module.js";
import { Annotations } from "./annotations.js";
import {
  ApproveHighModal,
  ConfBadge,
  ConfReasons,
  NeedsEyes,
  byRisk,
  confOf,
  itemDomId,
  useCollapse,
} from "./confidence.js";
import { Settings } from "./config.js";
import {
  api,
  media,
  post,
  screenUrl,
  token,
  useApi,
  useBus,
  useHashRoute,
  useRouteVersion,
} from "./core.js";
import { CostHint, confirmCost, setModels } from "./cost.js";
// demo-recording side panel — the control room (S5 part 4): stage tabs
// Storyboard · Recording · Voice over · Annotations · Render · Config, each
// with a shared stage header, the frame (frame.js) and the Activity drawer. Preact + htm,
// vendored, no build.
import { askText, confirmAsk, errorToast } from "./dialog.js";
import { newsTab, nextBand, stepStates, stripState } from "./frame-state.js";
import { ActivityDrawer, ActivityStrip, Header } from "./frame.js";
import { activityRows } from "./live.js";
import { Project } from "./project.js";
import { Recording } from "./recording.js";
import { Render } from "./render.js";
import { readLastPlace, writeLastPlace } from "./route.js";
import { stageOf, useStages } from "./stages.js";
import { StageSummary, VersionActions, runVersionAction, useHistory } from "./version-ui.js";

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

const STATUS_LABEL = { approved: "Mark reviewed", changes: "Needs changes", rerun: "Re-run" };

/** One line for a collapsed high-confidence item (D79/D81). */
function CompactCard({ id, index, title, conf, status, onExpand }) {
  return html`<article class=${`scene card compact ${status ? `st-${status}` : ""}`} id=${itemDomId(id)}>
    <header>
      ${index !== undefined ? html`<span class="idx">${index + 1}</span>` : null}
      <h3 class="title">${title}</h3>
      <span class="mono muted">${id}</span>
      <${ConfBadge} c=${conf} />
      ${conf?.approvedIn !== undefined ? html`<span class="muted small-text">unchanged since v${conf.approvedIn}, where you approved it</span>` : null}
      ${status ? html`<span class=${`badge ${status}`}>${status}</span>` : null}
      <span class="grow"></span>
      <button class="ghost" onClick=${onExpand}>show ▾</button>
    </header>
  </article>`;
}

function SceneCard({ scene, index, review, diffKind, readOnly, onReview, conf }) {
  const r = review?.scenes?.[scene.id];
  const [note, setNote] = useState(r?.note ?? "");
  useEffect(() => setNote(r?.note ?? ""), [r?.note]);
  const set = (status) => onReview(scene.id, r?.status === status ? null : status, note);
  return html`
    <article class=${`scene card ${r ? `st-${r.status}` : ""} ${conf ? `cf-${conf.level}` : ""}`} id=${itemDomId(scene.id)}>
      <div class="thumb">
        ${scene.screen ? html`<img src=${screenUrl(scene.screen)} alt="" loading="lazy" />` : html`<div class="muted">no screen</div>`}
      </div>
      <div class="body">
        <header>
          <span class="idx">${index + 1}</span>
          <h3 class="title">${scene.title}</h3>
          <span class="mono muted">${scene.id}</span>
          ${diffKind ? html`<span class=${`badge ${diffKind}`}>${diffKind}</span>` : null}
          <${ConfBadge} c=${conf} />
        </header>
        <${ConfReasons} c=${conf} />
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
  const version = useRouteVersion("storyboard");
  const hist = useHistory("storyboard", events);
  const path = version ? `/api/storyboard?version=${version}` : "/api/storyboard";
  const { data, error, reload } = useApi(path, events, /^(storyboard\.|review\.|project\.)/);
  const [overall, setOverall] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const [riskFirst, setRiskFirst] = useState(false);
  const [approveOpen, setApproveOpen] = useState(false);
  const fold = useCollapse();
  useEffect(() => setOverall(data?.review?.note ?? ""), [data?.version, data?.review?.note]);

  if (error) return html`<section class="card error">${error}</section>`;
  if (!data) return html`<section class="card muted">loading…</section>`;
  if (!data.project) return html`<section class="card muted">No active project.</section>`;
  if (!data.storyboard && version !== null)
    return html`<${StageSummary} stage="storyboard" rows=${hist.data?.rows} viewed=${version} />`;
  if (!data.storyboard) {
    return html`<section class="card muted">No storyboard yet. Run <code>/demo discover</code> in pi; it appears here as soon as the agent writes one.</section>`;
  }

  const latest = data.versions.at(-1);
  const readOnly = data.version !== latest;
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
    <${StageSummary} stage="storyboard" row=${hist.data?.rows?.find((r) => r.version === data.version)} rows=${hist.data?.rows}
      viewed=${data.version} onUse=${(v) => runVersionAction({ stage: "storyboard", version: v, intent: "use" }).then(reload)}
      meta=${readOnly ? html`<span>older version: read-only</span>` : null} />
    <section class="card review-head">
      <div class="row">
        <${VersionActions} stage="storyboard" row=${hist.data?.rows?.find((r) => r.version === data.version)} events=${events} onDone=${reload} />
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
      <${NeedsEyes} summary=${data.confidence} riskFirst=${riskFirst} setRiskFirst=${setRiskFirst} collapseHigh=${fold.collapseHigh} setCollapseHigh=${fold.setCollapseHigh}>
        ${readOnly || !data.confidence ? null : html`<button class="ghost" title="mark every unmarked high-confidence scene reviewed — you see the list first" onClick=${() => setApproveOpen(true)}>Mark high-confidence reviewed…</button>`}
      </${NeedsEyes}>
    </section>
    <div class="scenes">
      ${(
        riskFirst
          ? byRisk(data.storyboard.scenes, data.confidence, (s) => s.id)
          : data.storyboard.scenes
      ).map((scene) => {
        const i = data.storyboard.scenes.indexOf(scene);
        const conf = confOf(data.confidence, scene.id);
        return fold.isCollapsed(scene.id, conf)
          ? html`<${CompactCard} key=${`${data.version}-${scene.id}-c`} id=${scene.id} index=${i} title=${scene.title} conf=${conf} status=${data.review?.scenes?.[scene.id]?.status} onExpand=${() => fold.expand(scene.id)} />`
          : html`<${SceneCard}
          key=${`${data.version}-${scene.id}`}
          scene=${scene}
          index=${i}
          review=${data.review}
          diffKind=${diffKind(scene.id)}
          readOnly=${readOnly}
          onReview=${onReview}
          conf=${conf}
        />`;
      })}
    </div>
    ${
      approveOpen
        ? html`<${ApproveHighModal} artifact="storyboard" version=${data.version} onClose=${() => setApproveOpen(false)} onDone=${(
            r,
          ) => {
            setApproveOpen(false);
            setFlash(`${r.approved.length} scene(s) approved · ${r.skip.length} left for you`);
            setTimeout(() => setFlash(null), 5000);
            reload();
          }} />`
        : null
    }
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
              }, "review sent to the agent")}>Send review to agent</button><${CostHint} />
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

/** Word diff vs the base (D83): insertions and deletions inline. */
function DiffText({ parts }) {
  return html`<p class="spoken diff">${parts.map((p) =>
    p.op === "eq"
      ? `${p.text} `
      : html`<span class=${p.op === "ins" ? "d-ins" : "d-del"}>${p.text}</span>${" "}`,
  )}</p>`;
}

function VoSection({
  section,
  timing,
  fit,
  issues,
  review,
  readOnly,
  onReview,
  onEdit,
  audio,
  conf,
  showChanges,
}) {
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
  const diffParts = showChanges && Array.isArray(section.diff) ? section.diff : null;
  return html`<article class=${`scene card vo ${r ? `st-${r.status}` : ""} ${conf ? `cf-${conf.level}` : ""}`} id=${itemDomId(section.key)}>
    <div class="body">
      <header>
        <h3 class="title">${section.key}</h3>
        <span class="badge">${KIND_LABEL[section.kind]}</span>
        ${showChanges && section.diff === "new" ? html`<span class="badge new">new</span>` : null}
        ${diffParts ? html`<span class="badge changed">changed</span>` : null}
        <${ConfBadge} c=${conf} />
      </header>
      <${ConfReasons} c=${conf} />
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
          : diffParts
            ? html`<${DiffText} parts=${diffParts} />`
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

const DIR_STANCES = ["champion", "evaluator", "teacher"];
const DIR_TONES = ["calm", "energetic", "conversational", "crisp"];
const DIR_LENGTHS = [
  ["shorter", "−20 %"],
  ["same", "same"],
  ["longer", "+20 %"],
  ["fit", "fit footage"],
];

function Chips({ label, options, value, onChange }) {
  return html`<div class="dir-row"><span class="dir-label">${label}</span>
    ${options.map(([v, l]) => html`<button class=${`chip ${value === v ? "on" : ""}`} aria-pressed=${value === v} onClick=${() => onChange(value === v ? "" : v)}>${l}</button>`)}
  </div>`;
}

/** D82: steer the whole narrative — the agent rewrites the script as a new version from the same take. */
function Direction({ data, onSent }) {
  const def = data.direction?.defaults ?? {};
  const init = () => ({
    stance: def.stance ?? "",
    tone: def.tone ?? "",
    length: def.length ?? "same",
    focus: def.focus ?? "",
    notes: def.notes ?? "",
  });
  const [d, setD] = useState(init);
  const [save, setSave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => setD(init()), [data.version, JSON.stringify(def)]);
  const set = (k) => (v) => setD({ ...d, [k]: v });
  const pending = data.direction?.pending;
  const send = async () => {
    setBusy(true);
    setErr(null);
    try {
      await post("/api/vo-direction", { version: data.version, ...d, saveDefault: save });
      onSent(
        `direction sent — the agent drafts v${Math.max(...data.versions) + 1} from v${data.version}`,
      );
      setSave(false);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return html`<details class="card direction" open=${!!pending}>
    <summary><b>Direction</b> <span class="muted small-text">— steer the whole narrative; the agent drafts a new version of v${data.version} from the same take</span></summary>
    ${pending ? html`<p class="small-text pending">⏳ Direction sent ${new Date(pending.at).toLocaleTimeString()} on v${pending.base} — waiting for the agent's new version.</p>` : null}
    <${Chips} label="Stance" options=${DIR_STANCES.map((x) => [x, x])} value=${d.stance} onChange=${set("stance")} />
    <${Chips} label="Tone" options=${DIR_TONES.map((x) => [x, x])} value=${d.tone} onChange=${set("tone")} />
    <${Chips} label="Length" options=${DIR_LENGTHS} value=${d.length} onChange=${set("length")} />
    <div class="dir-row"><span class="dir-label">Focus</span><input class="grow" value=${d.focus} placeholder="what the story should lean on, e.g. the EMEA churn drill-down" onInput=${(e) => set("focus")(e.target.value)} aria-label="focus" /></div>
    <div class="dir-row"><span class="dir-label">Notes</span><textarea class="grow" value=${d.notes} placeholder="anything else: less hype, say each number once, …" onInput=${(e) => set("notes")(e.target.value)} aria-label="direction notes"></textarea></div>
    <div class="row">
      <label class="check small-text"><input type="checkbox" checked=${save} onChange=${(e) => setSave(e.target.checked)} /> save as the project's default direction (brief)</label>
      <span class="grow"></span>
      ${err ? html`<span class="error small-text">${err}</span>` : null}
      <button class="primary" disabled=${busy} onClick=${send}>Draft new version</button><${CostHint} />
    </div>
  </details>`;
}

function Voice({ events, stages }) {
  const version = useRouteVersion("voice");
  const hist = useHistory("vo", events);
  const [, go] = useHashRoute();
  const [compare, setCompare] = useState(null);
  const [showChanges, setShowChanges] = useState(true);
  const [riskFirst, setRiskFirst] = useState(false);
  const [approveOpen, setApproveOpen] = useState(false);
  const fold = useCollapse();
  const input = stageOf(stages, "vo")?.input;
  useEffect(() => setCompare(null), [version]);
  const q = [
    input !== undefined ? `take=${input}` : "",
    version ? `version=${version}` : "",
    compare ? `compare=${compare}` : "",
  ]
    .filter(Boolean)
    .join("&");
  const path = `/api/vo${q ? `?${q}` : ""}`;
  const { data, error, reload } = useApi(path, events, /^(vo\.|review\.|project\.|take\.|tts\.)/);
  const [overall, setOverall] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  useEffect(() => setOverall(data?.review?.note ?? ""), [data?.version, data?.review?.note]);
  // Keep the stage header (with its input picker) visible whatever the content does.
  const head = html`<${StageSummary} stage="vo" rows=${hist.data?.rows} viewed=${version} />`;
  if (error) return html`${head}<section class="card error">${error}</section>`;
  if (!data) return html`${head}<section class="card muted">loading…</section>`;
  if (!data.project) return html`<section class="card muted">No active project.</section>`;
  if (data.error)
    return html`${head}<section class="card error">${data.error} <a href="#/voice">Show the latest</a></section>`;
  if (!data.sections && version !== null)
    return html`${head}<section class="card error">Voice over v${version} does not exist. <a href="#/voice">Show the latest</a></section>`;
  if (!data.sections) {
    return html`${head}
      <section class="card muted">${input !== undefined ? `No voice-over for take-${String(input).padStart(3, "0")} yet — ask the agent to write one (/demo voiceover); it appears here.` : "Approve a take first (Recording tab); its voice-overs show up here."}</section>`;
  }
  const latest = data.versions.at(-1);
  const readOnly = data.version !== latest;
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
  /** D84, D91: the cost first (a dialog that never skips), then TTS → edit → draft as engine jobs. */
  const generate = async () => {
    try {
      if (!(await confirmCost("vo-generate", { version: data.version }))) return;
      await post("/api/vo-generate", { version: data.version, confirm: true });
      setFlash("voice synthesis started — then the edit and a draft render (progress in Live)");
      setTimeout(() => setFlash(null), 6000);
    } catch (e) {
      errorToast(e);
    }
  };
  const onReview = (scene, status, note) =>
    run(() => post("/api/review", { artifact: "vo", version: data.version, scene, status, note }));
  const onEdit = (section, text) =>
    run(async () => {
      const r = await post("/api/vo-edit", { version: data.version, section, text });
      go({ screen: "voice" }); // look at the new version: the latest
      return r;
    }, "saved as a new version");
  const changedCount = data.sections.filter(
    (x) => Array.isArray(x.diff) || x.diff === "new",
  ).length;
  const totalSpeech = data.timing.reduce((n, t) => n + t.speechSec, 0);
  const totalFootage = data.timing.reduce((n, t) => n + t.usableSec, 0);
  return html`
    <${StageSummary} stage="vo" row=${hist.data?.rows?.find((r) => r.version === data.version)} rows=${hist.data?.rows}
      viewed=${data.version} onUse=${(v) => runVersionAction({ stage: "vo", version: v, intent: "use" }).then(reload)}
      meta=${readOnly ? html`<span>older version: read-only</span>` : null} />
    <section class="card review-head">
      <div class="row">
        <span class="muted small-text">for ${data.take} · ${data.fit ? `${data.fit.reduce((n, f) => n + (f.voiceSec ?? 0), 0).toFixed(0)}s voice (real)` : `~${totalSpeech.toFixed(0)}s speech (estimate)`} / ${totalFootage.toFixed(0)}s footage</span>
        ${data.fit?.some((f) => f.level === "warn") ? html`<span class="badge changed">${data.fit.filter((f) => f.level === "warn").length} fit warning(s)</span>` : null}
        <${VersionActions} stage="vo" row=${hist.data?.rows?.find((r) => r.version === data.version)} events=${events} onDone=${reload} />
        ${data.canGenerate ? html`<button class="primary" title="synthesize the voice, then edit and render a draft — you see the cost estimate first" onClick=${generate}>Generate voice & render…</button>` : null}
      </div>
      ${
        data.base !== null && data.base !== undefined
          ? html`<div class="row small-text vo-diff-head">
            <span>${data.meta?.direction ? "re-directed from" : "compared with"} <b>v${data.base}</b>: changed ${changedCount} of ${data.sections.length} sections</span>
            <select aria-label="compare with" value=${data.base} onChange=${(e) => setCompare(Number(e.target.value))}>
              ${data.versions.filter((v) => v !== data.version).map((v) => html`<option value=${v}>compare with v${v}</option>`)}
            </select>
            <label class="check"><input type="checkbox" checked=${showChanges} onChange=${(e) => setShowChanges(e.target.checked)} /> show changes</label>
            ${
              data.meta?.direction
                ? html`<span class="muted">direction: ${Object.entries(data.meta.direction)
                    .map(([k, v]) => `${k} ${v}`)
                    .join(" · ")}</span>`
                : null
            }
          </div>`
          : null
      }
      <${NeedsEyes} summary=${data.confidence} riskFirst=${riskFirst} setRiskFirst=${setRiskFirst} collapseHigh=${fold.collapseHigh} setCollapseHigh=${fold.setCollapseHigh}>
        ${readOnly || !data.confidence ? null : html`<button class="ghost" title="mark every unmarked high-confidence section reviewed — you see the list first" onClick=${() => setApproveOpen(true)}>Mark high-confidence reviewed…</button>`}
      </${NeedsEyes}>
    </section>
    ${
      readOnly
        ? null
        : html`<${Direction} data=${data} onSent=${(m) => {
            setFlash(m);
            setTimeout(() => setFlash(null), 6000);
          }} />`
    }
    <div class="scenes">
      ${(riskFirst ? byRisk(data.sections, data.confidence, (x) => x.key) : data.sections).map(
        (s) => {
          const conf = confOf(data.confidence, s.key);
          if (fold.isCollapsed(s.key, conf, showChanges && s.diff === "same"))
            return html`<${CompactCard} key=${`${data.version}-${s.key}-c`} id=${s.key} title=${s.key} conf=${conf} status=${data.review?.scenes?.[s.key]?.status} onExpand=${() => fold.expand(s.key)} />`;
          return html`<${VoSection}
          key=${`${data.version}-${s.key}`}
          conf=${conf}
          showChanges=${showChanges}
          section=${s}
          timing=${data.timing.find((t) => t.section === s.key)}
          issues=${data.issues.filter((i) => i.section === s.key && !(data.fit && /of speech for ~/.test(i.message)))}
          review=${data.review}
          readOnly=${readOnly}
          onReview=${onReview}
          onEdit=${onEdit}
          audio=${data.audio?.[s.key] ? media("project", data.audio[s.key]) : null}
          fit=${data.fit?.find((f) => f.scene === s.key) ?? null}
        />`;
        },
      )}
    </div>
    ${
      approveOpen
        ? html`<${ApproveHighModal} artifact="vo" version=${data.version} onClose=${() => setApproveOpen(false)} onDone=${(
            r,
          ) => {
            setApproveOpen(false);
            setFlash(`${r.approved.length} section(s) approved · ${r.skip.length} left for you`);
            setTimeout(() => setFlash(null), 5000);
            reload();
          }} />`
        : null
    }
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
              }, "review sent to the agent")}>Send review to agent</button><${CostHint} />
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
      const ok = await confirmAsk({
        title: `Save brand "${selected}"?`,
        diff: plan.diff,
        warnings: plan.warnings,
        confirmLabel: "Save",
      });
      if (!ok) return;
      await post("/api/brand-save", { name: selected, patch, confirm: true });
      setPatch({});
      say(`saved ${selected}`);
      reload();
    });
  const duplicate = () =>
    run(async () => {
      const to = await askText({
        title: `Copy brand "${selected}"`,
        input: {
          label: "Name for the copy",
          hint: "lowercase, digits, dashes",
          value: `${selected}-custom`,
          required: true,
        },
        confirmLabel: "Create copy",
      });
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
      const ok = await confirmAsk({
        title: `Set the default brand (${scope})?`,
        diff: plan.diff,
        warnings: plan.shadowedBy
          ? [`Overridden by ${plan.shadowedBy}, so it has no effect right now.`]
          : [],
        confirmLabel: "Set default",
      });
      if (!ok) return;
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

// ---------------- CONFIG ----------------

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

const SCREEN_BODY = {
  project: (p) => html`<${Project} events=${p.events} />`,
  storyboard: (p) => html`<${Review} events=${p.events} stages=${p.stages} />`,
  recording: (p) => html`<${Recording} events=${p.events} stages=${p.stages} />`,
  voice: (p) => html`<${Voice} events=${p.events} stages=${p.stages} />`,
  annotations: (p) => html`<${Annotations} events=${p.events} stages=${p.stages} />`,
  render: (p) => html`<${Render} events=${p.events} stages=${p.stages} />`,
  config: (p) => html`<${Config} events=${p.events} />`,
};

function App() {
  const [route, go] = useHashRoute();
  const { events, status } = useBus();
  const { data: state, error: stateError } = useApi("/api/state", events, /./);
  setModels(state?.models);
  const { data: stages } = useStages(events);
  const { data: jobData } = useApi(
    "/api/jobs",
    events,
    /^(take|tts|edit|render|design|discovery)\./,
  );
  const jobs = jobData?.jobs ?? [];
  const slug = state?.project?.slug ?? null;
  const [notice, setNotice] = useState(null);
  const [drawer, setDrawer] = useState(false);
  const [dismissed, setDismissed] = useState(() => new Set());
  const [news, setNews] = useState(() => new Set());
  const stripButton = useRef(null);

  // Where we are comes from the URL. An empty hash restores the last place in this project (or starts
  // at Project); an unknown route says so and falls back, it never silently shows something else.
  useEffect(() => {
    if (!state) return;
    if (route === null) go(readLastPlace(slug) ?? { screen: "project" }, { replace: true });
    else if (!route.valid) {
      setNotice(`${route.reason}. Showing Project.`);
      go({ screen: "project" }, { replace: true });
    }
  }, [state, route]);
  const tab = route?.valid ? route.screen : "project";
  useEffect(() => {
    if (slug && route?.valid) writeLastPlace(slug, route);
  }, [slug, route?.raw]);
  useEffect(() => setNotice(null), [tab]);

  // A result that arrives for another screen puts a badge on its step. It never moves you.
  // History is whatever the engine had published when this page first asked for the state.
  const historyUntil = useRef(null);
  if (state && historyUntil.current === null) historyUntil.current = state.busSeq ?? 0;
  const seen = useRef(0);
  const here = useRef(tab);
  here.current = tab;
  useEffect(() => {
    if (historyUntil.current === null) return; // not known yet: nothing is judged
    const fresh = events.filter((e) => e.seq > seen.current);
    if (!fresh.length) return;
    seen.current = fresh.at(-1).seq;
    const add = fresh
      .filter((e) => e.seq > historyUntil.current)
      .map(newsTab)
      .filter((t) => t && t !== here.current);
    if (add.length) setNews((n) => new Set([...n, ...add]));
  }, [events, state]);
  useEffect(
    () =>
      setNews((n) => {
        if (!n.has(tab)) return n;
        const m = new Set(n);
        m.delete(tab);
        return m;
      }),
    [tab],
  );

  const rows = useMemo(() => activityRows(events), [events]);
  const discovery = rows.some((r) => r.key === "discovery" && r.state === "running");
  const states = useMemo(() => stepStates({ stages, jobs, discovery }), [stages, jobs, discovery]);
  const band = useMemo(() => nextBand({ stages, states, jobs }), [stages, states, jobs]);
  const strip = useMemo(
    () => stripState({ jobs, rows, status, dismissed }),
    [jobs, rows, status, dismissed],
  );
  const body = (SCREEN_BODY[tab] ?? SCREEN_BODY.project)({ events, stages });
  return html`
    <${Header} slug=${slug} tab=${tab} states=${states} news=${news} band=${band} />
    <main class=${tab}>
      ${notice ? html`<div class="ds-root ds-notice route-notice" role="note" data-tone="warn"><span class="ds-status" data-tone="warn" aria-hidden="true">!</span><div class="ds-grow">${notice}</div><button class="ds-btn ds-btn--sm" type="button" onClick=${() => setNotice(null)}>Dismiss</button></div>` : null}
      ${stateError ? html`<section class="card error">${stateError}</section>` : null}
      ${body}
    </main>
    <${ActivityStrip} strip=${strip} status=${status} open=${drawer} buttonRef=${stripButton}
      onToggle=${(forceOpen) => setDrawer((o) => (forceOpen === true ? true : !o))} />
    <${ActivityDrawer} open=${drawer} onClose=${() => setDrawer(false)} events=${events} rows=${rows} jobs=${jobs}
      dismissed=${dismissed} onDismiss=${(id) => setDismissed((d) => new Set([...d, id]))} buttonRef=${stripButton} />`;
}

render(html`<${App} />`, document.getElementById("app"));
