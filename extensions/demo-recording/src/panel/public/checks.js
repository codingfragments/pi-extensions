// "Checks of <stage> vN" (P1a Q1b, F32): ONE popup for the findings of any stage version, reused by every stage
// screen. Today it reads the render's QA (GET /api/checks); the other stages' adapters fill the same shape later.
// Read-only for now: Fix / Ignore / Leave and the ignored list come with the flag-and-propose loop.
import { html, useEffect, useState } from "/vendor/preact-htm.module.js";
import { api, post } from "./core.js";
import { ask, errorToast } from "./dialog.js";

const STAGE_NAME = {
  storyboard: "storyboard",
  recording: "recording",
  vo: "voice-over",
  annotations: "annotations",
  render: "render",
};

const clock = (ms) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

/** What kind of finding it is, in the user's words (the scope of "this kind in the whole project"). */
export function kindLabel(f) {
  if (f.check === "media")
    return (
      {
        still: "frozen-picture warnings",
        pause: "long-pause warnings",
        black: "black-picture warnings",
      }[f.identity?.kind] ?? "picture and sound notes"
    );
  if (f.check === "annotations")
    return f.hard === "redaction" ? "leaking-redaction stops" : "annotation and privacy warnings";
  return (
    {
      values: "narrated-value warnings",
      drift: "narration-timing warnings",
      footage: "toast and console-error warnings",
    }[f.check] ?? `${f.check} findings`
  );
}

function ScopePick({ item, choice }) {
  const [scope, setScope] = useState(choice.scope);
  const pick = (v) => {
    choice.scope = v;
    setScope(v);
  };
  const again = item.check === "footage" ? "the take changes" : "the scene's narration changes";
  const opts = [
    ["finding", "Only this finding", `it comes back if ${again}`],
    ...(item.scene ? [["scene", `${kindLabel(item)} in ${item.scene}`, `until ${again}`]] : []),
    ["project", `${kindLabel(item)} in the whole project`, "a rule: it stays until you stop it"],
  ];
  return html`<fieldset class="ds-field ignore-scope"><legend class="ds-label">How far does it go?</legend>${opts.map(
    ([v, label, hint]) =>
      html`<label class="ds-check" key=${v}><input type="radio" name="ignore-scope" value=${v} checked=${scope === v} onChange=${() => pick(v)} /> <span><b>${label}</b> <span class="ds-hint-text">${hint}</span></span></label>`,
  )}</fieldset>`;
}

/** Ask what to leave alone and why. Resolves { scope, reason } or null. */
export async function askIgnore(item) {
  const choice = { scope: "finding" };
  const r = await ask({
    title: "Leave this alone?",
    text: item.message,
    node: html`<${ScopePick} item=${item} choice=${choice} />`,
    input: {
      label: "Why is it fine?",
      required: true,
      placeholder: "e.g. test data, the forecast is meant",
    },
    confirmLabel: "Ignore",
  });
  return r ? { scope: choice.scope, reason: r.value } : null;
}

/** Ignore a finding of a render (asks first); true when it was done. */
export async function ignoreFinding(version, item) {
  const a = await askIgnore(item);
  if (!a) return false;
  try {
    await post("/api/render-qa-ignore", { version, id: item.id, scope: a.scope, reason: a.reason });
    return true;
  } catch (e) {
    errorToast(e, "ignoring");
    return false;
  }
}

/** Stop ignoring. */
export async function stopIgnoring(ignoreId, version) {
  try {
    await post("/api/render-qa-unignore", { ignore: ignoreId, version });
    return true;
  } catch (e) {
    errorToast(e, "stop ignoring");
    return false;
  }
}

export function IgnoredList({ items, ignores, version, reload }) {
  const mine = ignores.filter((i) => !i.endedAt);
  const ended = ignores.filter((i) => i.endedAt);
  if (!items.length && !mine.length && !ended.length) return null;
  const stop = async (id) => {
    if (await stopIgnoring(id, version)) reload();
  };
  return html`<details class="checks-group" data-tone="neutral"><summary class="small-text muted">Ignored by you (${mine.length} decision${mine.length === 1 ? "" : "s"}, ${items.length} finding${items.length === 1 ? "" : "s"} now)</summary>
    <ul class="qa-list">${mine.map(
      (i) => html`<li class="qa-item" key=${i.id}>
        <div class="row"><span class="qa-msg"><b>${i.scope === "project" ? "Rule" : i.scope === "scene" ? `In ${i.scene}` : "One finding"}:</b> ${i.finding?.message ?? `${i.check}${i.kind ? ` / ${i.kind}` : ""}${i.hard ? ` (${i.hard})` : ""}`}</span></div>
        <p class="small-text muted">“${i.reason}” · since render v${i.renderVersion}</p>
        <button class="ds-btn ds-btn--ghost ds-btn--sm" onClick=${() => stop(i.id)}>Stop ignoring</button>
      </li>`,
    )}${ended.map(
      (i) =>
        html`<li class="qa-item" key=${i.id}><p class="small-text muted">Ended: ${i.endedWhy} — “${i.reason}”</p></li>`,
    )}</ul></details>`;
}

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
  const [n, setN] = useState(0);
  useEffect(() => {
    api(`/api/checks?stage=${stage}&version=${version}`).then(setView, (e) => setErr(e.message));
  }, [stage, version, n]);
  if (err)
    return html`<div class="ds-notice" data-tone="err" role="alert"><span class="ds-status" data-tone="err" aria-hidden="true">!</span><div>${err}</div></div>`;
  if (!view) return html`<p class="muted">Loading…</p>`;
  if (!view.checked)
    return html`<div class="ds-notice" role="note"><span class="ds-status" data-tone="info" aria-hidden="true">i</span><div>${view.note}</div></div>`;
  const by = (f) => view.findings.filter((x) => !x.ignored && f(x));
  const c = view.coverage?.anchors;
  const s = view.summary;
  return html`<div class="checks" data-stage=${stage}>
    <p class="small-text muted">${s ? `${s.blocking} hard stop${s.blocking === 1 ? "" : "s"} · ${s.high ?? 0} need${(s.high ?? 0) === 1 ? "s" : ""} your eyes · ${s.warnings - (s.high ?? 0)} other warning${s.warnings - (s.high ?? 0) === 1 ? "" : "s"} · ${s.info} info` : ""}${c ? ` · sync measured at ${c.measured} of ${c.total} anchors` : ""}${view.whisper === false ? " · sync not checked (no Whisper)" : ""}</p>
    ${view.findings.some((x) => !x.ignored) ? null : html`<p>Nothing to report.</p>`}
    <${Group} title="Hard stops" tone="err" items=${by((f) => f.level === "blocking")} />
    <${Group} title="Needs your eyes" tone="warn" items=${by((f) => f.level === "warning" && f.high)} />
    <${Group} title="Worth a look" tone="neutral" items=${by((f) => f.level === "warning" && !f.high)} />
    <${Group} title="Info" tone="info" items=${by((f) => f.level === "info")} open=${false} />
    <${IgnoredList} items=${view.findings.filter((x) => x.ignored)} ignores=${view.ignores ?? []} version=${version} reload=${() => setN((x) => x + 1)} />
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
