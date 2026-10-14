// demo-recording panel — Project tab (S5 part 5a, D48): the first step.
// Facts (brief fields as a form, saved as a new brief version after a diff),
// Findings (auto / use / ignore, with evidence) and Memory (brief history,
// input log with mark outdated / restore, sources, working line).
// Tool configuration — also project-scope overrides — lives in ⚙ Config.
import { html, useEffect, useState } from "/vendor/preact-htm.module.js";
import { media, post, useApi } from "./core.js";

const PROJECT_EVENTS =
  /^(brief|input|finding|project|stage|line|storyboard|take|vo|edit|discovery)\./;

// ---- facts editor building blocks ----

const LENGTH_PRESETS = [
  [30, 60],
  [60, 90],
  [90, 120],
  [120, 180],
  [180, 300],
  [300, 480],
  [480, 900],
  [900, 1800],
];
const LEN_MIN = 15;
const LEN_MAX = 1800; // 30 min
const LEN_STEP = 15;

/** Seconds → "45 s", "1:30", "3 min". */
export function fmtSec(sec) {
  if (sec < 60) return `${sec} s`;
  return sec % 60 === 0
    ? `${sec / 60} min`
    : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

/** [min, max] seconds → a brief value the server parses ("3–5 min", "60–90 s", "2:30–3:30"). */
export function lengthText([lo, hi]) {
  if (lo >= 60 && lo % 60 === 0 && hi % 60 === 0) return `${lo / 60}–${hi / 60} min`;
  if (hi < 120) return `${lo}–${hi} s`;
  const ms = (x) => `${Math.floor(x / 60)}:${String(x % 60).padStart(2, "0")}`;
  return `${ms(lo)}–${ms(hi)}`;
}

/** Parse a brief length value client-side (same rules as the server, enough for the sliders). */
function parseLen(v) {
  if (!v) return null;
  const s = v.toLowerCase();
  const unitMin = /\bmin/.test(s);
  const nums = [...s.matchAll(/(\d+(?::\d{2})?(?:[.,]\d+)?)/g)].map((m) => {
    const t = m[1];
    if (t.includes(":")) {
      const [mm, ss] = t.split(":").map(Number);
      return mm * 60 + ss;
    }
    const n = Number(t.replace(",", "."));
    return unitMin ? n * 60 : n;
  });
  if (!nums.length) return null;
  const a = nums[0];
  const b = nums[1] ?? a;
  return [Math.min(a, b), Math.max(a, b)];
}

function Segmented({ options, value, onChange, title }) {
  return html`<div class="segmented" role="radiogroup" title=${title ?? ""}>${options.map(
    (o) =>
      html`<button type="button" role="radio" aria-checked=${value === o.value} class=${value === o.value ? "on" : ""} title=${o.title ?? ""} onClick=${() => onChange(o.value)}>${o.label}</button>`,
  )}</div>`;
}

function LengthPicker({ value, onChange, def }) {
  const parsed = parseLen(value);
  const range = parsed ?? def ?? [120, 180];
  const fromDefault = !parsed;
  const clamp = (x) => Math.max(LEN_MIN, Math.min(LEN_MAX, Math.round(x / LEN_STEP) * LEN_STEP));
  const setRange = (lo, hi) => onChange(lengthText([clamp(lo), clamp(hi)]));
  const isPreset = (p) => parsed && p[0] === parsed[0] && p[1] === parsed[1];
  return html`<div class="length-picker">
    <div class="presets">
      ${LENGTH_PRESETS.map((p) => html`<button type="button" class=${`chip ${isPreset(p) ? "on" : ""}`} onClick=${() => setRange(p[0], p[1])}>${fmtSec(p[0])}–${fmtSec(p[1])}</button>`)}
      ${def ? html`<button type="button" class=${`chip ${fromDefault ? "on" : ""}`} title="no length in the brief: use the depth default" onClick=${() => onChange("")}>depth default (${fmtSec(def[0])}–${fmtSec(def[1])})</button>` : null}
    </div>
    <div class=${`sliders ${fromDefault ? "from-default" : ""}`}>
      <label>min <input type="range" min=${LEN_MIN} max=${LEN_MAX} step=${LEN_STEP} value=${range[0]}
        onInput=${(e) => {
          const lo = Number(e.target.value);
          setRange(lo, Math.max(lo, range[1]));
        }} /><output>${fmtSec(range[0])}</output></label>
      <label>max <input type="range" min=${LEN_MIN} max=${LEN_MAX} step=${LEN_STEP} value=${range[1]}
        onInput=${(e) => {
          const hi = Number(e.target.value);
          setRange(Math.min(range[0], hi), hi);
        }} /><output>${fmtSec(range[1])}</output></label>
    </div>
    <small class="muted">${fromDefault ? (def ? `using the depth default ${fmtSec(def[0])}–${fmtSec(def[1])} — move a slider or pick a preset to set your own` : "not set — pick a preset or move a slider") : `target ${fmtSec(range[0])}–${fmtSec(range[1])}`}</small>
  </div>`;
}

function UrlList({ value, onChange }) {
  const urls = (value ?? "").split(/[\s,]+/).filter(Boolean);
  const [draft, setDraft] = useState("");
  const write = (list) => onChange(list.join(" "));
  const add = () => {
    const u = draft.trim();
    if (!u) return;
    write([...urls, u]);
    setDraft("");
  };
  return html`<div class="url-list">
    ${
      urls.length
        ? html`<ul>${urls.map(
            (u, i) => html`<li key=${`${i}-${u}`}>
        <input type="url" value=${u} onChange=${(e) => write(urls.map((x, j) => (j === i ? e.target.value.trim() : x)).filter(Boolean))} />
        <button type="button" class="ghost" title="remove" onClick=${() => write(urls.filter((_, j) => j !== i))}>✕</button>
      </li>`,
          )}</ul>`
        : html`<p class="muted small-text">no extra URLs</p>`
    }
    <div class="url-add">
      <input type="url" placeholder="https://… (admin, docs, a second app)" value=${draft} onInput=${(e) => setDraft(e.target.value)} onKeyDown=${(e) => e.key === "Enter" && add()} />
      <button type="button" disabled=${!draft.trim()} onClick=${add}>+ add</button>
    </div>
  </div>`;
}

function Field({ label, hint, children, counter }) {
  return html`<label class="field"><span class="field-label">${label}${counter ? html`<span class=${`counter ${counter.over ? "over" : ""}`}>${counter.text}</span>` : null}</span>${children}${hint ? html`<small class="muted">${hint}</small>` : null}</label>`;
}

function Facts({ events }) {
  const { data, error, reload } = useApi("/api/project", events, PROJECT_EVENTS);
  const [patch, setPatch] = useState({});
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  useEffect(() => setPatch({}), [data?.briefVersions?.length]);
  if (error) return html`<section class="card error">${error}</section>`;
  if (!data) return html`<section class="card muted">loading…</section>`;
  if (!data.project)
    return html`<section class="card muted">No active project. Run <code>/demo new</code> or <code>/demo open</code> in pi.</section>`;
  const value = (k) => (patch[k] !== undefined ? patch[k] : (data.facts[k] ?? ""));
  const set = (k, v) => setPatch((p) => ({ ...p, [k]: v }));
  const dirty = Object.keys(patch).length > 0;
  const depth = value("depth");
  const def = data.depthDefaults[depth] ?? null;
  const save = async () => {
    setBusy(true);
    try {
      const plan = await post("/api/project-facts", { patch });
      if (plan.unchanged) return setFlash("nothing changed");
      if (!confirm(`Save the project facts? This writes a new brief version:\n\n${plan.diff}`))
        return;
      const r = await post("/api/project-facts", { patch, confirm: true });
      setFlash(`saved as brief v${r.version}`);
      setPatch({});
      reload();
    } catch (e) {
      setFlash(`⚠ ${e.message}`);
    } finally {
      setBusy(false);
      setTimeout(() => setFlash(null), 6000);
    }
  };
  const title = value("title");
  const subtitle = value("subtitle");
  const count = (v, max) => ({ text: `${v.length}/${max}`, over: v.length > max });
  const depthOptions = [
    { value: "", label: "—", title: "not set" },
    ...Object.entries(data.depthDefaults).map(([k, d]) => ({ value: k, label: k, title: d.label })),
  ];
  const stanceOptions = [
    {
      value: "",
      label: def ? "default" : "—",
      title: def ? `use the depth default (${def.stance})` : "not set",
    },
    ...["champion", "evaluator", "teacher"].map((x) => ({ value: x, label: x })),
  ];
  return html`<section class="card facts">
    <div class="row">
      <h2>Project facts</h2>
      <span class="muted small-text">fields of brief.md · ${data.briefVersions.length} version${data.briefVersions.length === 1 ? "" : "s"} · tool settings live under ⚙ Config</span>
      <span class="grow"></span>
      ${flash ? html`<span class="flash">${flash}</span>` : null}
      <button disabled=${busy || !dirty} onClick=${() => setPatch({})}>Reset</button>
      <button class="primary" disabled=${busy || !dirty} onClick=${save}>Save facts</button>
    </div>

    <div class="fact-groups">
      <fieldset class="fact-group">
        <legend>Title card</legend>
        <div class="title-preview" aria-label="title card preview">
          ${(title.trim() || data.app.name).toLowerCase() === data.app.name.toLowerCase() ? null : html`<div class="tp-app">${data.app.name}</div>`}
          <div class="tp-rule"></div>
          <div class="tp-title">${title.trim() || data.app.name}</div>
          ${subtitle ? html`<div class="tp-sub">${subtitle}</div>` : null}
        </div>
        <${Field} label="Title" counter=${count(title, 60)} hint="large line on the title card">
          <input type="text" value=${title} placeholder="e.g. What KeyCraft gets right" onInput=${(e) => set("title", e.target.value)} />
        </${Field}>
        <${Field} label="Subtitle" counter=${count(subtitle, 90)} hint="optional second line">
          <input type="text" value=${subtitle} placeholder="e.g. and what it makes up" onInput=${(e) => set("subtitle", e.target.value)} />
        </${Field}>
      </fieldset>

      <fieldset class="fact-group">
        <legend>Audience & length</legend>
        <${Field} label="Persona" hint="who watches, what they already know">
          <textarea rows="3" value=${value("persona")} placeholder="e.g. developers evaluating test targets" onInput=${(e) => set("persona", e.target.value)}></textarea>
        </${Field}>
        <${Field} label="Depth" hint=${def ? def.label : "poc · showcase · sales — sets stance and length defaults"}>
          <${Segmented} options=${depthOptions} value=${depth} onChange=${(v) => set("depth", v)} />
        </${Field}>
        <${Field} label="Stance" hint=${!value("stance") && data.effective.stance ? `effective: ${data.effective.stance}${data.effective.stanceFromDepth ? " (depth default)" : ""}` : "the narrator's attitude"}>
          <${Segmented} options=${stanceOptions} value=${value("stance")} onChange=${(v) => set("stance", v)} />
        </${Field}>
        <${Field} label="Target length">
          <${LengthPicker} value=${value("length")} def=${def?.lengthSec ?? null} onChange=${(v) => set("length", v)} />
        </${Field}>
      </fieldset>

      <fieldset class="fact-group">
        <legend>App & access</legend>
        <${Field} label="App"><span class="readonly">${data.app.name} <span class="muted small-text">(${data.app.slug})</span></span></${Field}>
        <${Field} label="App URL" hint="where discovery and recording start">
          <input type="url" value=${value("url")} placeholder="https://…" onInput=${(e) => set("url", e.target.value)} />
        </${Field}>
        <${Field} label="Extra URLs" hint="other entry points the demo may use">
          <${UrlList} value=${value("extraUrls")} onChange=${(v) => set("extraUrls", v)} />
        </${Field}>
        <${Field} label="Login">
          <span class="readonly">${data.login.saved ? html`<span class="badge approved">saved session</span> <span class="muted small-text">${new Date(data.login.savedAt).toLocaleString()} · contents never shown</span>` : html`<span class="muted">no saved session — <code>/demo login ${data.app.slug}</code> (S7)</span>`}</span>
        </${Field}>
      </fieldset>
    </div>

    <fieldset class="fact-group goal">
      <legend>Goal / key message</legend>
      <textarea rows="4" value=${value("goal")} placeholder="The one thing the viewer should believe afterwards — the demo is built around it." onInput=${(e) => set("goal", e.target.value)}></textarea>
      <small class="muted">Kept on one line in brief.md; a short goal (≤ 60 chars) can also serve as the title card fallback.</small>
    </fieldset>
    <div class="row"><span class="muted small-text">${dirty ? `unsaved: ${Object.keys(patch).join(", ")}` : "no changes"}</span></div>
  </section>`;
}

const KIND_ICON = {
  strength: "＋",
  weakness: "−",
  friction: "≈",
  value: "#",
  "use-case": "◆",
  length: "⏱",
  other: "•",
  error: "▲",
  fallback: "↺",
  retry: "⟳",
  "dead-time": "⌛",
  blocked: "⛔",
  "state-change": "✎",
};

function evidenceLabel(e) {
  if (e.type === "screen") return `screen ${e.id}`;
  if (e.type === "take") return `${e.take} @${(e.t / 1000).toFixed(1)}s`;
  if (e.type === "url") return e.url;
  return e.path;
}

function Findings({ events }) {
  const { data, error, reload } = useApi("/api/findings", events, PROJECT_EVENTS);
  const [state, setState] = useState("all");
  const [source, setSource] = useState("all");
  if (error) return html`<section class="card error">${error}</section>`;
  if (!data) return html`<section class="card muted">loading…</section>`;
  if (!data.project) return null;
  const list = data.findings.filter(
    (f) => (state === "all" || f.state === state) && (source === "all" || f.source === source),
  );
  const counts = { use: 0, auto: 0, ignore: 0 };
  for (const f of data.findings) counts[f.state]++;
  const mark = async (f, s) => {
    try {
      await post("/api/finding-mark", { id: f.id, state: s });
      reload();
    } catch (e) {
      alert(e.message);
    }
  };
  return html`<section class="card">
    <div class="row"><h2>Findings</h2>
      <span class="muted small-text">${data.findings.length} · use ${counts.use} · auto ${counts.auto} · ignore ${counts.ignore}</span>
      <span class="grow"></span>
      ${["all", "use", "auto", "ignore"].map((s) => html`<button class=${`chip ${state === s ? "on" : ""}`} onClick=${() => setState(s)}>${s}</button>`)}
      <span class="muted">·</span>
      ${["all", "agent", "engine"].map((s) => html`<button class=${`chip ${source === s ? "on" : ""}`} onClick=${() => setSource(s)}>${s}</button>`)}
    </div>
    <p class="muted small-text"><b>use</b> = always part of the recording and the narration · <b>auto</b> = the director decides · <b>ignore</b> = never brought up. Agent findings come from discovery and analysis; engine findings are detected (errors, fallbacks, retries, dead time, blocked or state-changing actions, length).</p>
    ${
      list.length
        ? html`<ul class="findings">${list.map(
            (f) => html`<li class=${`finding ${f.state}`} key=${f.id}>
              <span class="f-icon" title=${f.kind}>${KIND_ICON[f.kind] ?? "•"}</span>
              <div class="f-body">
                <div><b>${f.text}</b></div>
                ${f.suggestion ? html`<div class="small-text">→ ${f.suggestion}</div>` : null}
                <div class="muted small-text"><span class="mono">${f.id}</span> · ${f.kind} · ${f.source} · ${f.stage}${f.scene ? ` · ${f.scene}` : ""}${f.evidence.length ? ` · ${f.evidence.slice(0, 3).map(evidenceLabel).join(" · ")}${f.evidence.length > 3 ? ` +${f.evidence.length - 3}` : ""}` : ""}</div>
                ${f.media?.length ? html`<div class="f-media">${f.media.map((m) => html`<img loading="lazy" src=${media(m.kind, m.path)} alt="evidence" />`)}</div>` : null}
              </div>
              <div class="f-state">${["auto", "use", "ignore"].map((s) => html`<button class=${`st ${f.state === s ? `on ${s}` : ""}`} onClick=${() => mark(f, s)}>${s}</button>`)}</div>
            </li>`,
          )}</ul>`
        : html`<p class="muted">${data.findings.length ? "No findings match the filter." : "No findings yet — discovery and recordings add them."}</p>`
    }
  </section>`;
}

function Memory({ events }) {
  const { data, error, reload } = useApi("/api/context", events, PROJECT_EVENTS);
  const [version, setVersion] = useState(null);
  const brief = useApi(
    version ? `/api/brief?version=${version}` : "/api/brief",
    events,
    PROJECT_EVENTS,
  );
  const [stage, setStage] = useState("all");
  const [showDiff, setShowDiff] = useState(false);
  if (error) return html`<section class="card error">${error}</section>`;
  if (!data) return html`<section class="card muted">loading…</section>`;
  if (!data.project) return null;
  const inputs = data.inputs.filter((i) => stage === "all" || i.stage === stage);
  const stages = ["all", ...new Set(data.inputs.map((i) => i.stage))];
  const toggle = async (i) => {
    const reason = i.outdated
      ? ""
      : prompt(`Mark ${i.id} outdated — why? (the agent will ignore it)`, "");
    if (!i.outdated && !reason) return;
    try {
      await post("/api/input-mark", { id: i.id, outdated: !i.outdated, reason });
      reload();
    } catch (e) {
      alert(e.message);
    }
  };
  const b = brief.data;
  return html`
    <section class="card">
      <div class="row"><h2>Working line</h2><span>${data.lineText}</span></div>
    </section>
    <section class="card">
      <div class="row"><h2>Brief</h2>
        ${b?.versions?.length ? html`<select value=${b.version ?? ""} onChange=${(e) => setVersion(Number(e.target.value))}>${b.versions.map((v) => html`<option value=${v}>v${v}</option>`).reverse()}</select>` : null}
        ${b?.diff ? html`<button class="ghost" onClick=${() => setShowDiff(!showDiff)}>${showDiff ? "show text" : "diff to previous"}</button>` : null}
        <span class="grow"></span><span class="muted small-text">edit facts above, prose via the agent (demo-brief skill)</span></div>
      <pre class="brief-text">${showDiff && b?.diff ? b.diff : (b?.text ?? "")}</pre>
    </section>
    <section class="card">
      <div class="row"><h2>Inputs</h2><span class="muted small-text">${data.inputs.length} · the agent reads the active ones</span><span class="grow"></span>
        ${stages.map((s) => html`<button class=${`chip ${stage === s ? "on" : ""}`} onClick=${() => setStage(s)}>${s}</button>`)}</div>
      ${
        inputs.length
          ? html`<ul class="inputs">${inputs.map(
              (i) => html`<li class=${i.outdated ? "outdated" : ""} key=${i.id}>
                <span class="mono small-text">${i.id}</span>
                <span class="muted small-text">${new Date(i.at).toLocaleString()} · ${i.stage}${i.version !== undefined ? ` v${i.version}` : ""} · ${i.kind}/${i.source}</span>
                <div class="i-text">${i.text}${i.refs?.length ? html` <span class="muted small-text">(${i.refs.join(", ")})</span>` : null}${i.outdated ? html`<div class="small-text warn">outdated: ${i.outdated.reason}</div>` : null}</div>
                <button class="ghost" onClick=${() => toggle(i)}>${i.outdated ? "restore" : "mark outdated"}</button>
              </li>`,
            )}</ul>`
          : html`<p class="muted small-text">No inputs yet — commands, panel reviews and chat directions show up here.</p>`
      }
    </section>
    <section class="card">
      <div class="row"><h2>Sources & assets</h2></div>
      ${
        data.sources.files.length || data.sources.refs.length
          ? html`<ul class="sources">
              ${data.sources.files.map((f) => html`<li class="mono small-text">${f.path} <span class="muted">(${Math.round(f.bytes / 1024)} KB)</span></li>`)}
              ${data.sources.refs.map((r) => html`<li class="small-text">${/^https?:/.test(r.ref) ? html`<a href=${r.ref} target="_blank" rel="noreferrer">${r.ref}</a>` : html`<span class="mono">${r.ref}</span>`} <span class="muted">— ${r.text} (${r.input})</span></li>`)}
            </ul>`
          : html`<p class="muted small-text">No sources yet. Put files under <code>context/</code> or give the agent links/files in chat.</p>`
      }
    </section>`;
}

export function Project({ events }) {
  const [view, setView] = useState("facts");
  return html`
    <div class="subtabs">${[
      ["facts", "Facts"],
      ["findings", "Findings"],
      ["memory", "Memory"],
    ].map(
      ([id, label]) =>
        html`<button class=${`chip ${view === id ? "on" : ""}`} onClick=${() => setView(id)}>${label}</button>`,
    )}</div>
    ${view === "facts" ? html`<${Facts} events=${events} />` : view === "findings" ? html`<${Findings} events=${events} />` : html`<${Memory} events=${events} />`}`;
}
