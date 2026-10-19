// Shared pieces of the list + inspector review screens (UX5): the review and confidence vocabulary as
// icon + word, and the rows of the list. Voice over (voice.js) and Storyboard (storyboard.js) use them.
import { html } from "/vendor/preact-htm.module.js";

export const STATUS_LABEL = {
  approved: "Mark reviewed",
  changes: "Needs changes",
  rerun: "Re-run",
};
/** A review status as [tone, icon]; none yet is an empty circle. */
export const REVIEW_ICON = { approved: ["ok", "✓"], changes: ["warn", "!"], rerun: ["warn", "!"] };
/** What a chosen decision is called as a STATE (the buttons are the actions; once chosen, the item is "Reviewed"). */
export const STATE_WORD = {
  approved: "Reviewed",
  changes: "Needs changes",
  rerun: "Re-run requested",
};

/** A decision as a badge: an icon and a word. Null when nothing is decided. */
export const ReviewBadge = ({ status }) =>
  status && REVIEW_ICON[status]
    ? html`<span class="ds-badge" data-tone=${REVIEW_ICON[status][0]} data-review-badge=${status}><span class="ds-badge-ico" aria-hidden="true">${REVIEW_ICON[status][1]}</span>${STATE_WORD[status]}</span>`
    : null;

/**
 * The three review decisions of one item (a voice-over section, a storyboard scene) as one control that shows its state (D-R2-5):
 * nothing decided: three action buttons; one decided: that one becomes the highlighted state with a **Revoke**, and the other two stay
 * available to switch (deciding differently later is one click). One line says what each does. `what`: what a re-run starts from.
 */
export function ReviewControl({ status, onChoose, noun = "section", what = "the take" }) {
  return html`<div class="ds-review ds-stack" role="group" aria-label=${`Review this ${noun}`} data-review=${status ?? "none"}>
    <div class="ds-row-flex">
      ${Object.entries(STATUS_LABEL).map(([st, label]) =>
        st === status
          ? html`<span class="ds-review-chosen" key=${st} data-state=${st} data-tone=${REVIEW_ICON[st][0]}>
              <span class="ds-status" data-tone=${REVIEW_ICON[st][0]} aria-hidden="true">${REVIEW_ICON[st][1]}</span><strong>${STATE_WORD[st]}</strong>
              <button class="ds-btn ds-btn--sm ds-btn--ghost" type="button" data-act="revoke" aria-label=${`Revoke: ${STATE_WORD[st]}`} onClick=${() => onChoose(null)}>Revoke</button>
            </span>`
          : html`<button class="ds-btn ds-btn--sm" key=${st} type="button" data-status=${st} onClick=${() => onChoose(st)}>${label}</button>`,
      )}
    </div>
    <p class="ds-small ds-muted ds-review-help"><b>Mark reviewed:</b> this ${noun} is fine. <b>Needs changes:</b> the Director edits it as your note says. <b>Re-run:</b> the Director redoes it from ${what}, not just an edit. Nothing happens until you send the review.</p>
  </div>`;
}

export const CONF_WORD = { high: "High", medium: "Medium", low: "Low" };
export const CONF_TONE = { high: "ok", medium: "warn", low: "err" };
export const CONF_ICON = { high: "✓", medium: "!", low: "!" };

/** The confidence of an item as a badge: an icon and a word, never colour alone. */
export const ConfPill = ({ c, long = false }) =>
  c
    ? html`<span class="ds-badge" data-tone=${CONF_TONE[c.level]}><span class="ds-badge-ico" aria-hidden="true">${CONF_ICON[c.level]}</span>${CONF_WORD[c.level]}${long ? " confidence" : ""}</span>`
    : null;

/**
 * One row of the list: the review status icon, a title and a meta line, and badges on the right.
 * `current` marks the selected row; `onSelect` receives the key.
 */
export function ListRow({ itemKey, title, meta, review, current, onSelect, badges }) {
  const [tone, icon] = REVIEW_ICON[review?.status] ?? ["", "○"];
  return html`<li><button class="ds-item" type="button" data-key=${itemKey} aria-current=${current ? "true" : undefined} onClick=${() => onSelect(itemKey)}>
    <span class="ds-status" data-tone=${tone || undefined} aria-hidden="true">${icon}</span>
    <span><span class="ds-item-title" title=${typeof title === "string" ? title : undefined}>${title}</span><span class="ds-item-meta">${meta}</span></span>
    <span class="ds-row-flex">${badges}</span>
  </button></li>`;
}

/** The small selector that replaces the list below the workspace's narrow threshold. */
export const NarrowSelect = ({ label, value, options, onChange }) =>
  html`<div class="ds-split-bar"><label class="ds-field"><span class="ds-label">${label}</span>
    <select class="ds-select" value=${value} onChange=${(e) => onChange(e.target.value)}>
      ${options.map(([v, text]) => html`<option value=${v}>${text}</option>`)}
    </select></label></div>`;
