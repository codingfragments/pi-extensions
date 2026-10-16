import { html, useEffect, useMemo, useRef, useState } from "/vendor/preact-htm.module.js";
import { Brand } from "./brand.js";
import {
  FILTERS,
  filterGroups,
  highlight,
  isChanged,
  queryFromSearch,
  same,
  searchFromQuery,
  showValue,
} from "./config-search.js";
import { post, useApi, useHashRoute } from "./core.js";
import { confirmAsk, errorToast, toast } from "./dialog.js";
// demo-recording panel — ⚙ Config → Settings (S5 part 5b, D41/D48): every
// setting grouped with its effective value, source and per-layer values;
// edits are global or for this project only, always through a diff
// confirmation (same two-phase write as demo_rec_config). The raw files are
// shown read-only; API keys only as "set / not set".
import { VoiceInput } from "./voices.js";

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
      (e, i) => html`<span class="cfg-engine" key=${e}><span class="mono">${i + 1}. ${e}</span>
        <button class="ds-btn ds-btn--ghost" disabled=${i === 0} title="earlier" onClick=${() => move(i, -1)}>↑</button>
        <button class="ds-btn ds-btn--ghost" disabled=${i === list.length - 1} title="later" onClick=${() => move(i, 1)}>↓</button>
        <button class="ds-btn ds-btn--ghost" disabled=${list.length === 1} title="remove" onClick=${() => onChange(list.filter((x) => x !== e))}>✕</button></span>`,
    )}
    ${options
      .filter((o) => !list.includes(o))
      .map(
        (o) =>
          html`<button class="ds-btn ds-btn--sm" onClick=${() => onChange([...list, o])}>+ ${o}</button>`,
      )}
  </div>`;
}

function SettingInput({ s, value, onChange, disabled, id }) {
  if (s.type === "boolean")
    return html`<input class="ds-check-input" id=${id} type="checkbox" checked=${!!value} disabled=${disabled} onChange=${(e) => onChange(e.target.checked)} />`;
  if (s.type === "number")
    return html`<input class="ds-input" id=${id} type="number" value=${value ?? ""} disabled=${disabled} onInput=${(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />`;
  if (s.type === "enum")
    return html`<select class="ds-select" id=${id} value=${value ?? ""} disabled=${disabled} onChange=${(e) => onChange(e.target.value)}>${(s.options ?? []).map((o) => html`<option value=${o}>${o}</option>`)}</select>`;
  if (s.type === "engines")
    return html`<${EnginesInput} value=${value} options=${s.options ?? []} onChange=${onChange} />`;
  if (s.type === "list")
    return html`<textarea class="ds-textarea ds-textarea--compact" id=${id} rows="2" disabled=${disabled} placeholder="one per line" value=${Array.isArray(value) ? value.join("\n") : ""} onInput=${(
      e,
    ) =>
      onChange(
        e.target.value
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean),
      )}></textarea>`;
  if (s.key === "voiceName")
    return html`<${VoiceInput} id=${id} value=${value} disabled=${disabled} onChange=${onChange} emptyLabel="Not set (no voice name)" />`;
  return html`<input class="ds-input" id=${id} type="text" value=${value ?? ""} disabled=${disabled} onInput=${(e) => onChange(e.target.value)} />`;
}

// The mock's source badges (docs/ux/config.html): tone and word.
const SRC = {
  env: ["warn", "Environment"],
  project: ["accent", "Project"],
  global: ["info", "Global"],
  default: ["neutral", "Default"],
  unset: ["neutral", "Not set"],
};

/** Text with the parts that match the query marked. */
function Hl({ text, ws }) {
  return html`${highlight(text, ws).map((p) => (p.hit ? html`<mark class="ds-mark">${p.t}</mark>` : p.t))}`;
}

const isSet = (v) => v !== null && v !== undefined;
const badge = (tone, label) =>
  html`<span class="ds-badge" data-tone=${tone} key=${label}>${label}</span>`;

/** The four scopes of a setting, each with its own action (D125): environment (read-only), project, global, default. */
function ScopeRows({ s, project, busy, onEdit, onRemove }) {
  const blocked = !project || s.globalOnly;
  const why = !project ? "Open a project to override" : "Global only";
  const proj = s.layers.project;
  const glob = s.layers.global;
  const act = (scope, label, extra = {}) =>
    html`<button class="ds-btn ds-btn--sm" type="button" data-act=${`${extra.act ?? "edit"}-${scope}`} aria-disabled=${busy ? "true" : undefined} onClick=${() => !busy && (extra.run ?? onEdit)(scope)}>${label}</button>`;
  return html`
    <div class="ds-scope" data-layer="env"><span>Environment</span><span>${s.envVar ? html`<code>${s.envVar}</code> = ${s.envSet ? showValue(s, s.value) : "not set"}` : html`<span class="ds-muted">Not set</span>`}</span><span class="ds-muted ds-small">${s.envSet ? "read-only, wins over both files" : "read-only"}</span></div>
    <div class="ds-scope" data-layer="project"><span>Project override</span><span data-set=${isSet(proj) ? "true" : "false"}>${isSet(proj) ? showValue(s, proj) : "Not set"}</span>
      ${
        blocked
          ? html`<span class="ds-row-flex"><button class="ds-btn ds-btn--sm" type="button" data-act="edit-project" aria-disabled="true" aria-describedby=${`why-${s.key}`}>${isSet(proj) ? "Edit project" : "Override for this project"}</button><span class="ds-why" id=${`why-${s.key}`}>${why}</span></span>`
          : html`<span class="ds-row-flex">${act("project", isSet(proj) ? "Edit project" : "Override for this project")}${isSet(proj) ? act("project", "Remove override", { act: "remove", run: onRemove }) : null}</span>`
      }</div>
    <div class="ds-scope" data-layer="global"><span>Global value</span><span data-set=${isSet(glob) ? "true" : "false"}>${isSet(glob) ? showValue(s, glob) : "Not set"}</span><span class="ds-row-flex">${act("global", "Edit global")}${isSet(glob) ? act("global", "Reset to default", { act: "remove", run: onRemove }) : null}</span></div>
    <div class="ds-scope" data-layer="default"><span>Default</span><span>${showValue(s, s.layers.default)}</span><span class="ds-muted ds-small">built in</span></div>`;
}

/**
 * One setting as a compact row (the UX0 mock): label, key, description; the effective value with where it comes
 * from; and "Scopes", which opens its layers with an action each. Editing opens under the row, in the layer that
 * was chosen, and ends in the diff confirmation, so a result of the search can never edit the wrong layer.
 */
function SettingRow({ s, project, ws, open, toggle, files, onSaved }) {
  const [edit, setEdit] = useState(null); // "global" | "project" | null
  const [draft, setDraft] = useState(undefined);
  const [busy, setBusy] = useState(false);
  const layerOf = (scope) => (scope === "project" ? s.layers.project : s.layers.global);
  useEffect(() => {
    setEdit(null);
    setDraft(undefined);
  }, [JSON.stringify(s.layers)]);
  const run = async (scope, body, title) => {
    setBusy(true);
    try {
      const plan = await post("/api/config-set", { key: s.key, scope, ...body });
      const ok = await confirmAsk({
        title,
        text: `${scope === "project" ? `Project ${project}` : "Global"} · ${plan.file}`,
        diff: plan.diff,
        warnings: plan.shadowedBy
          ? [`This change has no effect right now: it is overridden by ${plan.shadowedBy}.`]
          : [],
        confirmLabel: "Save",
      });
      if (!ok) return;
      await post("/api/config-set", { key: s.key, scope, ...body, confirm: true });
      setEdit(null);
      setDraft(undefined);
      onSaved(`${s.key} saved (${scope})`);
    } catch (e) {
      errorToast(e, s.key);
    } finally {
      setBusy(false);
    }
  };
  const start = (scope) => {
    setEdit(scope);
    setDraft(layerOf(scope) ?? s.value);
  };
  const remove = (scope) =>
    run(
      scope,
      { unset: true },
      scope === "project"
        ? `Remove the project override of ${s.key}?`
        : `Reset ${s.key} to its default?`,
    );
  const dirty = edit && !same(draft, layerOf(edit));
  const [tone, name] = SRC[s.source] ?? SRC.unset;
  const showScopes = open || !!edit;
  const target = edit ? (edit === "project" ? files.project : files.global) : "";
  return html`<div class="ds-srow" data-key=${s.key} id=${`setting-${s.key}`} data-edit=${edit ? "true" : undefined}>
    <div class="ds-srow-main"><div class="ds-srow-title"><h4><${Hl} text=${s.label} ws=${ws} /></h4><code><${Hl} text=${s.key} ws=${ws} /></code></div><p class="ds-small ds-muted"><${Hl} text=${s.doc} ws=${ws} /></p></div>
    <div class="ds-srow-value" data-effective><strong><${Hl} text=${showValue(s, s.value)} ws=${ws} /></strong><span>${s.source === "unset" ? null : badge(tone, s.source === "env" ? `Environment (${s.envVar})` : name)}${isSet(s.layers.project) && s.source !== "project" ? badge("accent", "Project override") : null}</span></div>
    <button class="ds-btn ds-btn--sm" type="button" data-toggle=${s.key} aria-expanded=${showScopes} onClick=${() => toggle(s.key)}>${showScopes ? "Hide scopes" : "Scopes"}</button>
    ${
      edit
        ? html`<div class="ds-srow-edit">
        <div class="ds-field"><label class="ds-label" for=${`edit-${s.key}`}>Editing the ${edit === "project" ? `project override (${project})` : "global value"}</label>
          <${SettingInput} s=${s} id=${`edit-${s.key}`} value=${draft} disabled=${busy} onChange=${setDraft} />
          <span class="ds-hint-text">Saved to <code>${target}</code> after you review the change. ${edit === "global" ? "Applies to every project unless one overrides it." : "Applies to this project only."}</span></div>
        ${s.envSet ? html`<div class="ds-notice" data-tone="warn"><span class="ds-status" data-tone="warn" aria-hidden="true">!</span><div>This change has no effect right now: it is overridden by the environment variable <code>${s.envVar}</code>.</div></div>` : null}
        <div class="ds-row-flex"><button class="ds-btn ds-btn--primary" type="button" data-act="save" disabled=${busy || !dirty} onClick=${() => run(edit, { value: draft }, `Set ${s.key}?`)}>Review change…</button><button class="ds-btn" type="button" data-act="cancel" onClick=${() => {
          setEdit(null);
          setDraft(undefined);
        }}>Cancel</button></div>
      </div>`
        : null
    }
    ${showScopes && !edit ? html`<div class="ds-srow-panel" role="group" aria-label=${`${s.label} by scope`}><${ScopeRows} s=${s} project=${project} busy=${busy} onEdit=${start} onRemove=${remove} /></div>` : null}
  </div>`;
}

/** Search box with its quick filters; `/` and Cmd/Ctrl+K focus it inside Config, never in an editable control or over a dialog. */
function SearchBar({ text, setText, filters, toggleFilter, status, searching, clear, inputRef }) {
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
    <label class="ds-search ds-grow ds-cfg-searchbox">
      <span class="ds-sr-only">Search settings</span><span class="ds-search-icon" aria-hidden="true">⌕</span>
      <input class="ds-input" type="search" placeholder="Search names, keys, descriptions and values…" autocomplete="off" ref=${inputRef} value=${text}
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
    ${searching ? html`<button class="ds-btn ds-btn--ghost" type="button" data-act="clear" onClick=${clear}>Clear</button>` : null}
    ${FILTERS.map(([id, label, title]) => html`<button class="ds-chip" type="button" key=${id} data-filter=${id} title=${title} aria-pressed=${filters.has(id)} onClick=${() => toggleFilter(id)}>${label}</button>`)}
    <span class="ds-small ds-muted" role="status" aria-live="polite" data-count>${status}</span>
  </div>`;
}

export function Settings({ events }) {
  const { data, error, reload } = useApi("/api/config", events, CONFIG_EVENTS);
  const [route, go] = useHashRoute();
  const st = useMemo(() => searchFromQuery(route?.query), [route?.raw]);
  const [text, setText] = useState(st.q);
  const [rawTab, setRawTab] = useState("global");
  // Config opens light: only the first group is open until you open another one (a search opens what matches)
  const [openGroups, setOpenGroups] = useState(null);
  const [openScopes, setOpenScopes] = useState(new Set());
  const [active, setActive] = useState(null);
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
    toast(m, { kind: "info" });
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
  const raw = rawTab === "project" ? data.raw.project : data.raw.global;
  const rawFile = rawTab === "project" ? data.files.project : data.files.global;
  const res = filterGroups(data.groups, { q: st.q, filters: st.filters, project: data.project });
  const hits = new Map(res.groups.map((g) => [g.id, g.settings]));
  const toggleFilter = (id) => {
    const next = new Set(st.filters);
    next.has(id) ? next.delete(id) : next.add(id);
    update({ filters: next });
  };
  const clear = () => {
    setText("");
    update({ q: "", filters: new Set() });
  };
  const toggleIn = (setter) => (key) =>
    setter((cur) => {
      const n = new Set(cur);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  const overrides = data.groups
    .flatMap((g) => g.settings)
    .filter((s) => isSet(s.layers.project)).length;
  const firstHit = res.groups[0]?.id ?? data.groups[0]?.id;
  const groupsOpen = openGroups ?? new Set(data.groups[0] ? [data.groups[0].id] : []);
  const toggleGroup = (id) =>
    setOpenGroups(() => {
      const n = new Set(groupsOpen);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const goTo = (id) => {
    setActive(id);
    setOpenGroups(() => new Set([...groupsOpen, id]));
    requestAnimationFrame(() =>
      document.getElementById(`g-${id}`)?.scrollIntoView({ block: "start" }),
    );
  };
  const status = res.searching
    ? `${res.count} setting${res.count === 1 ? "" : "s"} in ${res.groups.length} group${res.groups.length === 1 ? "" : "s"} match${res.count === 1 ? "es" : ""}${st.q.trim() ? ` “${st.q.trim()}”` : ""}${st.filters.size ? ` with ${[...st.filters].map((f) => FILTERS.find(([id]) => id === f)?.[1]).join(" + ")}` : ""}`
    : `${res.total} settings`;
  return html`
    <div class="ds-root ds-cfg-root">
      <div class="ds-cfg-top">
        <${SearchBar} text=${text} setText=${setText} filters=${st.filters} toggleFilter=${toggleFilter} status=${status} searching=${res.searching} clear=${clear} inputRef=${input} />
        <div class="ds-notice ds-cfg-project" role="note">
          ${
            data.project
              ? html`<span class="ds-status" data-tone="accent" aria-hidden="true">●</span><span>Project <strong style="color: var(--text-strong)">${data.project}</strong> is open: you can override a setting for it. ${overrides} override${overrides === 1 ? "" : "s"} today.</span>`
              : html`<span class="ds-status" data-tone="info" aria-hidden="true">i</span><span>No project is open, so only global values can be edited. Project overrides are shown for open projects.</span>`
          }
        </div>
        <div class="ds-cfg-keys"><span class="ds-cfg-keys-list ds-row-flex">${data.apiKeys.map((k) => html`<span class="ds-badge" data-tone=${k.set ? "ok" : "neutral"} title=${k.for} key=${k.name}><span class="ds-badge-ico" aria-hidden="true">${k.set ? "✓" : "○"}</span>${k.name}: ${k.set ? "set" : "not set"}</span>`)}</span><span>API keys come from the environment only. They are never shown, stored or searched here.</span></div>
      </div>
      <div class="ds-cfg">
        <nav class="ds-cfg-nav" aria-label="Setting groups">
          ${data.groups.map((g) => html`<button type="button" key=${g.id} data-nav=${g.id} data-empty=${res.searching && !hits.has(g.id)} aria-current=${(active ?? firstHit) === g.id ? "true" : undefined} onClick=${() => goTo(g.id)}>${g.label}<span class="ds-cfg-count">${res.searching ? `${hits.get(g.id)?.length ?? 0}/${g.settings.length}` : g.settings.length}</span></button>`)}
        </nav>
        <div class="ds-cfg-main">
          <div class="ds-cfg-groups settings-groups">
            ${
              res.searching && res.count === 0
                ? html`<div class="ds-card"><div class="ds-state"><div class="ds-state-ico" aria-hidden="true">⌕</div><h3>No settings match${st.q.trim() ? ` “${st.q.trim()}”` : ""}</h3><p>Search looks at names, keys, descriptions and current values. Secrets are never searched.</p><button class="ds-btn" type="button" data-act="clear-search" onClick=${clear}>Clear search</button></div></div>`
                : res.groups.map((g) => {
                    const whole = data.groups.find((x) => x.id === g.id)?.settings ?? g.settings;
                    const all = whole.length;
                    const changedHere = whole.filter(isChanged).length;
                    const isOpen = res.searching || groupsOpen.has(g.id);
                    return html`<section class="ds-group" id=${`g-${g.id}`} key=${g.id} aria-labelledby=${`gh-${g.id}`}>
                      <button class="ds-group-head" id=${`gh-${g.id}`} type="button" data-group=${g.id} aria-expanded=${isOpen} onClick=${() => toggleGroup(g.id)}><span class="ds-group-chev" aria-hidden="true">${isOpen ? "▾" : "▸"}</span>${g.label}<span class="ds-cfg-count">${res.searching ? `${g.settings.length} of ${all}` : all}</span>${!res.searching && changedHere ? html`<span class="ds-badge" data-tone="accent" data-changed title="settings in this group that differ from their default">${changedHere} changed</span>` : null}</button>
                      ${isOpen ? g.settings.map((s) => html`<${SettingRow} key=${s.key} s=${s} project=${data.project} ws=${res.words} open=${openScopes.has(s.key)} toggle=${toggleIn(setOpenScopes)} files=${data.files} onSaved=${say} />`) : null}
                    </section>`;
                  })
            }
            ${
              res.searching && res.groups.length < data.groups.length && res.count > 0
                ? html`<p class="ds-small ds-muted">${data.groups.length - res.groups.length} group${data.groups.length - res.groups.length === 1 ? " has" : "s have"} no match: ${data.groups
                    .filter((g) => !hits.has(g.id))
                    .map((g) => g.label)
                    .join(", ")}.</p>`
                : null
            }
          </div>
          <details class="ds-group raw-files">
            <summary class="ds-group-head" style="list-style: none"><span class="ds-group-chev" aria-hidden="true">▸</span>Raw config files <span class="ds-muted ds-small" style="font-weight: var(--weight-regular)">read-only, not searched</span></summary>
            <div class="ds-stack" style="padding: var(--space-4); border-block-start: 1px solid var(--border-subtle)">
              <div class="ds-row-flex"><span class="ds-seg"><button type="button" aria-pressed=${rawTab === "global"} onClick=${() => setRawTab("global")}>global</button><button type="button" aria-pressed=${rawTab === "project"} disabled=${!data.files.project} onClick=${() => setRawTab("project")}>project</button></span><code class="ds-small ds-muted">${rawFile ?? "—"}</code><span class="ds-grow"></span><button class="ds-btn ds-btn--sm" type="button" disabled=${!rawFile} onClick=${() => open(rawTab)}>Open in editor</button></div>
              <pre class="ds-raw">${raw ?? "(file does not exist yet: defaults apply)"}</pre>
            </div>
          </details>
        </div>
      </div>
    </div>`;
}

/** The Config page head (the UX0 mock): the title, what it is for, and Reload files. */
export function ConfigHead() {
  const reloadFiles = async () => {
    try {
      await post("/api/config-reload", {});
      toast("config reloaded", { kind: "info" });
    } catch (e) {
      errorToast(e, "reload");
    }
  };
  return html`<div class="ds-stagehead">
    <div class="ds-grow">
      <h1>Config</h1>
      <div class="ds-stagehead-meta"><span>How the tool behaves. Facts about the demo itself live in Project.</span></div>
    </div>
    <button class="ds-btn" type="button" data-act="reload-files" title="Re-read the config files after editing them by hand" onClick=${reloadFiles}>Reload files</button>
  </div>`;
}

/** Config: the page head, the Settings | Brands tabs (in the address) and the chosen view. */
export function Config({ events }) {
  // Settings or Brands, in the address with the search (#/config?view=brands, #/config?q=voice)
  const [route, go] = useHashRoute();
  const st = searchFromQuery(route?.query);
  const setView = (view) =>
    go(
      { screen: "config", query: queryFromSearch(view === "brands" ? { view } : { ...st, view }) },
      { replace: true },
    );
  return html`
    <div class="ds-root ds-cfg-head"><${ConfigHead} /></div>
    <div class="ds-tabs" role="tablist" aria-label="Config sections">${[
      ["settings", "Settings"],
      ["brands", "Brands"],
    ].map(
      ([id, label]) =>
        html`<button class="ds-tab" role="tab" type="button" key=${id} aria-selected=${st.view === id} onClick=${() => setView(id)}>${label}</button>`,
    )}</div>
    ${st.view === "settings" ? html`<${Settings} events=${events} />` : html`<${Brand} events=${events} />`}`;
}
