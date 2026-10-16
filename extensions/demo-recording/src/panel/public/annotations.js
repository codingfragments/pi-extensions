import { html, useEffect, useState } from "/vendor/preact-htm.module.js";
// demo-recording panel — Annotations tab (S5 part 8, D53–D58): the designer's
// suggestions per scene as cards (still eager, clip on click), toggles, inline
// text, ±0.5 s nudges, target choices, a large preview popup (click the still to play), a budget meter, filters, an unsaved
// draft with Save / Discard, Re-suggest with instructions, and a low-res scene
// draft with every enabled annotation.
import { ConfBadge, ConfReasons, NeedsEyes, byRisk, confOf, itemDomId } from "./confidence.js";
import { media, post, useApi } from "./core.js";
import { CostHint, confirmCost, getModels } from "./cost.js";
import { confirmAsk } from "./dialog.js";
import { StageHeader, VersionActions } from "./stages.js";

const TYPES = ["zoom", "highlight", "spotlight", "callout", "chapter", "redact"];
const ICON = {
  zoom: "🔍",
  highlight: "▢",
  spotlight: "◐",
  callout: "💬",
  chapter: "▤",
  redact: "▒",
};
const LABEL = {
  zoom: "Zoom",
  highlight: "Highlight",
  spotlight: "Spotlight",
  callout: "Callout",
  chapter: "Chapter",
  redact: "Redact",
};

const sec = (ms) => `${(ms / 1000).toFixed(1)} s`;

// One preview render at a time from this tab (the server serializes too).
let previewChain = Promise.resolve();
const queued = (fn) => {
  const run = previewChain.then(fn, fn);
  previewChain = run.catch(() => undefined);
  return run;
};

function anchorLabel(a) {
  const off = a.offsetMs
    ? ` ${a.offsetMs > 0 ? "+" : "−"}${(Math.abs(a.offsetMs) / 1000).toFixed(1)} s`
    : "";
  if (a.mark) return `@${a.mark}${off}`;
  if (a.word) return `“${a.word}”${a.occurrence > 1 ? ` #${a.occurrence}` : ""}${off}`;
  return `scene start${off}`;
}

function targetLabel(t) {
  if (!t) return "";
  if (t.step !== undefined) return `step ${t.step}`;
  if (t.layout) return `element ${t.layout}`;
  if (t.text) return `“${t.text}”${t.role ? ` (${t.role})` : ""}`;
  if (t.box) return `box ${t.box.x},${t.box.y} ${t.box.w}×${t.box.h}`;
  return "";
}

function BudgetMeter({ budget }) {
  if (!budget) return null;
  const max = Math.max(budget.optimum * 2, budget.noise * 1.1, 1);
  const pct = (v) => `${Math.min(100, (v / max) * 100)}%`;
  return html`<div class=${`budget ${budget.status.replace(" ", "-")}`} title="Noise of the enabled annotations vs. the designer's recommended set (Q7). Balanced = within ±25 %.">
    <div class="budget-bar">
      <div class="band" style=${`left:${pct(budget.optimum * 0.75)};width:calc(${pct(budget.optimum * 1.25)} - ${pct(budget.optimum * 0.75)})`}></div>
      <div class="fill" style=${`width:${pct(budget.noise)}`}></div>
      <div class="opt" style=${`left:${pct(budget.optimum)}`}></div>
    </div>
    <span class="budget-text"><b>${budget.status}</b> · noise ${budget.noise} / optimum ${budget.optimum} · value captured ${Math.round(budget.valueCaptured * 100)} % · ${budget.enabled}/${budget.suggested} on</span>
  </div>`;
}

function Preview({ version, item, onOpen }) {
  const [still, setStill] = useState(null);
  const [updating, setUpdating] = useState(false);
  const [err, setErr] = useState(null);
  const key = JSON.stringify([
    version,
    item.anchor,
    item.target,
    item.text,
    item.durMs,
    item.factor,
    item.type,
  ]);
  // Only this item's content decides the preview (the server caches by content too);
  // the old still stays visible, dimmed, while the new one renders.
  useEffect(() => {
    let live = true;
    setUpdating(true);
    setErr(null);
    queued(() => post("/api/annotation-preview", { version, id: item.id, kind: "still" })).then(
      (r) => {
        if (!live) return;
        setStill(r.still);
        setUpdating(false);
      },
      (e) => {
        if (!live) return;
        setErr(e.message);
        setUpdating(false);
      },
    );
    return () => {
      live = false;
    };
  }, [key]);
  if (err) return html`<div class="ann-thumb missing" title=${err}>no preview: ${err}</div>`;
  return html`<button class=${`ann-thumb ${updating && still ? "updating" : ""}`} disabled=${!still}
      title="open larger — click the big image to play the clip" aria-label=${`open the preview of ${item.id}`}
      onClick=${() => still && onOpen({ item, version, still })}>
    ${still ? html`<img src=${media("project", still)} alt=${`${item.type} preview`} loading="lazy" />` : html`<div class="ann-loading">rendering still…</div>`}
    ${still ? html`<span class="enlarge" aria-hidden="true">⤢</span>` : null}
  </button>`;
}

/** The big preview: the still first; a click on it renders (cached) and plays the clip. */
function Lightbox({ open, onClose }) {
  const [clip, setClip] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const { item, version, still } = open;
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const play = async () => {
    if (busy || clip) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await queued(() =>
        post("/api/annotation-preview", { version, id: item.id, kind: "clip" }),
      );
      setClip(r.clip);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="lightbox" role="dialog" aria-modal="true" aria-label=${`${LABEL[item.type]} ${item.id}`}
      onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <figure class="lightbox-box">
      <button class="lightbox-close ghost" title="close (Esc)" aria-label="close" onClick=${onClose}>×</button>
      ${
        clip
          ? html`<video src=${media("project", clip)} controls autoplay playsinline></video>`
          : html`<button class="lightbox-still" title="play the clip around this annotation" onClick=${play}>
              <img src=${media("project", still)} alt=${`${item.type} preview`} />
              <span class=${`lightbox-play ${busy ? "busy" : ""}`}>${busy ? "rendering clip…" : "▶ play clip"}</span>
            </button>`
      }
      <figcaption>
        <b>${ICON[item.type]} ${LABEL[item.type]}</b> <span class="mono muted">${item.id}</span>
        ${item.text ? html` · “${item.text}”` : null}
        <span class="muted"> · ${anchorLabel(item.anchor)}${item.enabled ? "" : " · off"}</span>
        ${err ? html`<span class="error"> · ${err}</span>` : null}
      </figcaption>
    </figure>
  </div>`;
}

function TextEdit({ item, onSave }) {
  const [text, setText] = useState(item.text ?? "");
  useEffect(() => setText(item.text ?? ""), [item.text]);
  const dirty = text.trim() !== (item.text ?? "");
  return html`<div class="ann-text">
    <input value=${text} maxlength="60" onInput=${(e) => setText(e.target.value)}
      onKeyDown=${(e) => e.key === "Enter" && dirty && onSave(text)} aria-label="annotation text" />
    <span class=${`count ${text.length > 50 ? "warn" : ""}`}>${text.length}/60</span>
    ${dirty ? html`<button class="ghost" onClick=${() => onSave(text)}>set</button>` : null}
  </div>`;
}

function AnnotationCard({ item, res, version, edit, onOpen, conf }) {
  const problem = res && "problem" in res ? res.problem : null;
  const privacy = item.type === "redact" && (item.reason ?? "").startsWith("privacy:");
  const touched =
    item.origin === "edited" || item.origin === "manual" || (item.edits?.length ?? 0) > 0;
  return html`<article class=${`ann-card ${item.enabled ? "on" : "off"} ${problem ? "problem" : ""} ${conf ? `cf-${conf.level}` : ""}`} id=${itemDomId(item.id)}>
    <div class="ann-top">
      <${ConfBadge} c=${conf} />
      <label class="ann-enabled" title=${item.enabled ? "in the render" : "not rendered — tick to use it"}>
        <input type="checkbox" checked=${item.enabled} onChange=${(e) => edit({ op: "toggle", id: item.id, enabled: e.target.checked })} />
        enabled
      </label>
    </div>
    <${Preview} version=${version} item=${item} onOpen=${onOpen} />
    <div class="ann-body">
      <div class="row">
        <span class="ann-type" title=${LABEL[item.type]}>${ICON[item.type]} ${LABEL[item.type]}</span>
        <span class="muted small-text mono">${item.id}</span>
      </div>
      ${item.type === "callout" || item.type === "chapter" ? html`<${TextEdit} item=${item} onSave=${(text) => edit({ op: "text", id: item.id, text })} />` : null}
      <div class="ann-when small-text">
        <span title="when it is fully there">${anchorLabel(item.anchor)}</span>
        ${res && !problem ? html`<span class="muted">· ${sec(res.startMs)}–${sec(res.endMs)}</span>` : null}
        <span class="nudges">
          <span class="muted">start</span>
          <button class="ghost tiny" title="0.5 s earlier" onClick=${() => edit({ op: "nudge", id: item.id, field: "start", deltaMs: -500 })}>−½</button>
          <button class="ghost tiny" title="0.5 s later" onClick=${() => edit({ op: "nudge", id: item.id, field: "start", deltaMs: 500 })}>+½</button>
          ${
            item.type !== "redact"
              ? html`<span class="muted">length</span>
            <button class="ghost tiny" title="0.5 s shorter" onClick=${() => edit({ op: "nudge", id: item.id, field: "duration", deltaMs: -500 })}>−½</button>
            <button class="ghost tiny" title="0.5 s longer" onClick=${() => edit({ op: "nudge", id: item.id, field: "duration", deltaMs: 500 })}>+½</button>`
              : null
          }
        </span>
      </div>
      ${item.target ? html`<div class="small-text muted">on ${targetLabel(item.target)}${item.factor ? ` · ${item.factor}×` : ""}</div>` : null}
      ${
        item.alternatives?.length
          ? html`<div class="ann-alts small-text"><span class="muted">other targets:</span> ${item.alternatives.map(
              (a, i) =>
                html`<button class="chip" title="use this target instead" onClick=${() => edit({ op: "target", id: item.id, alternative: i })}>${targetLabel(a)}</button>`,
            )}</div>`
          : null
      }
      ${item.reason ? html`<p class="ann-reason small-text">${item.reason}</p>` : null}
      <${ConfReasons} c=${conf} />
      <div class="ann-tags small-text">
        ${item.weight ? html`<span class="pill" title="value 1–5 (designer) · noise cost (Q7)">value ${item.weight.value} · noise ${item.weight.noise}</span>` : null}
        ${privacy ? html`<span class="pill privacy" title="found by the privacy scan — turn on to redact">privacy</span>` : null}
        ${touched ? html`<span class="pill edited" title="you changed this — kept on re-suggest">yours</span>` : null}
        ${problem ? html`<span class="pill fail-pill" title=${problem}>can't place: ${problem}</span>` : null}
      </div>
    </div>
  </article>`;
}

function SceneDraft({ version, scene, draftKey }) {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => setFile(null), [draftKey]);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await queued(() => post("/api/annotations-scene-draft", { version, scene }));
      setFile(r.file);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return html`<span class="scene-draft">
    <button class="ghost" disabled=${busy} title="render this scene with every enabled annotation (640×360, no chapter titles)" onClick=${run}>${busy ? "rendering…" : "▶ Play scene with enabled annotations"}</button>
    ${err ? html`<span class="error small-text">${err}</span>` : null}
    ${file ? html`<video class="scene-video" src=${media("project", file)} controls autoplay playsinline></video>` : null}
  </span>`;
}

function Resuggest({ data, onDone }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const has = data.version !== null;
  const noAnnotations = async () => {
    setBusy(true);
    try {
      const r = await post("/api/annotations-empty", {});
      setFlash(`v${r.version}: no annotations — accept it to render a plain final`);
      onDone?.(r.version);
    } catch (e) {
      setFlash(`⚠ ${e.message}`);
    } finally {
      setBusy(false);
      setTimeout(() => setFlash(null), 8000);
    }
  };
  const go = async () => {
    setBusy(true);
    try {
      if (
        !(await confirmCost("annotations-resuggest", {
          version: has ? data.version : null,
          instructions: text,
        }))
      )
        return;
      await post("/api/annotations-resuggest", {
        version: has ? data.version : null,
        instructions: text,
      });
      setText("");
      setFlash(
        has
          ? "re-suggest requested — the agent works on it (see the Activity drawer); your changes are kept"
          : "suggestions requested — the agent works on it",
      );
      onDone?.();
    } catch (e) {
      setFlash(`⚠ ${e.message}`);
    } finally {
      setBusy(false);
      setTimeout(() => setFlash(null), 8000);
    }
  };
  return html`<details class="resuggest" open=${!has}>
    <summary>${has ? "Re-suggest with instructions" : "Suggest annotations"}</summary>
    <textarea rows="2" placeholder=${has ? "e.g. calmer — no spotlights; zoom on the totals instead of the chart; callouts in German" : "optional instructions for the annotation designer"} value=${text} onInput=${(e) => setText(e.target.value)}></textarea>
    <div class="row">
      <button class="primary" disabled=${busy || !data.canSuggest || !!data.draft} title=${data.draft ? "save or discard your unsaved changes first" : data.canSuggest ? "an agent turn: the designer suggests again; items you added, edited or toggled are kept" : "accept a voice-over and run the sync edit first"} onClick=${go}>${has ? `Re-suggest on v${data.version}` : "Suggest annotations"}</button>
      <span class="muted small-text">${has ? "Keeps every item you added, edited or toggled; regenerates the rest." : data.autoSuggest ? "Auto-suggest is on: this also starts by itself after each sync edit." : "Auto-suggest is off (Config → Settings → Annotations)."}</span>
      <${CostHint} what=${getModels()?.designer ? "a separate designer call" : "starts the Director"} model=${getModels()?.designer ? getModels().designer[0] : undefined} />
      ${flash ? html`<span class="flash">${flash}</span>` : null}
    </div>
    <div class="row small-text">
      <button class="ghost" disabled=${busy || !data.canSuggest} title="writes an empty annotation version — accept it to render a plain final; you can still choose per render which annotation types to include" onClick=${noAnnotations}>Use no annotations</button>
      <span class="muted">for a demo without any; or choose per render which types to include (Render tab).</span>
    </div>
  </details>`;
}

export function Annotations({ events, stages }) {
  const [version, setVersion] = useState(null);
  const path = version ? `/api/annotations?version=${version}` : "/api/annotations";
  const { data, error, reload } = useApi(path, events, /^(annotations|stage|line|project|edit)\./);
  const [types, setTypes] = useState(new Set());
  const [state, setState] = useState("all");
  const [flash, setFlash] = useState(null);
  const [view, setView] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [riskFirst, setRiskFirst] = useState(false);
  // The edit routes answer with the new view; the next reload (bus event) replaces it.
  const d = view ?? data;
  useEffect(() => setView(null), [data]);
  if (error) return html`<section class="card error">${error}</section>`;
  if (!d) return html`<section class="card muted">loading…</section>`;
  if (!d.project) return html`<section class="card muted">No active project.</section>`;
  const say = (m) => {
    setFlash(m);
    setTimeout(() => setFlash(null), 6000);
  };
  const edit = async (op) => {
    try {
      setView(await post("/api/annotations-edit", { version: d.version, ...op }));
    } catch (e) {
      say(`⚠ ${e.message}`);
    }
  };
  const save = async () => {
    try {
      const r = await post("/api/annotations-save", {});
      setVersion(r.version);
      say(`saved as v${r.version}`);
    } catch (e) {
      say(`⚠ ${e.message}`);
    }
  };
  const discard = async () => {
    const ok = await confirmAsk({
      title: "Discard unsaved changes?",
      text: `${d.draft.changes} unsaved change(s) on v${d.draft.base} will be lost.`,
      confirmLabel: "Discard",
      danger: true,
    });
    if (!ok) return;
    try {
      setView(await post("/api/annotations-discard", {}));
    } catch (e) {
      say(`⚠ ${e.message}`);
    }
  };
  if (d.version === null)
    return html`
      <${StageHeader} stages=${stages} stage="annotations" />
      <section class="card">
        <h2>Annotations</h2>
        <p class="muted">${d.canSuggest ? "No annotations yet. The Annotation designer suggests zooms, highlights, callouts and more from the recording and the narration; you toggle, edit and accept them here." : "Accept a voice-over and run the sync edit first — annotations follow the real timing of the narration."}</p>
        <${Resuggest} data=${d} onDone=${(v) => (typeof v === "number" ? setVersion(v) : reload())} />
      </section>`;
  const f = d.file;
  const draftKey = d.draft ? `${d.draft.base}:${d.draft.changes}` : `v${d.version}`;
  const shown = f.items.filter(
    (it) =>
      (types.size === 0 || types.has(it.type)) &&
      (state === "all" || (state === "on") === it.enabled),
  );
  const toggleType = (t) => {
    const n = new Set(types);
    n.has(t) ? n.delete(t) : n.add(t);
    setTypes(n);
  };
  const count = (t) => f.items.filter((x) => x.type === t).length;
  return html`
    <${StageHeader} stages=${stages} stage="annotations" />
    <section class="card review-head ann-head">
      <div class="row">
        <h2>Annotations v${d.version}${d.draft ? html` <span class="badge stale">draft</span>` : null}</h2>
        <span class="muted small-text">${f.by ? `by ${f.by}` : ""} · based on VO v${f.basedOn.vo} · ${f.take}${f.resuggestedFrom ? ` · re-suggested from v${f.resuggestedFrom}` : ""}${f.importedFrom ? ` · imported from v${f.importedFrom}` : ""}${f.editedFrom ? ` · your edits on v${f.editedFrom}` : ""}</span>
        <span class="grow"></span>
        ${flash ? html`<span class="flash">${flash}</span>` : null}
        <select aria-label="version" value=${d.version} onChange=${(e) => setVersion(Number(e.target.value))}>
          ${d.versions
            .slice()
            .reverse()
            .map((v) => html`<option value=${v}>v${v}</option>`)}
        </select>
        ${d.draft ? html`<button class="primary" disabled title="save your changes first">Accept v${d.version}</button>` : html`<${VersionActions} stages=${stages} stage="annotations" version=${d.version} unlocks="The final render can use these annotations." onDone=${reload} />`}
      </div>
      ${f.instructions ? html`<p class="small-text muted">Instructions for this version: “${f.instructions}”</p>` : null}
      ${d.stale ? html`<p class="small-text error">⚠ ${d.stale} — previews are unavailable.</p>` : null}
      <${BudgetMeter} budget=${d.budget} />
      ${
        d.draft
          ? html`<div class="draft-bar">
            <span><b>${d.draft.changes}</b> unsaved change${d.draft.changes === 1 ? "" : "s"} on v${d.draft.base}</span>
            <span class="grow"></span>
            <button class="primary" onClick=${save}>Save as v${Math.max(...d.versions) + 1}</button>
            <button class="ghost" onClick=${discard}>Discard</button>
          </div>`
          : d.otherDraft
            ? html`<div class="draft-bar muted">Unsaved changes on v${d.otherDraft} — <button class="ghost" onClick=${() => setVersion(d.otherDraft)}>open v${d.otherDraft}</button></div>`
            : null
      }
      <div class="filters row">
        ${TYPES.filter(count).map((t) => html`<button class=${`chip ${types.has(t) ? "on" : ""}`} onClick=${() => toggleType(t)}>${ICON[t]} ${LABEL[t]} <span class="muted">${count(t)}</span></button>`)}
        <span class="grow"></span>
        ${["all", "on", "off"].map((s) => html`<button class=${`chip ${state === s ? "on" : ""}`} onClick=${() => setState(s)}>${s === "all" ? "all" : s === "on" ? "enabled" : "suggested, off"}</button>`)}
      </div>
      <${NeedsEyes} summary=${d.confidence} riskFirst=${riskFirst} setRiskFirst=${setRiskFirst} />
      <${Resuggest} data=${d} onDone=${(v) => (typeof v === "number" ? setVersion(v) : reload())} />
    </section>
    ${d.scenes.map((sc) => {
      const inScene = shown.filter((it) => it.scene === sc.id);
      const items = riskFirst ? byRisk(inScene, d.confidence, (it) => it.id) : inScene;
      const total = f.items.filter((it) => it.scene === sc.id);
      if (!total.length) return null;
      return html`<section class="card ann-scene" key=${sc.id}>
        <div class="row">
          <h3><span class="mono">${sc.id}</span> · ${sc.title}</h3>
          <span class="muted small-text">${sec(sc.durationMs)} · ${total.filter((x) => x.enabled).length}/${total.length} on</span>
          <span class="grow"></span>
          <${SceneDraft} version=${d.version} scene=${sc.id} draftKey=${draftKey} />
        </div>
        ${items.length ? html`<div class="ann-grid">${items.map((it) => html`<${AnnotationCard} key=${it.id} item=${it} res=${d.resolved[it.id]} version=${d.version} edit=${edit} onOpen=${setLightbox} conf=${confOf(d.confidence, it.id)} />`)}</div>` : html`<p class="muted small-text">No annotations match the filter.</p>`}
      </section>`;
    })}
    ${lightbox ? html`<${Lightbox} open=${lightbox} onClose=${() => setLightbox(null)} />` : null}`;
}
