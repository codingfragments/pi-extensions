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
    <span><span class="ds-item-title">${title}</span><br /><span class="ds-item-meta">${meta}</span></span>
    <span class="ds-row-flex">${badges}</span>
  </button></li>`;
}

/** The small selector that replaces the list below the workspace's narrow threshold. */
export const NarrowSelect = ({ label, value, options, onChange }) =>
  html`<div class="ds-split-bar"><label class="ds-field"><span class="ds-label">${label}</span>
    <select class="ds-select" value=${value} onChange=${(e) => onChange(e.target.value)}>
      ${options.map(([v, text]) => html`<option value=${v}>${text}</option>`)}
    </select></label></div>`;
