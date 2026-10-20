// "The Director asks" (P1a, F17; item 11, D140): what the Director wants from you. Two kinds, one bar:
//  - a request to spend (a take, a voice): Allow / Not now, or `/demo allow` in the chat; both end up as the same grant in the engine;
//  - a question with 2 to 4 options: answer it here (a button per option) or type the option's number or word in the chat; whichever
//    answers it, it is resolved once and the other place updates. Dismiss gives up on it without choosing.
import { html } from "/vendor/preact-htm.module.js";
import { post, useApi } from "./core.js";
import { errorToast } from "./dialog.js";

function Questions({ pending }) {
  const call = async (path, body) => {
    try {
      await post(path, body);
    } catch (e) {
      errorToast(e, "answering the Director");
    }
  };
  return html`${pending.map(
    (
      q,
    ) => html`<div class="ds-notice ds-question" data-tone="info" role="group" aria-label=${`${q.role} asks`} data-question=${q.id} key=${q.id}>
      <span class="ds-status" data-tone="info" aria-hidden="true">?</span>
      <div class="ds-grow ds-stack">
        <div><span class="ds-badge" data-tone="neutral" data-role>${q.role}</span> <b data-part="what">${q.what}</b></div>
        ${q.why ? html`<div class="ds-small ds-muted">${q.why}</div>` : null}
        <div class="ds-row-flex">${q.options.map((o) => html`<button class="ds-btn ds-btn--sm" type="button" data-act="answer-question" data-option=${o.key} key=${o.key} onClick=${() => call("/api/question-answer", { id: q.id, option: o.key })}><span class="ds-kbd" aria-hidden="true">${o.key}</span> ${o.label}</button>`)}
          ${q.grant ? null : html`<button class="ds-btn ds-btn--ghost ds-btn--sm" type="button" data-act="dismiss-question" onClick=${() => call("/api/question-cancel", { id: q.id })}>Dismiss</button>`}</div>
        <div class="ds-hint">It waits for you. In the chat type ${q.options.map((o, i) => html`${i ? " or " : ""}<code>${o.key}</code> (<code>${o.word}</code>)`)}; anything else is normal chat.</div>
      </div>
    </div>`,
  )}`;
}

export function DirectorAsks({ events }) {
  const { data } = useApi("/api/confirmations", events, /^confirm\./);
  const requests = data?.requests ?? [];
  const questions = useApi("/api/questions", events, /^question\./).data?.pending ?? [];
  if (!requests.length && !questions.length) return null;
  const answer = async (path, id) => {
    try {
      await post(path, { request: id });
    } catch (e) {
      errorToast(e, "answering the Director");
    }
  };
  return html`<section class="ds-root asks" aria-label="The Director asks">
    <${Questions} pending=${questions} />
    ${requests
      .filter((r) => !questions.some((q) => q.grant?.request === r.id))
      .map(
        (r) => html`<div class="ds-notice" data-tone="warn" role="alert" key=${r.id}>
        <span class="ds-status" data-tone="warn" aria-hidden="true">!</span>
        <div class="ds-grow"><b>The Director asks to ${r.summary}.</b> <span class="ds-hint">It waits for you. Or type <code>/demo allow ${r.id}</code> in chat.</span></div>
        <button class="ds-btn ds-btn--primary ds-btn--sm" type="button" onClick=${() => answer("/api/grant", r.id)}>Allow</button>
        <button class="ds-btn ds-btn--sm" type="button" onClick=${() => answer("/api/grant-deny", r.id)}>Not now</button>
      </div>`,
      )}
  </section>`;
}
