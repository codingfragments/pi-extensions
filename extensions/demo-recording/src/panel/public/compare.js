import { html, useEffect, useMemo, useRef, useState } from "/vendor/preact-htm.module.js";
import { defaultPair } from "./compare-core.js";
import { Modal, api } from "./core.js";
// Compare two versions (item 9, D-R2-11, R2-3): "Advanced → Compare two versions…" on the storyboard and the voice-over. The
// window shows the facts, which are free and instant: counts with their difference, and what was added, removed or changed in
// words and numbers. (The Director's verdict comes on top of these facts in the next step.)

export const COMPARABLE = ["storyboard", "vo"];
const NAME = { storyboard: "Storyboard", vo: "Voice over" };
const KIND = {
  added: ["ok", "+", "added"],
  removed: ["err", "−", "removed"],
  changed: ["accent", "~", "changed"],
  reordered: ["accent", "↕", "reordered"],
  same: ["neutral", "=", "unchanged"],
};

const sign = (n) => (n > 0 ? `+${n}` : String(n));

function VersionSelect({ id, label, value, rows, onChange }) {
  return html`<label class="ds-field" for=${id}><span class="ds-label">${label}</span>
    <select class="ds-select" id=${id} value=${value} onChange=${(e) => onChange(Number(e.target.value))}>
      ${rows.map((r) => html`<option value=${r.version} key=${r.version}>${r.short}${r.inLine ? " · in the production line" : ""}${r.approved ? " · approved" : ""}</option>`)}
    </select></label>`;
}

export function Facts({ c }) {
  return html`<div class="ds-compare-facts">
    <div class="ds-table-wrap"><table class="ds-table" aria-label="Facts of the two versions">
      <thead><tr><th scope="col">What</th><th scope="col">v${c.a}</th><th scope="col">v${c.b}</th><th scope="col" class="ds-num">Change</th></tr></thead>
      <tbody>${c.facts.map(
        (f) =>
          html`<tr key=${f.id} data-fact=${f.id}><th scope="row">${f.label}</th><td>${f.a ?? "—"}</td><td>${f.b ?? "—"}</td><td class="ds-num">${f.delta === undefined ? "" : f.delta === 0 ? "no change" : sign(f.delta)}</td></tr>`,
      )}</tbody>
    </table></div>
    <h3 class="ds-compare-h">What changed</h3>
    ${
      c.changes.every((x) => x.kind === "same")
        ? html`<p class="ds-muted ds-small">Nothing changed between these two versions.</p>`
        : null
    }
    <ul class="ds-compare-changes" aria-label="Changes">${c.changes.map((x) => {
      const [tone, icon, word] = KIND[x.kind] ?? KIND.same;
      return html`<li key=${x.id} data-change=${x.id} data-kind=${x.kind}><span class="ds-badge" data-tone=${tone}><span class="ds-badge-ico" aria-hidden="true">${icon}</span>${word}</span> <strong>${x.label}</strong>${x.kind === "same" ? null : html` <span class="ds-muted">· ${x.detail}</span>`}</li>`;
    })}</ul>
  </div>`;
}

function CompareModal({ stage, rows, viewed, onClose }) {
  const [a0, b0] = useMemo(() => defaultPair(rows, viewed), []);
  const [a, setA] = useState(a0);
  const [b, setB] = useState(b0);
  const [state, setState] = useState({ status: "loading" });
  useEffect(() => {
    if (a === b) return setState({ status: "same" });
    let live = true;
    setState({ status: "loading" });
    api(`/api/compare?stage=${stage}&a=${a}&b=${b}`).then(
      (c) => live && setState({ status: "ok", c }),
      (e) => live && setState({ status: "error", message: String(e.message ?? e) }),
    );
    return () => {
      live = false;
    };
  }, [stage, a, b]);
  const swap = () => {
    setA(b);
    setB(a);
  };
  return html`<${Modal} title=${`Compare two versions · ${NAME[stage]}`} size="large" onClose=${onClose}>
    <div class="ds-stack ds-compare" data-stage=${stage}>
      <div class="ds-row-flex ds-compare-pick">
        <${VersionSelect} id="cmp-a" label="From (older)" value=${a} rows=${rows} onChange=${setA} />
        <button class="ds-btn ds-btn--ghost" type="button" data-act="compare-swap" aria-label="Swap the two versions" title="Swap" onClick=${swap}>⇄</button>
        <${VersionSelect} id="cmp-b" label="To (newer)" value=${b} rows=${rows} onChange=${setB} />
      </div>
      <p class="ds-small ds-muted">These are the facts: counted from the two versions, free and instant. They do not say which one is better.</p>
      ${state.status === "loading" ? html`<p class="ds-muted" role="status">Comparing…</p>` : null}
      ${state.status === "same" ? html`<p class="ds-notice" role="note">Pick two different versions.</p>` : null}
      ${state.status === "error" ? html`<div class="ds-notice" data-tone="err" role="alert"><span class="ds-status" data-tone="err" aria-hidden="true">!</span><div>${state.message}</div></div>` : null}
      ${state.status === "ok" ? html`<${Facts} c=${state.c} />` : null}
    </div>
  <//>`;
}

/** "Advanced" on the stage screens that can compare: one entry, "Compare two versions…". Needs two versions to exist. */
export function AdvancedMenu({ stage, rows, viewed }) {
  const [open, setOpen] = useState(false);
  const menu = useRef(null);
  useEffect(() => {
    const out = (e) => {
      if (menu.current?.open && !menu.current.contains(e.target))
        menu.current.removeAttribute("open");
    };
    document.addEventListener("pointerdown", out);
    return () => document.removeEventListener("pointerdown", out);
  }, []);
  if (!COMPARABLE.includes(stage) || (rows?.length ?? 0) < 2) return null;
  return html`<details class="ds-menu ds-advanced" ref=${menu} onKeyDown=${(e) => e.key === "Escape" && menu.current?.removeAttribute("open")}>
    <summary class="ds-btn ds-btn--ghost" data-act="advanced" title="Less common actions">Advanced</summary>
    <ul aria-label="Advanced">
      <li><button type="button" data-act="compare-open" onClick=${() => {
        menu.current?.removeAttribute("open");
        setOpen(true);
      }}>Compare two versions…</button></li>
    </ul>
    ${open ? html`<${CompareModal} stage=${stage} rows=${rows} viewed=${viewed} onClose=${() => setOpen(false)} />` : null}
  </details>`;
}
