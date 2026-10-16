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
import { ProjectMap } from "./map.js";
import { Project } from "./project.js";
import { Recording } from "./recording.js";
import { Render } from "./render.js";
import { readLastPlace, writeLastPlace } from "./route.js";
import { stageOf, useStages } from "./stages.js";
import { StageSummary, VersionActions, runVersionAction, useHistory } from "./version-ui.js";
import { Voice } from "./voice.js";

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
  const { data: state, error: stateError } = useApi("/api/state", events, /^(?!draft\.)/);
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
  // The map is an overlay: the screen under it stays the current screen (and the one remembered).
  const mapOpen = route?.valid && route.screen === "map";
  const under = useRef(null);
  const cameFrom = useRef(false); // the entry before the map is one of ours: closing can go Back
  if (route?.valid && route.screen !== "map") under.current = route;
  const tab = mapOpen
    ? (under.current?.screen ?? "project")
    : route?.valid
      ? route.screen
      : "project";
  useEffect(() => {
    if (slug && route?.valid && route.screen !== "map") writeLastPlace(slug, route);
  }, [slug, route?.raw]);
  const wasMap = useRef(false);
  useEffect(() => {
    // the first map route of a visit: was there a screen before it in this tab's history?
    if (mapOpen && !wasMap.current) cameFrom.current = !!under.current;
    wasMap.current = !!mapOpen;
  }, [mapOpen]);
  const closeMap = () => {
    if (cameFrom.current && history.length > 1) history.back();
    else go(under.current ?? readLastPlace(slug) ?? { screen: "project" }, { replace: true });
  };
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
    ${mapOpen ? html`<${ProjectMap} route=${route} go=${go} slug=${slug} events=${events} onClose=${closeMap} />` : null}
    <${ActivityStrip} strip=${strip} status=${status} open=${drawer} buttonRef=${stripButton}
      onToggle=${(forceOpen) => setDrawer((o) => (forceOpen === true ? true : !o))} />
    <${ActivityDrawer} open=${drawer} onClose=${() => setDrawer(false)} events=${events} rows=${rows} jobs=${jobs}
      dismissed=${dismissed} onDismiss=${(id) => setDismissed((d) => new Set([...d, id]))} buttonRef=${stripButton} />`;
}

render(html`<${App} />`, document.getElementById("app"));
