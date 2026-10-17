// "The Director asks" (P1a, F17): what the Director wanted to spend and was refused. The user answers here
// (Allow / Not now) or types /demo allow in chat; both end up as the same grant in the engine.
import { html } from "/vendor/preact-htm.module.js";
import { post, useApi } from "./core.js";
import { errorToast } from "./dialog.js";

export function DirectorAsks({ events }) {
  const { data } = useApi("/api/confirmations", events, /^confirm\./);
  const requests = data?.requests ?? [];
  if (!requests.length) return null;
  const answer = async (path, id) => {
    try {
      await post(path, { request: id });
    } catch (e) {
      errorToast(e, "answering the Director");
    }
  };
  return html`<section class="ds-root asks" aria-label="The Director asks">
    ${requests.map(
      (r) => html`<div class="ds-notice" data-tone="warn" role="alert" key=${r.id}>
        <span class="ds-status" data-tone="warn" aria-hidden="true">!</span>
        <div class="ds-grow"><b>The Director asks to ${r.summary}.</b> <span class="ds-hint">It waits for you. Or type <code>/demo allow ${r.id}</code> in chat.</span></div>
        <button class="ds-btn ds-btn--primary ds-btn--sm" type="button" onClick=${() => answer("/api/grant", r.id)}>Allow</button>
        <button class="ds-btn ds-btn--sm" type="button" onClick=${() => answer("/api/grant-deny", r.id)}>Not now</button>
      </div>`,
    )}
  </section>`;
}
