import { html, useEffect, useState } from "/vendor/preact-htm.module.js";
import { post, useApi } from "./core.js";
// demo-recording panel — ⚙ Config → Settings (S5 part 5b, D41/D48): every
// setting grouped with its effective value, source and per-layer values;
// edits are global or for this project only, always through a diff
// confirmation (same two-phase write as demo_rec_config). The raw files are
// shown read-only; API keys only as "set / not set".
import { confirmAsk, errorToast } from "./dialog.js";

const CONFIG_EVENTS = /^(config|project|brand)\./;

const show = (v) =>
  v === null || v === undefined
    ? "—"
    : Array.isArray(v)
      ? v.join(", ")
      : typeof v === "object"
        ? JSON.stringify(v)
        : String(v);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function EnginesInput({ value, options, onChange }) {
  const list = Array.isArray(value) ? value : [];
  const move = (i, d) => {
    const next = [...list];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x);
    onChange(next);
  };
  return html`<div class="engines">
    ${list.map(
      (e, i) => html`<span class="engine" key=${e}><span class="mono">${i + 1}. ${e}</span>
        <button class="ghost" disabled=${i === 0} title="earlier" onClick=${() => move(i, -1)}>↑</button>
        <button class="ghost" disabled=${i === list.length - 1} title="later" onClick=${() => move(i, 1)}>↓</button>
        <button class="ghost" disabled=${list.length === 1} title="remove" onClick=${() => onChange(list.filter((x) => x !== e))}>✕</button></span>`,
    )}
    ${options
      .filter((o) => !list.includes(o))
      .map(
        (o) => html`<button class="chip" onClick=${() => onChange([...list, o])}>+ ${o}</button>`,
      )}
  </div>`;
}

function SettingInput({ s, value, onChange, disabled }) {
  if (s.type === "boolean")
    return html`<input type="checkbox" checked=${!!value} disabled=${disabled} onChange=${(e) => onChange(e.target.checked)} />`;
  if (s.type === "number")
    return html`<input type="number" value=${value ?? ""} disabled=${disabled} onInput=${(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />`;
  if (s.type === "enum")
    return html`<select value=${value ?? ""} disabled=${disabled} onChange=${(e) => onChange(e.target.value)}>${(s.options ?? []).map((o) => html`<option value=${o}>${o}</option>`)}</select>`;
  if (s.type === "engines")
    return html`<${EnginesInput} value=${value} options=${s.options ?? []} onChange=${onChange} />`;
  if (s.type === "list")
    return html`<textarea rows="2" disabled=${disabled} placeholder="one per line" value=${Array.isArray(value) ? value.join("\n") : ""} onInput=${(
      e,
    ) =>
      onChange(
        e.target.value
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean),
      )}></textarea>`;
  return html`<input type="text" value=${value ?? ""} disabled=${disabled} onInput=${(e) => onChange(e.target.value)} />`;
}

function SettingRow({ s, scope, project, onSaved }) {
  const layer = scope === "project" ? s.layers.project : s.layers.global;
  const base = layer ?? s.value;
  const [draft, setDraft] = useState(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(undefined), [scope, JSON.stringify(s.value), JSON.stringify(layer)]);
  const value = draft !== undefined ? draft : base;
  const dirty = draft !== undefined && !same(draft, base);
  const disabled = busy || (scope === "project" && (s.globalOnly || !project));
  const run = async (body, what) => {
    setBusy(true);
    try {
      const plan = await post("/api/config-set", { key: s.key, scope, ...body });
      const ok = await confirmAsk({
        title: `${what} ${s.key}?`,
        text: `${scope === "project" ? `Project ${project}` : "Global"} · ${plan.file}`,
        diff: plan.diff,
        warnings: plan.shadowedBy
          ? [`This change has no effect right now: it is overridden by ${plan.shadowedBy}.`]
          : [],
        confirmLabel: "Save",
      });
      if (!ok) return;
      await post("/api/config-set", { key: s.key, scope, ...body, confirm: true });
      setDraft(undefined);
      onSaved(`${s.key} saved (${scope})`);
    } catch (e) {
      errorToast(e, s.key);
    } finally {
      setBusy(false);
    }
  };
  const notes = [];
  if (s.envSet)
    notes.push(
      html`<span class="badge stale" title="environment variables win over both files">env ${s.envVar} overrides the files</span>`,
    );
  else if (scope === "global" && s.layers.project !== null && project)
    notes.push(html`<span class="badge stale">overridden by project ${project}</span>`);
  return html`<div class=${`setting ${dirty ? "dirty" : ""}`}>
    <div class="setting-main">
      <div class="setting-head">
        <span class="setting-label">${s.label}</span>
        <span class="mono small-text muted">${s.key}</span>
        <span class=${`badge src-${s.source}`} title="where the effective value comes from">${s.source}</span>
        ${notes}
      </div>
      <div class="setting-edit">
        <${SettingInput} s=${s} value=${value} disabled=${disabled} onChange=${setDraft} />
        ${dirty ? html`<button class="primary" disabled=${busy} onClick=${() => run({ value: draft }, "Set")}>Save</button><button class="ghost" onClick=${() => setDraft(undefined)}>cancel</button>` : null}
        ${!dirty && layer !== null ? html`<button class="ghost" disabled=${busy} title=${`remove from the ${scope} file (falls back to ${scope === "project" ? "global/default" : "default"})`} onClick=${() => run({ unset: true }, "Reset")}>reset</button>` : null}
      </div>
      <div class="layers small-text muted">effective <b>${show(s.value)}</b> · default ${show(s.layers.default)} · global ${show(s.layers.global)}${project ? html` · project ${show(s.layers.project)}` : null}${s.globalOnly ? " · global only" : ""}</div>
    </div>
    <div class="setting-doc small-text muted">${s.doc}</div>
  </div>`;
}

export function Settings({ events }) {
  const { data, error, reload } = useApi("/api/config", events, CONFIG_EVENTS);
  const [scope, setScope] = useState("global");
  const [flash, setFlash] = useState(null);
  const [rawTab, setRawTab] = useState("global");
  if (error) return html`<section class="card error">${error}</section>`;
  if (!data) return html`<section class="card muted">loading…</section>`;
  const say = (m) => {
    setFlash(m);
    setTimeout(() => setFlash(null), 5000);
    reload();
  };
  const open = async (sc) => {
    try {
      const r = await post("/api/config-open", { scope: sc });
      say(r.opened ? `opened ${r.file}` : `open it yourself: ${r.file}`);
    } catch (e) {
      errorToast(e);
    }
  };
  const reloadFiles = async () => {
    await post("/api/config-reload", {});
    say("config reloaded");
  };
  const raw = rawTab === "project" ? data.raw.project : data.raw.global;
  const rawFile = rawTab === "project" ? data.files.project : data.files.global;
  return html`
    <section class="card review-head">
      <div class="row">
        <h2>Settings</h2>
        <div class="segmented">
          <button class=${scope === "global" ? "on" : ""} onClick=${() => setScope("global")}>Global</button>
          <button class=${scope === "project" ? "on" : ""} disabled=${!data.project} title=${data.project ? "" : "no active project"} onClick=${() => setScope("project")}>This project${data.project ? ` (${data.project})` : ""}</button>
        </div>
        <span class="grow"></span>
        ${flash ? html`<span class="flash">${flash}</span>` : null}
        <button class="ghost" onClick=${reloadFiles} title="re-read the config files after editing them by hand">reload</button>
      </div>
      <p class="muted small-text">${scope === "project" ? `Changes go into ${data.files.project} and apply to this project only.` : `Changes go into ${data.files.global} and apply to every project (unless a project overrides them).`} Order: default → global → project → environment. Facts about the demo itself live in the Project tab.</p>
      <div class="api-keys">${data.apiKeys.map((k) => html`<span class=${`badge ${k.set ? "approved" : "old"}`} title=${k.for}>${k.name}: ${k.set ? "set" : "not set"}</span>`)}<span class="muted small-text">API keys come from the environment only — never shown or stored here.</span></div>
    </section>
    <div class="settings-groups">
      ${data.groups.map(
        (g) => html`<section class="card setting-group">
          <h3>${g.label}</h3>
          ${g.settings.map((s) => html`<${SettingRow} key=${s.key} s=${s} scope=${scope} project=${data.project} onSaved=${say} />`)}
        </section>`,
      )}
      <details class="card raw-files">
        <summary><b>Raw config files</b> <span class="muted small-text">read-only — global ${data.raw.global ? "" : "(not created yet) "}· project ${data.files.project ? (data.raw.project ? "" : "(not created yet)") : "(no active project)"}</span></summary>
        <div class="row">
          <div class="segmented">
            <button class=${rawTab === "global" ? "on" : ""} onClick=${() => setRawTab("global")}>global</button>
            <button class=${rawTab === "project" ? "on" : ""} disabled=${!data.files.project} onClick=${() => setRawTab("project")}>project</button>
          </div>
          <span class="mono small-text muted">${rawFile ?? "—"}</span>
          <span class="grow"></span>
          <button disabled=${!rawFile} onClick=${() => open(rawTab)}>open in editor</button>
        </div>
        <pre class="raw">${raw ?? "(file does not exist yet — defaults apply)"}</pre>
      </details>
    </div>`;
}
