// demo-recording panel — Project tab (S5 part 5a, D48): the first step.
// Facts (brief fields as a form, saved as a new brief version after a diff),
// Findings (auto / use / ignore, with evidence) and Memory (brief history,
// input log with mark outdated / restore, sources, working line).
// Tool configuration — also project-scope overrides — lives in ⚙ Config.
import { html, useEffect, useState } from "/vendor/preact-htm.module.js";
import { media, post, useApi } from "./core.js";

const PROJECT_EVENTS =
  /^(brief|input|finding|project|stage|line|storyboard|take|vo|edit|discovery)\./;

const FACT_FIELDS = [
  { key: "title", label: "Title", hint: "title card, ≤ 60 chars" },
  { key: "subtitle", label: "Subtitle", hint: "second line on the title card" },
  { key: "persona", label: "Persona", hint: "who watches, what they already know" },
  { key: "depth", label: "Depth", type: "depth" },
  { key: "stance", label: "Stance", type: "stance" },
  { key: "length", label: "Target length", hint: "min–max, e.g. 3–4 min or 60–90 s" },
  {
    key: "goal",
    label: "Goal / key message",
    hint: "the one thing the viewer should believe afterwards",
  },
  { key: "url", label: "App URL", hint: "base URL" },
  { key: "extraUrls", label: "Extra URLs", hint: "admin, docs … (space-separated)" },
];

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
  const field = (f) => {
    if (f.type === "depth")
      return html`<select value=${value("depth")} onChange=${(e) => set("depth", e.target.value)}>
        <option value="">— not set —</option>
        ${Object.entries(data.depthDefaults).map(([k, d]) => html`<option value=${k}>${k} — ${d.label.split("—")[1]?.trim() ?? d.label}</option>`)}
      </select>`;
    if (f.type === "stance")
      return html`<select value=${value("stance")} onChange=${(e) => set("stance", e.target.value)}>
        <option value="">${def ? `default from depth: ${def.stance}` : "— not set —"}</option>
        ${["champion", "evaluator", "teacher"].map((s) => html`<option value=${s}>${s}</option>`)}
      </select>`;
    return html`<input type="text" value=${value(f.key)} placeholder=${f.key === "length" && def ? `default from depth: ${def.length}` : f.hint} onInput=${(e) => set(f.key, e.target.value)} />`;
  };
  return html`<section class="card facts">
    <div class="row"><h2>${data.facts.title ?? data.project}</h2>
      ${data.facts.subtitle ? html`<span class="muted">${data.facts.subtitle}</span>` : null}
      <span class="grow"></span>${flash ? html`<span class="flash">${flash}</span>` : null}</div>
    <p class="muted small-text">Facts about this demo, stored as fields of brief.md (${data.briefVersions.length} version${data.briefVersions.length === 1 ? "" : "s"}). How the tool behaves — also for this project only — is set under ⚙ Config.</p>
    <div class="facts-grid">
      <label><span>App</span><span class="readonly">${data.app.name} <span class="muted small-text">(${data.app.slug})</span></span></label>
      ${FACT_FIELDS.map((f) => html`<label><span>${f.label}</span>${field(f)}${f.key === "depth" && def ? html`<small class="muted">${def.label}</small>` : null}${f.key === "stance" && !value("stance") && data.effective.stance ? html`<small class="muted">effective: ${data.effective.stance}${data.effective.stanceFromDepth ? " (depth default)" : ""}</small>` : null}${f.key === "length" && data.effective.length ? html`<small class="muted">effective: ${data.effective.length}${data.effective.lengthFromDepth ? " (depth default)" : ""}</small>` : null}</label>`)}
      <label><span>Login</span><span class="readonly">${data.login.saved ? `saved session (${new Date(data.login.savedAt).toLocaleString()}) — contents never shown` : html`<span class="muted">no saved session — <code>/demo login ${data.app.slug}</code> (S7)</span>`}</span></label>
    </div>
    <div class="row"><span class="muted small-text">${dirty ? "unsaved changes" : "no changes"}</span><span class="grow"></span>
      <button disabled=${busy || !dirty} onClick=${() => setPatch({})}>Reset</button>
      <button class="primary" disabled=${busy || !dirty} onClick=${save}>Save facts</button></div>
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
