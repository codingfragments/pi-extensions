// Config page prototype (UX0): settings search with both scopes visible, effective source,
// explicit edit scope and shadowing warnings. Fixture data uses the real setting keys, labels
// and groups. UX9 builds the real thing on GET /api/config.
(() => {
  const GROUPS = [
    ["voice", "Voice (TTS)"],
    ["models", "Models"],
    ["recording", "Recording & capture"],
    ["output", "Output & look"],
    ["annotations", "Annotations"],
    ["discovery", "Discovery budgets"],
    ["general", "General"],
  ];
  const FILES = {
    global: "~/.config/demo-recording/config.json",
    project: "~/DemoRecordings/projects/keycraft/config.json",
  };
  // value = effective; layers: default / global / project / env (null = not set)
  const S = [
    {
      key: "ttsChain",
      label: "TTS chain",
      group: "voice",
      doc: "Voice engines in priority order (elevenlabs | openai | kokoro | say); one engine per video.",
      value: ["say"],
      source: "env",
      envVar: "DEMO_REC_TTS_CHAIN",
      layers: {
        default: ["elevenlabs", "openai", "kokoro"],
        global: ["elevenlabs", "say"],
        project: null,
        env: ["say"],
      },
    },
    {
      key: "voiceName",
      label: "Voice name",
      group: "voice",
      doc: "ElevenLabs voice display name (exact, then prefix) or voice id. A project's brief “Voice:” wins.",
      value: "Stefan_trained",
      source: "global",
      layers: { default: "", global: "Stefan_trained", project: null, env: null },
    },
    {
      key: "tts.elevenlabs.model",
      label: "ElevenLabs · Model",
      group: "voice",
      doc: "ElevenLabs model used for synthesis and timestamps.",
      value: "eleven_v4",
      source: "default",
      layers: { default: "eleven_v4", global: null, project: null, env: null },
    },
    {
      key: "tts.elevenlabs.fallbackModel",
      label: "ElevenLabs · Fallback model",
      group: "voice",
      doc: "Used when the account rejects the main model for the timestamp endpoint.",
      value: "eleven_multilingual_v2",
      source: "default",
      layers: { default: "eleven_multilingual_v2", global: null, project: null, env: null },
    },
    {
      key: "improvise.models",
      label: "Operator · Models",
      group: "models",
      doc: "The Operator's model: fast-model chain (provider/id) for live improvised inputs.",
      value: ["anthropic/claude-haiku-4-5", "openai/gpt-5-mini"],
      source: "global",
      layers: {
        default: ["anthropic/claude-haiku-4-5"],
        global: ["anthropic/claude-haiku-4-5", "openai/gpt-5-mini"],
        project: null,
        env: null,
      },
    },
    {
      key: "roles.annotationDesigner.model",
      label: "Annotation designer · Model",
      group: "models",
      doc: "Run the Annotation designer as one call on this model instead of an agent turn. Unset = the agent turn.",
      value: null,
      source: "unset",
      layers: { default: null, global: null, project: null, env: null },
    },
    {
      key: "align.model",
      label: "Alignment · Model",
      group: "models",
      doc: "Whisper model used to align narration to audio.",
      value: "base.en",
      source: "default",
      layers: { default: "base.en", global: null, project: null, env: null },
    },
    {
      key: "viewport.width",
      label: "Viewport · Width",
      group: "recording",
      doc: "Browser viewport width in CSS px.",
      value: 1600,
      source: "default",
      layers: { default: 1600, global: null, project: null, env: null },
    },
    {
      key: "viewport.height",
      label: "Viewport · Height",
      group: "recording",
      doc: "Browser viewport height in CSS px.",
      value: 900,
      source: "default",
      layers: { default: 900, global: null, project: null, env: null },
    },
    {
      key: "viewport.dpr",
      label: "Viewport · DPR",
      group: "recording",
      doc: "Device pixel ratio for capture (2 → 3200×1800 frames at 1600×900).",
      value: 2,
      source: "default",
      layers: { default: 2, global: null, project: null, env: null },
    },
    {
      key: "recording.maxRetriesPerScene",
      label: "Recording · Max retries per scene",
      group: "recording",
      doc: "Retries per failing scene (0..5).",
      value: 3,
      source: "project",
      layers: { default: 2, global: null, project: 3, env: null },
    },
    {
      key: "output.width",
      label: "Output · Width",
      group: "output",
      doc: "Rendered video width.",
      value: 1920,
      source: "default",
      layers: { default: 1920, global: null, project: null, env: null },
    },
    {
      key: "fps",
      label: "FPS",
      group: "output",
      doc: "Output frame rate.",
      value: 30,
      source: "default",
      layers: { default: 30, global: null, project: null, env: null },
    },
    {
      key: "brand",
      label: "Brand",
      group: "output",
      doc: "Default brand package for renders. A render can pick another.",
      value: "acme",
      source: "project",
      layers: { default: "neutral", global: "neutral", project: "acme", env: null },
    },
    {
      key: "annotations.autoSuggest",
      label: "Annotations · Auto suggest",
      group: "annotations",
      doc: "Suggest annotations automatically after the voice edit.",
      value: true,
      source: "default",
      layers: { default: true, global: null, project: null, env: null },
    },
    {
      key: "budgets.discoveryActions",
      label: "Discovery · Actions",
      group: "discovery",
      doc: "Maximum browser actions during one discovery session.",
      value: 150,
      source: "default",
      layers: { default: 150, global: null, project: null, env: null },
    },
    {
      key: "root",
      label: "Root",
      group: "general",
      doc: "Working directory holding apps/ and projects/ (~ is expanded).",
      value: "~/DemoRecordings",
      source: "global",
      globalOnly: true,
      layers: { default: "~/DemoRecordings", global: "~/DemoRecordings", project: null, env: null },
    },
    {
      key: "panelPort",
      label: "Panel port",
      group: "general",
      doc: "Preferred side-panel port (next free port if taken).",
      value: 4317,
      source: "default",
      layers: { default: 4317, global: null, project: null, env: null },
    },
  ];
  const API_KEYS = [
    ["ELEVENLABS_API_KEY", true],
    ["OPENAI_API_KEY", false],
  ];
  const PROJECT = "keycraft";

  const esc = (s) =>
    String(s).replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
    );
  const show = (v) =>
    v === null || v === undefined ? "Not set" : Array.isArray(v) ? v.join(", ") : String(v);
  const SRC = {
    env: ["warn", "Environment"],
    project: ["accent", "Project"],
    global: ["info", "Global"],
    default: ["neutral", "Default"],
    unset: ["neutral", "Not set"],
  };

  const params = new URLSearchParams(location.search);
  const state = {
    q: params.get("q") ?? "",
    open: new Set((params.get("open") ?? "").split(",").filter(Boolean)),
    edit: params.get("edit")
      ? { key: params.get("edit"), scope: params.get("scope") ?? "global" }
      : null,
    collapsed: new Set(),
    noProject: params.get("project") === "none",
  };
  const root = document.querySelector(".ds-cfg-root");
  const q = (sel) => root.querySelector(sel);

  const mark = (text, query) => {
    const t = String(text);
    const n = query.trim();
    if (!n) return esc(t);
    const i = t.toLowerCase().indexOf(n.toLowerCase());
    return i < 0
      ? esc(t)
      : `${esc(t.slice(0, i))}<mark class="ds-mark">${esc(t.slice(i, i + n.length))}</mark>${esc(t.slice(i + n.length))}`;
  };
  const matches = (s, query) => {
    const n = query.trim().toLowerCase();
    if (!n) return true;
    const hay = [s.key, s.label, s.doc, show(s.value), ...Object.values(s.layers).map(show)]
      .join(" ")
      .toLowerCase();
    return hay.includes(n);
  };
  const badge = (tone, label) => `<span class="ds-badge" data-tone="${tone}">${label}</span>`;

  function scopeRows(s) {
    const noProj = state.noProject || s.globalOnly;
    const why = state.noProject ? "Open a project to override" : "Global only";
    const edit = (scope, label) =>
      `<button class="ds-btn ds-btn--sm" type="button" data-edit="${s.key}" data-scope="${scope}">${label}</button>`;
    return `
      <div class="ds-scope"><span>Environment</span><span>${s.envVar ? `<code>${s.envVar}</code> = ${esc(show(s.layers.env))}` : '<span class="ds-muted">Not set</span>'}</span><span class="ds-muted ds-small">${s.layers.env ? "read-only, wins over both files" : "read-only"}</span></div>
      <div class="ds-scope"><span>Project override</span><span>${esc(show(s.layers.project))}</span>${noProj ? `<button class="ds-btn ds-btn--sm" type="button" aria-disabled="true" aria-describedby="why-${s.key}">${s.layers.project === null ? "Override for this project" : "Edit project"}</button><span class="ds-why" id="why-${s.key}">${why}</span>` : edit("project", s.layers.project === null ? "Override for this project" : "Edit project")}</div>
      <div class="ds-scope"><span>Global value</span><span>${esc(show(s.layers.global))}</span>${edit("global", "Edit global")}</div>
      <div class="ds-scope"><span>Default</span><span>${esc(show(s.layers.default))}</span><span class="ds-muted ds-small">built in</span></div>`;
  }

  function row(s) {
    const [tone, name] = SRC[s.source];
    const editing = state.edit?.key === s.key;
    const open = state.open.has(s.key) || editing;
    const shadow =
      s.layers.env && editing && state.edit.scope
        ? `<div class="ds-notice" data-tone="warn"><span class="ds-status" data-tone="warn" aria-hidden="true">!</span><div>This change has no effect right now: it is overridden by the environment variable <code>${s.envVar}</code>.</div></div>`
        : "";
    const target = editing ? (state.edit.scope === "project" ? FILES.project : FILES.global) : "";
    return `<div class="ds-srow" data-key="${s.key}" ${editing ? 'data-edit="true"' : ""}>
      <div class="ds-srow-main"><div class="ds-srow-title"><h4>${mark(s.label, state.q)}</h4><code>${mark(s.key, state.q)}</code></div><p class="ds-small ds-muted">${mark(s.doc, state.q)}</p></div>
      <div class="ds-srow-value"><strong>${mark(show(s.value), state.q)}</strong><span>${s.source === "unset" ? "" : badge(tone, name)}${s.layers.env && s.source !== "env" ? badge("warn", "Environment set") : ""}${s.source !== "project" && s.layers.project !== null ? badge("accent", "Project override") : ""}</span></div>
      <button class="ds-btn ds-btn--sm" type="button" data-toggle="${s.key}" aria-expanded="${open}">${open ? "Hide scopes" : "Scopes"}</button>
      ${
        editing
          ? `<div class="ds-srow-edit">
          <div class="ds-field"><label class="ds-label" for="edit-${s.key}">Editing the ${state.edit.scope === "project" ? `project override (${PROJECT})` : "global value"}</label>
            <input class="ds-input" id="edit-${s.key}" value="${esc(show(s.layers[state.edit.scope] ?? s.value))}" style="max-inline-size:24rem" />
            <span class="ds-hint-text">Saved to <code>${target}</code> after you review the change. ${state.edit.scope === "global" ? "Applies to every project unless one overrides it." : "Applies to this project only."}</span></div>
          ${shadow}
          <div class="ds-row-flex"><button class="ds-btn ds-btn--primary" type="button">Review change…</button><button class="ds-btn" type="button" data-cancel>Cancel</button></div>
        </div>`
          : ""
      }
      ${open && !editing ? `<div class="ds-srow-panel" role="group" aria-label="${esc(s.label)} by scope">${scopeRows(s)}</div>` : ""}
    </div>`;
  }

  function render() {
    const query = state.q;
    const byGroup = GROUPS.map(([id, label]) => ({
      id,
      label,
      all: S.filter((s) => s.group === id),
      hits: S.filter((s) => s.group === id && matches(s, query)),
    }));
    const total = byGroup.reduce((n, g) => n + g.hits.length, 0);
    const groupsHit = byGroup.filter((g) => g.hits.length).length;
    const searching = query.trim() !== "";
    q(".ds-cfg-status").textContent = searching
      ? `${total} setting${total === 1 ? "" : "s"} in ${groupsHit} group${groupsHit === 1 ? "" : "s"} match “${query.trim()}”`
      : `${S.length} settings`;
    q(".ds-cfg-nav").innerHTML = byGroup
      .map(
        (g) =>
          `<a href="#g-${g.id}" data-empty="${searching && !g.hits.length}" ${g.id === (byGroup.find((x) => x.hits.length)?.id ?? "voice") ? 'aria-current="true"' : ""}>${esc(g.label)}<span class="ds-cfg-count">${searching ? `${g.hits.length}/${g.all.length}` : g.all.length}</span></a>`,
      )
      .join("");
    const visible = byGroup.filter((g) => g.hits.length);
    const hiddenGroups = byGroup.filter((g) => !g.hits.length);
    q(".ds-cfg-groups").innerHTML =
      total === 0
        ? `<div class="ds-card"><div class="ds-state"><div class="ds-state-ico" aria-hidden="true">⌕</div><h3>No settings match “${esc(query.trim())}”</h3><p>Search looks at names, keys, descriptions and current values. Secrets are never searched.</p><button class="ds-btn" type="button" data-clear>Clear search</button></div></div>`
        : visible
            .map((g) => {
              const open = searching || !state.collapsed.has(g.id);
              return `<section class="ds-group" id="g-${g.id}" aria-labelledby="gh-${g.id}"><button class="ds-group-head" id="gh-${g.id}" type="button" data-group="${g.id}" aria-expanded="${open}"><span class="ds-group-chev" aria-hidden="true">${open ? "▾" : "▸"}</span>${esc(g.label)}<span class="ds-cfg-count">${searching ? `${g.hits.length} of ${g.all.length}` : g.all.length}</span></button>${open ? g.hits.map(row).join("") : ""}</section>`;
            })
            .join("") +
          (searching && hiddenGroups.length
            ? `<p class="ds-small ds-muted">${hiddenGroups.length} group${hiddenGroups.length === 1 ? " has" : "s have"} no match: ${hiddenGroups.map((g) => esc(g.label)).join(", ")}.</p>`
            : "");
    q(".ds-cfg-clear").hidden = !searching;
  }

  root.addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.toggle) {
      state.open.has(t.dataset.toggle)
        ? state.open.delete(t.dataset.toggle)
        : state.open.add(t.dataset.toggle);
    } else if (t.dataset.edit) state.edit = { key: t.dataset.edit, scope: t.dataset.scope };
    else if ("cancel" in t.dataset) state.edit = null;
    else if (t.dataset.group)
      state.collapsed.has(t.dataset.group)
        ? state.collapsed.delete(t.dataset.group)
        : state.collapsed.add(t.dataset.group);
    else if ("clear" in t.dataset || t.classList.contains("ds-cfg-clear")) {
      state.q = "";
      q(".ds-input").value = "";
    } else return;
    render();
  });
  const input = q(".ds-input");
  input.addEventListener("input", () => {
    state.q = input.value;
    render();
  });
  document.addEventListener("keydown", (e) => {
    const editable =
      /input|textarea|select/i.test(document.activeElement?.tagName ?? "") ||
      document.activeElement?.isContentEditable;
    const dialogOpen = document.querySelector("dialog[open]");
    if (dialogOpen) return;
    if ((e.key === "/" && !editable) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")) {
      e.preventDefault();
      input.focus();
      input.select();
    }
    if (e.key === "Escape" && document.activeElement === input && input.value) {
      e.preventDefault();
      state.q = "";
      input.value = "";
      render();
    }
  });
  q(".ds-cfg-keys-list").innerHTML = API_KEYS.map(
    ([n, set]) =>
      `<span class="ds-badge" data-tone="${set ? "ok" : "neutral"}"><span class="ds-badge-ico" aria-hidden="true">${set ? "✓" : "○"}</span>${n}: ${set ? "set" : "not set"}</span>`,
  ).join(" ");
  q(".ds-cfg-project").innerHTML = state.noProject
    ? `<span class="ds-status" data-tone="info" aria-hidden="true">i</span><span>No project is open, so only global values can be edited. Project overrides are shown for open projects.</span>`
    : `<span class="ds-status" data-tone="accent" aria-hidden="true">●</span><span>Project <strong style="color:var(--text-strong)">${PROJECT}</strong> is open: you can override a setting for it. ${S.filter((s) => s.layers.project !== null).length} overrides today.</span>`;
  input.value = state.q;
  render();
})();
