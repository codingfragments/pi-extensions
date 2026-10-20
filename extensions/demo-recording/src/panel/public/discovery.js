import { html, useEffect, useState } from "/vendor/preact-htm.module.js";
import { Modal, media, post, screenUrl, useApi } from "./core.js";
import { CostHint } from "./cost.js";
import { errorToast, toast } from "./dialog.js";
import { AREA_WORDS, stallOf, stallWords } from "./discovery-core.js";
// demo-recording panel — Project → Discovery (item 10, D1; F1, F5): where discovery stands, how each session ended, and the way to
// start it, enhance it, or extend its budget without leaving the page. Discovery itself is the Director's work (it explores the app in
// a browser): Start and Enhance send it your notes, the areas you want covered and the budget you chose.

const EVENTS = /^(discovery|project|finding|input)\./;

const STATUS = {
  never: ["neutral", "○", "Not started"],
  running: ["info", "◔", "Running"],
  done: ["ok", "✓", "Done"],
  budget: ["warn", "!", "Budget used"],
  interrupted: ["warn", "!", "Cut off"],
};

const clock = (iso) =>
  iso && !iso.startsWith("1970")
    ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
    : "unknown time";

/** How one session ended, in a word and an icon (never colour alone). */
function ended(s, running) {
  if (running === s.id) return ["info", "◔", "running now"];
  if (s.exhausted) return ["warn", "!", "budget used up"];
  if (s.older) return ["neutral", "i", "older session: no budget recorded"];
  if (!s.closedAt) return ["warn", "!", "cut off before it closed"];
  return ["ok", "✓", "finished within the budget"];
}

const used = (value, limit) => (limit ? `${value} of ${limit}` : String(value));

function Sessions({ sessions, running }) {
  if (!sessions.length) return null;
  return html`<div class="ds-table-wrap"><table class="ds-table" aria-label="Discovery sessions">
    <thead><tr><th scope="col">Session</th><th scope="col">Started</th><th scope="col" class="ds-num">Screens</th><th scope="col" class="ds-num">Actions</th><th scope="col" class="ds-num">Minutes</th><th scope="col">How it ended</th></tr></thead>
    <tbody>${[...sessions].reverse().map((s) => {
      const [tone, icon, word] = ended(s, running);
      return html`<tr key=${s.id} data-session=${s.id}><th scope="row" class="mono">${s.id}</th><td>${clock(s.startedAt)}</td>
        <td class="ds-num">${used(s.screens, s.budgets?.discoveryScreens)}</td><td class="ds-num">${used(s.actions, s.budgets?.discoveryActions)}</td><td class="ds-num">${s.minutes === undefined ? "—" : used(s.minutes, s.budgets?.discoveryMinutes)}</td>
        <td><span class="ds-badge" data-tone=${tone}><span class="ds-badge-ico" aria-hidden="true">${icon}</span>${word}</span></td></tr>`;
    })}</tbody>
  </table></div>`;
}

/** Re-reads the clock while a session is open, so "no activity for 2 min" appears without any event. */
function useNow(on) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return undefined;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** "No activity for 2 min": a stalled session says so, as an icon and words and never as an error (the Director may be thinking). */
export function DiscoveryStall({ events }) {
  const open = events.some((e) => e.type === "discovery.opened");
  const now = useNow(open);
  const s = stallOf(events, now);
  if (!s) return null;
  return html`<p class="ds-small ds-stall" role="status" data-stall=${s.kind}><span class="ds-status" data-tone="warn" aria-hidden="true">◔</span> ${stallWords(s)}</p>`;
}

/** What the latest session has actually seen, per declared area. Marking an area done is a claim; looks and actions are the measure. */
function Areas({ measure, session }) {
  if (!measure?.planned || !measure.areas.length) return null;
  return html`<div class="ds-stack">
    <h3>Areas · session ${session}</h3>
    <div class="ds-table-wrap"><table class="ds-table" aria-label="What each area got">
      <thead><tr><th scope="col">Area</th><th scope="col">State</th><th scope="col" class="ds-num">Looks</th><th scope="col" class="ds-num">Actions</th></tr></thead>
      <tbody>${measure.areas.map((a) => {
        const [tone, icon, word] = AREA_WORDS[a.status] ?? AREA_WORDS.todo;
        return html`<tr key=${a.name} data-area=${a.name} data-area-status=${a.status}><th scope="row">${a.name}${a.routes.length ? html` <span class="ds-muted ds-small mono">${a.routes.join(" ")}</span>` : null}</th>
          <td><span class="ds-badge" data-tone=${tone}><span class="ds-badge-ico" aria-hidden="true">${icon}</span>${word}</span>${a.droppedWhy ? html` <span class="ds-muted ds-small">${a.droppedWhy}</span>` : null}</td>
          <td class="ds-num">${a.looks}</td><td class="ds-num">${a.acts}</td></tr>`;
      })}</tbody>
    </table></div>
    ${measure.unassigned.looks + measure.unassigned.acts ? html`<p class="ds-small ds-muted" data-unassigned>${measure.unassigned.looks} look${measure.unassigned.looks === 1 ? "" : "s"} and ${measure.unassigned.acts} action${measure.unassigned.acts === 1 ? "" : "s"} were on pages no area's route claims and no area was in hand.</p>` : null}
  </div>`;
}

const PRESET_WORD = { quick: "Quick", standard: "Standard", deep: "Deep" };

/** The window that asks the Director: notes, areas, the budget (a choice or the three numbers), and for an enhance which session it builds on. */
function AskModal({ mode, data, extend, onClose }) {
  const enhance = mode === "enhance";
  const start = extend?.budget ?? data.defaults;
  const [notes, setNotes] = useState("");
  const [areas, setAreas] = useState("");
  const [preset, setPreset] = useState(extend ? "custom" : "standard");
  const [b, setB] = useState({ ...start });
  const [base, setBase] = useState(extend?.base ?? data.sessions.at(-1)?.id ?? "");
  const [busy, setBusy] = useState(false);
  const choose = (p) => {
    setPreset(p);
    if (p !== "custom") setB({ ...data.presets[p] });
  };
  const num = (key, label, max) =>
    html`<label class="ds-field ds-disc-num"><span class="ds-label">${label}</span>
      <input class="ds-input" type="number" min="1" max=${max} step="1" value=${b[key]} data-budget=${key}
        onInput=${(e) => {
          setPreset("custom");
          setB({ ...b, [key]: e.target.value === "" ? "" : Number(e.target.value) });
        }} /></label>`;
  const ask = async () => {
    setBusy(true);
    try {
      await post("/api/discovery-start", {
        mode,
        notes,
        areas: areas.split("\n"),
        budget: b,
        preset,
        ...(enhance && base ? { base } : {}),
      });
      toast(
        `Asked the Director to ${enhance ? "enhance" : "start"} discovery. Follow it in the Activity drawer.`,
        { kind: "info" },
      );
      onClose();
    } catch (e) {
      errorToast(e, "discovery");
    } finally {
      setBusy(false);
    }
  };
  const footer = html`<button class="ds-btn" type="button" onClick=${onClose}>Cancel</button><button class="ds-btn ds-btn--primary" type="button" data-act="ask-discovery" disabled=${busy} onClick=${ask}>${enhance ? "Ask the Director to enhance" : "Ask the Director to start"}</button><${CostHint} />`;
  return html`<${Modal} title=${extend ? "Extend the budget and continue" : enhance ? "Enhance the discovery" : "Start discovery"} size="medium" onClose=${onClose} footer=${footer}>
    <div class="ds-stack ds-disc-form" data-mode=${extend ? "extend" : mode}>
      ${enhance ? html`<p class="ds-small ds-muted">A new session that builds on the earlier ones and the findings so far: it says what it adds and does not repeat what is covered.</p>` : html`<p class="ds-small ds-muted">The Director explores the app in a browser, records what it finds, and proposes a storyboard from the brief.</p>`}
      ${extend ? html`<div class="ds-notice" data-tone="warn" role="note"><span class="ds-status" data-tone="warn" aria-hidden="true">!</span><div>The last session ran out of budget, so the Director had to stop. The budget below is twice what it had.</div></div>` : null}
      <label class="ds-field"><span class="ds-label">${enhance ? "What should it look at now?" : "What should it keep in mind?"} <span class="ds-muted">(optional)</span></span>
        <textarea class="ds-textarea ds-textarea--compact" rows="3" maxlength="2000" data-field="notes" value=${notes} onInput=${(e) => setNotes(e.target.value)} placeholder="e.g. the checkout flow, what happens with an empty search"></textarea></label>
      <label class="ds-field"><span class="ds-label">Areas to cover <span class="ds-muted">(optional, one per line)</span></span>
        <textarea class="ds-textarea ds-textarea--compact" rows="3" data-field="areas" value=${areas} onInput=${(e) => setAreas(e.target.value)} placeholder=${"Search box\nCart and checkout"}></textarea>
        <span class="ds-hint-text">The Director declares them in its plan and covers each. Add more to the Sources & context group first if you have documents or links.</span></label>
      ${enhance && data.sessions.length > 1 ? html`<label class="ds-field"><span class="ds-label">Build on</span><select class="ds-select" data-field="base" value=${base} onChange=${(e) => setBase(e.target.value)}>${[...data.sessions].reverse().map((s) => html`<option value=${s.id} key=${s.id}>${s.id}${s.id === data.sessions.at(-1).id ? " (the newest)" : ""}</option>`)}</select></label>` : null}
      <fieldset class="ds-field ds-disc-budget"><legend class="ds-label">Budget</legend>
        <div class="ds-seg" role="group" aria-label="Budget choice">${["quick", "standard", "deep"].map((p) => html`<button type="button" key=${p} data-preset=${p} aria-pressed=${preset === p} onClick=${() => choose(p)}>${PRESET_WORD[p]}</button>`)}<button type="button" data-preset="custom" aria-pressed=${preset === "custom"} onClick=${() => setPreset("custom")}>Custom</button></div>
        <div class="ds-row-flex">${num("discoveryScreens", "Screens", 200)}${num("discoveryActions", "Actions", 800)}${num("discoveryMinutes", "Minutes", 120)}</div>
        <span class="ds-hint-text">The Director stops exploring when any of the three is used up. Standard is the Config value (${data.defaults.discoveryScreens} screens, ${data.defaults.discoveryActions} actions, ${data.defaults.discoveryMinutes} minutes).</span>
      </fieldset>
    </div>
  <//>`;
}

/** The Discovery group of the Project page. */
export function Discovery({ events }) {
  const { data, reload } = useApi("/api/discovery", events, EVENTS);
  const [ask, setAsk] = useState(null);
  if (!data) return html`<section class="card muted">loading…</section>`;
  const [tone, icon, word] = STATUS[data.status];
  const last = data.sessions.at(-1);
  const running = data.status === "running";
  const takeBack = async () => {
    try {
      await post("/api/discovery-cancel", {});
      reload();
    } catch (e) {
      errorToast(e, "discovery");
    }
  };
  const line = {
    never:
      "Discovery has not run yet. The Director explores the app and records what it finds before it writes a storyboard.",
    running: `Session ${data.running} is running. Its progress and the live picture are in the Activity drawer.`,
    done: `${data.sessions.length} session${data.sessions.length === 1 ? "" : "s"} · ${data.findings} finding${data.findings === 1 ? "" : "s"} so far. Enhance it to cover more.`,
    budget: `The last session (${last?.id}) used up its budget (${last?.screens} of ${last?.budgets?.discoveryScreens} screens, ${last?.actions} of ${last?.budgets?.discoveryActions} actions), so the Director had to stop exploring.`,
    interrupted: `Session ${last?.id} was cut off before it closed (pi may have stopped). What it saw is kept; enhance to continue.`,
  }[data.status];
  return html`<section class="card ds-discovery" aria-label="Discovery" data-status=${data.status}>
    <div class="ds-row-flex"><h2>Discovery</h2><span class="ds-badge" data-tone=${tone} data-status-word><span class="ds-badge-ico" aria-hidden="true">${icon}</span>${word}</span></div>
    <p>${line}</p>
    ${
      data.pending
        ? html`<div class="ds-notice" role="status" data-pending><span class="ds-status" data-tone="info" aria-hidden="true">◔</span><div>Waiting for the Director to pick up your ${data.pending.mode === "enhance" ? "enhance" : "start"} request (${data.pending.budget.discoveryScreens} screens, ${data.pending.budget.discoveryActions} actions, ${data.pending.budget.discoveryMinutes} minutes). <button class="ds-btn ds-btn--ghost ds-btn--sm" type="button" data-act="take-back" onClick=${takeBack}>Take it back</button></div></div>`
        : null
    }
    <div class="ds-row-flex">
      ${data.status === "never" ? html`<button class="ds-btn ds-btn--primary" type="button" data-act="start-discovery" disabled=${running} onClick=${() => setAsk({ mode: "start" })}>Start discovery</button>` : html`<button class="ds-btn ds-btn--primary" type="button" data-act="enhance-discovery" disabled=${running} onClick=${() => setAsk({ mode: "enhance" })}>Enhance…</button>`}
      ${data.extend && !running ? html`<button class="ds-btn" type="button" data-act="extend-budget" onClick=${() => setAsk({ mode: "enhance", extend: data.extend })}>Extend the budget…</button>` : null}
      <${CostHint} />
      ${running ? html`<span class="ds-why">A session is running: wait for it to finish.</span>` : null}
    </div>
    ${running ? html`<${DiscoveryStall} events=${events} />` : null}
    <${Areas} measure=${data.measure} session=${last?.id} />
    ${data.uncovered?.length && !running ? html`<div class="ds-notice" data-tone="warn" role="note" data-uncovered><span class="ds-status" data-tone="warn" aria-hidden="true">!</span><div><strong>Not seen yet:</strong> ${data.uncovered.join(", ")}. The storyboard is not written over these until the Director explores them or leaves them out on purpose with a reason.</div></div>` : null}
    <${Sessions} sessions=${data.sessions} running=${data.running} />
    ${ask ? html`<${AskModal} mode=${ask.mode} extend=${ask.extend} data=${data} onClose=${() => setAsk(null)} />` : null}
  </section>
  <${Report} events=${events} sessions=${data.sessions} running=${running} canAsk=${data.sessions.length > 0} />`;
}

const GUIDE = [
  ["useCases", "Use cases"],
  ["mustShow", "Must show"],
  ["risks", "Risks"],
  ["avoid", "Avoid"],
];

/** An evidence id as a link where there is somewhere to go: a screen opens its picture, a source its file or link. */
function Evidence({ id }) {
  const link = (href, label, title) =>
    html`<a class="ds-chip ds-evidence" href=${href} target="_blank" rel="noopener noreferrer" title=${title} data-evidence=${id}>${label}</a>`;
  if (/^f-\d+$/.test(id))
    return html`<a class="ds-chip ds-evidence" href=${"#/project?group=findings"} title="open the findings" data-evidence=${id}>${id}</a>`;
  if (/^[\w-]+\/s\d+$/.test(id)) return link(screenUrl(id), id, "open the screen discovery saw");
  if (id.startsWith("file:"))
    return link(media("project", id.slice(5)), id.slice(5), "open the source file");
  if (id.startsWith("ref:"))
    return link(id.slice(4), id.slice(4).replace(/^https?:\/\//, ""), "open the link");
  return html`<span class="ds-chip ds-evidence" data-evidence=${id}>${id}</span>`;
}

const Chips = ({ ids }) =>
  html`<span class="ds-evidence-list">${ids.map((e) => html`<${Evidence} id=${e} key=${e} />`)}</span>`;

/** The discovery report (D2, F2): what it found, what the sources added, the guidance for the storyboard. Every claim carries its evidence. */
function Report({ events, sessions, running, canAsk }) {
  const [version, setVersion] = useState(null);
  const { data, reload } = useApi(
    `/api/discovery-report${version ? `?version=${version}` : ""}`,
    events,
    /^discovery\./,
  );
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  const r = data.report;
  const ask = async () => {
    setBusy(true);
    try {
      await post("/api/discovery-report-ask", {});
      toast("Asked the Director to write the report. It appears here when it is done.", {
        kind: "info",
      });
      reload();
    } catch (e) {
      errorToast(e, "report");
    } finally {
      setBusy(false);
    }
  };
  const asking = html`<div class="ds-row-flex"><button class="ds-btn ${r ? "" : "ds-btn--primary"}" type="button" data-act="ask-report" disabled=${busy || !canAsk || running} onClick=${ask}>${r ? "Ask the Director to update the report" : "Ask the Director to write the report"}</button><${CostHint} />${!canAsk ? html`<span class="ds-why">Run a discovery first.</span>` : running ? html`<span class="ds-why">A session is running: the report comes when it has finished.</span>` : null}</div>`;
  if (!r)
    return html`<section class="card ds-report" aria-label="Discovery report" data-report="none"><h2>Report</h2>
      <p class="ds-muted">No report yet. At the end of a discovery the Director writes one: what it found about the app, what your sources added, and the guidance for the storyboard, each claim with its evidence.</p>${asking}</section>`;
  const last = r.coverage.sessions.at(-1);
  return html`<section class="card ds-report" aria-label="Discovery report" data-report=${r.version}>
    <div class="ds-row-flex"><h2>Report v${r.version}</h2>
      ${data.versions.length > 1 ? html`<label class="ds-small"><span class="ds-sr-only">Version</span><select class="ds-select" aria-label="Report version" data-field="report-version" value=${r.version} onChange=${(e) => setVersion(Number(e.target.value))}>${[...data.versions].reverse().map((v) => html`<option value=${v} key=${v}>v${v}${v === data.versions.at(-1) ? " (newest)" : ""}</option>`)}</select></label>` : null}
      <span class="ds-muted ds-small">${new Date(r.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span></div>
    ${data.newer.length ? html`<div class="ds-notice" data-tone="warn" role="note" data-newer><span class="ds-status" data-tone="warn" aria-hidden="true">!</span><div>${data.newer.length} discovery session${data.newer.length === 1 ? "" : "s"} ran after this report (${data.newer.join(", ")}): it does not know about ${data.newer.length === 1 ? "it" : "them"}. Ask the Director to update it.</div></div>` : null}
    <p data-part="summary">${r.summary}</p>
    <h3>What it found about the app</h3>
    <ul class="ds-report-list" data-part="found">${r.found.map((x, i) => html`<li key=${i}>${x.text} <${Chips} ids=${x.evidence} /></li>`)}</ul>
    ${r.research.length ? html`<h3>What your sources added</h3><ul class="ds-report-list" data-part="research">${r.research.map((x, i) => html`<li key=${i}>${x.text} <${Chips} ids=${x.evidence} /></li>`)}</ul>` : null}
    <h3>Guidance for the storyboard</h3>
    ${GUIDE.filter(([k]) => r.guidance[k].length).map(([k, label]) => html`<div class="ds-report-group" data-guide=${k} key=${k}><h4>${label}</h4><ul class="ds-report-list">${r.guidance[k].map((x, i) => html`<li key=${i}><strong>${x.title}</strong> <span class="ds-muted">${x.why}</span> <${Chips} ids=${x.evidence} /></li>`)}</ul></div>`)}
    ${last ? html`<p class="ds-small ds-muted" data-part="coverage"><strong>Coverage, counted by the engine:</strong> ${last.areas.filter((a) => a.looks > 0).length} of ${last.areas.length} areas seen in session ${last.id}${last.areas.some((a) => a.status === "dropped") ? `, ${last.areas.filter((a) => a.status === "dropped").length} left out on purpose` : ""} · ${r.coverage.findings} finding${r.coverage.findings === 1 ? "" : "s"} · ${r.coverage.sources.files + r.coverage.sources.refs} source${r.coverage.sources.files + r.coverage.sources.refs === 1 ? "" : "s"}.</p>` : null}
    ${asking}
  </section>`;
}
