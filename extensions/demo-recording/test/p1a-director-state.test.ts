/**
 * P1a PR 15 (A2, F9 F11 F13): the Director's state is visible. The state machine and its words (pure), the wiring to pi's real events
 * in a real agent session with a scripted model, the engine snapshot, and the panel (band, strip, stepper, Activity) in a browser.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { stepLabel, taskLabel } from "../src/director/labels.ts";
import { DirectorTracker } from "../src/director/state.ts";
import { registerDirectorWatch } from "../src/director/watch.ts";
import { approvalMessage, reviewMessage, voReviewMessage } from "../src/panel/bridge.ts";
import { directorNow, nextBand, stepStates, stripState } from "../src/panel/public/frame-state.js";
import { Runtime } from "../src/runtime.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";
import { fauxAssistantMessage, fauxSession, fauxToolCall } from "./helpers/pi-session.ts";

// --- the words -------------------------------------------------------------------------

test("task labels: what you typed, a skill, a panel message, a report", () => {
  assert.deepEqual(taskLabel({ input: "make the intro shorter please" }), {
    label: "Answering you: “make the intro shorter please”",
    by: "you",
  });
  assert.equal(
    taskLabel({ input: "/skill:demo-voiceover Analyze the latest take of keycraft" }).label,
    "Analyzing the take and writing the voice-over",
  );
  assert.equal(
    taskLabel({ input: "/skill:demo-recording Discover Keycraft (https://x) for demo project k" })
      .label,
    "Exploring the app",
  );
  // the real panel messages (src/panel/bridge.ts) are recognised
  const sb = { version: 2, scenes: [{ id: "01-a", title: "A", steps: [] }] } as never;
  const review = { scenes: { "01-a": { status: "changes", note: "shorter" } } } as never;
  assert.equal(
    taskLabel({ input: reviewMessage("k", sb, review) }).label,
    "Revising the storyboard from your review of v2",
  );
  assert.equal(
    taskLabel({ input: voReviewMessage("k", 3, ["01-a"], review) }).label,
    "Revising the voice-over from your review of v3",
  );
  assert.deepEqual(taskLabel({ input: approvalMessage("k", "vo", 3) }), {
    label: "Continuing after you approved the voice-over",
    by: "panel",
  });
  assert.equal(
    taskLabel({ input: approvalMessage("k", "storyboard", 2) }).label,
    "Continuing after you approved the storyboard",
  );
  assert.equal(
    taskLabel({ input: approvalMessage("k", "recording", 1) }).label,
    "Continuing after you approved the recording",
  );
  assert.equal(
    taskLabel({ input: approvalMessage("k", "render", 8) }).label,
    "Continuing after you approved the final render",
  );
  assert.equal(
    taskLabel({
      input:
        "[demo-recording] The user ALLOWED: synthesize voice-over v1. Go on with exactly that.",
    }).label,
    "Going on with what you allowed",
  );
  assert.equal(
    taskLabel({
      input: '[demo-panel] The user asks for a new take of storyboard v2 for project "k"',
    }).label,
    "Recording a new take for you",
  );
  assert.equal(
    taskLabel({ input: "[demo-panel] Something new happened. And more text." }).label,
    "Something new happened.",
  );
  assert.deepEqual(
    taskLabel({ custom: "[demo-recording] Voice synthesis finished (6 sections)\n\nmore" }),
    {
      label: "Reading the report: Voice synthesis finished (6 sections)",
      by: "report",
    },
  );
});

test("step labels name the tool and the stage it concerns", () => {
  assert.deepEqual(stepLabel("demo_rec_vo", { action: "write" }), {
    label: "Writing the voice-over",
    stage: "vo",
  });
  assert.deepEqual(stepLabel("demo_rec_take", { action: "analyze" }), {
    label: "Analyzing the take",
    stage: "recording",
  });
  assert.deepEqual(stepLabel("demo_rec_browser", { action: "act" }), {
    label: "Exploring the app",
    stage: "storyboard",
  });
  assert.deepEqual(stepLabel("demo_rec_tts", { action: "start" }), {
    label: "Asking to synthesize the voice",
    stage: "vo",
  });
  assert.deepEqual(stepLabel("demo_rec_config", { action: "show" }), {
    label: "Checking the settings",
  });
  assert.deepEqual(stepLabel("bash", { command: "ls" }), { label: "Using bash" });
});

// --- the state machine -----------------------------------------------------------------

function tracker() {
  const events: { type: string; data: Record<string, unknown> }[] = [];
  let t = 1000;
  const d = new DirectorTracker(
    (type, data) => events.push({ type, data }),
    () => t,
  );
  return {
    d,
    events,
    tick: (ms: number) => {
      t += ms;
    },
    at: () => t,
  };
}

test("working from the start of a run to agent_settled, with the step in between", () => {
  const { d, events, tick } = tracker();
  d.onInput({ text: "write the voice-over" });
  d.onRunStart({ messageType: "user", prompt: "write the voice-over" });
  assert.deepEqual(
    [d.snapshot().working, d.snapshot().task, d.snapshot().by],
    [true, "Answering you: “write the voice-over”", "you"],
  );
  tick(500);
  d.onToolStart({ toolCallId: "c1", toolName: "demo_rec_vo", args: { action: "write" } });
  assert.deepEqual(
    [d.snapshot().step?.label, d.snapshot().step?.stage],
    ["Writing the voice-over", "vo"],
  );
  tick(2000);
  d.onToolEnd({ toolCallId: "c1", toolName: "demo_rec_vo" });
  assert.equal(d.snapshot().step, undefined, "between tools it is thinking");
  assert.equal(d.snapshot().working, true, "still working: the answer is not written yet");
  tick(300);
  d.onSettled({ aborted: false });
  assert.equal(d.snapshot().working, false);
  assert.deepEqual(d.snapshot().last, {
    task: "Answering you: “write the voice-over”",
    aborted: false,
    ms: 2800,
    at: 3800,
  });
  assert.deepEqual(
    events.map((e) => e.type),
    ["director.started", "director.step", "director.step", "director.settled"],
  );
  assert.equal(events[2]?.data.tool, null, "the step ended");
  assert.match(String(events[3]?.data.message), /^Director finished: /);
});

test("a message taken into a run that is going starts nothing; parallel tools; steer; Escape; shutdown", () => {
  const { d, events } = tracker();
  d.onRunStart({ messageType: "user", prompt: "first" });
  d.onRunStart({ messageType: "custom", message: { content: "[demo-recording] a report" } });
  assert.equal(events.filter((e) => e.type === "director.started").length, 1);
  assert.equal(d.snapshot().task, "Answering you: “first”");
  // two tools at once: the newest is shown, and when it ends the other is again
  d.onToolStart({ toolCallId: "a", toolName: "demo_rec_vo", args: { action: "get" } });
  d.onToolStart({ toolCallId: "b", toolName: "demo_rec_take", args: { action: "analyze" } });
  assert.equal(d.snapshot().step?.label, "Analyzing the take");
  d.onToolEnd({ toolCallId: "b", toolName: "demo_rec_take" });
  assert.equal(d.snapshot().step?.label, "Reading the voice-over");
  d.onToolEnd({ toolCallId: "a", toolName: "demo_rec_vo" });
  assert.equal(d.snapshot().step, undefined);
  // typing while it works joins the run
  d.onInput({ text: "be brief", streamingBehavior: "steer" });
  assert.equal(d.snapshot().working, true);
  assert.equal(events.filter((e) => e.type === "director.started").length, 1);
  // Escape
  d.onSettled({ aborted: true });
  assert.equal(d.snapshot().last?.aborted, true);
  assert.match(String(events.at(-1)?.data.message), /^Director stopped: /);
  // idle: tool events and a stray settle do nothing
  const n = events.length;
  d.onToolStart({ toolName: "x" });
  d.onSettled({});
  assert.equal(events.length, n);
  // a closing session ends a run that was going
  d.onRunStart({ messageType: "custom", message: { content: "[demo-recording] report" } });
  assert.equal(d.snapshot().by, "report");
  d.onShutdown();
  assert.equal(d.snapshot().working, false);
});

// --- the panel's pure functions ---------------------------------------------------------

test("the band, the strip and the stepper say it; events after the snapshot win", () => {
  const stages = {
    project: "k",
    next: { who: "user", stage: "storyboard", text: "review storyboard v2" },
    stages: [{ stage: "vo", accepted: [], selected: 1, drafts: [] }],
  } as never;
  const states = {
    storyboard: { state: "needs", why: "Storyboard v2 is waiting for review", pending: 1 },
    recording: { state: "complete", why: "ok", pending: 0 },
    voice: { state: "complete", why: "ok", pending: 0 },
    annotations: { state: "upcoming", why: "", pending: 0 },
    render: { state: "upcoming", why: "", pending: 0 },
  } as never;
  const idle = nextBand({ stages, states, jobs: [], director: { working: false } });
  assert.equal(idle?.tone, "needs");
  const working = {
    working: true,
    task: "Revising the voice-over from your review of v3",
    step: { tool: "demo_rec_vo", label: "Writing the voice-over", stage: "vo" },
  };
  const band = nextBand({ stages, states, jobs: [], director: working, now: 1000 });
  assert.deepEqual([band?.tone, band?.label], ["working", "Director working"]);
  assert.equal(
    band?.text,
    "Revising the voice-over from your review of v3 · Writing the voice-over",
  );
  assert.equal(band?.action, null);
  assert.deepEqual(
    band?.more.map((m) => m.tab),
    ["storyboard"],
    "what waits for you stays one click away",
  );
  assert.equal(
    nextBand({
      stages,
      states,
      jobs: [],
      director: { ...working, step: undefined },
      now: 1000,
    })?.text.endsWith("· thinking"),
    true,
  );
  const quiet = nextBand({
    stages,
    states,
    jobs: [],
    director: { working: true, task: "x", lastAt: 0 },
    now: 7 * 60000,
  });
  assert.match(quiet?.text ?? "", /\(no news for 7 min\)$/);
  // the strip says it when no job runs, a job's own line wins
  assert.equal(
    stripState({ jobs: [], rows: [], director: working }).text,
    "Director: Revising the voice-over from your review of v3 · Writing the voice-over",
  );
  assert.equal(stripState({ jobs: [], rows: [] }).text, "Nothing running");
  // the stepper: the stage a tool belongs to is running
  const st = stepStates({ stages, jobs: [], director: working });
  assert.deepEqual([st.voice?.state, st.storyboard?.state], ["running", "needs"]);
  assert.match(st.voice?.why ?? "", /^The Director is writing the voice-over$/);
  // the snapshot, then newer events
  const state = { busSeq: 10, director: { working: true, task: "old", since: 1 } };
  const ev = (seq: number, type: string, data: Record<string, unknown>) => ({
    seq,
    type,
    at: "2026-10-18T12:00:00.000Z",
    data,
  });
  assert.equal(
    directorNow(state, [ev(9, "director.settled", { task: "old", aborted: false, ms: 1 })]).working,
    true,
    "older than the snapshot: ignored",
  );
  const after = directorNow(state, [
    ev(11, "director.settled", { task: "old", aborted: false, ms: 5 }),
    ev(12, "director.started", { task: "new", by: "panel", since: 2 }),
    ev(13, "director.step", { tool: "demo_rec_vo", label: "Writing the voice-over", stage: "vo" }),
  ]);
  assert.deepEqual(
    [after.working, after.task, after.step?.label],
    [true, "new", "Writing the voice-over"],
  );
  assert.equal(
    directorNow(state, [ev(11, "director.settled", { task: "old", aborted: true, ms: 5 })]).working,
    false,
  );
});

// --- pi's real events -------------------------------------------------------------------

/** Our wiring inside a real agent session: a Runtime (and its bus) plus the Director watch, with stub tools named like ours. */
// biome-ignore lint/suspicious/noExplicitAny: pi's extension API
async function wired(extra?: (pi: any, rt: Runtime) => void) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "p1a-dir-"));
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(root, "none.json") } }),
    root,
    panelPort: 0,
  }));
  const gates: (() => void)[] = [];
  const peek: { working: boolean; step?: string }[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: pi's extension API
  const factory = (pi: any) => {
    (rt as unknown as { agent: unknown }).agent = pi;
    registerDirectorWatch(pi, rt);
    // biome-ignore lint/suspicious/noExplicitAny: pi's extension API
    (pi as any).registerTool({
      name: "demo_rec_vo",
      label: "vo",
      description: "stub",
      parameters: { type: "object", properties: {} },
      async execute() {
        peek.push({
          working: rt.director.snapshot().working,
          step: rt.director.snapshot().step?.label,
        });
        await new Promise<void>((r) => gates.push(r));
        return { content: [{ type: "text", text: "written" }], details: {} };
      },
    });
    extra?.(pi, rt);
  };
  const s = await fauxSession({ extensions: [factory] });
  const bus: { type: string; data: Record<string, unknown> }[] = [];
  rt.bus.subscribe((e) => bus.push({ type: e.type, data: e.data as Record<string, unknown> }));
  return { s, rt, bus, gates, peek, root };
}

test(
  "in a real session: working from the first event to agent_settled, and a retry is not an end",
  { timeout: 30_000 },
  async () => {
    const { s, rt, bus, gates, peek, root } = await wired();
    try {
      let atRetry: boolean | undefined;
      s.faux.setResponses([
        fauxAssistantMessage([fauxToolCall("demo_rec_vo", { action: "write" })]),
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" }),
        () => {
          atRetry = rt.director.snapshot().working; // the retry's model call, two seconds after the failed run ended
          return fauxAssistantMessage("written and reviewed");
        },
      ]);
      const run = s.session.prompt("write the voice-over");
      await new Promise((r) => setTimeout(r, 150));
      // while the tool is in flight: working, with the step, and the engine's snapshot says so too
      assert.deepEqual(peek[0], { working: true, step: "Writing the voice-over" });
      assert.equal((rt.snapshot().director as { working: boolean }).working, true);
      gates[0]?.();
      await run.catch(() => undefined);
      await s.settled(1, 20_000);
      assert.equal(atRetry, true, "still working in the retry's gap: agent_end was not the end");
      assert.equal(rt.director.snapshot().working, false, "idle only after agent_settled");
      const types = bus.filter((e) => e.type.startsWith("director.")).map((e) => e.type);
      assert.equal(types.filter((t) => t === "director.started").length, 1);
      assert.equal(types.filter((t) => t === "director.settled").length, 1);
      assert.equal(types[0], "director.started");
      assert.equal(types.at(-1), "director.settled");
      const settled = bus.find((e) => e.type === "director.settled");
      assert.equal(settled?.data.aborted, false);
      assert.match(
        String(bus.find((e) => e.type === "director.started")?.data.task),
        /^Answering you: “write the voice-over”$/,
      );
    } finally {
      s.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "in a real session: a panel approval gets its task label, and Escape ends it as stopped",
  { timeout: 30_000 },
  async () => {
    const { s, rt, bus, gates, root } = await wired((pi) => {
      pi.registerCommand("approve", {
        description: "a panel approval reaches the Director",
        handler: async () =>
          pi.sendUserMessage(approvalMessage("k", "vo", 3), { deliverAs: "followUp" }),
      });
    });
    try {
      s.faux.setResponses([
        fauxAssistantMessage([fauxToolCall("demo_rec_vo", { action: "get" })]),
        fauxAssistantMessage("never"),
      ]);
      await s.session.prompt("/approve");
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(rt.director.snapshot().task, "Continuing after you approved the voice-over");
      assert.equal(rt.director.snapshot().by, "panel");
      const aborting = s.session.abort();
      gates[0]?.(); // the tool in flight finishes; Escape does not interrupt a tool that ignores its signal
      await aborting;
      await s.settled(1);
      const settled = bus.find((e) => e.type === "director.settled");
      assert.equal(settled?.data.aborted, true);
      assert.match(
        String(settled?.data.message),
        /^Director stopped: Continuing after you approved the voice-over$/,
      );
      assert.equal(rt.director.snapshot().working, false);
    } finally {
      s.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test("the real extension registers the Director's watch", () => {
  const index = fs.readFileSync(path.join(import.meta.dirname, "..", "index.ts"), "utf8");
  assert.match(index, /registerDirectorWatch\(pi, rt\)/);
});

// --- the panel, in a browser ------------------------------------------------------------

async function chromium() {
  try {
    const pw = await import("playwright");
    return fs.existsSync(pw.chromium.executablePath()) ? pw.chromium : undefined;
  } catch {
    return undefined;
  }
}
const browserType = await chromium();

test(
  "in the browser: Director working replaces Needs you while it works, and the stage runs",
  { skip: !browserType && "needs Playwright Chromium", timeout: 90_000 },
  async () => {
    process.env.DEMO_REC_NO_OPEN = "1";
    const seed = seedPanelProject();
    const cfg = path.join(seed.root, "c.json");
    fs.writeFileSync(cfg, "{}");
    const rt = new Runtime(() => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
      root: seed.root,
      panelPort: 0,
    }));
    rt.setActiveProject(seed.slug);
    const gates: (() => void)[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: pi's extension API
    const factory = (pi: any) => {
      (rt as unknown as { agent: unknown }).agent = pi;
      registerDirectorWatch(pi, rt);
      // biome-ignore lint/suspicious/noExplicitAny: pi's extension API
      (pi as any).registerTool({
        name: "demo_rec_vo",
        label: "vo",
        description: "stub",
        parameters: { type: "object", properties: {} },
        async execute() {
          await new Promise<void>((r) => gates.push(r));
          return { content: [{ type: "text", text: "ok" }], details: {} };
        },
      });
    };
    const s = await fauxSession({ extensions: [factory] });
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.goto(`${panel.url}#/voice`);
      await page.waitForSelector("header.top");
      // idle: the band asks for you (the seeded storyboard v2 waits for review)
      await page.locator(".ds-next", { hasText: "Needs you" }).waitFor();

      s.faux.setResponses([
        fauxAssistantMessage([fauxToolCall("demo_rec_vo", { action: "write" })]),
        fauxAssistantMessage("done"),
      ]);
      const run = s.session.prompt("rewrite the voice-over a bit shorter");
      // the band, the strip, the stepper and Activity
      const band = page.locator(".ds-next[data-tone=working]");
      await band.waitFor();
      await page.waitForFunction(
        `document.querySelector(".ds-next")?.textContent?.includes("Writing the voice-over")`,
      );
      const text = await band.innerText();
      assert.match(text, /Director working/i);
      assert.match(text, /Answering you: “rewrite the voice-over a bit shorter”/);
      assert.match(text, /Writing the voice-over/);
      assert.doesNotMatch(text, /Needs you/i);
      assert.match(text, /\d+ items? wait/i, "what waits for you is a small link beside it");
      assert.match(
        await page.locator(".ds-strip .strip-text").innerText(),
        /Director: Answering you.*Writing the voice-over/,
      );
      assert.equal(
        await page.locator("nav.steps a[data-tab=voice]").getAttribute("data-state"),
        "running",
      );
      await page.getByRole("button", { name: /Activity/ }).click();
      await page.locator(".prow.running", { hasText: "Director" }).waitFor();
      if (process.env.P1A_SHOTS)
        await page.screenshot({ path: `${process.env.P1A_SHOTS}-director.png` });
      await page.keyboard.press("Escape");

      // done: Needs you is back, the stage is no longer running, and Activity says it finished
      gates[0]?.();
      await run;
      await s.settled();
      await page.locator(".ds-next", { hasText: "Needs you" }).waitFor();
      assert.notEqual(
        await page.locator("nav.steps a[data-tab=voice]").getAttribute("data-state"),
        "running",
      );
      await page.getByRole("button", { name: /Activity/ }).click();
      await page.locator(".prow", { hasText: /Director finished/ }).waitFor();
      await page.close();
    } finally {
      await browser.close();
      s.dispose();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
