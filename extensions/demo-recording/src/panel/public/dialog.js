// Decisions and errors (S5 part 13, D93, D96): `ask()` replaces confirm() and
// prompt(), `toast()` replaces alert(). No native dialog is used anywhere in
// the panel (a test scans for them).
//
//   ask({ title, text, facts, list, diff, warnings, input, danger, skipKey, confirmLabel })
//     → Promise<null | { value?: string, skip?: boolean }>   null = cancelled
//   toast(message, { kind: "error" | "info", detail })
//
// Behaviour: Escape cancels; Enter confirms (not in a danger dialog, where the
// focus starts on Cancel); Tab stays inside; focus returns to where it was;
// the dialog is labelled for screen readers. Only CSS custom properties are used
// for colour, so the UX pass restyles it by changing tokens.
import { html, render, useLayoutEffect, useRef, useState } from "/vendor/preact-htm.module.js";
import { copyText } from "./core.js";

const SKIP_PREFIX = "demo-rec-skip:";
export const isSkipped = (key) => {
  try {
    return sessionStorage.getItem(SKIP_PREFIX + key) === "1";
  } catch {
    return false;
  }
};
export const clearSkips = () => {
  try {
    for (const k of Object.keys(sessionStorage))
      if (k.startsWith(SKIP_PREFIX)) sessionStorage.removeItem(k);
  } catch {
    // no storage: nothing to clear
  }
};

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

function Diff({ text }) {
  return html`<pre class="dlg-diff" aria-label="changes">${String(text)
    .split("\n")
    .map(
      (l) =>
        html`<span class=${l.startsWith("+") ? "d-add" : l.startsWith("-") ? "d-rem" : ""}>${l}\n</span>`,
    )}</pre>`;
}

let counter = 0;

function Dialog({ o, done }) {
  const box = useRef(null);
  const id = useRef(`dlg-${++counter}`);
  const [value, setValue] = useState(o.input?.value ?? "");
  const [skip, setSkip] = useState(false);
  const missing = !!o.input?.required && !value.trim();
  const live = useRef({});
  live.current = {
    confirm: () => !missing && done({ ...(o.input ? { value: value.trim() } : {}), skip }),
    cancel: () => done(null),
  };
  // A layout effect: this root is rendered outside Preact's normal flow (see Modal in core.js).
  useLayoutEffect(() => {
    const before = document.activeElement;
    const el = box.current;
    const onKey = (e) => {
      const all = document.querySelectorAll(".modal-backdrop");
      if (all[all.length - 1] !== el?.parentElement) return; // only the top-most popup reacts
      if (e.key === "Escape") {
        e.stopPropagation();
        live.current.cancel();
      } else if (e.key === "Tab" && el) {
        const items = [...el.querySelectorAll(FOCUSABLE)];
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      } else if (e.key === "Enter" && !o.danger && !e.shiftKey) {
        const t = e.target;
        if (t instanceof HTMLElement && ["TEXTAREA", "BUTTON", "SELECT", "A"].includes(t.tagName))
          return; // those handle Enter themselves
        e.preventDefault();
        live.current.confirm();
      }
    };
    window.addEventListener("keydown", onKey, true);
    const first = el?.querySelector(
      o.danger ? "[data-cancel]" : o.input ? "input, textarea" : "[data-confirm]",
    );
    (first ?? el)?.focus();
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (before instanceof HTMLElement) before.focus();
    };
  }, []);
  const paragraphs = o.text ? String(o.text).split(/\n{2,}/) : [];
  return html`<div class="modal-backdrop dlg-backdrop" onClick=${(e) => e.target === e.currentTarget && !o.danger && !value && live.current.cancel()}>
    <div class=${`modal medium dialog${o.danger ? " danger" : ""}`} role=${o.danger ? "alertdialog" : "dialog"} aria-modal="true"
      aria-labelledby=${`${id.current}-t`} aria-describedby=${`${id.current}-b`} tabindex="-1" ref=${box}>
      <header class="modal-head"><h2 id=${`${id.current}-t`}>${o.title}</h2></header>
      <div class="modal-body dialog-body" id=${`${id.current}-b`}>
        ${paragraphs.map((p) => html`<p>${p}</p>`)}
        ${
          o.facts?.length
            ? html`<dl class="dlg-facts">${o.facts.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`
            : null
        }
        ${o.warnings?.map((w) => html`<p class="dlg-warn" role="note">⚠ ${w}</p>`)}
        ${
          o.list?.items?.length
            ? html`<div class="dlg-list">${o.list.title ? html`<p>${o.list.title}</p>` : null}<ul>${o.list.items.map((i) => html`<li>${i}</li>`)}</ul></div>`
            : null
        }
        ${o.diff ? html`<${Diff} text=${o.diff} />` : null}
        ${o.node ?? null}
        ${
          o.input
            ? html`<label class="dlg-input">${o.input.label}
              ${
                o.input.multiline
                  ? html`<textarea value=${value} placeholder=${o.input.placeholder ?? ""} onInput=${(e) => setValue(e.target.value)}></textarea>`
                  : html`<input value=${value} placeholder=${o.input.placeholder ?? ""} onInput=${(e) => setValue(e.target.value)} />`
              }
              ${o.input.hint ? html`<span class="muted small-text">${o.input.hint}</span>` : null}
            </label>`
            : null
        }
        ${
          o.skipKey
            ? html`<label class="check small-text dlg-skip"><input type="checkbox" checked=${skip} onChange=${(e) => setSkip(e.target.checked)} /> Don't ask again this session</label>`
            : null
        }
      </div>
      <footer class="dialog-foot">
        <button class="ghost" data-cancel onClick=${() => live.current.cancel()}>${o.cancelLabel ?? "Cancel"}</button>
        <button class=${o.danger ? "danger" : "primary"} data-confirm disabled=${missing} onClick=${() => live.current.confirm()}>${o.confirmLabel ?? "OK"}</button>
      </footer>
    </div>
  </div>`;
}

/** A decision. Resolves null when cancelled, else { value?, skip? } (immediately { skipped: true } when "don't ask again" was ticked earlier). */
export function ask(o) {
  if (o.skipKey && isSkipped(o.skipKey)) return Promise.resolve({ skipped: true });
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const done = (result) => {
      render(null, host);
      host.remove();
      if (result?.skip && o.skipKey) {
        try {
          sessionStorage.setItem(SKIP_PREFIX + o.skipKey, "1");
        } catch {
          // no storage: it just asks again next time
        }
      }
      resolve(result);
    };
    render(html`<${Dialog} o=${o} done=${done} />`, host);
  });
}

/** A yes/no decision. */
export const confirmAsk = async (o) => (await ask(o)) !== null;

/** A text answer, or null when cancelled. */
export const askText = async (o) => {
  const r = await ask(o);
  return r === null ? null : (r.value ?? "");
};

// ---------------- toasts ----------------

let toastHost;
const toasts = [];
let toastSeq = 0;

function Toasts({ items }) {
  return html`<div class="toasts" role="region" aria-label="notifications">
    ${items.map(
      (
        t,
      ) => html`<div key=${t.id} class=${`toast ${t.kind}`} role=${t.kind === "error" ? "alert" : "status"}>
        <span class="toast-msg">${t.message}${t.count > 1 ? html` <span class="toast-count">×${t.count}</span>` : null}</span>
        ${t.kind === "error" ? html`<button class="ghost tiny" onClick=${() => copyText(t.detail ?? t.message)}>Copy</button>` : null}
        <button class="ghost tiny" aria-label="dismiss" onClick=${() => dismiss(t.id)}>×</button>
      </div>`,
    )}
  </div>`;
}

function paint() {
  if (!toastHost) {
    toastHost = document.createElement("div");
    document.body.appendChild(toastHost);
  }
  render(html`<${Toasts} items=${[...toasts]} />`, toastHost);
}

export function dismiss(id) {
  const i = toasts.findIndex((t) => t.id === id);
  if (i >= 0) toasts.splice(i, 1);
  paint();
}

/** A non-blocking message. Errors stay until dismissed (with Copy); info disappears after a few seconds. */
export function toast(message, o = {}) {
  const kind = o.kind ?? "error";
  const same = toasts.find((t) => t.message === message && t.kind === kind);
  if (same) {
    same.count++;
    paint();
    return same.id;
  }
  const t = { id: ++toastSeq, kind, message: String(message), detail: o.detail, count: 1 };
  toasts.push(t);
  while (toasts.length > 5) toasts.shift();
  paint();
  if (kind !== "error") setTimeout(() => dismiss(t.id), o.ms ?? 6000);
  return t.id;
}

/** An error from a failed action: `errorToast(e)` or `errorToast(e, "config set")`. */
export const errorToast = (e, what) =>
  toast(what ? `${what}: ${e?.message ?? e}` : String(e?.message ?? e), {
    kind: "error",
    detail: e?.stack ?? undefined,
  });
