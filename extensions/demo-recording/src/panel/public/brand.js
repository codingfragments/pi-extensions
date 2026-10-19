// The Brand editor (Config → Brands, S5 part 5): pick a brand, tweak its colours, frame and title card with a
// live preview, then save it as a copy, set it as the default or use it for this project.
import { html, useEffect, useState } from "/vendor/preact-htm.module.js";
import { post, token, useApi } from "./core.js";
import { askText, confirmAsk, errorToast, toast } from "./dialog.js";
import { NarrowSelect } from "./inspector.js";

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

/** A copy of `o` without the dotted path (and without parents that became empty). */
function unsetPath(o, p) {
  const keys = p.split(".");
  const out = { ...o };
  const trail = [out];
  let cur = out;
  for (const k of keys.slice(0, -1)) {
    if (cur[k] == null) return out;
    cur[k] = { ...cur[k] };
    cur = cur[k];
    trail.push(cur);
  }
  Reflect.deleteProperty(cur, keys.at(-1));
  for (let n = keys.length - 1; n > 0; n--) {
    const parent = trail[n - 1];
    if (Object.keys(trail[n]).length === 0) Reflect.deleteProperty(parent, keys[n - 1]);
  }
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

/** The control of one field: colour, hex, switch, select or slider, with a visible value where it helps. */
function BrandControl({ f, value, onChange, disabled, id }) {
  if (f.type === "color")
    return html`<span class="ds-row-flex"><input class="ds-color" id=${id} type="color" value=${String(value ?? "#000000" /* ratchet-ok: the colour input needs a hex default */).slice(0, 7)} disabled=${disabled} onInput=${(e) => onChange(e.target.value)} /><code class="ds-small">${value}</code></span>`;
  if (f.type === "hex")
    return html`<span class="ds-row-flex"><input class="ds-input ds-input--hex" id=${id} type="text" value=${value ?? ""} placeholder=${f.placeholder ?? ""} disabled=${disabled} onChange=${(e) => onChange(e.target.value.trim())} /><span class="ds-swatch" aria-hidden="true" style=${`background:${value}`}></span></span>`;
  if (f.type === "bool")
    return html`<label class="ds-check"><input id=${id} type="checkbox" checked=${!!value} disabled=${disabled} onChange=${(e) => onChange(e.target.checked)} /> ${value ? "On" : "Off"}</label>`;
  if (f.type === "select")
    return html`<select class="ds-select" id=${id} value=${value} disabled=${disabled} onChange=${(e) => onChange(e.target.value)}>${f.options.map((o) => html`<option value=${o}>${o}</option>`)}</select>`;
  return html`<span class="ds-row-flex ds-brand-range"><input id=${id} type="range" min=${f.min} max=${f.max} step=${f.step} value=${value} disabled=${disabled} onInput=${(e) => onChange(Number(e.target.value))} /><output class="ds-small" for=${id}>${value}</output></span>`;
}

export function Brand({ events }) {
  const { data, error, reload } = useApi(
    "/api/brands",
    events,
    /^(brand\.|config\.|edit\.|project\.)/,
  );
  const [name, setName] = useState(null);
  const [patch, setPatch] = useState({});
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState(() => new Set());
  const selected = name ?? data?.default;
  const entry = data?.brands.find((b) => b.name === selected);
  const dirty = Object.keys(patch).length > 0;
  const say = (m) => toast(m, { kind: "info" });
  const run = async (fn) => {
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      errorToast(e);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const refresh = (p = patch) =>
    run(async () => setPreview(await post("/api/brand-preview", { name: selected, patch: p })));
  // Preview when the brand changes (not on every tweak: rendering takes about a second).
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
  const changed = (p) => getPath(patch, p) !== undefined;
  const changes = BRAND_FIELDS.filter((f) => changed(f.path)).length;
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
  const toggleGroup = (g) =>
    setClosed((c) => {
      const n = new Set(c);
      n.has(g) ? n.delete(g) : n.add(g);
      return n;
    });
  return html`<div class="ds-root ds-workspace brand-editor">
    <p class="ds-small ds-muted ds-measure">A new brand from your logos and colours: ask the Director (<code>/demo brand new path/to/brand.zip</code>). Your brands live in <code>${data.userDir}</code>.</p>
    <div class="ds-split">
      <${NarrowSelect} label="Brand" value=${selected} onChange=${(v) => setName(v)}
        options=${data.brands.map((b) => [b.name, `${b.name}${b.builtin ? " (built-in)" : ""}${b.name === data.default ? " · default" : ""}`])} />
      <section class="ds-split-list" aria-label="Brands">
        <div class="ds-list-head"><span><strong style="color: var(--text-strong)">${data.brands.length} brand${data.brands.length === 1 ? "" : "s"}</strong></span></div>
        <ul class="ds-list">
          ${data.brands.map(
            (
              b,
            ) => html`<li key=${b.name}><button class="ds-item" type="button" data-key=${b.name} aria-current=${b.name === selected ? "true" : undefined} onClick=${() => setName(b.name)}>
              <span class="ds-status" data-tone=${b.error ? "err" : b.name === data.default ? "ok" : undefined} aria-hidden="true">${b.error ? "!" : b.name === data.default ? "✓" : "○"}</span>
              <span><span class="ds-item-title">${b.name}</span><span class="ds-item-meta">${b.builtin ? "built-in" : "yours"}</span></span>
              <span class="ds-row-flex">${b.name === data.default ? html`<span class="ds-badge" data-tone="ok"><span class="ds-badge-ico" aria-hidden="true">✓</span>Default</span>` : null}${b.error ? html`<span class="ds-badge" data-tone="err"><span class="ds-badge-ico" aria-hidden="true">!</span>Invalid</span>` : null}</span>
            </button></li>`,
          )}
        </ul>
      </section>
      <section class="ds-split-detail" aria-label="Selected brand">
        <div class="ds-stack ds-inspector" data-brand=${selected}>
          <div class="ds-row-flex">
            <h2>${selected}</h2>
            ${entry?.builtin ? html`<span class="ds-badge" data-tone="neutral">Built-in</span>` : null}
            ${selected === data.default ? html`<span class="ds-badge" data-tone="ok"><span class="ds-badge-ico" aria-hidden="true">✓</span>Default</span>` : null}
            <span class="ds-grow"></span>
            <button class="ds-btn" type="button" data-act="default-global" disabled=${busy || selected === data.default} onClick=${() => makeDefault("global")}>Set as default</button>
            <button class="ds-btn" type="button" data-act="default-project" disabled=${busy || !data.project} title=${data.project ? `writes projects/${data.project}/config.json` : "no active project"} onClick=${() => makeDefault("project")}>Default for this project</button>
          </div>
          ${entry?.error ? html`<div class="ds-notice" data-tone="err" role="note"><span class="ds-status" data-tone="err" aria-hidden="true">!</span><div>This brand is invalid: ${entry.error}</div></div>` : null}
          ${entry?.builtin ? html`<div class="ds-notice" role="note"><span class="ds-status" data-tone="info" aria-hidden="true">i</span><div>Built-in brands are read-only. Tweak it, then <b>Save as copy…</b>.</div></div>` : null}
          <details class="ds-section" open>
            <summary><strong>Preview</strong></summary>
            <div class="ds-section-body ds-stack">
              <div class="ds-row-flex"><span class="ds-small ds-muted">${dirty ? "Rendered from your tweaks once you press Preview." : "The title card and a sample frame in this brand."}</span><span class="ds-grow"></span>
                <button class="ds-btn ds-btn--sm" type="button" data-act="preview" disabled=${busy} onClick=${() => refresh()}>${busy ? "Rendering…" : dirty ? "Preview tweaks" : "Refresh"}</button></div>
              <div class="ds-brand-shots">
                ${preview?.title ? html`<img src=${`${preview.title}&token=${token}`} alt="title card" />` : null}
                ${preview?.framed ? html`<img src=${`${preview.framed}&token=${token}`} alt="framed sample frame" />` : html`<p class="ds-small ds-muted">Rendering…</p>`}
              </div>
              ${preview?.warnings?.length ? html`<ul class="ds-small">${preview.warnings.map((w) => html`<li>${w}</li>`)}</ul>` : null}
            </div>
          </details>
          ${groups.map((g) => {
            const fields = BRAND_FIELDS.filter((f) => f.group === g);
            const open = !closed.has(g);
            const n = fields.filter((f) => changed(f.path)).length;
            return html`<section class="ds-group" key=${g} data-group=${g}>
              <button class="ds-group-head" type="button" aria-expanded=${open} onClick=${() => toggleGroup(g)}><span class="ds-group-chev" aria-hidden="true">${open ? "▾" : "▸"}</span>${g}<span class="ds-cfg-count">${fields.length}</span>${n ? html`<span class="ds-badge" data-tone="accent">${n} changed</span>` : null}</button>
              ${
                open
                  ? fields.map(
                      (
                        f,
                      ) => html`<div class="ds-srow ds-brow" key=${f.path} data-path=${f.path} data-changed=${changed(f.path) ? "true" : undefined}>
                        <div class="ds-srow-main"><div class="ds-srow-title"><h4><label for=${`brand-${f.path}`}>${f.label}</label></h4><code>${f.path}</code></div></div>
                        <div class="ds-srow-value"><${BrandControl} f=${f} id=${`brand-${f.path}`} value=${value(f.path)} disabled=${busy || !entry?.brand} onChange=${(v) => setPatch((p) => setPath(p, f.path, v))} /></div>
                        ${changed(f.path) ? html`<button class="ds-btn ds-btn--ghost ds-btn--sm" type="button" data-act="undo-field" aria-label=${`Undo the change to ${f.label}`} onClick=${() => setPatch((p) => unsetPath(p, f.path))}>Undo</button>` : html`<span></span>`}
                      </div>`,
                    )
                  : null
              }
            </section>`;
          })}
          <div class="ds-actionbar brand-actionbar">
            <span class="ds-small ds-muted" role="status">${dirty ? `${changes} unsaved tweak${changes === 1 ? "" : "s"}` : "No changes"}</span>
            <span class="ds-grow"></span>
            <button class="ds-btn ds-btn--ghost" type="button" data-act="reset" disabled=${busy || !dirty} onClick=${() => setPatch({})}>Reset</button>
            <button class="ds-btn" type="button" data-act="copy" disabled=${busy} onClick=${duplicate}>Save as copy…</button>
            <button class="ds-btn ds-btn--primary" type="button" data-act="save" disabled=${busy || !dirty || entry?.builtin} onClick=${save}>Save</button>
          </div>
        </div>
      </section>
    </div>
  </div>`;
}
