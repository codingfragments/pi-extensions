// The fix loop in the panel (P1c Q3): flag findings (Fix / Leave), write context, ask the Director for suggested fixes, decide on
// its proposals, give it more context and ask it to rethink. Nothing here applies a fix.
import { html, useEffect, useMemo, useRef, useState } from "/vendor/preact-htm.module.js";
import { api, post, useApi } from "./core.js";
import { CostHint } from "./cost.js";
import { errorToast } from "./dialog.js";

const STAGE_TAB = {
  storyboard: "storyboard",
  recording: "recording",
  vo: "voice",
  annotations: "annotations",
  render: "render",
};
const STAGE_WORD = {
  discovery: "Discovery",
  storyboard: "Storyboard",
  recording: "Recording",
  vo: "Voice over",
  annotations: "Annotations",
  render: "Render again",
};

/** The flags, the context and the open fix set of a render, kept in step with the server. */
export function useFixes(version, events) {
  const { data, reload } = useApi(`/api/qa-fixes?version=${version}`, events ?? [], /^qa\./);
  const [flags, setFlags] = useState({});
  const [guidance, setGuidance] = useState("");
  const loaded = useRef(null);
  // adopt the server's draft once per fix set (and again after an ask clears nothing: the draft stays what you wrote)
  useEffect(() => {
    if (!data) return;
    const key = `${version}:${data.fixset?.id ?? "none"}`;
    if (loaded.current === key) return;
    loaded.current = key;
    const draft = data.fixset?.draft;
    setFlags(Object.fromEntries((draft?.flags ?? []).map((f) => [f.id, f.choice])));
    setGuidance(draft?.guidance ?? "");
  }, [data, version]);
  const save = async (nextFlags, nextGuidance) => {
    try {
      await post("/api/qa-fix-flag", {
        version,
        flags: Object.entries(nextFlags).map(([id, choice]) => ({ id, choice })),
        guidance: nextGuidance,
      });
    } catch (e) {
      errorToast(e, "saving your flags");
    }
  };
  const setFlag = (id, choice) => {
    const next = { ...flags };
    if (next[id] === choice) Reflect.deleteProperty(next, id);
    else next[id] = choice;
    setFlags(next);
    save(next, guidance);
  };
  const setMany = (ids, choice) => {
    const next = { ...flags };
    for (const id of ids) {
      if (choice) next[id] = choice;
      else Reflect.deleteProperty(next, id);
    }
    setFlags(next);
    save(next, guidance);
  };
  const writeGuidance = (g) => setGuidance(g);
  return {
    data,
    reload,
    flags,
    guidance,
    setFlag,
    setMany,
    writeGuidance,
    saveGuidance: () => save(flags, guidance),
    can: new Set(data?.flaggable ?? []),
  };
}

/** Fix / Leave on one finding. */
export function FlagChips({ id, fixes }) {
  if (!fixes.can.has(id)) return null;
  const v = fixes.flags[id];
  return html`<span class="ds-seg flag-chips" role="group" aria-label="Flag this finding">
    <button type="button" data-flag="fix" aria-pressed=${v === "fix"} title="Ask the Director to fix this" onClick=${() => fixes.setFlag(id, "fix")}>Fix</button>
    <button type="button" data-flag="leave" aria-pressed=${v === "leave"} title="Leave it as it is (not the same as Ignore: it comes back next time)" onClick=${() => fixes.setFlag(id, "leave")}>Leave</button>
  </span>`;
}

/** Flag many at once: all that need your eyes, all, none. */
export function FlagToolbar({ items, fixes }) {
  const ids = items.filter((i) => fixes.can.has(i.id)).map((i) => i.id);
  if (!ids.length) return null;
  const eyes = items
    .filter((i) => fixes.can.has(i.id) && (i.high || i.level === "blocking"))
    .map((i) => i.id);
  const n = ids.filter((id) => fixes.flags[id] === "fix").length;
  return html`<div class="flag-toolbar small-text" role="group" aria-label="Flag findings to fix">
    <span class="muted">Fix:</span>
    ${eyes.length ? html`<button class="ds-btn ds-btn--ghost ds-btn--sm" type="button" data-act="flag-eyes" onClick=${() => fixes.setMany(eyes, "fix")}>all that need your eyes (${eyes.length})</button>` : null}
    <button class="ds-btn ds-btn--ghost ds-btn--sm" type="button" data-act="flag-all" onClick=${() => fixes.setMany(ids, "fix")}>all (${ids.length})</button>
    <button class="ds-btn ds-btn--ghost ds-btn--sm" type="button" data-act="flag-none" onClick=${() => fixes.setMany(ids, null)}>none</button>
    <span class="muted">${n} flagged to fix</span>
  </div>`;
}

function Proposal({ p, set, items, reload }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(p.edited ?? p.change);
  const [note, setNote] = useState(p.note ?? "");
  const decide = async (body) => {
    try {
      await post("/api/qa-fix-decide", { fixset: set.id, proposal: p.id, ...body });
      reload();
    } catch (e) {
      errorToast(e, "your decision");
    }
  };
  const gist = (id) => (items.find((i) => i.id === id)?.message ?? id).slice(0, 90);
  return html`<li class="fix-proposal" data-stage=${p.stage} data-decision=${p.decision}>
    <div class="row"><span class="ds-badge" data-tone="accent">${STAGE_WORD[p.stage]}</span><b class="qa-msg">${p.title}</b></div>
    ${editing ? html`<textarea class="ds-textarea" aria-label="Your wording of the change" value=${text} onInput=${(e) => setText(e.target.value)}></textarea>` : html`<p class="fix-change">${p.edited ?? p.change}${p.edited ? html` <span class="ds-badge" data-tone="info">your wording</span>` : null}</p>`}
    <p class="small-text muted"><b>Why:</b> ${p.why}</p>
    <p class="small-text muted"><b>Answers:</b> ${p.findings.map((f) => html`<span class="fix-finding" key=${f} title=${gist(f)}>${f}</span> `)}</p>
    ${p.cost ? html`<p class="small-text muted"><b>Applying it costs:</b> ${p.cost}</p>` : null}
    <div class="row fix-decide">
      <span class="ds-seg" role="group" aria-label="Your decision">
        <button type="button" data-decision="accepted" aria-pressed=${p.decision === "accepted"} onClick=${() => decide({ decision: p.decision === "accepted" ? "undecided" : "accepted" })}>Accept</button>
        <button type="button" data-decision="rejected" aria-pressed=${p.decision === "rejected"} onClick=${() => decide({ decision: p.decision === "rejected" ? "undecided" : "rejected" })}>Reject</button>
      </span>
      ${
        editing
          ? html`<button class="ds-btn ds-btn--sm ds-btn--primary" type="button" onClick=${async () => {
              await decide({ edited: text });
              setEditing(false);
            }}>Save my wording</button><button class="ds-btn ds-btn--ghost ds-btn--sm" type="button" onClick=${() => setEditing(false)}>Cancel</button>`
          : html`<button class="ds-btn ds-btn--ghost ds-btn--sm" type="button" data-act="edit-proposal" onClick=${() => {
              setText(p.edited ?? p.change);
              setEditing(true);
            }}>Edit the wording</button>`
      }
    </div>
    <input class="ds-input fix-note" aria-label="Your note on this proposal" placeholder="a note for the Director (kept when you ask it to rethink)" value=${note} onInput=${(e) => setNote(e.target.value)} onChange=${() => decide({ note })} />
  </li>`;
}

/** The Fixes section of a render's quality check. */
export function FixesPanel({ r, items, fixes }) {
  const set = fixes.data?.fixset;
  const round = set?.rounds?.at(-1);
  const flagged = Object.values(fixes.flags).filter((c) => c === "fix").length;
  const waiting = round?.status === "asked";
  const [busy, setBusy] = useState(false);
  const accepted = useMemo(
    () => (round?.proposals ?? []).filter((p) => p.decision === "accepted"),
    [round],
  );
  const ask = async () => {
    setBusy(true);
    try {
      await post("/api/qa-fix-ask", {
        version: r.version,
        flags: Object.entries(fixes.flags).map(([id, choice]) => ({ id, choice })),
        guidance: fixes.guidance,
      });
      fixes.reload();
    } catch (e) {
      errorToast(e, "asking the Director");
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    try {
      await post("/api/qa-fix-cancel", { fixset: set.id });
      fixes.reload();
    } catch (e) {
      errorToast(e, "cancelling");
    }
  };
  if (!fixes.can.size && !set?.rounds?.length) return null;
  const proposed = round?.status === "proposed";
  const applying = set?.applying;
  const writing = applying && !applying.version && !applying.kept;
  const applied = applying?.version !== undefined;
  const earliestAccepted = accepted[0]?.stage;
  const startsItself = earliestAccepted === "recording" || earliestAccepted === "discovery";
  const apply = async () => {
    setBusy(true);
    try {
      await post("/api/qa-fix-apply", { fixset: set.id });
      fixes.reload();
    } catch (e) {
      errorToast(e, "applying");
    } finally {
      setBusy(false);
    }
  };
  const pending = fixes.data?.pending ?? [];
  return html`<section class="fixes ds-stack" aria-label="Fixes">
    <h4 class="qa-head">Fixes</h4>
    ${waiting ? html`<div class="ds-notice" data-tone="info" role="status"><span class="ds-status" data-tone="info" aria-hidden="true">◔</span><div class="ds-grow">Waiting for the Director: it is working on round ${round.n} (the band above says what it is doing).</div><button class="ds-btn ds-btn--sm" type="button" data-act="cancel-ask" onClick=${cancel}>Cancel this ask</button></div>` : null}
    ${round?.status === "failed" ? html`<div class="ds-notice" data-tone="warn" role="note"><span class="ds-status" data-tone="warn" aria-hidden="true">!</span><div>Round ${round.n} did not get an answer (${round.summary}). You can ask again.</div></div>` : null}
    ${
      proposed
        ? html`<div class="fix-answer">
      <p class="small-text"><b>The Director's answer</b> (round ${round.n}): ${round.summary}</p>
      ${round.earliest ? html`<p class="small-text" data-earliest=${round.earliest}>The earliest stage that needs a fix: <b>${STAGE_WORD[round.earliest]}</b>. One run there fixes ${round.proposals[0].findings.length} finding${round.proposals[0].findings.length === 1 ? "" : "s"}; later stages follow from it.</p>` : null}
      <ol class="fix-list">${round.proposals.map((p) => html`<${Proposal} key=${`${round.n}-${p.id}-${p.decision}-${p.edited ?? ""}`} p=${p} set=${set} items=${items} reload=${fixes.reload} />`)}</ol>
      ${round.unresolved?.length ? html`<div class="ds-notice" data-tone="warn" role="note"><span class="ds-status" data-tone="warn" aria-hidden="true">!</span><div><b>The Director could not fix:</b><ul>${round.unresolved.map((u) => html`<li key=${u.finding}><span class="fix-finding">${u.finding}</span> ${u.why}</li>`)}</ul></div></div>` : null}
      <p class="small-text muted">${accepted.length ? `${accepted.length} accepted, from ${STAGE_WORD[accepted[0].stage]} on.` : "Nothing accepted yet."} ${applying ? "" : "Nothing changes until you apply the accepted proposals."}</p>
      ${
        !applying && accepted.length
          ? html`<div class="row fix-apply"><button class="ds-btn ds-btn--primary" type="button" data-act="apply-fixes" disabled=${busy} onClick=${apply}>${startsItself ? `Keep the ${accepted.length} accepted fix${accepted.length === 1 ? "" : "es"} for when I start the ${STAGE_WORD[earliestAccepted].toLowerCase()}` : `Apply ${accepted.length} accepted proposal${accepted.length === 1 ? "" : "s"}`}</button>${startsItself ? null : html`<${CostHint} />`}</div>
        <p class="small-text muted">${startsItself ? `A ${STAGE_WORD[earliestAccepted].toLowerCase()} is something you start yourself: the fixes are remembered and the Director takes them into account then.` : `The Director writes ONE new ${STAGE_WORD[earliestAccepted].toLowerCase()} draft from them. Nothing is rendered and nothing is synthesized: you read the draft, verify it and approve it, and only then does the voice cost anything.`}</p>`
          : null
      }
    </div>`
        : null
    }
    ${writing ? html`<div class="ds-notice" data-tone="info" role="status"><span class="ds-status" data-tone="info" aria-hidden="true">◔</span><div class="ds-grow">The Director is writing the ${STAGE_WORD[applying.stage].toLowerCase()} draft from the fixes you accepted (the band above says what it is doing).</div></div>` : null}
    ${applied ? html`<div class="ds-notice" data-tone="ok" role="status" data-applied=${applying.stage}><span class="ds-status" data-tone="ok" aria-hidden="true">✓</span><div class="ds-grow"><b>Applied.</b> ${STAGE_WORD[applying.stage]} v${applying.version} is a new draft written from your accepted fixes. Read it and approve it in the <a href=${`#/${STAGE_TAB[applying.stage]}`}>${STAGE_WORD[applying.stage]}</a> tab; nothing was rendered or synthesized.</div></div>` : null}
    ${applying?.kept ? html`<div class="ds-notice" data-tone="info" role="note"><span class="ds-status" data-tone="info" aria-hidden="true">i</span><div class="ds-grow">The earliest accepted fix is for the ${STAGE_WORD[applying.stage].toLowerCase()}, which you start yourself. The fixes are kept as pending fixes.</div></div>` : null}
    ${pending.length ? html`<div class="fix-pending"><p class="small-text"><b>Pending fixes</b> (kept for their stage; its writer takes them into account):</p><ul class="small-text">${pending.map((x) => html`<li key=${x.id} data-stage=${x.stage}><span class="ds-badge" data-tone="neutral">${STAGE_WORD[x.stage]}</span> ${x.text}</li>`)}</ul></div>` : null}
    ${
      applying
        ? null
        : html`<label class="ds-field"><span class="ds-label">${proposed ? "More context: ask the Director to rethink" : "Context for the Director (optional)"}</span>
      <textarea class="ds-textarea" data-field="guidance" placeholder=${proposed ? "what it missed, what you want different, what to keep…" : "what matters here, what to keep, what you would rather not change…"} value=${fixes.guidance} onInput=${(e) => fixes.writeGuidance(e.target.value)} onBlur=${fixes.saveGuidance}></textarea></label>
    <div class="row">
      <button class="ds-btn ds-btn--primary" type="button" data-act="ask-fixes" disabled=${busy || waiting || !flagged} title=${flagged ? "" : "flag at least one finding as Fix"} onClick=${ask}>${proposed ? "Ask the Director to rethink" : "Ask the Director for suggested fixes"} (${flagged} flagged)</button>
      <${CostHint} />
    </div>`
    }
  </section>`;
}
