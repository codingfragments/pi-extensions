// demo-recording panel — branching stages (S5 part 4, D44–D46): the shared
// stage header, the input picker (which accepted parent version a tab works
// on), and per-version actions: accept, un-accept (with the orphan warning),
// and "work on this" (put it on the working line).
import { html, useState } from "/vendor/preact-htm.module.js";
import { post, useApi } from "./core.js";

export const STAGE_EVENTS =
  /^(storyboard|vo|take|recording|tts|edit|review|project|brand|config|input|annotations|render|stage|line)\./;

export function useStages(events) {
  return useApi("/api/stages", events, STAGE_EVENTS);
}

export const vLabel = (stage, n) =>
  stage === "recording" ? `take-${String(n).padStart(3, "0")}` : `v${n}`;
const STAGE_NAMES = {
  storyboard: "storyboard",
  recording: "recording",
  vo: "voice-over",
  annotations: "annotations",
  render: "render",
};

export const stageOf = (stages, stage) => stages?.stages?.find((x) => x.stage === stage);
export const acceptedInfo = (stages, stage, v) =>
  stageOf(stages, stage)?.accepted?.find((a) => a.version === v);

/** Picker for a tab's input: the accepted, usable versions of the parent stage (with lineage). */
export function InputPicker({ stages, stage }) {
  const s = stageOf(stages, stage);
  if (!s?.parent) return null;
  const parentName = STAGE_NAMES[s.parent];
  if (!s.inputs?.length)
    return html`<span class="muted small-text">no accepted ${parentName} yet — accept one first</span>`;
  const select = async (e) => {
    try {
      await post("/api/select", { artifact: s.parent, version: Number(e.target.value) });
    } catch (err) {
      alert(err.message);
    }
  };
  return html`<label class="input-picker small-text">input ${parentName}
    <select value=${s.input ?? ""} onChange=${select}>
      ${s.input === undefined ? html`<option value="">— pick —</option>` : null}
      ${s.inputs.map((i) => html`<option value=${i.version}>${i.label}${i.version === s.input ? " (working line)" : ""}</option>`)}
    </select></label>`;
}

/** Accept / Un-accept / Work on this — for one version of a stage. */
export function VersionActions({
  stages,
  stage,
  version,
  label,
  disabled,
  disabledWhy,
  unlocks,
  onDone,
}) {
  const [busy, setBusy] = useState(false);
  const info = acceptedInfo(stages, stage, version);
  const onLine = stageOf(stages, stage)?.selected === version;
  const what = label ?? `${STAGE_NAMES[stage]} ${vLabel(stage, version)}`;
  const run = async (fn) => {
    setBusy(true);
    try {
      await fn();
      onDone?.();
    } catch (e) {
      alert(`${what}: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };
  const accept = () =>
    confirm(
      `Accept ${what}? ${unlocks ?? ""}\n\nAccepting resets nothing: other accepted versions stay valid inputs.`,
    ) && run(() => post("/api/approve", { artifact: stage, version }));
  const unaccept = async () => {
    let orphans = [];
    try {
      ({ orphans } = await post("/api/unaccept-preview", { artifact: stage, version }));
    } catch (e) {
      return alert(e.message);
    }
    const list = orphans.length
      ? `\n\nBuilt on it and accepted — these become orphaned (kept, but not usable until ${what} is accepted again):\n${orphans.map((o) => `• ${o.label}`).join("\n")}`
      : "";
    if (confirm(`Un-accept ${what}?${list}`))
      run(() => post("/api/unaccept", { artifact: stage, version }));
  };
  if (!info)
    return html`<button class="primary" disabled=${busy || disabled} title=${disabledWhy ?? ""} onClick=${accept}>Accept ${vLabel(stage, version)}</button>`;
  return html`<span class="version-actions">
    <span class="badge approved">accepted</span>
    ${info.orphaned ? html`<span class="badge stale" title=${info.orphaned}>orphaned</span>` : null}
    ${onLine ? html`<span class="badge line">working line</span>` : html`<button disabled=${busy || !!info.orphaned} title=${info.orphaned ?? "make this the working line (the agent works on it; later stages follow)"} onClick=${() => run(() => post("/api/select", { artifact: stage, version }))}>Work on this</button>`}
    <button class="ghost" disabled=${busy} onClick=${unaccept}>Un-accept</button>
  </span>`;
}

/** Header strip of a stage tab: input, accepted versions, working line, orphan flags, next step. */
export function StageHeader({ stages, stage, children }) {
  const s = stageOf(stages, stage);
  if (!s) return null;
  const next = stages.next;
  // Only versions on the selected input count here (v3 of take-006 is not "accepted" for take-005).
  const onInput = s.parent ? s.accepted.filter((a) => s.onInput.includes(a.version)) : s.accepted;
  const elsewhere = s.accepted.length - onInput.length;
  const orphans = onInput.filter((a) => a.orphaned);
  return html`<div class="stage-head">
    <span class="stage-name">${STAGE_NAMES[stage]}</span>
    ${s.parent ? html`<${InputPicker} stages=${stages} stage=${stage} />` : null}
    <span class="muted small-text">${
      s.parent
        ? s.input !== undefined
          ? `${s.onInput.length} version${s.onInput.length === 1 ? "" : "s"} on this input`
          : "pick an input"
        : `${s.versions.length} version${s.versions.length === 1 ? "" : "s"}`
    }</span>
    ${
      onInput.length
        ? html`<span class="badge approved">accepted ${onInput.map((a) => vLabel(stage, a.version)).join(", ")}</span>`
        : html`<span class="badge old">none accepted${s.parent ? " on this input" : ""}</span>`
    }
    ${elsewhere > 0 ? html`<span class="muted small-text">+${elsewhere} accepted on other inputs</span>` : null}
    ${s.selected !== undefined ? html`<span class="badge line">working line ${vLabel(stage, s.selected)}</span>` : null}
    ${orphans.length ? html`<span class="badge stale" title=${orphans.map((o) => `${vLabel(stage, o.version)}: ${o.orphaned}`).join("\n")}>${orphans.length} orphaned</span>` : null}
    <span class="grow"></span>
    ${children}
    ${next?.stage === stage ? html`<span class=${`next ${next.who ?? ""}`}>${next.who === "user" ? "→ you: " : next.who === "agent" ? "→ agent: " : ""}${next.text}</span>` : null}
  </div>`;
}
