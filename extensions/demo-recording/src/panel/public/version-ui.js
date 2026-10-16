// Versions in the panel (UX3, D99, D103, D118): what you are viewing and how it relates to the
// production line, a History of every version, and the four actions with their consequence.
//
//   Approve & use     approve it and make it part of the production line
//   Approve only      approve it and leave the line exactly as it is
//   Use for next steps put an already approved version on the line
//   Withdraw approval take the approval back (what is built on it becomes "blocked by dependency")
//
// Browsing never writes: a View link only changes the route. Every action asks the engine for a free
// plan first (POST /api/version-plan) and applies it once, only if the project is still as planned.
import {
  html,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "/vendor/preact-htm.module.js";
import { post, useApi } from "./core.js";
import { CostHint, getModels } from "./cost.js";
import { ask, errorToast, toast } from "./dialog.js";
import { formatRoute } from "./route.js";

export const HISTORY_EVENTS =
  /^(storyboard|vo|take|recording|tts|edit|review|project|input|annotations|render|stage|line)\./;

/** Every version of a stage and where it stands (GET /api/history), refetched when stages change. */
export const useHistory = (stage, events) =>
  useApi(`/api/history?stage=${stage}`, events, HISTORY_EVENTS);

const SCREEN = {
  storyboard: "storyboard",
  recording: "recording",
  vo: "voice",
  annotations: "annotations",
  render: "render",
};
const NAME = {
  storyboard: "Storyboard",
  recording: "Recording",
  vo: "Voice over",
  annotations: "Annotations",
  render: "Render",
};
export const stageTitle = (stage) => NAME[stage];

const ago = (iso) => {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 90
    ? "just now"
    : s < 5400
      ? `${Math.round(s / 60)} min ago`
      : s < 129600
        ? `${Math.round(s / 3600)} h ago`
        : `${Math.round(s / 86400)} d ago`;
};

/** The badges of one history row, each an icon and a word. */
export function RowBadges({ row, viewing }) {
  const kind = row.kind === "final" ? "Final render" : row.kind === "draft" ? "Draft render" : null;
  return html`<span class="ds-row-flex" style="gap:var(--space-1)">
    ${kind ? html`<span class="ds-badge" data-tone="neutral">${kind}</span>` : null}
    ${viewing ? html`<span class="ds-badge" data-tone="info"><span class="ds-badge-ico" aria-hidden="true">i</span>Viewing</span>` : null}
    ${row.inLine ? html`<span class="ds-badge" data-tone="accent"><span class="ds-badge-ico" aria-hidden="true">▶</span>In production line</span>` : null}
    ${
      row.blocked
        ? html`<span class="ds-badge" data-tone="err" title=${row.blocked}><span class="ds-badge-ico" aria-hidden="true">!</span>Blocked by dependency</span>`
        : row.approved
          ? html`<span class="ds-badge" data-tone="ok"><span class="ds-badge-ico" aria-hidden="true">✓</span>Approved</span>`
          : html`<span class="ds-badge" data-tone="neutral"><span class="ds-badge-ico" aria-hidden="true">✎</span>Draft version</span>`
    }
  </span>`;
}

/** How the viewed version relates to the production line, in words (null when there is nothing to say). */
export function lineNotice(stage, row, rows) {
  if (!row || row.inLine) return null;
  const inLine = rows?.find((r) => r.inLine);
  const name = NAME[stage];
  let what;
  if (row.blocked) what = `a version that is blocked by dependency (${row.blocked})`;
  else if (!row.approved)
    what = inLine && row.version > inLine.version && row.onInput ? "a new draft" : "a draft";
  else if (!row.onInput) what = "an approved version on another branch";
  else what = "an approved alternative";
  return inLine
    ? `You are viewing ${what}. ${name} ${inLine.short} is in the production line, so the next steps still use ${inLine.short}.`
    : `You are viewing ${what}. Nothing is in the production line for ${name.toLowerCase()} yet.`;
}

/** The History: every version, where it came from, and a link to look at it. Looking never changes anything. */
export function History({ stage, rows, viewed, onUse }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const button = useRef(null);
  useLayoutEffect(() => {
    if (!open) return;
    wrap.current?.querySelector(".ds-histpop a, .ds-histpop button")?.focus(); // into the list, not back onto the History button
    const onKey = (e) => {
      if (e.key === "Escape" && !document.querySelector(".modal-backdrop")) {
        e.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }
    };
    const onDown = (e) => {
      if (!wrap.current?.contains(e.target)) setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [open]);
  const list = rows ?? [];
  return html`<div class="ds-histwrap" ref=${wrap}>
    <button ref=${button} class="ds-btn history-btn" type="button" aria-expanded=${open} aria-controls=${`history-${stage}`} onClick=${() => setOpen((o) => !o)}>History${list.length ? ` · ${list.length}` : ""}</button>
    ${
      open
        ? html`<div class="ds-popover ds-histpop" id=${`history-${stage}`} role="dialog" aria-label=${`${NAME[stage]} history`}>
            ${
              list.length
                ? list.map(
                    (
                      r,
                    ) => html`<div class="ds-version" key=${r.version} aria-current=${viewed === r.version ? "true" : undefined}>
                      <span>
                        <a href=${formatRoute({ screen: SCREEN[stage], version: r.version })} onClick=${() => setOpen(false)}><strong>${r.short}</strong></a>
                        ${r.basedOn ? html` <span class="ds-muted ds-small">· based on ${r.basedOn.label}</span>` : null}
                        ${!r.onInput && r.basedOn ? html` <span class="ds-muted ds-xs">(another branch)</span>` : null}
                        <span class="ds-muted ds-xs"> ${ago(r.at)}</span>
                        <br /><${RowBadges} row=${r} viewing=${viewed === r.version} />
                      </span>
                      <span class="ds-row-flex">
                        ${
                          r.approved && !r.inLine && !r.blocked
                            ? html`<button class="ds-btn ds-btn--sm" type="button" onClick=${() => {
                                setOpen(false);
                                onUse?.(r.version);
                              }}>Use for next steps</button>`
                            : null
                        }
                      </span>
                    </div>`,
                  )
                : html`<div class="ds-version"><span class="ds-muted">No versions yet.</span></div>`
            }
          </div>`
        : null
    }
  </div>`;
}

/** The head of a stage screen: what you are viewing, how it relates to the production line, History. */
export function StageSummary({ stage, row, rows, viewed, meta, onUse, children }) {
  const notice = lineNotice(stage, row, rows);
  // a version in the address that does not exist is said, not silently replaced
  const missing =
    viewed !== null && viewed !== undefined && rows && !rows.some((r) => r.version === viewed);
  return html`<div class="ds-root ds-stack stage-summary">
    <div class="ds-stagehead">
      <div class="ds-grow">
        <h1>${NAME[stage]}</h1>
        <div class="ds-stagehead-meta">
          ${row ? html`<span>Viewing <strong style="color:var(--text-strong)">${row.short}</strong></span><${RowBadges} row=${row} />${row.basedOn ? html`<span>Based on ${row.basedOn.label}</span>` : null}` : null}
          ${meta ?? null}
        </div>
      </div>
      ${children ?? null}
      <${History} stage=${stage} rows=${rows} viewed=${viewed} onUse=${onUse} />
    </div>
    ${missing ? html`<div class="ds-notice" data-tone="warn" role="note"><span class="ds-status" data-tone="warn" aria-hidden="true">!</span><div>${NAME[stage]} ${stage === "recording" ? `take-${String(viewed).padStart(3, "0")}` : `v${viewed}`} does not exist. <a href=${formatRoute({ screen: SCREEN[stage] })}>Show the latest</a></div></div>` : null}
    ${notice ? html`<div class="ds-notice" role="note"><span class="ds-status" data-tone="info" aria-hidden="true">i</span><div>${notice}</div></div>` : null}
  </div>`;
}

// ---------------------------------------------------------------- actions

const changeLines = (plan) =>
  plan.line.changes.map(
    (c) =>
      `${NAME[c.stage]}: ${c.from ?? "none"} → ${c.to ?? "none"}${c.to === null ? " (stays approved)" : ""}`,
  );

/** The dialog that states the consequence, for the actions where something leaves or changes in the line. */
function dialogFor(plan, stale) {
  const turn = plan.intent === "approve-use";
  const model = getModels()?.session;
  const base = { cancelLabel: "Cancel" };
  const lines = changeLines(plan);
  const facts = [
    ["Production line now", plan.line.before],
    ["After", plan.line.after],
  ];
  const note = stale
    ? "The project changed while you were looking; this is what happens now."
    : "Earlier versions and approvals stay.";
  if (plan.intent === "approve-use")
    return {
      ...base,
      title: `Approve and use ${plan.label}?`,
      text: `${note}${turn ? `\n\nThe Director continues from it (starts an agent turn${model ? ` on ${model.split("/").slice(1).join("/") || model}` : ""}).` : ""}`,
      facts,
      list: lines.length ? { title: "The production line changes:", items: lines } : undefined,
      confirmLabel: plan.stage === "render" ? "Approve final" : "Approve & use",
    };
  if (plan.intent === "use")
    return {
      ...base,
      title: `Use ${plan.label} for the next steps?`,
      text: note,
      facts,
      list: { title: "The production line changes:", items: lines },
      confirmLabel: "Use for next steps",
    };
  return {
    ...base,
    title: `Withdraw the approval of ${plan.label}?`,
    text: `${note} Nothing is deleted; you can approve it again.`,
    facts,
    list: plan.blocked.length
      ? {
          title:
            "Built on it and approved: these become blocked by dependency until it is approved again:",
          items: plan.blocked.map((b) => b.label),
        }
      : undefined,
    confirmLabel: "Withdraw approval",
  };
}

const DONE = {
  "approve-use": (p) => `${p.label} approved and in the production line.`,
  "approve-only": (p) => `${p.label} approved. The production line is unchanged.`,
  use: (p) => `${p.label} is now in the production line.`,
  withdraw: (p) => `Approval of ${p.label} withdrawn.`,
};

/**
 * Run one action: plan, ask only when something leaves or changes in the line (or something becomes
 * blocked), apply once, and tell the user what happened. A stale plan is shown again, never applied.
 */
export async function runVersionAction({ stage, version, intent }) {
  let plan = await post("/api/version-plan", { stage, version, intent });
  if (plan.blockers.length) {
    await ask({
      title: "This can't be done",
      text: plan.blockers.join("\n"),
      confirmLabel: "OK",
      cancelLabel: "Close",
    });
    return false;
  }
  let stale = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const consequence =
      plan.line.changes.some((c) => c.from !== null) ||
      (intent === "withdraw" && plan.blocked.length > 0);
    if (stale || consequence) {
      const r = await ask(dialogFor(plan, stale));
      if (r === null) return false;
    }
    const res = await post("/api/version-act", { stage, version, intent, token: plan.token });
    if (!res.stale) {
      toast(DONE[intent](plan), { kind: "info" });
      return true;
    }
    plan = res.plan;
    stale = true;
    if (plan.blockers.length) {
      await ask({
        title: "This can't be done any more",
        text: plan.blockers.join("\n"),
        confirmLabel: "OK",
        cancelLabel: "Close",
      });
      return false;
    }
  }
  return false;
}

/** The plans of the viewed version for the actions that apply to it, so buttons can say why they are disabled. */
function usePlans(stage, row, events) {
  const [plans, setPlans] = useState({});
  const key = row
    ? `${stage}:${row.version}:${row.approved}:${row.inLine}:${row.blocked ?? ""}`
    : "";
  const stamp = events.filter((e) => HISTORY_EVENTS.test(e.type)).at(-1)?.seq ?? 0;
  useEffect(() => {
    if (!row) return setPlans({});
    let stop = false;
    const intents = row.approved ? ["use", "withdraw"] : ["approve-use", "approve-only"];
    Promise.all(
      intents.map((intent) =>
        post("/api/version-plan", { stage, version: row.version, intent }).then(
          (p) => [intent, p],
          () => [intent, null],
        ),
      ),
    ).then((all) => !stop && setPlans(Object.fromEntries(all)));
    return () => {
      stop = true;
    };
  }, [key, stamp]);
  return plans;
}

const firstBlocker = (p) => (p?.blockers?.length ? p.blockers[0] : "");

/**
 * The actions for one version. `eager` fetches the plans up front, so a disabled button states why
 * (single-version screens); in lists it checks on click and says why then.
 */
export function VersionActions({
  stage,
  row,
  events = [],
  eager = true,
  onDone,
  label,
  compact,
  knownWhy,
}) {
  const [busy, setBusy] = useState(false);
  const plans = eager ? usePlans(stage, row, events) : {};
  const run = useCallback(
    async (intent) => {
      setBusy(true);
      try {
        if (await runVersionAction({ stage, version: row.version, intent })) onDone?.();
      } catch (e) {
        errorToast(e, label ?? row.label);
      } finally {
        setBusy(false);
      }
    },
    [stage, row?.version, onDone, label],
  );
  if (!row) return null;
  const why = (intent) =>
    eager ? firstBlocker(plans[intent]) : intent.startsWith("approve") ? (knownWhy ?? "") : "";
  const btn = (intent, text, cls = "") => {
    const reason = why(intent);
    const id = `why-${stage}-${row.version}-${intent}`;
    return html`<span class="ds-actionwrap">
      <button class=${`ds-btn ${cls}${compact ? " ds-btn--sm" : ""}`} type="button" aria-busy=${busy ? "true" : undefined}
        aria-disabled=${reason ? "true" : undefined} aria-describedby=${reason ? id : undefined} data-intent=${intent}
        onClick=${() => !reason && !busy && run(intent)}>${text}</button>
      ${reason ? html`<span class="ds-why" id=${id}>${reason}</span>` : null}
    </span>`;
  };
  const final = stage === "render";
  const approveUse = final ? `Approve final ${row.short}` : `Approve & use ${row.short}`;
  return html`<span class="ds-row-flex version-actions">
    ${
      !row.approved
        ? html`${btn("approve-use", approveUse, "ds-btn--primary")}
            <${CostHint} />
            ${btn("approve-only", "Approve only")}`
        : html`${!row.inLine && !row.blocked ? btn("use", "Use for next steps", "ds-btn--primary") : null}
            ${btn("withdraw", "Withdraw approval", "ds-btn--ghost")}`
    }
  </span>`;
}
