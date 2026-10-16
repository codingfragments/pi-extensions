// The Voice over screen (UX5b, D100, D121): a section list and one inspector for the selected section,
// with working drafts for the narration. Editing keeps a working draft (autosaved, private until saved,
// never a version); "Save new version" turns it into exactly one version. Reviewing a section is a
// separate act from editing it, and approving a version is separate from both.
import { html, useEffect, useMemo, useState } from "/vendor/preact-htm.module.js";
import { ApproveHighModal, ConfReasons, NeedsEyes, byRisk, confOf } from "./confidence.js";
import { media, post, useApi, useHashRoute, useRouteVersion } from "./core.js";
import { CostHint, confirmCost } from "./cost.js";
import { errorToast } from "./dialog.js";
import { CompareTable, saveStateText, useDraft } from "./drafts.js";
import { ConfPill, ListRow, NarrowSelect, STATUS_LABEL } from "./inspector.js";
import { formatRoute } from "./route.js";
import { stageOf } from "./stages.js";
import { StageSummary, VersionActions, runVersionAction, useHistory } from "./version-ui.js";

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
    ${options.map(([v, l]) => html`<button class="ds-chip" aria-pressed=${value === v} onClick=${() => onChange(value === v ? "" : v)}>${l}</button>`)}
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
    <div class="dir-row"><span class="dir-label">Focus</span><input class="ds-input grow" value=${d.focus} placeholder="what the story should lean on, e.g. the EMEA churn drill-down" onInput=${(e) => set("focus")(e.target.value)} aria-label="focus" /></div>
    <div class="dir-row"><span class="dir-label">Notes</span><textarea class="grow" value=${d.notes} placeholder="anything else: less hype, say each number once, …" onInput=${(e) => set("notes")(e.target.value)} aria-label="direction notes"></textarea></div>
    <div class="row">
      <label class="ds-check small-text"><input type="checkbox" checked=${save} onChange=${(e) => setSave(e.target.checked)} /> save as the project's default direction (brief)</label>
      <span class="grow"></span>
      ${err ? html`<span class="error small-text">${err}</span>` : null}
      <button class="ds-btn ds-btn--primary" disabled=${busy} onClick=${send}>Draft new version</button><${CostHint} />
    </div>
  </details>`;
}

// ---------------- the screen ----------------

const short = (kind) =>
  ({ intro: "intro", outro: "outro", bridge: "bridge", scene: "scene" })[kind] ?? kind;
const wordCount = (t) => (String(t).match(/\S+/g) ?? []).length;
const STATE_ICON = {
  clean: ["", "○"],
  dirty: ["info", "●"],
  saving: ["info", "…"],
  saved: ["ok", "✓"],
  failed: ["err", "!"],
  conflict: ["err", "!"],
};

/** Mine against theirs, or your draft against the newest version, as rows for the compare table. */
function conflictRows(draft, bodies) {
  const theirs = draft.conflict?.current?.edits ?? {};
  const mine = Object.fromEntries(draft.changedKeys().map((k) => [k, draft.texts[k]]));
  return [...new Set([...Object.keys(mine), ...Object.keys(theirs)])]
    .map((key) => ({ key, a: mine[key] ?? bodies[key], b: theirs[key] ?? bodies[key] }))
    .filter((r) => r.a !== r.b);
}

/** What needs your decision about the draft: a failed save, a conflict, a base that moved. */
function DraftNotices({ draft, bodies, base, latest, go }) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [base, draft.state.status]);
  const { state, conflict, flags, server } = draft;
  const out = [];
  if (state.status === "conflict")
    out.push(html`<div class="ds-notice" data-tone="err" role="alert" key="conflict">
      <span class="ds-status" data-tone="err" aria-hidden="true">!</span>
      <div class="ds-grow">
        <strong>${conflict?.current ? "This draft was changed in another tab or session." : "This draft no longer exists."}</strong>
        ${conflict?.current ? " Your edits are still here and nothing was overwritten." : " It was saved or discarded elsewhere. Your edits are still here."}
        <span class="ds-row-flex" style="margin-block-start: var(--space-2)">
          <button class="ds-btn ds-btn--sm" type="button" data-act="keep-mine" onClick=${draft.keepMine}>Keep mine</button>
          <button class="ds-btn ds-btn--sm" type="button" data-act="take-theirs" onClick=${draft.takeTheirs}>Take theirs</button>
          ${conflict?.current ? html`<button class="ds-btn ds-btn--sm ds-btn--ghost" type="button" aria-expanded=${open} onClick=${() => setOpen(!open)}>Compare</button>` : null}
        </span>
        ${open && conflict?.current ? html`<${CompareTable} rows=${conflictRows(draft, bodies)} aLabel="Mine" bLabel="Theirs" />` : null}
      </div>
    </div>`);
  if (state.status === "failed")
    out.push(html`<div class="ds-notice" data-tone="err" role="alert" key="failed">
      <span class="ds-status" data-tone="err" aria-hidden="true">!</span>
      <div class="ds-grow"><strong>Save failed.</strong> ${state.error}. Your text is kept in this page, but it is not saved: do not close it yet.</div>
      <button class="ds-btn ds-btn--sm" type="button" data-act="retry" onClick=${draft.retry}>Retry</button>
    </div>`);
  const sections = server?.sections ?? [];
  if (flags?.notes?.length && draft.changes > 0 && state.status !== "conflict") {
    const rows = sections
      .filter((s) => s.latest !== undefined)
      .map((s) => ({ key: s.key, a: s.draft, b: s.latest }));
    out.push(html`<div class="ds-notice" data-tone="warn" role="note" key="base">
      <span class="ds-status" data-tone="warn" aria-hidden="true">!</span>
      <div class="ds-grow">
        <strong>Your draft: ${flags.notes.join("; ")}.</strong> It stays on v${flags.base}; nothing was moved or merged.
        <span class="ds-row-flex" style="margin-block-start: var(--space-2)">
          <button class="ds-btn ds-btn--sm" type="button" data-act="save-as-new" onClick=${draft.saveVersion}>Save as new version</button>
          ${flags.superseded ? html`<button class="ds-btn ds-btn--sm ds-btn--ghost" type="button" aria-expanded=${open} onClick=${() => setOpen(!open)}>Compare with v${flags.superseded}</button>` : null}
          ${flags.superseded ? html`<a class="ds-btn ds-btn--sm ds-btn--ghost" href=${formatRoute({ screen: "voice", version: flags.superseded })}>View v${flags.superseded}</a>` : null}
          <button class="ds-btn ds-btn--sm ds-btn--ghost" type="button" data-act="discard-note" onClick=${draft.discard}>Discard draft</button>
        </span>
        ${open && flags.superseded ? html`<${CompareTable} rows=${rows} aLabel="Your draft" bLabel=${`v${flags.superseded}`} />` : null}
      </div>
    </div>`);
  }
  return out.length
    ? html`<div class="ds-stack" style="margin-block-end: var(--space-3)">${out}</div>`
    : null;
}

/** The selected section: the narration (editable, a working draft), its review and what the footage says. */
function SectionInspector({
  data,
  section,
  draft,
  readOnly,
  review,
  showChanges,
  onReview,
  timing,
  fit,
  issues,
  audio,
  conf,
}) {
  const r = review?.scenes?.[section.key];
  const [note, setNote] = useState(r?.note ?? "");
  useEffect(() => setNote(r?.note ?? ""), [r?.note]);
  const edited =
    draft.texts[section.key] !== undefined && draft.texts[section.key] !== section.written;
  const text = draft.texts[section.key] ?? section.written;
  const diffParts = showChanges && Array.isArray(section.diff) ? section.diff : null;
  const set = (status) => onReview(section.key, r?.status === status ? null : status, note);
  const id = `narration-${data.version}-${section.key}`;
  return html`<div class="ds-stack ds-inspector">
    <div class="ds-row-flex">
      <h2>${section.key}</h2>
      <span class="ds-badge" data-tone="neutral">${KIND_LABEL[section.kind]}</span>
      ${showChanges && section.diff === "new" ? html`<span class="ds-badge" data-tone="info"><span class="ds-badge-ico" aria-hidden="true">+</span>New</span>` : null}
      ${diffParts ? html`<span class="ds-badge" data-tone="info"><span class="ds-badge-ico" aria-hidden="true">~</span>Changed</span>` : null}
      ${edited ? html`<span class="ds-badge" data-tone="accent"><span class="ds-badge-ico" aria-hidden="true">✎</span>Edited in draft</span>` : null}
      <${ConfPill} c=${conf} long />
    </div>
    ${conf?.approvedIn !== undefined ? html`<p class="ds-small ds-muted carried">Unchanged since v${conf.approvedIn}, where you approved it.</p>` : null}
    <${ConfReasons} c=${conf} />
    ${section.kind === "scene" ? html`<${TimingBar} timing=${timing} fit=${fit} />` : null}
    ${
      diffParts
        ? html`<details open class="ds-small"><summary>Changed since v${data.base}</summary><${DiffText} parts=${diffParts} /></details>`
        : null
    }
    <div class="ds-field">
      <label class="ds-label" for=${id}>Narration</label>
      <textarea class="ds-textarea ds-measure" id=${id} rows="6" value=${text} onInput=${(e) => draft.setText(section.key, e.target.value)}></textarea>
      <span class="ds-hint-text">Anchors in [@brackets] are kept. ${wordCount(text)} words · about ${Math.round(wordCount(text) / 2.58)} s at 155 words per minute.</span>
      ${edited ? html`<span class="ds-row-flex"><button class="ds-btn ds-btn--sm ds-btn--ghost" type="button" data-act="revert" onClick=${() => draft.setText(section.key, section.written)}>Revert this section</button></span>` : null}
    </div>
    ${issues.map((i) => html`<p class=${`issue ${i.level}`}>${i.level === "error" ? "✖" : "⚠"} ${i.message}</p>`)}
    ${audio ? html`<audio controls preload="none" src=${audio}></audio>` : null}
    ${
      readOnly
        ? html`<p class="ds-small ds-muted">An older version: the review is read-only. You can still edit its text; that starts a working draft.</p>`
        : html`<div class="ds-stack">
          <span class="ds-label">Review</span>
          <div class="ds-row-flex">
            ${Object.entries(STATUS_LABEL).map(([st, label]) => html`<button class="ds-btn ds-btn--sm" type="button" aria-pressed=${r?.status === st} data-status=${st} onClick=${() => set(st)}>${label}</button>`)}
          </div>
          <textarea class="ds-textarea ds-textarea--compact" aria-label="Notes for this section" placeholder="Notes for this section…" value=${note} onInput=${(e) => setNote(e.target.value)}
            onBlur=${() => r && note !== (r.note ?? "") && onReview(section.key, r.status, note)}></textarea>
        </div>`
    }
  </div>`;
}

/** D82, D121: sections as a list and one inspector; editing is a working draft, a version is explicit. */
export function Voice({ events, stages }) {
  const version = useRouteVersion("voice");
  const hist = useHistory("vo", events);
  const [route, go] = useHashRoute();
  const [compare, setCompare] = useState(null);
  const [showChanges, setShowChanges] = useState(true);
  const [riskFirst, setRiskFirst] = useState(false);
  const [approveOpen, setApproveOpen] = useState(false);
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
  const bodies = useMemo(
    () => Object.fromEntries((data?.sections ?? []).map((s) => [s.key, s.written])),
    [data?.version, data?.sections],
  );
  const draft = useDraft({
    base: data?.sections ? data.version : undefined,
    bodies,
    events,
    onSaved: (r) => {
      setFlash(`saved as v${r.version}`);
      setTimeout(() => setFlash(null), 5000);
      go({ screen: "voice" }); // look at the new version: the latest (the new address fetches it)
    },
  });
  // Keep the stage header visible whatever the content does.
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
  const changedCount = data.sections.filter(
    (x) => Array.isArray(x.diff) || x.diff === "new",
  ).length;
  const totalSpeech = data.timing.reduce((n, t) => n + t.speechSec, 0);
  const totalFootage = data.timing.reduce((n, t) => n + t.usableSec, 0);
  const ordered = riskFirst ? byRisk(data.sections, data.confidence, (x) => x.key) : data.sections;
  const wanted = route?.query?.section;
  const section = ordered.find((s) => s.key === wanted) ?? ordered[0];
  const select = (key) =>
    go(
      { screen: "voice", ...(version ? { version } : {}), query: { section: key } },
      { replace: true },
    );
  const row = hist.data?.rows?.find((r) => r.version === data.version);
  const editedKeys = new Set(draft.changedKeys());
  const st = STATE_ICON[draft.state.status] ?? STATE_ICON.clean;
  const canSave = draft.changes > 0 && draft.state.status !== "conflict";
  return html`
    <${StageSummary} stage="vo" row=${row} rows=${hist.data?.rows}
      viewed=${data.version} onUse=${(v) => runVersionAction({ stage: "vo", version: v, intent: "use" }).then(reload)}
      meta=${readOnly ? html`<span>older version</span>` : null} />
    <section class="card review-head">
      <div class="row">
        <span class="muted small-text">for ${data.take} · ${data.fit ? `${data.fit.reduce((n, f) => n + (f.voiceSec ?? 0), 0).toFixed(0)}s voice (real)` : `~${totalSpeech.toFixed(0)}s speech (estimate)`} / ${totalFootage.toFixed(0)}s footage</span>
        ${data.fit?.some((f) => f.level === "warn") ? html`<span class="badge changed">${data.fit.filter((f) => f.level === "warn").length} fit warning(s)</span>` : null}
        <${VersionActions} stage="vo" row=${row} events=${events} onDone=${reload} />
        ${data.canGenerate ? html`<button class="ds-btn ds-btn--primary" title="synthesize the voice, then edit and render a draft — you see the cost estimate first" onClick=${generate}>Generate voice & render…</button>` : null}
      </div>
      ${
        data.base !== null && data.base !== undefined
          ? html`<div class="row small-text vo-diff-head">
            <span>${data.meta?.direction ? "re-directed from" : "compared with"} <b>v${data.base}</b>: changed ${changedCount} of ${data.sections.length} sections</span>
            <select aria-label="compare with" value=${data.base} onChange=${(e) => setCompare(Number(e.target.value))}>
              ${data.versions.filter((v) => v !== data.version).map((v) => html`<option value=${v}>compare with v${v}</option>`)}
            </select>
            <label class="ds-check"><input type="checkbox" checked=${showChanges} onChange=${(e) => setShowChanges(e.target.checked)} /> show changes</label>
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
      <${NeedsEyes} summary=${data.confidence} riskFirst=${riskFirst} setRiskFirst=${setRiskFirst} onJump=${select}>
        ${readOnly || !data.confidence ? null : html`<button class="ds-btn ds-btn--ghost" title="mark every unmarked high-confidence section reviewed — you see the list first" onClick=${() => setApproveOpen(true)}>Mark high-confidence reviewed…</button>`}
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
    <${DraftNotices} draft=${draft} bodies=${bodies} base=${data.version} latest=${latest} go=${go} />
    <div class="ds-root ds-workspace">
      <div class="ds-split">
        <${NarrowSelect} label="Section" value=${section?.key} onChange=${select}
          options=${ordered.map((s) => [s.key, `${s.key}${editedKeys.has(s.key) ? " (edited)" : ""}`])} />
        <section class="ds-split-list" aria-label="Sections">
          <div class="ds-list-head">
            <span><strong style="color: var(--text-strong)">${data.sections.length} sections</strong> · ${Object.keys(data.review?.scenes ?? {}).length} marked${editedKeys.size ? ` · ${editedKeys.size} edited` : ""}</span>
          </div>
          <ul class="ds-list">
            ${ordered.map((s) => {
              const rv = data.review?.scenes?.[s.key];
              const c = confOf(data.confidence, s.key);
              return html`<${ListRow} key=${s.key} itemKey=${s.key} title=${s.key} review=${rv} current=${section?.key === s.key} onSelect=${select}
                meta=${`${short(s.kind)} · ${rv ? STATUS_LABEL[rv.status] : "not reviewed"}${c?.approvedIn !== undefined ? ` · unchanged since v${c.approvedIn}` : ""}`}
                badges=${html`${editedKeys.has(s.key) ? html`<span class="ds-badge" data-tone="accent"><span class="ds-badge-ico" aria-hidden="true">✎</span>Edited</span>` : null}${c && c.level !== "high" ? html`<${ConfPill} c=${c} />` : null}`} />`;
            })}
          </ul>
        </section>
        <section class="ds-split-detail" aria-label="Selected section">
          ${
            section
              ? html`<${SectionInspector} key=${`${data.version}-${section.key}`}
                  data=${data} section=${section} draft=${draft} readOnly=${readOnly} review=${data.review} showChanges=${showChanges} onReview=${onReview}
                  conf=${confOf(data.confidence, section.key)}
                  timing=${data.timing.find((t) => t.section === section.key)}
                  issues=${data.issues.filter((i) => i.section === section.key && !(data.fit && /of speech for ~/.test(i.message)))}
                  audio=${data.audio?.[section.key] ? media("project", data.audio[section.key]) : null}
                  fit=${data.fit?.find((f) => f.scene === section.key) ?? null} />`
              : null
          }
          <div class="ds-actionbar">
            <span class="ds-savestate" data-state=${draft.state.status} role="status"><span class="ds-status" data-tone=${st[0] || undefined} aria-hidden="true">${st[1]}</span>${saveStateText(draft.state, draft.changes)}</span>
            ${draft.state.status === "failed" ? html`<button class="ds-btn ds-btn--sm" type="button" onClick=${draft.retry}>Retry</button>` : null}
            ${draft.changes > 0 ? html`<button class="ds-btn ds-btn--ghost" type="button" data-act="discard" onClick=${draft.discard}>Discard draft</button>` : null}
            <span class="ds-grow"></span>
            <button class="ds-btn ds-btn--primary" type="button" data-act="save-version" aria-disabled=${canSave ? undefined : "true"} aria-describedby="why-save"
              onClick=${() => canSave && draft.saveVersion()}>Save new version</button>
            ${canSave ? null : html`<span class="ds-why" id="why-save" style="flex-basis: 100%; text-align: end">${draft.state.status === "conflict" ? "Resolve the conflict above first." : "Edit a section first: there is nothing to save."}</span>`}
          </div>
        </section>
      </div>
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
        : html`<section class="card review-foot ds-inflow">
          <textarea placeholder="Overall notes (tone, density, stance)…" aria-label="Overall notes" value=${overall} onInput=${(e) => setOverall(e.target.value)}
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
