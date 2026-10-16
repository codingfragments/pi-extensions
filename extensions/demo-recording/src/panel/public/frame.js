import { html, useLayoutEffect, useRef, useState } from "/vendor/preact-htm.module.js";
import { JOB_TITLE, STEPS } from "./frame-state.js";
// The control room's frame (UX2, D98–D101): the header with the stepper, the next-action band,
// the status strip and the Activity drawer. What they say is decided in frame-state.js; this file
// draws it with the design-system components (ds/components.css).
//
// Rules: results that arrive never move you (they put a badge on a step); the strip is one short line;
// the drawer opens only when you ask, overlays instead of squeezing the page, and never opens by itself,
// not even on an error.
import { showShortcuts } from "./keys.js";
import { FramePreview, FullLogModal, Log, LogLineModal, ProgressRows, Safety } from "./live.js";
import { formatRoute } from "./route.js";

const GLYPH = { complete: "✓", needs: "●", running: "▶", blocked: "!", upcoming: "○" };
const WORDS = {
  complete: "complete",
  needs: "needs you",
  running: "running",
  blocked: "blocked",
  upcoming: "not started",
};

const THEME_KEY = "demo-rec-theme";

export function ThemeToggle() {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme || "macchiato");
  const next = theme === "macchiato" ? "latte" : "macchiato";
  const flip = () => {
    document.documentElement.dataset.theme = next;
    localStorage.setItem(THEME_KEY, next);
    setTheme(next);
  };
  return html`<button class="ds-btn ds-btn--ghost theme-toggle" type="button" title=${`Switch to ${next === "latte" ? "Latte (light)" : "Macchiato (dark)"}`} onClick=${flip}>
    ${theme === "macchiato" ? "☾ Macchiato" : "☀ Latte"}
  </button>`;
}

const closeOnEscape = (e) => {
  if (e.key === "Escape") e.currentTarget.removeAttribute("open");
};

/** The next-action band: what needs you (or is blocked) and where to go. Navigation only, never an action. */
export function NextBand({ band }) {
  if (!band) return null;
  const icon = { needs: "●", blocked: "!", done: "✓", idle: "○" }[band.tone];
  const iconTone = { needs: "accent", blocked: "err", done: "ok", idle: undefined }[band.tone];
  return html`<div class="ds-next" data-tone=${band.tone} role="region" aria-label="Next step" title=${band.title ?? ""}>
    <span class="ds-status" data-tone=${iconTone} aria-hidden="true">${icon}</span>
    <span class="ds-next-label">${band.label}</span>
    <span class="ds-next-text">${band.text}</span>
    <span class="ds-grow"></span>
    ${
      band.more.length
        ? html`<details class="ds-menu" onKeyDown=${closeOnEscape}>
            <summary>${band.more.length} other item${band.more.length === 1 ? "" : "s"} need${band.more.length === 1 ? "s" : ""} you</summary>
            <ul>${band.more.map((m) => html`<li key=${m.tab}><a href=${formatRoute({ screen: m.tab })}>${m.text}</a></li>`)}</ul>
          </details>`
        : null
    }
    ${band.map ? html`<a class="ds-btn ds-btn--ghost band-map" href=${formatRoute({ screen: "map", query: { sel: band.map, focus: "1" } })}>Show in map</a>` : null}
    ${band.action ? html`<a class="ds-btn ds-btn--primary" href=${formatRoute({ screen: band.action.tab })}>${band.action.label}</a>` : null}
  </div>`;
}

/** Header: the project, the five production stages with their state, Config and the theme. */
export function Header({ slug, tab, states, news, band }) {
  return html`<div class="ds-hwrap">
    <header class="top ds-header">
      <span class="ds-brand">demo-recording${slug ? html` <span class="ds-brand-sub ds-muted ds-small">${slug}</span>` : null}</span>
      <a class="ds-step ds-step--plain" href="#/project" aria-current=${tab === "project" ? "page" : undefined}><span class="ds-step-label">Project</span></a>
      <nav class="steps" aria-label="Production stages" style="flex:1;min-inline-size:0">
        <ol class="ds-steps">
          ${STEPS.map((step) => {
            const st = states[step.tab] ?? { state: "upcoming", why: "" };
            const here = tab === step.tab;
            const fresh = news.has(step.tab) && !here;
            return html`<li key=${step.tab}>
              <a class="ds-step" href=${formatRoute({ screen: step.tab })} data-state=${st.state} data-tab=${step.tab}
                aria-current=${here ? "step" : undefined} title=${st.why || step.label}>
                <span class="ds-step-dot" aria-hidden="true">${GLYPH[st.state]}</span>
                <span class="ds-step-label">${step.label}</span>
                ${fresh ? html`<span class="ds-badge" data-tone="accent">new</span>` : null}
                <span class="ds-sr-only"> — ${WORDS[st.state]}${fresh ? ", new result" : ""}</span>
              </a>
            </li>`;
          })}
        </ol>
      </nav>
      <span class="ds-header-tools">
        <a class="ds-btn ds-btn--ghost map-link" href="#/map" aria-haspopup="dialog" title="The project map: every version and what depends on what">◇ Map</a>
        <a class="ds-btn ds-btn--ghost config-btn" href="#/config" aria-current=${tab === "config" ? "page" : undefined} title="Settings and brands (not a process step)">⚙ Config</a>
        <button class="ds-btn ds-btn--ghost ds-btn--icon" type="button" data-act="shortcuts" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick=${showShortcuts}>?</button>
        <${ThemeToggle} />
      </span>
    </header>
    <${NextBand} band=${band} />
  </div>`;
}

/** The status strip: one short line. Progress shows only when it is known. */
export function ActivityStrip({ strip, status, open, onToggle, buttonRef }) {
  const iconTone = { err: "err", running: "info", warn: "warn", idle: "ok" }[strip.tone];
  const icon = { err: "!", running: "▶", warn: "!", idle: "✓" }[strip.tone];
  // The visible line changes with every progress tick; screen readers hear only what changes meaning.
  const announce = strip.tone === "running" ? strip.text.replace(/\s\d+%/g, "") : strip.text;
  return html`<div class="ds-strip" data-tone=${strip.tone}>
    <span class="ds-status" data-tone=${iconTone} aria-hidden="true">${icon}</span>
    <span class="strip-text">${strip.text}</span>
    ${
      strip.progress !== null
        ? html`<span class="ds-progress" role="progressbar" aria-label="progress" aria-valuenow=${strip.progress} aria-valuemin="0" aria-valuemax="100"><span style=${`inline-size:${strip.progress}%`}></span></span><span class="ds-muted ds-xs">${strip.progress}%</span>`
        : null
    }
    ${strip.failure ? html`<button class="ds-btn ds-btn--sm" type="button" onClick=${() => onToggle(true)}>Show error</button>` : null}
    <span class="ds-grow"></span>
    <span class="ds-muted ds-xs strip-conn"><span class="ds-status" data-tone=${status === "live" ? "ok" : "warn"} aria-hidden="true">●</span> ${status === "live" ? "connected" : status}</span>
    <button ref=${buttonRef} class="ds-btn ds-btn--sm" type="button" aria-expanded=${open} aria-controls="activity" onClick=${() => onToggle()}>Activity ${open ? "↓" : "↑"}</button>
    <span class="ds-sr-only" role="status">${announce}</span>
  </div>`;
}

const ago = (t) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 90
    ? `${s}s ago`
    : s < 5400
      ? `${Math.round(s / 60)} min ago`
      : `${Math.round(s / 3600)} h ago`;
};

function JobList({ jobs, dismissed, onDismiss }) {
  const failed = jobs.filter((j) => j.status === "failed" && !dismissed.has(j.id));
  const recent = jobs.filter((j) => j.status !== "running" && !failed.includes(j)).slice(0, 6);
  return html`${
    failed.length
      ? html`<section class="ds-stack" aria-label="Needs attention"><h3>Needs attention</h3>
          ${failed.map(
            (j) => html`<div class="ds-notice" data-tone="err" key=${j.id}>
              <span class="ds-status" data-tone="err" aria-hidden="true">!</span>
              <div class="ds-grow"><strong>${JOB_TITLE[j.kind] ?? j.kind} failed</strong> <span class="ds-muted ds-xs">${ago(j.finishedAt ?? j.startedAt)}</span>
                ${j.error ? html`<details><summary class="ds-small">Details</summary><pre class="ds-raw" style="white-space:pre-wrap">${j.error}</pre></details>` : null}
              </div>
              <button class="ds-btn ds-btn--sm" type="button" onClick=${() => onDismiss(j.id)}>Dismiss</button>
            </div>`,
          )}</section>`
      : null
  }
  ${
    recent.length
      ? html`<section class="ds-stack" aria-label="Recent jobs"><h3>Recent</h3>
          <ul class="ds-checklist">${recent.map(
            (j) => html`<li class="ds-iconrow" key=${j.id}>
              <span class="ds-status" data-tone=${j.status === "done" ? "ok" : j.status === "failed" ? "err" : undefined} aria-hidden="true">${j.status === "done" ? "✓" : j.status === "failed" ? "!" : "–"}</span>
              <span class="ds-grow">${JOB_TITLE[j.kind] ?? j.kind} · ${j.status}${j.status === "failed" ? " (dismissed)" : ""} <span class="ds-muted ds-xs">${ago(j.finishedAt ?? j.startedAt)}</span></span>
            </li>`,
          )}</ul></section>`
      : null
  }`;
}

/**
 * The Activity drawer: a non-modal overlay on the right. It opens only on request, takes the focus
 * when it opens, gives it back to the strip's button when it closes, and Escape closes it (unless a
 * dialog or popup is on top, which then closes first).
 */
export function ActivityDrawer({
  open,
  onClose,
  events,
  rows,
  jobs,
  dismissed,
  onDismiss,
  buttonRef,
}) {
  const box = useRef(null);
  const [fullLog, setFullLog] = useState(false);
  const [line, setLine] = useState(null);
  // A layout effect: the focus and the Escape handler must be in place the moment the drawer shows.
  useLayoutEffect(() => {
    if (!open) return;
    box.current?.focus();
    const onKey = (e) => {
      if (e.key !== "Escape" || document.querySelector(".modal-backdrop")) return;
      if (
        !box.current?.contains(document.activeElement) &&
        document.activeElement !== document.body
      )
        return; // the key belongs to something outside the drawer
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (box.current?.contains(document.activeElement) || document.activeElement === document.body)
        buttonRef.current?.focus();
    };
  }, [open]);
  const recording = rows.some((r) => r.key === "take" && r.state === "running");
  return html`<aside class="ds-drawer" id="activity" aria-label="Activity" tabindex="-1" hidden=${!open} ref=${box}>
    ${
      open
        ? html`<div class="ds-drawer-head"><h2>Activity</h2><span class="ds-grow"></span>
            <button class="ds-btn ds-btn--ghost ds-btn--icon" type="button" aria-label="Close activity" onClick=${onClose}>×</button></div>
          <div class="ds-drawer-body">
            <section class="ds-stack" aria-label="Running"><h3>Running</h3><${ProgressRows} rows=${rows} /></section>
            <${JobList} jobs=${jobs} dismissed=${dismissed} onDismiss=${onDismiss} />
            <section class="ds-stack" aria-label="Preview"><h3>Preview</h3><${FramePreview} events=${events} recording=${recording} /></section>
            <section class="ds-stack" aria-label="Safety"><h3>Safety</h3><${Safety} events=${events} /></section>
            <section class="ds-stack log-section" aria-label="Log">
              <div class="ds-row-flex"><h3>Log</h3><span class="ds-grow"></span>
                <button class="ds-btn ds-btn--sm log-head" type="button" title="open the full log (80 % of the window)" onClick=${() => setFullLog(true)}>Full log <span aria-hidden="true">⤢</span></button></div>
              <${Log} events=${events} onPick=${setLine} />
            </section>
          </div>
          ${fullLog ? html`<${FullLogModal} events=${events} onClose=${() => setFullLog(false)} onPick=${setLine} />` : null}
          ${line ? html`<${LogLineModal} e=${line} onClose=${() => setLine(null)} />` : null}`
        : null
    }
  </aside>`;
}

/** The title of a stage screen (UX2: used by the Recording tab; the other screens follow in their slices). */
export function StageTitle({ title, meta, children }) {
  return html`<div class="ds-root ds-stagehead">
    <div class="ds-grow"><h1>${title}</h1>${meta ? html`<div class="ds-stagehead-meta">${meta}</div>` : null}</div>
    ${children ?? null}
  </div>`;
}
