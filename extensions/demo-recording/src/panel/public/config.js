import { html, useEffect, useMemo, useRef, useState } from "/vendor/preact-htm.module.js";
import {
  FILTERS,
  filterGroups,
  highlight,
  queryFromSearch,
  same,
  searchFromQuery,
  showValue,
} from "./config-search.js";
import { post, useApi, useHashRoute } from "./core.js";
// demo-recording panel — ⚙ Config → Settings (S5 part 5b, D41/D48): every
// setting grouped with its effective value, source and per-layer values;
// edits are global or for this project only, always through a diff
// confirmation (same two-phase write as demo_rec_config). The raw files are
// shown read-only; API keys only as "set / not set".
import { confirmAsk, errorToast } from "./dialog.js";

const CONFIG_EVENTS = /^(config|project|brand)\./;

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

function SettingInput({ s, value, onChange, disabled, label }) {
  if (s.type === "boolean")
    return html`<input class="ds-check-input" aria-label=${label} type="checkbox" checked=${!!value} disabled=${disabled} onChange=${(e) => onChange(e.target.checked)} />`;
  if (s.type === "number")
    return html`<input class="ds-input" aria-label=${label} type="number" value=${value ?? ""} disabled=${disabled} onInput=${(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />`;
  if (s.type === "enum")
    return html`<select class="ds-select" aria-label=${label} value=${value ?? ""} disabled=${disabled} onChange=${(e) => onChange(e.target.value)}>${(s.options ?? []).map((o) => html`<option value=${o}>${o}</option>`)}</select>`;
  if (s.type === "engines")
    return html`<${EnginesInput} value=${value} options=${s.options ?? []} onChange=${onChange} />`;
  if (s.type === "list")
    return html`<textarea class="ds-textarea ds-textarea--compact" aria-label=${label} rows="2" disabled=${disabled} placeholder="one per line" value=${Array.isArray(value) ? value.join("\n") : ""} onInput=${(
      e,
    ) =>
      onChange(
        e.target.value
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean),
      )}></textarea>`;
  return html`<input class="ds-input" aria-label=${label} type="text" value=${value ?? ""} disabled=${disabled} onInput=${(e) => onChange(e.target.value)} />`;
}

const SOURCE_WORD = {
  default: "Default",
  global: "Global",
  project: "Project override",
  env: "Environment",
  unset: "Not set",
};

/** Text with the parts that match the query marked. */
function Hl({ text, ws }) {
  return html`${highlight(text, ws).map((p) => (p.hit ? html`<mark class="ds-hit">${p.t}</mark>` : p.t))}`;
}

/**
 * One setting with its layers side by side (D125): what is in effect and why, the global value and the project
 * override, each with its own action. Editing opens in that layer's cell and ends in the diff confirmation, so
 * a setting found by search can never be edited in the wrong layer.
 */
function SettingCard({ s, project, ws, onSaved }) {
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState(undefined);
  const [busy, setBusy] = useState(false);
  const layerOf = (scope) => (scope === "project" ? s.layers.project : s.layers.global);
  useEffect(() => {
    setEditing(null);
    setDraft(undefined);
  }, [JSON.stringify(s.layers)]);
  const run = async (scope, body, what) => {
    setBusy(true);
    try {
      const plan = await post("/api/config-set", { key: s.key, scope, ...body });
      const ok = await confirmAsk({
        title: what,
        text: `${scope === "project" ? `Project ${project}` : "Global"} · ${plan.file}`,
        diff: plan.diff,
        warnings: plan.shadowedBy
          ? [`This change has no effect right now: it is overridden by ${plan.shadowedBy}.`]
          : [],
        confirmLabel: "Save",
      });
      if (!ok) return;
      await post("/api/config-set", { key: s.key, scope, ...body, confirm: true });
      setEditing(null);
      setDraft(undefined);
      onSaved(`${s.key} saved (${scope})`);
    } catch (e) {
      errorToast(e, s.key);
    } finally {
      setBusy(false);
    }
  };
  const start = (scope) => {
    setEditing(scope);
    setDraft(layerOf(scope) ?? s.value);
  };
  const dirty = editing && !same(draft, layerOf(editing));
  const cell = (scope) => {
    const layer = layerOf(scope);
    const isSet = layer !== null && layer !== undefined;
    const blocked = scope === "project" && (s.globalOnly || !project);
    const why =
      scope === "project"
        ? s.globalOnly
          ? "This setting is global only: a project cannot override it."
          : !project
            ? "Open a project to override this setting for it."
            : ""
        : "";
    return html`<div class="ds-layer" data-layer=${scope}>
      <span class="ds-label">${scope === "global" ? "Global" : project ? `Project override (${project})` : "Project override"}</span>
      ${
        editing === scope
          ? html`<div class="ds-row-flex ds-layer-edit"><${SettingInput} s=${s} value=${draft} disabled=${busy} onChange=${setDraft} label=${`${s.label}, ${scope === "project" ? "project override" : "global value"}`} />
              <button class="ds-btn ds-btn--primary ds-btn--sm" type="button" data-act="save" disabled=${busy || !dirty} onClick=${() => run(scope, { value: draft }, `Set ${s.key}?`)}>Save…</button>
              <button class="ds-btn ds-btn--ghost ds-btn--sm" type="button" data-act="cancel" onClick=${() => {
                setEditing(null);
                setDraft(undefined);
              }}>Cancel</button></div>`
          : html`<span class=${`ds-layer-value ${isSet ? "" : "ds-muted"}`} data-set=${isSet ? "true" : "false"}>${isSet ? showValue(s, layer) : "Not set"}</span>`
      }
      ${
        editing === scope
          ? null
          : html`<span class="ds-row-flex">
            <button class="ds-btn ds-btn--sm" type="button" data-act=${scope === "global" ? "edit-global" : isSet ? "edit-override" : "add-override"} aria-disabled=${blocked || busy ? "true" : undefined} onClick=${() => !blocked && !busy && start(scope)}>${scope === "global" ? "Edit global" : isSet ? "Edit override" : "Add override for this project"}</button>
            ${isSet ? html`<button class="ds-btn ds-btn--ghost ds-btn--sm" type="button" data-act=${`remove-${scope}`} aria-disabled=${busy || blocked ? "true" : undefined} title=${scope === "project" ? "remove it from the project file (falls back to global or the default)" : "remove it from the global file (falls back to the default)"} onClick=${() => !busy && !blocked && run(scope, { unset: true }, scope === "project" ? `Remove the project override of ${s.key}?` : `Reset ${s.key} to its default?`)}>${scope === "project" ? "Remove override" : "Reset to default"}</button>` : null}
          </span>`
      }
      ${blocked ? html`<span class="ds-why">${why}</span>` : null}
    </div>`;
  };
  const sourceText =
    s.source === "env" ? `Environment (${s.envVar})` : (SOURCE_WORD[s.source] ?? s.source);
  return html`<article class="ds-setting" data-key=${s.key} id=${`setting-${s.key}`}>
    <div class="ds-row-flex">
      <h4 class="ds-setting-label"><${Hl} text=${s.label} ws=${ws} /></h4>
      <span class="ds-mono ds-small ds-muted"><${Hl} text=${s.key} ws=${ws} /></span>
      <span class="ds-grow"></span>
      <span class="ds-small" data-effective><span class="ds-muted">Effective</span> <strong class="ds-layer-value">${showValue(s, s.value)}</strong> <span class="ds-badge" data-tone=${s.source === "env" ? "warn" : "neutral"} title="where the effective value comes from">${sourceText}</span></span>
    </div>
    <p class="ds-small ds-muted ds-measure"><${Hl} text=${s.doc} ws=${ws} /></p>
    ${
      s.envSet
        ? html`<div class="ds-notice" data-tone="warn" role="note"><span class="ds-status" data-tone="warn" aria-hidden="true">!</span>
            <div class="ds-grow">The environment variable <span class="ds-mono">${s.envVar}</span> sets this and wins over both files (read-only here). A value saved below is stored but has no effect while it is set.</div></div>`
        : null
    }
    <div class="ds-layers">${cell("global")}${cell("project")}</div>
    <details class="ds-small">
      <summary>Technical details</summary>
      <p class="ds-mono ds-muted">key ${s.key} · type ${s.type} · default ${showValue(s, s.layers.default)}${s.envVar ? ` · environment ${s.envVar}${s.envSet ? " (set)" : " (not set)"}` : ""}${s.globalOnly ? " · global only" : ""}</p>
    </details>
  </article>`;
}

/** Search box and quick filters; `/` and Cmd/Ctrl+K focus it inside Config, never in an editable control or over a dialog. */
function SearchBar({ text, setText, filters, toggleFilter, count, total, searching, inputRef }) {
  useEffect(() => {
    const onKey = (e) => {
      if (document.querySelector(".modal-backdrop")) return;
      const el = document.activeElement;
      const editable = el?.matches?.("input, textarea, select, [contenteditable=true]");
      const slash = e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey;
      const cmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      if ((slash && !editable) || (cmdK && (!editable || el === inputRef.current))) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return html`<div class="ds-row-flex config-search">
    <label class="ds-search">
      <span class="ds-sr-only">Search the settings</span><span class="ds-search-icon" aria-hidden="true">⌕</span>
      <input class="ds-input" type="search" placeholder="Search settings…" autocomplete="off" ref=${inputRef} value=${text}
        onInput=${(e) => setText(e.target.value)}
        onKeyDown=${(e) => {
          if (e.key === "Escape" && text) {
            e.preventDefault();
            e.stopPropagation();
            setText("");
          }
        }} />
      <kbd class="ds-kbd">/</kbd>
    </label>
    ${FILTERS.map(([id, label, title]) => html`<button class="ds-chip" type="button" key=${id} data-filter=${id} title=${title} aria-pressed=${filters.has(id)} onClick=${() => toggleFilter(id)}>${label}</button>`)}
    <span class="ds-small ds-muted" role="status" data-count>${searching ? `${count} of ${total} settings` : `${total} settings`}</span>
  </div>`;
}

export function Settings({ events }) {
  const { data, error, reload } = useApi("/api/config", events, CONFIG_EVENTS);
  const [route, go] = useHashRoute();
  const st = useMemo(() => searchFromQuery(route?.query), [route?.raw]);
  const [text, setText] = useState(st.q);
  const [flash, setFlash] = useState(null);
  const [rawTab, setRawTab] = useState("global");
  const input = useRef(null);
  useEffect(() => setText(st.q), [st.q]);
  const update = (next) =>
    go({ screen: "config", query: queryFromSearch({ ...st, ...next }) }, { replace: true });
  // typing reaches the address a moment later
  useEffect(() => {
    if (text === st.q) return;
    const t = setTimeout(() => update({ q: text }), 150);
    return () => clearTimeout(t);
  }, [text]);
  if (error) return html`<section class="card error">Settings are unavailable: ${error}</section>`;
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
  const res = filterGroups(data.groups, { q: st.q, filters: st.filters, project: data.project });
  const toggleFilter = (id) => {
    const next = new Set(st.filters);
    next.has(id) ? next.delete(id) : next.add(id);
    update({ filters: next });
  };
  const clear = () => {
    setText("");
    update({ q: "", filters: new Set() });
  };
  return html`
    <section class="card review-head">
      <div class="row">
        <h2>Settings</h2>
        <span class="grow"></span>
        ${flash ? html`<span class="flash">${flash}</span>` : null}
        <button class="ghost" onClick=${reloadFiles} title="re-read the config files after editing them by hand">reload</button>
      </div>
      <${SearchBar} text=${text} setText=${setText} filters=${st.filters} toggleFilter=${toggleFilter} count=${res.count} total=${res.total} searching=${res.searching} inputRef=${input} />
      <p class="muted small-text">Each setting shows what is in effect and where it comes from, the global value and this project's override. Order: default → global file → project file → environment (read-only here). Global: ${data.files.global}${data.files.project ? ` · project: ${data.files.project}` : " · no project open"}.</p>
      <div class="api-keys">${data.apiKeys.map((k) => html`<span class="ds-badge" data-tone=${k.set ? "ok" : "neutral"} title=${k.for}><span class="ds-badge-ico" aria-hidden="true">${k.set ? "✓" : "–"}</span>${k.name}: ${k.set ? "set" : "not set"}</span>`)}<span class="muted small-text">API keys come from the environment only: never shown, saved or searched.</span></div>
    </section>
    <div class="settings-groups">
      ${
        res.searching && res.count === 0
          ? html`<section class="card"><div class="ds-state"><div class="ds-state-ico" aria-hidden="true">⌕</div><h3>No setting matches</h3><p>Nothing in ${res.total} settings matches${st.q ? ` “${st.q}”` : ""}${st.filters.size ? ` with ${[...st.filters].map((f) => FILTERS.find(([id]) => id === f)?.[1]).join(" + ")}` : ""}.</p><button class="ds-btn" type="button" data-act="clear-search" onClick=${clear}>Clear the search</button></div></section>`
          : res.groups.map(
              (g) => html`<section class="card setting-group" key=${g.id}>
          <h3>${g.label}${res.searching ? html` <span class="ds-muted ds-small">${g.settings.length} match${g.settings.length === 1 ? "" : "es"}</span>` : null}</h3>
          ${g.settings.map((s) => html`<${SettingCard} key=${s.key} s=${s} project=${data.project} ws=${res.words} onSaved=${say} />`)}
        </section>`,
            )
      }
      <details class="card raw-files">
        <summary><b>Raw config files</b> <span class="muted small-text">read-only, not searched: global ${data.raw.global ? "" : "(not created yet) "}· project ${data.files.project ? (data.raw.project ? "" : "(not created yet)") : "(no active project)"}</span></summary>
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
