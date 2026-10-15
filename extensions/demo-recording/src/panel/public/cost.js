// Cost hints and the "ask first" check (S5 part 13, D91–D95).
//   <CostHint />            a visible caption on buttons that start an agent turn
//   confirmCost(action, …)  asks the engine what an action would start (POST /api/estimate,
//                           a free dry run) and, for money and long jobs, a dialog first
import { html } from "/vendor/preact-htm.module.js";
import { post } from "./core.js";
import { ask } from "./dialog.js";

let models = null;
/** The engine's view of who runs what (from /api/state): set once per render of the app. */
export const setModels = (m) => {
  models = m ?? null;
};
export const getModels = () => models;

const bare = (spec) => (spec ? spec.split("/").slice(1).join("/") || spec : "");

/** "starts the Director · claude-opus-4-5" — a turn on the session model; its cost can't be estimated. */
export function CostHint({ what = "starts the Director", model }) {
  const m = model ?? models?.session;
  return html`<span class="ds-hint cost-hint" title=${`${what} on ${m ?? "the session model"}: an agent turn, its cost can't be estimated`}>${what}${m ? ` · ${bare(m)}` : ""}</span>`;
}

/**
 * Resolves true when the action may go ahead: nothing to ask, "don't ask again" was ticked
 * earlier this session, or you confirmed. Throws when the estimate itself fails (the caller
 * shows the error).
 */
export async function confirmCost(action, body = {}) {
  const e = await post("/api/estimate", { ...body, action });
  if (!e.blocking) return true;
  const r = await ask({
    title: e.title,
    text: e.facts?.length ? undefined : e.what,
    facts: e.facts,
    warnings: e.warnings,
    confirmLabel: e.confirmLabel,
    skipKey: e.skippable ? action : undefined,
  });
  return r !== null;
}
