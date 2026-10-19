import { html, useEffect, useMemo, useRef, useState } from "/vendor/preact-htm.module.js";
import { defaultPair } from "./compare-core.js";
import { Modal, api, post, useApi } from "./core.js";
import { CostHint } from "./cost.js";
import { confirmAsk, errorToast } from "./dialog.js";
// Compare two versions (item 9, D-R2-11, R2-3): "Advanced → Compare two versions…" on the storyboard and the voice-over. The
// window shows the facts, which are free and instant: counts with their difference, and what was added, removed or changed in
// words and numbers. Below them the Director's verdict, on request (a visible Director turn that costs model tokens only):
// its points cite the facts above, and it must say the strongest argument against its own recommendation.

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

export function Facts({ c, cited = new Set() }) {
  return html`<div class="ds-compare-facts">
    <div class="ds-table-wrap"><table class="ds-table" aria-label="Facts of the two versions">
      <thead><tr><th scope="col">What</th><th scope="col">v${c.a}</th><th scope="col">v${c.b}</th><th scope="col" class="ds-num">Change</th></tr></thead>
      <tbody>${c.facts.map(
        (f) =>
          html`<tr key=${f.id} data-fact=${f.id} data-cited=${cited.has(`fact:${f.id}`) ? "true" : undefined}><th scope="row">${f.label}</th><td>${f.a ?? "—"}</td><td>${f.b ?? "—"}</td><td class="ds-num">${f.delta === undefined ? "" : f.delta === 0 ? "no change" : sign(f.delta)}</td></tr>`,
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
      return html`<li key=${x.id} data-change=${x.id} data-kind=${x.kind} data-cited=${cited.has(x.id) ? "true" : undefined}><span class="ds-badge" data-tone=${tone}><span class="ds-badge-ico" aria-hidden="true">${icon}</span>${word}</span> <strong>${x.label}</strong>${x.kind === "same" ? null : html` <span class="ds-muted">· ${x.detail}</span>`}</li>`;
    })}</ul>
  </div>`;
}

const VERDICT = {
  better: ["ok", "▲", "Better"],
  worse: ["err", "▼", "Worse"],
  different: ["info", "≈", "Different"],
  "no meaningful change": ["neutral", "=", "No meaningful change"],
};

/** Jump to the fact or change a point cites, and mark it for a moment. */
function showEvidence(id) {
  const el = id.startsWith("fact:")
    ? document.querySelector(`[data-fact="${id.slice(5)}"]`)
    : document.querySelector(`[data-change="${id}"]`);
  if (!el) return;
  el.scrollIntoView({ block: "center" });
  el.setAttribute("data-flash", "true");
  setTimeout(() => el.removeAttribute("data-flash"), 1600);
}

function choiceWord(choice, a, b) {
  return (
    { a: `Keep v${a}`, b: `Use v${b}`, both: "Keep both", neither: "Neither of them" }[choice] ??
    choice
  );
}

/** The Director's verdict: what it says, what it cites, what it holds against its own recommendation, and the way to act on it. */
function VerdictCard({ v, onUse }) {
  const [tone, icon, word] = VERDICT[v.verdict] ?? VERDICT.different;
  const rec = v.recommendation;
  const target = rec?.choice === "a" ? v.a : rec?.choice === "b" ? v.b : null;
  return html`<section class="ds-verdict" aria-label="The Director's verdict" data-verdict=${v.verdict}>
    <div class="ds-row-flex"><span class="ds-badge" data-tone=${tone}><span class="ds-badge-ico" aria-hidden="true">${icon}</span>${word}</span><strong>${v.headline}</strong></div>
    <p class="ds-small ds-muted">v${v.b} compared with v${v.a}, by the Director${v.answeredAt ? `, ${new Date(v.answeredAt).toLocaleString()}` : ""}.</p>
    <ul class="ds-verdict-points" aria-label="Evidence">${v.points.map(
      (p) =>
        html`<li key=${p.evidence}><button class="ds-btn ds-btn--ghost ds-btn--sm" type="button" data-act="show-evidence" data-evidence=${p.evidence} onClick=${() => showEvidence(p.evidence)} title="Show it in the facts">${p.evidence}</button> ${p.said}</li>`,
    )}</ul>
    <div class="ds-verdict-against"><strong>Against this recommendation</strong><p>${v.against}</p></div>
    <div class="ds-verdict-rec"><strong>Recommendation: ${choiceWord(rec.choice, v.a, v.b)}</strong><p>${rec.why}</p>
      ${target !== null && onUse ? html`<button class="ds-btn" type="button" data-act="use-recommended" onClick=${() => onUse(target)}>Use v${target} for next steps</button>` : null}
    </div>
  </section>`;
}

/** Ask for a verdict, wait for it, read it, ask again: the part of the window below the facts. */
function Verdict({ stage, a, b, verdicts, onChanged, onUse }) {
  const v = verdicts.find((x) => x.stage === stage && x.a === a && x.b === b);
  const [busy, setBusy] = useState(false);
  const call = async (route, ask) => {
    setBusy(true);
    try {
      if (
        ask &&
        v?.status === "answered" &&
        !(await confirmAsk({
          title: "Replace the earlier verdict?",
          text: `Asking again starts the Director once more (model tokens only) and replaces its verdict on v${a} → v${b}.`,
          confirmLabel: "Ask again",
        }))
      )
        return;
      await post(`/api/${route}`, { stage, a, b });
      onChanged();
    } catch (e) {
      errorToast(e, "verdict");
    } finally {
      setBusy(false);
    }
  };
  const ask = html`<div class="ds-row-flex"><button class="ds-btn ds-btn--primary" type="button" data-act="ask-verdict" disabled=${busy} onClick=${() => call("compare-ask", true)}>${v?.status === "answered" ? "Ask again" : "Ask the Director for a verdict"}</button><${CostHint} /><span class="ds-small ds-muted">Model tokens only: nothing is recorded, spoken or changed.</span></div>`;
  if (v?.status === "asked")
    return html`<div class="ds-notice" role="status" data-verdict-state="asked"><span class="ds-status" data-tone="info" aria-hidden="true">◔</span><div>Waiting for the Director… it reads the facts and answers here. <button class="ds-btn ds-btn--ghost ds-btn--sm" type="button" data-act="cancel-verdict" disabled=${busy} onClick=${() => call("compare-cancel", false)}>Give up on this ask</button></div></div>`;
  if (v?.status === "answered")
    return html`<div class="ds-stack" data-verdict-state="answered"><${VerdictCard} v=${v} onUse=${onUse} />${ask}</div>`;
  return html`<div class="ds-stack" data-verdict-state=${v?.status ?? "none"}>${v?.status === "cancelled" ? html`<p class="ds-small ds-muted">You gave up on the last ask. The Director may have stopped without answering.</p>` : null}${ask}</div>`;
}

function CompareModal({ stage, rows, viewed, pair, events, onUse, onClose }) {
  const [a0, b0] = useMemo(() => pair ?? defaultPair(rows, viewed), []);
  const [a, setA] = useState(a0);
  const [b, setB] = useState(b0);
  const [state, setState] = useState({ status: "loading" });
  const verdicts = useApi(`/api/compare-verdicts?stage=${stage}`, events ?? [], /^compare\./);
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
      ${state.status === "ok" ? html`<${Facts} c=${state.c} cited=${new Set(verdicts.data?.verdicts.find((x) => x.stage === stage && x.a === a && x.b === b && x.status === "answered")?.points.map((p) => p.evidence) ?? [])} />` : null}
      ${state.status === "ok" && verdicts.data ? html`<${Verdict} stage=${stage} a=${a} b=${b} verdicts=${verdicts.data.verdicts} onChanged=${verdicts.reload} onUse=${onUse} />` : null}
    </div>
  <//>`;
}

/** "Advanced" on the stage screens that can compare: one entry, "Compare two versions…". Needs two versions to exist. */
export function AdvancedMenu({ stage, rows, viewed, events, onUse }) {
  const [open, setOpen] = useState(null);
  const past = useApi(`/api/compare-verdicts?stage=${stage}`, events ?? [], /^compare\./);
  const answered = (past.data?.verdicts ?? []).filter((x) => x.status === "answered");
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
        setOpen({});
      }}>Compare two versions…</button></li>
      ${answered.length ? html`<li class="ds-menu-label" role="presentation">Past comparisons (${answered.length})</li>` : null}
      ${answered.map(
        (x) =>
          html`<li key=${x.id}><button type="button" data-act="past-comparison" data-id=${x.id} onClick=${() => {
            menu.current?.removeAttribute("open");
            setOpen({ pair: [x.a, x.b] });
          }}>v${x.a} → v${x.b} · ${(VERDICT[x.verdict] ?? VERDICT.different)[2].toLowerCase()}</button></li>`,
      )}
    </ul>
    ${open ? html`<${CompareModal} stage=${stage} rows=${rows} viewed=${viewed} pair=${open.pair} events=${events} onUse=${onUse} onClose=${() => setOpen(null)} />` : null}
  </details>`;
}
