// What the frame says (UX2, D98): where each stage stands, what needs you, what runs.
// Pure functions over the engine's data (/api/stages, /api/jobs, the activity rows), tested in Node.
//
// The rules (docs/UX.md §2):
//  - the viewed screen, the production line, the review status and the job status are separate things;
//  - a stage is complete only when its version in the production line is approved and usable: an
//    approval on an unrelated branch does not complete it;
//  - "running" comes from real engine jobs (or a live discovery), never from "the Director has not
//    started yet"; no percentage is invented for a job without progress.

import { stepOf } from "./steps.js";

/** The production stages in order, with the panel tab of each. */
export const STEPS = [
  { tab: "storyboard", stage: "storyboard", label: "Storyboard" },
  { tab: "recording", stage: "recording", label: "Recording" },
  { tab: "voice", stage: "vo", label: "Voice over" },
  { tab: "annotations", stage: "annotations", label: "Annotations" },
  { tab: "render", stage: "render", label: "Render" },
];

/** Which stage an engine job works for. */
export const JOB_STAGE = {
  record: "recording",
  tts: "vo",
  edit: "vo",
  design: "annotations",
  render: "render",
};
export const JOB_TITLE = {
  record: "Recording",
  tts: "Voice",
  edit: "Edit and draft render",
  design: "Annotation designer",
  render: "Render",
};

export const stepOfStage = (stage) => STEPS.find((s) => s.stage === stage);
export const vLabel = (stage, n) =>
  stage === "recording" ? `take-${String(n).padStart(3, "0")}` : `v${n}`;
const capital = (s) => String(s).replace(/^./, (c) => c.toUpperCase());

/** Versions on this stage's input that came after the newest accepted one, and are not accepted: waiting for review. */
export function pendingDrafts(s) {
  if (!s) return [];
  const accepted = new Set((s.accepted ?? []).map((a) => a.version));
  const onInput = s.onInput ?? [];
  const newestAccepted = Math.max(0, ...onInput.filter((v) => accepted.has(v)));
  return onInput.filter((v) => !accepted.has(v) && v > newestAccepted);
}

/** The most recent failure per stage: a failed job with no later successful job of the same kind. */
export function failedJobs(jobs) {
  const out = [];
  for (const kind of Object.keys(JOB_STAGE)) {
    const mine = (jobs ?? []).filter((j) => j.kind === kind); // newest first
    const lastDone = mine.findIndex((j) => j.status === "done");
    const failed = mine.findIndex((j) => j.status === "failed");
    if (failed >= 0 && (lastDone < 0 || failed < lastDone)) out.push(mine[failed]);
  }
  return out;
}

export const runningJobs = (jobs) => (jobs ?? []).filter((j) => j.status === "running");

/**
 * The state of every production stage, by tab id:
 * { state: "complete" | "needs" | "running" | "blocked" | "upcoming", why, pending }.
 * Order of precedence: blocked, running, needs, complete, upcoming.
 */
export function stepStates({ stages, jobs, discovery = false, director }) {
  const out = {};
  const failed = failedJobs(jobs);
  for (const step of STEPS) {
    const s = stages?.stages?.find((x) => x.stage === step.stage);
    const next = stages?.next;
    const selectedAcc = s?.accepted?.find((a) => a.version === s.selected);
    const pending = step.stage === "render" ? [] : pendingDrafts(s);
    const fail = failed.find((j) => JOB_STAGE[j.kind] === step.stage);
    const running = runningJobs(jobs).find((j) => JOB_STAGE[j.kind] === step.stage);
    let state = "upcoming";
    let why = "";
    let node;
    if (selectedAcc?.orphaned) {
      state = "blocked";
      why = `${step.label} ${vLabel(step.stage, s.selected)} is blocked: ${selectedAcc.orphaned}`;
      node = `${step.stage}:${s.selected}`;
    } else if (fail) {
      state = "blocked";
      why = `${JOB_TITLE[fail.kind]} failed${fail.error ? `: ${String(fail.error).split("\n")[0]}` : ""}`;
    } else if (running || (step.stage === "storyboard" && discovery)) {
      state = "running";
      why = `${running ? JOB_TITLE[running.kind] : "Discovery"} is running`;
    } else if ((next?.who === "user" && next.stage === step.stage) || pending.length) {
      state = "needs";
      const latest = pending.at(-1);
      why =
        latest !== undefined
          ? `${step.label} ${vLabel(step.stage, latest)} is waiting for review`
          : capital(next?.text ?? "needs you");
    } else if (selectedAcc) {
      state = "complete";
      why = `${step.label} ${vLabel(step.stage, s.selected)} is approved and in the production line`;
    } else if (next?.who === "agent" && next.stage === step.stage) {
      why = `Waiting for the Director: ${next.text}`;
    }
    // the Director is working on this stage right now (a tool of this stage is in flight): running, unless it is blocked
    const busy = director?.working && director.step?.stage === step.stage;
    if (busy && state !== "blocked" && state !== "running") {
      state = "running";
      why = `The Director is ${director.step.label.charAt(0).toLowerCase()}${director.step.label.slice(1)}`;
    }
    // the newest draft was written from accepted QA fixes: say where it comes from (P1c Q4, D-QA-8)
    const link = s?.fixLinks?.find((l) => l.version === pending.at(-1));
    if (link && state === "needs") why = `${why} (fixes from render v${link.render})`;
    out[step.tab] = {
      state,
      why,
      pending: pending.length,
      ...(node ? { node } : {}),
      ...(link ? { fixesFrom: link.render } : {}),
    };
  }
  return out;
}

/**
 * The next-action band: what needs you (or is blocked) and where to go. null without a project.
 * { tone: "needs" | "blocked" | "idle" | "done", label, text, title?, action?: { label, tab }, more: [{ tab, text }] }
 */
export function nextBand({ stages, states, jobs, director, now = Date.now() }) {
  if (!stages?.project) return null;
  const order = STEPS.map((s) => s.tab);
  const blocked = order.find((t) => states[t]?.state === "blocked");
  if (blocked)
    return {
      tone: "blocked",
      label: "Blocked",
      text: states[blocked].why,
      action: { label: "Show", tab: blocked },
      ...(states[blocked].node ? { map: states[blocked].node } : {}),
      more: [],
    };
  const next = stages.next;
  const nextTab = next?.stage ? stepOfStage(next.stage)?.tab : undefined;
  const needing = order.filter((t) => states[t]?.state === "needs");
  const first = next?.who === "user" && nextTab ? nextTab : needing[0];
  // the Director is working: say so instead of "Needs you" (F9); what waits for you is a small link beside it
  if (director?.working) {
    const quiet =
      director.lastAt !== undefined && !director.step
        ? Math.floor((now - director.lastAt) / 60000)
        : 0;
    return {
      tone: "working",
      label: "Director working",
      text: `${director.task}${director.step ? ` · ${director.step.label}` : " · thinking"}${quiet >= 5 ? ` (no news for ${quiet} min)` : ""}`,
      action: null,
      more: needing.map((t) => ({ tab: t, text: states[t].why })),
      moreWord: "wait for you",
    };
  }
  if (first)
    return {
      tone: "needs",
      label: "Needs you",
      text:
        first === nextTab && next?.who === "user"
          ? `${capital(next.text)}${states[first].fixesFrom ? ` (fixes from render v${states[first].fixesFrom})` : ""}`
          : states[first].why,
      action: { label: "Continue", tab: first },
      more: needing.filter((t) => t !== first).map((t) => ({ tab: t, text: states[t].why })),
    };
  const running = runningJobs(jobs)[0];
  if (running)
    return {
      tone: "idle",
      label: "Running",
      text: `${JOB_TITLE[running.kind]} is running`,
      action: null,
      more: [],
    };
  if (next?.who === "agent")
    return {
      tone: "idle",
      label: "Waiting",
      text: `for the Director: ${next.text}`,
      title: "Nothing is running yet: the Director starts this from the chat",
      action: null,
      more: [],
    };
  return {
    tone: "done",
    label: "Done",
    text: capital(next?.text ?? "everything is approved"),
    action: { label: "Open Render", tab: "render" },
    more: [],
  };
}

/**
 * The status strip: what runs (with progress only when it is known), what failed, the connection.
 * `rows` are the activity rows (progress detail from events); `dismissed` is a Set of job ids.
 * { tone: "idle" | "running" | "err" | "warn", text, progress: number | null, running: [], failure: job | null }
 */
export function stripState({ jobs, rows, status, dismissed = new Set(), director }) {
  if (status && status !== "live")
    return {
      tone: "warn",
      text: status === "reconnecting" ? "Disconnected from pi, reconnecting…" : "Connecting to pi…",
      progress: null,
      running: [],
      failure: null,
    };
  const run = runningJobs(jobs);
  const rowOf = (kind) => (rows ?? []).find((r) => r.state === "running" && r.key === kind);
  const KEY = { record: "take", tts: "tts", edit: "edit", design: "design", render: "render" };
  const label = (j) => {
    const r = rowOf(KEY[j.kind]);
    const pct =
      r && r.fraction !== null && r.fraction !== undefined
        ? ` ${Math.round(r.fraction * 100)}%`
        : "";
    return `${JOB_TITLE[j.kind] ?? j.kind}${pct}`;
  };
  const discovery = (rows ?? []).find((r) => r.state === "running" && r.key === "discovery");
  const failure = failedJobs(jobs).find((j) => !dismissed.has(j.id)) ?? null;
  if (failure && !run.length)
    return {
      tone: "err",
      text: `${JOB_TITLE[failure.kind] ?? failure.kind} failed${failure.error ? `: ${String(failure.error).split("\n")[0]}` : ""}`,
      progress: null,
      running: [],
      failure,
    };
  if (run.length || discovery) {
    const names = [
      ...run.map(label),
      ...(discovery
        ? [`Discovery${discovery.fraction ? ` ${Math.round(discovery.fraction * 100)}%` : ""}`]
        : []),
    ];
    const single = run.length + (discovery ? 1 : 0) === 1;
    const first = run[0] ? rowOf(KEY[run[0].kind]) : discovery;
    return {
      tone: "running",
      text: single ? `${names[0]}` : `${names.length} running: ${names.join(", ")}`,
      progress:
        single && first && first.fraction !== null && first.fraction !== undefined
          ? Math.round(first.fraction * 100)
          : null,
      running: run,
      failure,
    };
  }
  if (director?.working)
    return {
      tone: "running",
      text: `Director: ${director.task}${director.step ? ` · ${director.step.label}` : ""}`,
      progress: null,
      running: [],
      failure,
    };
  return { tone: "idle", text: "Nothing running", progress: null, running: [], failure };
}

/**
 * What the Director is doing now: the snapshot the engine put in /api/state, and the director.* events that came after it
 * (their seq is greater than the state's busSeq). { working, task, by, step?, lastAt? }
 */
export function directorNow(state, events = []) {
  let d = { ...(state?.director ?? { working: false }) };
  const after = state?.busSeq ?? 0;
  for (const e of events) {
    if (e.seq <= after || !e.type.startsWith("director.")) continue;
    const at = Date.parse(e.at) || Date.now();
    if (e.type === "director.started")
      d = { working: true, task: e.data.task, by: e.data.by, since: e.data.since, lastAt: at };
    else if (e.type === "director.step" && d.working)
      d = {
        ...d,
        lastAt: at,
        step: e.data.tool
          ? { tool: e.data.tool, label: e.data.label, stage: e.data.stage }
          : undefined,
      };
    else if (e.type === "director.settled")
      d = {
        working: false,
        last: { task: e.data.task, aborted: e.data.aborted, ms: e.data.ms, at },
      };
  }
  return d;
}

/** The events that mean "something new for you" on a tab (a result arrived), or null. Decided by the step table (steps.js). */
export function newsTab(e) {
  const s = stepOf(e);
  return s?.class === "run-and-tell" && s.tab ? s.tab : null;
}
