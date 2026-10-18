// "Checks of <stage> vN" (P1a Q1b, F32): ONE popup for the findings of any stage version, reused by every stage
// screen. Today it reads the render's QA (GET /api/checks); the other stages' adapters fill the same shape later.
// Read-only for now: Fix / Ignore / Leave and the ignored list come with the flag-and-propose loop.
import { html, useEffect, useState } from "/vendor/preact-htm.module.js";
import { api } from "./core.js";
import { ask } from "./dialog.js";

const STAGE_NAME = {
  storyboard: "storyboard",
  recording: "recording",
  vo: "voice-over",
  annotations: "annotations",
  render: "render",
};

const clock = (ms) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

function Group({ title, tone, items, open = true }) {
  if (!items.length) return null;
  const list = html`<ul class="qa-list">${items.map(
    (f) => html`<li class=${`qa-item ${f.level}`} key=${f.id}>
      <div class="row">${f.atMs !== undefined ? html`<span class="time small-text muted">${clock(f.atMs)}</span>` : null}<span class="qa-msg">${f.message}</span></div>
      ${f.moments?.length > 1 ? html`<p class="small-text muted">at ${f.moments.map(clock).join(", ")}</p>` : null}
      ${f.confirmed ? html`<p class="small-text muted">✔ confirmed: “${f.confirmed.reason}”</p>` : null}
    </li>`,
  )}</ul>`;
  return open
    ? html`<section class="checks-group" data-tone=${tone}><h3 class="qa-head">${title} <span class="ds-badge" data-tone=${tone}>${items.length}</span></h3>${list}</section>`
    : html`<details class="checks-group" data-tone=${tone}><summary class="small-text muted">${title} (${items.length})</summary>${list}</details>`;
}

function ChecksBody({ stage, version }) {
  const [view, setView] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    api(`/api/checks?stage=${stage}&version=${version}`).then(setView, (e) => setErr(e.message));
  }, [stage, version]);
  if (err)
    return html`<div class="ds-notice" data-tone="err" role="alert"><span class="ds-status" data-tone="err" aria-hidden="true">!</span><div>${err}</div></div>`;
  if (!view) return html`<p class="muted">Loading…</p>`;
  if (!view.checked)
    return html`<div class="ds-notice" role="note"><span class="ds-status" data-tone="info" aria-hidden="true">i</span><div>${view.note}</div></div>`;
  const by = (f) => view.findings.filter(f);
  const c = view.coverage?.anchors;
  const s = view.summary;
  return html`<div class="checks" data-stage=${stage}>
    <p class="small-text muted">${s ? `${s.blocking} hard stop${s.blocking === 1 ? "" : "s"} · ${s.high ?? 0} need${(s.high ?? 0) === 1 ? "s" : ""} your eyes · ${s.warnings - (s.high ?? 0)} other warning${s.warnings - (s.high ?? 0) === 1 ? "" : "s"} · ${s.info} info` : ""}${c ? ` · sync measured at ${c.measured} of ${c.total} anchors` : ""}${view.whisper === false ? " · sync not checked (no Whisper)" : ""}</p>
    ${view.findings.length ? null : html`<p>Nothing to report.</p>`}
    <${Group} title="Hard stops" tone="err" items=${by((f) => f.level === "blocking")} />
    <${Group} title="Needs your eyes" tone="warn" items=${by((f) => f.level === "warning" && f.high)} />
    <${Group} title="Worth a look" tone="neutral" items=${by((f) => f.level === "warning" && !f.high)} />
    <${Group} title="Info" tone="info" items=${by((f) => f.level === "info")} open=${false} />
  </div>`;
}

/** Open the checks of a stage version. Resolves when closed. */
export function openChecks({ stage, version }) {
  return ask({
    title: `Checks of ${STAGE_NAME[stage] ?? stage} v${version}`,
    node: html`<${ChecksBody} stage=${stage} version=${version} />`,
    confirmLabel: "Close",
    cancelLabel: null,
  });
}
