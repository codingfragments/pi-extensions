// Confidence-guided review (S5 part 11, D23, D76–D81): badges with reasons,
// "N need your eyes" chips that jump to the item, a riskiest-first sort, and
// the guarded "Mark high-confidence reviewed" popup.
import { html, useEffect, useState } from "/vendor/preact-htm.module.js";
import { Modal, post } from "./core.js";

const RANK = { low: 0, medium: 1, high: 2 };

export const confOf = (summary, id) => summary?.items?.find((i) => i.id === id) ?? null;

/** Riskiest first (stable: story order within a level). */
export const byRisk = (list, summary, idOf) =>
  list
    .map((x, i) => ({ x, i, r: RANK[confOf(summary, idOf(x))?.level ?? "high"] }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((e) => e.x);

export const itemDomId = (id) => `item-${String(id).replace(/[^a-zA-Z0-9_-]/g, "_")}`;

export function jumpTo(id) {
  const el = document.getElementById(itemDomId(id));
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  el.classList.remove("jumped");
  // restart the highlight animation
  void el.offsetWidth;
  el.classList.add("jumped");
}

const reasonsText = (c) =>
  c.reasons.length
    ? c.reasons
        .map((r) => `${r.level === "high" ? "✓" : r.level === "low" ? "✖" : "⚠"} ${r.text}`)
        .join("\n")
    : "no risk signals";

/** "● low" chip; the reasons are in the tooltip. */
export function ConfBadge({ c }) {
  if (!c) return null;
  return html`<span class=${`conf conf-${c.level}`} title=${`confidence: ${c.level}\n${reasonsText(c)}`}>● ${c.level}</span>`;
}

/** The reasons under a card (only for medium/low, plus "approved in vN"). */
export function ConfReasons({ c }) {
  if (!c) return null;
  const shown = c.reasons.filter((r) => r.level !== "high");
  if (!shown.length) return null;
  return html`<ul class="conf-reasons small-text">
    ${shown.map((r) => html`<li class=${`r-${r.level}`}>${r.level === "low" ? "✖" : "⚠"} ${r.text}</li>`)}
  </ul>`;
}

/** Header row: "N need your eyes" chips (jump), riskiest-first toggle, collapse-high toggle, and extra actions. */
export function NeedsEyes({
  summary,
  riskFirst,
  setRiskFirst,
  collapseHigh,
  setCollapseHigh,
  onJump,
  children,
}) {
  if (!summary) return null;
  const risky = byRisk(
    summary.items.filter((i) => i.level !== "high"),
    summary,
    (i) => i.id,
  );
  return html`<div class="eyes row small-text">
    ${
      summary.needEyes
        ? html`<b class="eyes-count">${summary.needEyes} need${summary.needEyes === 1 ? "s" : ""} your eyes</b>
          ${risky.map((i) => html`<button class=${`chip conf-chip conf-${i.level}`} title=${reasonsText(i)} onClick=${() => (onJump ? onJump(i.id) : jumpTo(i.id))}>${i.id}</button>`)}`
        : html`<span class="conf conf-high">● all ${summary.items.length} high confidence</span>`
    }
    <span class="grow"></span>
    ${setRiskFirst ? html`<label class="check"><input type="checkbox" checked=${riskFirst} onChange=${(e) => setRiskFirst(e.target.checked)} /> riskiest first</label>` : null}
    ${setCollapseHigh ? html`<label class="check" title="show high-confidence items as one line"><input type="checkbox" checked=${collapseHigh} onChange=${(e) => setCollapseHigh(e.target.checked)} /> collapse high</label>` : null}
    ${children}
  </div>`;
}

/** D80: the plan first (approve / skip with reasons / your marks stay), then one click. */
export function ApproveHighModal({ artifact, version, onClose, onDone }) {
  const [plan, setPlan] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    post("/api/review-approve-high", { artifact, version })
      .then(setPlan)
      .catch((e) => setErr(e.message));
  }, [artifact, version]);
  const apply = async () => {
    setBusy(true);
    try {
      const r = await post("/api/review-approve-high", { artifact, version, confirm: true });
      onDone(r);
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };
  const what = artifact === "vo" ? "section" : "scene";
  return html`<${Modal} title="Mark high-confidence items reviewed" onClose=${onClose}
      actions=${html`<button class="primary" disabled=${busy || !plan?.approve?.length} onClick=${apply}>Mark ${plan?.approve?.length ?? 0} ${what}(s) reviewed</button>`}>
    ${err ? html`<p class="error">${err}</p>` : null}
    ${
      !plan
        ? html`<p class="muted">checking…</p>`
        : html`<div class="approve-plan">
          <h3 class="small-text">Marks reviewed (${plan.approve.length})</h3>
          ${plan.approve.length ? html`<ul>${plan.approve.map((id) => html`<li class="mono">✓ ${id}</li>`)}</ul>` : html`<p class="muted small-text">No unmarked high-confidence ${what}s.</p>`}
          <h3 class="small-text">Skips — these need your eyes (${plan.skip.length})</h3>
          ${plan.skip.length ? html`<ul>${plan.skip.map((s) => html`<li><span class=${`conf conf-${s.level}`}>● ${s.level}</span> <span class="mono">${s.id}</span> <span class="muted">— ${s.why}</span></li>`)}</ul>` : html`<p class="muted small-text">none</p>`}
          ${plan.kept.length ? html`<h3 class="small-text">Your marks stay (${plan.kept.length})</h3><ul>${plan.kept.map((k) => html`<li><span class="mono">${k.id}</span> <span class="muted">${k.status}</span></li>`)}</ul>` : null}
          <p class="muted small-text">Only the review marks change — approving the version stays a separate step.</p>
        </div>`
    }
  </${Modal}>`;
}

/** Which cards render as one line: carried-over high items always, all high ones with "collapse high"; an expanded card stays open. */
export function useCollapse() {
  const [collapseHigh, setCollapseHigh] = useState(false);
  const [expanded, setExpanded] = useState(new Set());
  const collapsed = (c, extra = false) =>
    !!c && c.level === "high" && (collapseHigh || c.approvedIn !== undefined || extra);
  return {
    collapseHigh,
    setCollapseHigh,
    isCollapsed: (id, c, extra) => !expanded.has(id) && collapsed(c, extra),
    expand: (id) => setExpanded(new Set([...expanded, id])),
  };
}
