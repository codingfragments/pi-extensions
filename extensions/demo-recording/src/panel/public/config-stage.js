// Config: staged edits (D-R2-9). An edit on a row is not written; it is staged, and "Review and save" shows ONE combined
// diff and writes everything at once. The list lives here (not in a component) so it survives a switch between Settings
// and Brands; leaving Config asks first, and a reload warns. Pure reducers plus a small store.
import { useEffect, useState } from "/vendor/preact-htm.module.js";
import { countWord, stageId, toBatch, withChange, without } from "./config-stage-core.js";

export { countWord, stageId, toBatch, withChange, without };

let items = [];
const subs = new Set();
const emit = () => {
  for (const f of subs) f(items);
};

export const stagedList = () => items;
export function stage(item) {
  items = withChange(items, item);
  emit();
}
export function unstage(id) {
  items = without(items, id);
  emit();
}
export function clearStaged() {
  if (!items.length) return;
  items = [];
  emit();
}

/** The staged list, re-read when it changes. */
export function useStaged() {
  const [list, setList] = useState(items);
  useEffect(() => {
    subs.add(setList);
    setList(items);
    return () => subs.delete(setList);
  }, []);
  return list;
}

/**
 * Leaving the Config screen with staged edits asks first. A click on a link to another screen is held until the answer
 * (`ask(count)` resolves true to leave); a reload or closing the tab gets the browser's own warning. Returns the remover.
 */
export function guardLeaving(ask) {
  const onClick = (e) => {
    if (!items.length || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey) return;
    const a = e.target instanceof Element ? e.target.closest("a[href^='#/']") : null;
    if (!a) return;
    const target = a.getAttribute("href").slice(2).split(/[/?]/)[0];
    if (target === "config") return;
    e.preventDefault();
    const href = a.getAttribute("href");
    ask(items.length).then((leave) => {
      if (!leave) return;
      clearStaged();
      location.hash = href;
    });
  };
  const onUnload = (e) => {
    if (!items.length) return;
    e.preventDefault();
    e.returnValue = "";
  };
  document.addEventListener("click", onClick, true);
  window.addEventListener("beforeunload", onUnload);
  return () => {
    document.removeEventListener("click", onClick, true);
    window.removeEventListener("beforeunload", onUnload);
  };
}
