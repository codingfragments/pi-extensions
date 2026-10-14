// demo-recording panel — stage chain helpers (S5 part 4, D30/D33/D39):
// the shared stage header and the cascade-aware approval confirmation.
import { html } from "/vendor/preact-htm.module.js";
import { post, useApi } from "./core.js";

export const STAGE_EVENTS =
  /^(storyboard|vo|take|recording|tts|edit|review|project|brand|config|input|annotations|render)\./;

export function useStages(events) {
  return useApi("/api/stages", events, STAGE_EVENTS);
}

const vLabel = (stage, n) =>
  stage === "recording" ? `take-${String(n).padStart(3, "0")}` : `v${n}`;

/**
 * Dry-run an approval, then confirm with the user — listing what the stage
 * chain would reset. Returns true when the user confirmed (the caller approves).
 */
export async function confirmApproval(artifact, version, what, unlocks) {
  let resets = [];
  try {
    ({ resets } = await post("/api/approve-preview", { artifact, version }));
  } catch (e) {
    alert(`Can't approve ${what}:\n\n${e.message}`);
    return false;
  }
  const resetText = resets.length
    ? `\n\nThis resets (stage chain):\n${resets.map((r) => `• ${r.label} — ${r.reason}`).join("\n")}\nNothing is deleted; you can approve them again later if they still fit.`
    : "";
  return confirm(`Approve ${what}? ${unlocks}${resetText}`);
}

/** Header strip of a stage tab: lineage, approval, stale flag, what approving here would reset. */
export function StageHeader({ stages, stage }) {
  const s = stages?.stages?.find((x) => x.stage === stage);
  if (!s) return null;
  const parent = s.parent ? stages.stages.find((x) => x.stage === s.parent) : null;
  const next = stages.next;
  return html`<div class="stage-head">
    <span class="stage-name">${s.label}</span>
    ${
      s.versions.length
        ? html`<span class="muted small-text">${s.versions.length} version${s.versions.length > 1 ? "s" : ""} · latest ${vLabel(stage, s.latest)}
            ${parent && s.latestBasedOn ? html` · based on ${parent.label} ${vLabel(parent.stage, s.latestBasedOn)}` : null}</span>`
        : html`<span class="muted small-text">no versions yet</span>`
    }
    ${s.approved ? html`<span class="badge approved">approved ${vLabel(stage, s.approved)}</span>` : html`<span class="badge old">not approved</span>`}
    ${s.stale ? html`<span class="badge stale" title="the latest version is not based on the approved parent">stale: ${s.stale}</span>` : null}
    <span class="grow"></span>
    ${s.downstreamApproved?.length ? html`<span class="muted small-text" title="approving a different version here resets what no longer chains up">approving another version resets ${s.downstreamApproved.join(", ")}</span>` : null}
    ${next?.stage === stage ? html`<span class=${`next ${next.who ?? ""}`}>${next.who === "user" ? "→ you: " : next.who === "agent" ? "→ agent: " : ""}${next.text}</span>` : null}
  </div>`;
}
