// The Annotations screen (UX6b, D100, D122): the designer's suggestions as a list grouped by scene and one
// inspector for the selected annotation. The enable switch sits in the row; everything else (preview,
// text, timing, targets, reasons) is in the inspector. Edits go straight into a working draft on the server
// (one per version, revisions, conflicts: src/drafts/annotations.ts) and are shown as Saving / Draft saved /
// Save failed; "Save new version" turns the draft into exactly one version, and approving is a separate act.
// Turning off a redaction asks first; "Reset to suggested" undoes what you changed on one annotation.
import { html, useEffect, useRef, useState } from "/vendor/preact-htm.module.js";
import { ConfReasons, NeedsEyes, byRisk, confOf } from "./confidence.js";
import { api, media, post, useApi, useHashRoute, useRouteVersion } from "./core.js";
import { CostHint, confirmCost, getModels } from "./cost.js";
import { confirmAsk } from "./dialog.js";
import { CompareTable, TAB } from "./drafts.js";
import { ConfPill, NarrowSelect } from "./inspector.js";
import { formatRoute } from "./route.js";
import { StageSummary, VersionActions, runVersionAction, useHistory } from "./version-ui.js";

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
      <button class="lightbox-close ds-btn ds-btn--ghost" title="close (Esc)" aria-label="close" onClick=${onClose}>×</button>
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
    <button class="ds-btn ds-btn--ghost" disabled=${busy} title="render this scene with every enabled annotation (640×360, no chapter titles)" onClick=${run}>${busy ? "rendering…" : "▶ Play scene with enabled annotations"}</button>
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
      setFlash(`v${r.version}: no annotations — approve it to render a plain final`);
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
    <summary>${has ? "Suggest again…" : "Suggest annotations"}</summary>
    <textarea rows="2" placeholder=${has ? "e.g. calmer — no spotlights; zoom on the totals instead of the chart; callouts in German" : "optional instructions for the annotation designer"} value=${text} onInput=${(e) => setText(e.target.value)}></textarea>
    <div class="row">
      <button class="ds-btn ds-btn--primary" disabled=${busy || !data.canSuggest || !!data.draft} title=${data.draft ? "save or discard your unsaved changes first" : data.canSuggest ? "an agent turn: the designer suggests again; items you added, edited or toggled are kept" : "approve a voice-over and run the sync edit first"} onClick=${go}>${has ? `Re-suggest on v${data.version}` : "Suggest annotations"}</button>
      <span class="muted small-text">${has ? "Keeps every item you added, edited or toggled; regenerates the rest." : data.autoSuggest ? "Auto-suggest is on: this also starts by itself after each sync edit." : "Auto-suggest is off (Config → Settings → Annotations)."}</span>
      <${CostHint} what=${getModels()?.designer ? "a separate designer call" : "starts the Director"} model=${getModels()?.designer ? getModels().designer[0] : undefined} />
      ${flash ? html`<span class="flash">${flash}</span>` : null}
    </div>
    <div class="row small-text">
      <button class="ds-btn ds-btn--ghost" disabled=${busy || !data.canSuggest} title="writes an empty annotation version — approve it to render a plain final; you can still choose per render which annotation types to include" onClick=${noAnnotations}>Use no annotations</button>
      <span class="muted">for a demo without any; or choose per render which types to include (Render tab).</span>
    </div>
  </details>`;
}

// ---------------- the screen ----------------

const clock = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const isNetwork = (e) =>
  /Failed to fetch|NetworkError|Load failed|network/i.test(String(e?.message ?? e));
/** Redactions turned off in this page: the question is asked once per redaction. */
const redactionsOff = new Set();

const isPrivacy = (it) => it.type === "redact" && (it.reason ?? "").startsWith("privacy:");
const touched = (it) =>
  it.origin === "edited" || it.origin === "manual" || (it.edits?.length ?? 0) > 0;
const rowTitle = (it) =>
  it.text
    ? `${LABEL[it.type]}: ${it.text}`
    : it.target
      ? `${LABEL[it.type]} on ${targetLabel(it.target)}`
      : LABEL[it.type];
const summary = (it) =>
  it
    ? `${it.enabled ? "on" : "off"}${it.text ? ` · “${it.text}”` : ""} · ${anchorLabel(it.anchor)}${it.durMs ? ` · ${sec(it.durMs)}` : ""}${it.target ? ` · ${targetLabel(it.target)}` : ""}`
    : "(not in that version)";

/**
 * The draft edits of one screen: a serial queue of operations, each carrying the revision of the last
 * answer. A refused edit (validation) is said and dropped; a lost connection stops the queue with the
 * change kept (Retry); a stale revision stops it with the server's draft shown and the change held
 * (apply it again, or keep theirs). Nothing is ever applied silently on top of someone else's draft.
 */
function useAnnotationEdits({ data, say }) {
  const [view, setView] = useState(null);
  const [save, setSave] = useState({ status: "clean" });
  const revRef = useRef(null);
  const queue = useRef([]);
  const running = useRef(false);
  const d = view ?? data;
  const idle = !running.current && !queue.current.length;
  useEffect(() => setView(null), [data]);
  if (idle) revRef.current = d?.draft?.revision ?? null;

  const pump = async () => {
    if (running.current) return;
    running.current = true;
    try {
      while (queue.current.length) {
        const op = queue.current[0];
        setSave({ status: "saving" });
        let r;
        try {
          r = await post("/api/annotations-edit", { revision: revRef.current, author: TAB, ...op });
        } catch (e) {
          if (isNetwork(e)) {
            setSave({ status: "failed", error: e.message });
            return;
          }
          queue.current.shift(); // refused: said, dropped, the rest goes on
          say(`⚠ ${e.message}`);
          continue;
        }
        setView(r);
        revRef.current = r.draft?.revision ?? null;
        if (r.conflict) {
          setSave({ status: "conflict", message: r.message });
          return;
        }
        queue.current.shift();
      }
      setSave({ status: "saved", at: clock() });
    } finally {
      running.current = false;
    }
  };
  const edit = (op) => {
    queue.current.push({ version: d.version, ...op });
    pump();
  };
  const drain = async () => {
    while (
      running.current ||
      (queue.current.length && ["saving", "saved", "clean"].includes(save.status))
    )
      await new Promise((r) => setTimeout(r, 40));
    return !queue.current.length;
  };
  useEffect(() => {
    const warn = (e) => {
      if (queue.current.length) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  return {
    d,
    setView,
    save,
    held: queue.current,
    edit,
    drain,
    revision: () => revRef.current,
    retry: pump,
    /** Apply my held change(s) again, on top of the draft as it is now. */
    reapply: pump,
    keepTheirs: () => {
      queue.current = [];
      setSave({ status: "saved", at: clock() });
    },
  };
}

function saveText(save, draft) {
  switch (save.status) {
    case "saving":
      return "Saving…";
    case "saved":
      return `Draft saved ${save.at ?? ""} · not a new version yet`;
    case "failed":
      return `Save failed: ${save.error ?? "no answer"}. Your last change is kept here.`;
    case "conflict":
      return "This draft was changed elsewhere. Choose what to keep.";
    default:
      return draft
        ? `Working draft: ${draft.changes} change${draft.changes === 1 ? "" : "s"} · not a new version yet`
        : "No edits yet. Changes are kept in a working draft; it is not a new version.";
  }
}
const SAVE_ICON = {
  clean: ["", "○"],
  saving: ["info", "…"],
  saved: ["ok", "✓"],
  failed: ["err", "!"],
  conflict: ["err", "!"],
};

/** What needs a decision about the draft: a failed save, a conflict, a base that moved, other drafts. */
function Notices({ d, ed, setVersion }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState(null);
  useEffect(() => {
    setOpen(false);
    setRows(null);
  }, [d.version, ed.save.status]);
  const flags = d.draft?.flags;
  const compare = async () => {
    setOpen(!open);
    if (open || rows || !flags?.superseded) return;
    const latest = await api(`/api/annotations?version=${flags.superseded}`);
    const theirs = new Map((latest.file?.items ?? []).map((x) => [x.id, x]));
    setRows(
      (d.draft.changedIds ?? []).map((id) => ({
        key: id,
        a: summary(d.file.items.find((x) => x.id === id)),
        b: summary(theirs.get(id)),
      })),
    );
  };
  const out = [];
  if (ed.save.status === "conflict")
    out.push(html`<div class="ds-notice" data-tone="err" role="alert" key="conflict">
      <span class="ds-status" data-tone="err" aria-hidden="true">!</span>
      <div class="ds-grow">
        <strong>This draft was changed in another tab or session.</strong> Your last change was not saved; nothing was overwritten, and the list shows the draft as it is now.
        <span class="ds-row-flex" style="margin-block-start: var(--space-2)">
          <button class="ds-btn ds-btn--sm" type="button" data-act="reapply" onClick=${ed.reapply}>Apply my change${ed.held.length === 1 ? "" : "s"} again (${ed.held.length})</button>
          <button class="ds-btn ds-btn--sm" type="button" data-act="keep-theirs" onClick=${ed.keepTheirs}>Keep theirs</button>
        </span>
      </div>
    </div>`);
  if (ed.save.status === "failed")
    out.push(html`<div class="ds-notice" data-tone="err" role="alert" key="failed">
      <span class="ds-status" data-tone="err" aria-hidden="true">!</span>
      <div class="ds-grow"><strong>Save failed.</strong> ${ed.save.error}. Your change is kept in this page, but it is not saved: do not close it yet.</div>
      <button class="ds-btn ds-btn--sm" type="button" data-act="retry" onClick=${ed.retry}>Retry</button>
    </div>`);
  if (flags?.notes?.length && ed.save.status !== "conflict")
    out.push(html`<div class="ds-notice" data-tone="warn" role="note" key="base">
      <span class="ds-status" data-tone="warn" aria-hidden="true">!</span>
      <div class="ds-grow">
        <strong>Your draft: ${flags.notes.join("; ")}.</strong> It stays on v${flags.base}; nothing was moved or merged.
        <span class="ds-row-flex" style="margin-block-start: var(--space-2)">
          <button class="ds-btn ds-btn--sm" type="button" data-act="save-as-new" onClick=${ed.onSave}>Save as new version</button>
          ${flags.superseded ? html`<button class="ds-btn ds-btn--sm ds-btn--ghost" type="button" aria-expanded=${open} onClick=${compare}>Compare with v${flags.superseded}</button>` : null}
          ${flags.superseded ? html`<a class="ds-btn ds-btn--sm ds-btn--ghost" href=${formatRoute({ screen: "annotations", version: flags.superseded })}>View v${flags.superseded}</a>` : null}
          <button class="ds-btn ds-btn--sm ds-btn--ghost" type="button" data-act="discard-note" onClick=${ed.onDiscard}>Discard draft</button>
        </span>
        ${open && rows ? html`<${CompareTable} rows=${rows} aLabel="Your draft" bLabel=${`v${flags.superseded}`} />` : null}
      </div>
    </div>`);
  if (d.otherDrafts?.length)
    out.push(html`<div class="ds-notice" role="note" key="other">
      <span class="ds-status" data-tone="info" aria-hidden="true">i</span>
      <div class="ds-grow">Other working drafts are kept: ${d.otherDrafts.map((o) => html`<button class="ds-btn ds-btn--sm ds-btn--ghost" type="button" key=${o.base} onClick=${() => setVersion(o.base)}>v${o.base} (${o.changes} change${o.changes === 1 ? "" : "s"})</button>`)}</div>
    </div>`);
  return out.length
    ? html`<div class="ds-stack" style="margin-block-end: var(--space-3)">${out}</div>`
    : null;
}

function TextField({ item, onCommit }) {
  const [text, setText] = useState(item.text ?? "");
  const timer = useRef(null);
  useEffect(() => setText(item.text ?? ""), [item.text]);
  const valid = text.trim().length > 0 && text.trim().length <= 60;
  const dirty = text.trim() !== (item.text ?? "");
  const commit = (t) => {
    clearTimeout(timer.current);
    if (t.trim() && t.trim().length <= 60 && t.trim() !== (item.text ?? "")) onCommit(t);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  const id = `ann-text-${item.id}`;
  return html`<div class="ds-field">
    <label class="ds-label" for=${id}>${item.type === "chapter" ? "Chapter title" : "Callout text"}</label>
    <input class="ds-input ds-measure" id=${id} value=${text} maxlength="60"
      onInput=${(e) => {
        setText(e.target.value);
        clearTimeout(timer.current);
        const v = e.target.value;
        timer.current = setTimeout(() => commit(v), 800);
      }}
      onBlur=${() => commit(text)}
      onKeyDown=${(e) => e.key === "Enter" && commit(text)} />
    <span class="ds-hint-text" data-invalid=${!valid && dirty ? "true" : undefined}>${text.length}/60 · it marks, it doesn't narrate${!text.trim() ? " · the text can't be empty" : ""}</span>
  </div>`;
}

/** The selected annotation: its preview, text, timing, target and the reasons; the enable switch and reset. */
function Inspector({ d, item, onEdit, onToggle, onOpen, resettable, readOnlyNote }) {
  const res = d.resolved[item.id];
  const problem = res && "problem" in res ? res.problem : null;
  const conf = confOf(d.confidence, item.id);
  const privacy = isPrivacy(item);
  return html`<div class="ds-stack ds-inspector">
    <div class="ds-row-flex">
      <h2>${ICON[item.type]} ${LABEL[item.type]}</h2>
      <span class="ds-badge ds-mono" data-tone="neutral">${item.id}</span>
      ${privacy ? html`<span class="ds-badge" data-tone="info" title="found by the privacy scan"><span class="ds-badge-ico" aria-hidden="true">◆</span>Privacy</span>` : null}
      ${touched(item) ? html`<span class="ds-badge" data-tone="accent" title="you changed this: kept on re-suggest"><span class="ds-badge-ico" aria-hidden="true">✎</span>Yours</span>` : null}
      ${problem ? html`<span class="ds-badge" data-tone="err" title=${problem}><span class="ds-badge-ico" aria-hidden="true">!</span>Can't place</span>` : null}
      <${ConfPill} c=${conf} long />
      <span class="ds-grow"></span>
      <button class="ds-switch" type="button" role="switch" aria-checked=${item.enabled} data-act="enabled" onClick=${() => onToggle(item)}>
        <span class="ds-switch-track" aria-hidden="true"></span>${item.enabled ? "In the render" : "Not rendered"}
      </button>
    </div>
    <${ConfReasons} c=${conf} />
    ${problem ? html`<p class="ds-small" style="color: var(--status-err)">Can't be placed: ${problem}</p>` : null}
    <div class="ds-shot ann-shot"><${Preview} version=${d.version} item=${item} onOpen=${onOpen} /></div>
    ${item.type === "callout" || item.type === "chapter" ? html`<${TextField} item=${item} onCommit=${(text) => onEdit({ op: "text", id: item.id, text })} />` : null}
    <div class="ds-stack">
      <span class="ds-label">When</span>
      <div class="ds-row-flex ds-small">
        <span title="when it is fully there">${anchorLabel(item.anchor)}</span>
        ${res && !problem ? html`<span class="ds-muted">· ${sec(res.startMs)}–${sec(res.endMs)}</span>` : null}
      </div>
      <div class="ds-row-flex ds-small">
        <span class="ds-muted">Start</span>
        <button class="ds-btn ds-btn--sm" type="button" title="0.5 s earlier" onClick=${() => onEdit({ op: "nudge", id: item.id, field: "start", deltaMs: -500 })}>−½ s</button>
        <button class="ds-btn ds-btn--sm" type="button" title="0.5 s later" onClick=${() => onEdit({ op: "nudge", id: item.id, field: "start", deltaMs: 500 })}>+½ s</button>
        ${
          item.type !== "redact"
            ? html`<span class="ds-muted" style="margin-inline-start: var(--space-3)">Length</span>
          <button class="ds-btn ds-btn--sm" type="button" title="0.5 s shorter" onClick=${() => onEdit({ op: "nudge", id: item.id, field: "duration", deltaMs: -500 })}>−½ s</button>
          <button class="ds-btn ds-btn--sm" type="button" title="0.5 s longer" onClick=${() => onEdit({ op: "nudge", id: item.id, field: "duration", deltaMs: 500 })}>+½ s</button>`
            : html`<span class="ds-muted ds-xs" style="margin-inline-start: var(--space-3)">A redaction lasts to the end of the scene.</span>`
        }
      </div>
    </div>
    ${
      item.target
        ? html`<div class="ds-stack">
          <span class="ds-label">Target</span>
          <span class="ds-small">on ${targetLabel(item.target)}${item.factor ? ` · ${item.factor}×` : ""}</span>
          ${
            item.alternatives?.length
              ? html`<span class="ds-row-flex ds-small"><span class="ds-muted">Other targets:</span> ${item.alternatives.map((a, i) => html`<button class="ds-btn ds-btn--sm" type="button" key=${i} title="use this target instead" onClick=${() => onEdit({ op: "target", id: item.id, alternative: i })}>${targetLabel(a)}</button>`)}</span>`
              : null
          }
        </div>`
        : null
    }
    ${item.reason ? html`<p class="ds-small"><span class="ds-muted">Why:</span> ${item.reason}</p>` : null}
    ${item.weight ? html`<p class="ds-small ds-muted" title="value 1–5 (designer) · noise cost (Q7)">Value ${item.weight.value} · noise ${item.weight.noise}</p>` : null}
    <div class="ds-row-flex">
      ${resettable ? html`<button class="ds-btn" type="button" data-act="reset" title="undo every change you made to this annotation" onClick=${() => onEdit({ op: "reset", id: item.id })}>Reset to suggested</button>` : null}
      <${SceneDraft} version=${d.version} scene=${item.scene} draftKey=${`${d.draft?.revision ?? "v"}`} />
    </div>
    ${readOnlyNote}
  </div>`;
}

export function Annotations({ events }) {
  const version = useRouteVersion("annotations");
  const [route, goTo] = useHashRoute();
  const setVersion = (v) =>
    goTo(
      v === null || v === undefined
        ? { screen: "annotations" }
        : { screen: "annotations", version: v },
    );
  const hist = useHistory("annotations", events);
  const path = version ? `/api/annotations?version=${version}` : "/api/annotations";
  const { data, error, reload } = useApi(path, events, /^(annotations|stage|line|project|edit)\./);
  const [types, setTypes] = useState(new Set());
  const [state, setState] = useState("all");
  const [flash, setFlash] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [riskFirst, setRiskFirst] = useState(false);
  const say = (m) => {
    setFlash(m);
    setTimeout(() => setFlash(null), 6000);
  };
  const ed = useAnnotationEdits({ data, say });
  const d = ed.d;
  if (error) return html`<section class="card error">${error}</section>`;
  if (!d) return html`<section class="card muted">loading…</section>`;
  if (!d.project) return html`<section class="card muted">No active project.</section>`;
  if (d.version === null && version !== null)
    return html`<${StageSummary} stage="annotations" rows=${hist.data?.rows} viewed=${version} />`;
  if (d.version === null)
    return html`
      <${StageSummary} stage="annotations" rows=${hist.data?.rows} viewed=${null} />
      <section class="card">
        <p class="muted">${d.canSuggest ? "No annotations yet. The Annotation designer suggests zooms, highlights, callouts and more from the recording and the narration; you switch them on and off, edit them and approve a version." : "Approve a voice-over (and let the sync edit run) first: annotations follow the narration."}</p>
        <${Resuggest} data=${d} onDone=${(v) => (typeof v === "number" ? setVersion(v) : reload())} />
      </section>`;

  const f = d.file;
  const row = hist.data?.rows?.find((r) => r.version === d.version);
  const toggleType = (t) => {
    const n = new Set(types);
    n.has(t) ? n.delete(t) : n.add(t);
    setTypes(n);
  };
  const count = (t) => f.items.filter((x) => x.type === t).length;
  const shown = f.items.filter(
    (it) =>
      (types.size === 0 || types.has(it.type)) &&
      (state === "all" || (state === "on") === it.enabled),
  );
  const groups = d.scenes
    .map((sc) => {
      const inScene = shown.filter((it) => it.scene === sc.id);
      return {
        sc,
        items: riskFirst ? byRisk(inScene, d.confidence, (it) => it.id) : inScene,
        total: f.items.filter((it) => it.scene === sc.id),
      };
    })
    .filter((g) => g.total.length);
  const flat = groups.flatMap((g) => g.items);
  const item = flat.find((x) => x.id === route?.query?.item) ?? flat[0];
  const select = (id) =>
    goTo(
      { screen: "annotations", ...(version ? { version } : {}), query: { item: id } },
      { replace: true },
    );
  const resettable = new Set(d.resettable ?? []);
  const onToggle = async (it) => {
    if (it.type === "redact" && it.enabled && !redactionsOff.has(it.id)) {
      const ok = await confirmAsk({
        title: "Turn off this redaction?",
        text: isPrivacy(it)
          ? `“${(it.reason ?? "").replace(/^privacy:\s*/, "")}” was found by the privacy scan. Without the redaction that value stays visible in the video.`
          : "Without the redaction the area it covers stays visible in the video.",
        confirmLabel: "Turn off the redaction",
        danger: true,
      });
      if (!ok) return;
      redactionsOff.add(it.id);
    }
    ed.edit({ op: "toggle", id: it.id, enabled: !it.enabled });
  };
  const onSave = async () => {
    if (!d.draft) return;
    if (!(await ed.drain())) return;
    try {
      const r = await post("/api/annotations-save", {
        version: d.draft.base,
        revision: ed.revision(),
      });
      ed.setView(r);
      if (r.conflict) return say(`⚠ ${r.message}`);
      setVersion(r.version);
      say(`saved as v${r.version}`);
    } catch (e) {
      say(`⚠ ${e.message}`);
    }
  };
  const onDiscard = async () => {
    if (!d.draft) return;
    const ids = d.draft.changedIds ?? [];
    const ok = await confirmAsk({
      title: `Discard the working draft of v${d.draft.base}?`,
      text: `This drops your ${d.draft.changes} change${d.draft.changes === 1 ? "" : "s"}${ids.length ? ` to ${ids.join(", ")}` : ""}. The saved version is not changed.`,
      confirmLabel: "Discard draft",
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await post("/api/annotations-discard", {
        version: d.draft.base,
        revision: ed.revision(),
      });
      ed.setView(r);
      if (r.conflict) say(`⚠ ${r.message}`);
    } catch (e) {
      say(`⚠ ${e.message}`);
    }
  };
  ed.onSave = onSave;
  ed.onDiscard = onDiscard;
  const [tone, icon] = SAVE_ICON[ed.save.status] ?? SAVE_ICON.clean;
  const canSave = !!d.draft && ed.save.status !== "conflict";

  return html`
    <${StageSummary} stage="annotations" row=${row} rows=${hist.data?.rows}
      viewed=${d.version} onUse=${(v) => runVersionAction({ stage: "annotations", version: v, intent: "use" }).then(reload)}
      meta=${html`${d.draft ? html`<span class="ds-badge" data-tone="warn"><span class="ds-badge-ico" aria-hidden="true">✎</span>Working draft</span>` : null}<span>${f.by ? `by ${f.by}` : ""} · ${f.take}</span>`} />
    <section class="card review-head ann-head">
      <div class="row">
        <${VersionActions} stage="annotations" row=${row} events=${events} onDone=${reload} />
        <span class="grow"></span>
        ${flash ? html`<span class="flash">${flash}</span>` : null}
      </div>
      ${f.instructions ? html`<p class="small-text muted">Instructions for this version: “${f.instructions}”</p>` : null}
      ${d.stale ? html`<p class="small-text error">⚠ ${d.stale} — previews are unavailable.</p>` : null}
      <${BudgetMeter} budget=${d.budget} />
      <div class="filters row">
        ${TYPES.filter(count).map((t) => html`<button class="ds-chip" aria-pressed=${types.has(t)} onClick=${() => toggleType(t)}>${ICON[t]} ${LABEL[t]} <span class="muted">${count(t)}</span></button>`)}
        <span class="grow"></span>
        ${["all", "on", "off"].map((s) => html`<button class="ds-chip" aria-pressed=${state === s} onClick=${() => setState(s)}>${s === "all" ? "all" : s === "on" ? "enabled" : "suggested, off"}</button>`)}
      </div>
      <${NeedsEyes} summary=${d.confidence} riskFirst=${riskFirst} setRiskFirst=${setRiskFirst} onJump=${select} />
      <${Resuggest} data=${d} onDone=${(v) => (typeof v === "number" ? setVersion(v) : reload())} />
    </section>
    <${Notices} d=${d} ed=${ed} setVersion=${setVersion} />
    <div class="ds-root ds-workspace">
      <div class="ds-split">
        <${NarrowSelect} label="Annotation" value=${item?.id} onChange=${select}
          options=${flat.map((it) => [it.id, `${it.scene} · ${rowTitle(it)}${it.enabled ? "" : " (off)"}`])} />
        <section class="ds-split-list" aria-label="Annotations">
          <div class="ds-list-head"><span><strong style="color: var(--text-strong)">${f.items.length} annotations</strong> · ${f.items.filter((x) => x.enabled).length} on${shown.length < f.items.length ? ` · ${shown.length} shown` : ""}</span></div>
          ${
            flat.length
              ? html`<ul class="ds-list">
            ${groups.map(
              (g) => html`<li class="ds-list-group" key=${`g-${g.sc.id}`}>
                <span class="ds-mono">${g.sc.id}</span> · ${g.sc.title} <span class="ds-muted">· ${g.total.filter((x) => x.enabled).length}/${g.total.length} on</span>
              </li>
              ${g.items.map((it) => {
                const c = confOf(d.confidence, it.id);
                const res = d.resolved[it.id];
                const problem = res && "problem" in res;
                return html`<li class="ds-rowwrap" key=${it.id} data-off=${it.enabled ? undefined : "true"}>
                  <button class="ds-switch" type="button" role="switch" aria-checked=${it.enabled} aria-label=${`${it.enabled ? "In the render" : "Not rendered"}: ${rowTitle(it)}`} data-act="row-enabled" data-id=${it.id} onClick=${() => onToggle(it)}>
                    <span class="ds-switch-track" aria-hidden="true"></span>
                  </button>
                  <button class="ds-item" type="button" data-key=${it.id} aria-current=${item?.id === it.id ? "true" : undefined} onClick=${() => select(it.id)}>
                    <span class="ds-status" aria-hidden="true">${ICON[it.type]}</span>
                    <span><span class="ds-item-title">${rowTitle(it)}</span><br /><span class="ds-item-meta">${it.id} · ${anchorLabel(it.anchor)}${res && !problem ? ` · ${sec(res.startMs)}` : ""}</span>
                      <span class="ds-row-flex" style="margin-block-start: var(--space-1)">
                        ${isPrivacy(it) ? html`<span class="ds-badge" data-tone="info"><span class="ds-badge-ico" aria-hidden="true">◆</span>Privacy</span>` : null}
                        ${touched(it) ? html`<span class="ds-badge" data-tone="accent"><span class="ds-badge-ico" aria-hidden="true">✎</span>Yours</span>` : null}
                        ${problem ? html`<span class="ds-badge" data-tone="err"><span class="ds-badge-ico" aria-hidden="true">!</span>Can't place</span>` : null}
                        ${c && c.level !== "high" ? html`<${ConfPill} c=${c} />` : null}
                      </span>
                    </span>
                  </button>
                </li>`;
              })}`,
            )}
          </ul>`
              : html`<p class="ds-small ds-muted" style="padding: var(--space-3)">No annotation matches the filters.</p>`
          }
        </section>
        <section class="ds-split-detail" aria-label="Selected annotation">
          ${item ? html`<${Inspector} key=${`${d.version}-${item.id}`} d=${d} item=${item} onEdit=${ed.edit} onToggle=${onToggle} onOpen=${setLightbox} resettable=${resettable.has(item.id)} />` : null}
          <div class="ds-actionbar">
            <span class="ds-savestate" data-state=${ed.save.status} role="status"><span class="ds-status" data-tone=${tone || undefined} aria-hidden="true">${icon}</span>${saveText(ed.save, d.draft)}</span>
            ${ed.save.status === "failed" ? html`<button class="ds-btn ds-btn--sm" type="button" onClick=${ed.retry}>Retry</button>` : null}
            ${d.draft ? html`<button class="ds-btn ds-btn--ghost" type="button" data-act="discard" onClick=${onDiscard}>Discard draft</button>` : null}
            <span class="ds-grow"></span>
            <button class="ds-btn ds-btn--primary" type="button" data-act="save-version" aria-disabled=${canSave ? undefined : "true"} aria-describedby="why-save-ann"
              onClick=${() => canSave && onSave()}>Save new version</button>
            ${canSave ? null : html`<span class="ds-why" id="why-save-ann" style="flex-basis: 100%; text-align: end">${ed.save.status === "conflict" ? "Resolve the conflict above first." : "Change an annotation first: there is nothing to save."}</span>`}
          </div>
        </section>
      </div>
    </div>
    ${lightbox ? html`<${Lightbox} open=${lightbox} onClose=${() => setLightbox(null)} />` : null}`;
}
