// Keyboard help for the whole panel (UX14, D128): arrow keys inside lists, one tab stop per list, and a "?" sheet
// of the shortcuts that exist. Nothing here fires while you type in a field or while a dialog is open.
import { ask } from "./dialog.js";
import { SHORTCUTS } from "./shortcuts.js";

const EDITABLE = "input, textarea, select, [contenteditable], [contenteditable=true]";

/** True when the key belongs to a text field, a dialog or a modifier combination, not to the panel. */
const ignored = (e) =>
  e.defaultPrevented ||
  e.ctrlKey ||
  e.metaKey ||
  e.altKey ||
  (e.target instanceof Element && !!e.target.closest(EDITABLE)) ||
  !!document.querySelector(".modal-backdrop");

let sheetOpen = false;
export async function showShortcuts() {
  if (sheetOpen) return;
  sheetOpen = true;
  try {
    await ask({
      title: "Keyboard shortcuts",
      facts: SHORTCUTS,
      text: "Shortcuts never fire while you type in a field or while a dialog is open.",
      confirmLabel: "Close",
      cancelLabel: null,
    });
  } finally {
    sheetOpen = false;
  }
}

const LISTS = [
  { container: ".ds-list", item: ".ds-item" },
  { container: ".ds-histpop", item: ".ds-version-main" },
];

function neighbour(items, from, key) {
  const i = items.indexOf(from);
  if (i < 0) return null;
  if (key === "ArrowDown") return items[Math.min(items.length - 1, i + 1)];
  if (key === "ArrowUp") return items[Math.max(0, i - 1)];
  if (key === "Home") return items[0];
  if (key === "End") return items[items.length - 1];
  return null;
}

function onKeyDown(e) {
  if (ignored(e)) return;
  if (e.key === "?") {
    e.preventDefault();
    showShortcuts();
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  const target = e.target instanceof Element ? e.target : null;
  for (const { container, item } of LISTS) {
    const here = target?.closest(item);
    const list = here?.closest(container);
    if (!here || !list) continue;
    const items = [...list.querySelectorAll(item)].filter((el) => !el.closest("[hidden]"));
    const next = neighbour(items, here, e.key);
    if (next && next !== here) {
      e.preventDefault();
      next.focus();
    } else if (next) e.preventDefault();
    return;
  }
}

/** One tab stop per list: the current item (or the first) is in the tab order, the others are reached by arrows. */
function rove() {
  for (const list of document.querySelectorAll(".ds-list")) {
    const items = [...list.querySelectorAll(".ds-item")];
    if (!items.length) continue;
    const focused = items.find((el) => el === document.activeElement);
    const current =
      focused ?? items.find((el) => el.getAttribute("aria-current") === "true") ?? items[0];
    for (const el of items) el.tabIndex = el === current ? 0 : -1;
  }
}

let started = false;
/** Start once, for the life of the page. */
export function installKeys() {
  if (started) return;
  started = true;
  window.addEventListener("keydown", onKeyDown);
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      rove();
    });
  };
  new MutationObserver(schedule).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-current"],
  });
  // focus moves the stop with it, so Shift+Tab and Tab come back to where you were
  document.addEventListener("focusin", (e) => {
    const el = e.target instanceof Element ? e.target.closest(".ds-list .ds-item") : null;
    if (el) rove();
  });
  schedule();
}
