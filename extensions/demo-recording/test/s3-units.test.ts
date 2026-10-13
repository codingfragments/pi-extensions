import assert from "node:assert/strict";
import { test } from "node:test";
import { minJerk, planMove, timePath } from "../src/browser/cursor/motion.ts";
import { expectedTypingMs, planTyping } from "../src/browser/cursor/typing.ts";
import { resolveConfig } from "../src/config.ts";
import { discoveryProgress, formatDiscoveryProgress } from "../src/discovery/progress.ts";
import { Jobs } from "../src/jobs.ts";
import {
  type ModelAccess,
  type ModelLike,
  createImproviser,
  sanitizeInput,
} from "../src/recorder/improvise.ts";
import { ProgressTracker, estimateStepMs, formatProgress } from "../src/recorder/progress.ts";
import { parseStoryboard } from "../src/storyboard/parse.ts";
import { briefContext } from "../src/tools/record.ts";
import { createRng } from "../src/util/rng.ts";

// ---------- motion ----------

test("minJerk: 0→1, symmetric, slow at both ends", () => {
  assert.equal(minJerk(0), 0);
  assert.equal(minJerk(1), 1);
  assert.ok(Math.abs(minJerk(0.5) - 0.5) < 1e-9);
  assert.ok(minJerk(0.1) < 0.1 && minJerk(0.9) > 0.9, "slow start, slow landing");
});

test("planMove: exact endpoints, monotonic time, no teleports, deterministic per seed", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const from = { x: 100, y: 120 };
    const to = { x: 1300, y: 700 };
    const plan = planMove(from, to, 60, createRng(seed));
    assert.deepEqual({ x: plan[0]?.x, y: plan[0]?.y }, from);
    const last = plan.at(-1);
    assert.ok(
      last && Math.abs(last.x - to.x) < 0.01 && Math.abs(last.y - to.y) < 0.01,
      "lands exactly on target",
    );
    for (let i = 1; i < plan.length; i++) {
      const a = plan[i - 1] as { x: number; y: number; t: number };
      const b = plan[i] as { x: number; y: number; t: number };
      assert.ok(b.t >= a.t, "time is monotonic");
      assert.ok(Math.hypot(b.x - a.x, b.y - a.y) < 120, `no teleport (seed ${seed}, step ${i})`);
    }
    const total = (last as { t: number }).t;
    assert.ok(total > 400 && total < 1900, `human-ish duration ${total} ms`);
  }
  const a = planMove({ x: 0, y: 0 }, { x: 800, y: 300 }, 40, createRng(9));
  const b = planMove({ x: 0, y: 0 }, { x: 800, y: 300 }, 40, createRng(9));
  assert.deepEqual(a, b, "same seed → same path (Math.random is swapped for the seeded RNG)");
  assert.notDeepEqual(a, planMove({ x: 0, y: 0 }, { x: 800, y: 300 }, 40, createRng(10)));
});

test("planMove: long moves sometimes overshoot past the target and correct", () => {
  let overshoots = 0;
  for (let seed = 1; seed <= 50; seed++) {
    const to = { x: 1200, y: 400 };
    const plan = planMove({ x: 100, y: 400 }, to, 40, createRng(seed));
    if (plan.some((p) => p.x > to.x + 5)) overshoots++;
  }
  assert.ok(
    overshoots > 10 && overshoots < 45,
    `overshoot is occasional, not constant (${overshoots}/50)`,
  );
  const short = planMove({ x: 100, y: 100 }, { x: 160, y: 120 }, 40, createRng(1));
  assert.ok(!short.some((p) => p.x > 161), "short moves never overshoot");
});

test("timePath resamples by arc length with min-jerk velocity", () => {
  const pts = timePath(
    [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
    ],
    1000,
    60,
  );
  assert.equal(pts.length, 61);
  const mid = pts[30] as { x: number };
  assert.ok(Math.abs(mid.x - 500) < 1);
  const v = (i: number) => (pts[i + 1] as { x: number }).x - (pts[i] as { x: number }).x;
  assert.ok(v(30) > v(2) * 5, "fast in the middle, slow at the start");
});

// ---------- typing ----------

test("typing: log-normal delays within human bounds, word pauses, deterministic", () => {
  const text = "churn by region in the last quarter";
  const plan = planTyping(text, createRng(4));
  assert.equal(plan.map((a) => (a.kind === "char" ? a.ch : "")).join(""), text);
  const delays = plan.map((a) => a.delay);
  const mean = delays.reduce((x, y) => x + y, 0) / delays.length;
  assert.ok(mean > 70 && mean < 170, `mean ${mean}`);
  assert.ok(Math.min(...delays) >= 25 && Math.max(...delays) <= 600);
  const sd = Math.sqrt(delays.reduce((n, d) => n + (d - mean) ** 2, 0) / delays.length);
  assert.ok(sd > 15, "not robotic: delays vary");
  const afterSpace = plan.filter((_, i) => text[i - 1] === " ").map((a) => a.delay);
  const avgAfterSpace = afterSpace.reduce((x, y) => x + y, 0) / afterSpace.length;
  assert.ok(avgAfterSpace > mean, "longer pauses at word starts");
  assert.deepEqual(planTyping(text, createRng(4)), plan);
  const est = expectedTypingMs(text);
  const actual = delays.reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(est - actual) / actual < 0.45, `estimate ${est} vs actual ${actual}`);
});

test("typing: typos are corrected and only happen when enabled", () => {
  assert.ok(!planTyping("a".repeat(200), createRng(1)).some((a) => a.kind === "backspace"));
  const plan = planTyping("search for the strongest regional signal", createRng(2), {
    typoRate: 0.08,
  });
  assert.ok(plan.some((a) => a.kind === "backspace"));
  // Replaying the plan yields exactly the intended text.
  const out: string[] = [];
  for (const a of plan) {
    if (a.kind === "backspace") out.pop();
    else out.push(a.ch);
  }
  assert.equal(out.join(""), "search for the strongest regional signal");
});

// ---------- recording progress ----------

const SB = parseStoryboard(
  `start_url: /
scenes:
  - id: a
    title: A
    steps: [{ do: hover, target: { text: x } }, { do: type, target: { text: y }, text: hello world }]
  - id: b
    title: B
    steps: [{ do: wait, for: { text: z } }, { do: pause, ms: 1000 }]
`,
  { version: 1 },
);

test("estimateStepMs: plausible per-kind estimates", () => {
  assert.equal(estimateStepMs({ do: "pause", ms: 1234 }), 1234);
  assert.ok(
    estimateStepMs({ do: "type", text: "x".repeat(40) }) >
      estimateStepMs({ do: "type", text: "x" }),
  );
  assert.ok(estimateStepMs({ do: "hover", target: { text: "x" }, dwell: 2000 }) > 2000);
});

test("ProgressTracker: fractions per scene, never past an open wait, restarts, ETA", () => {
  let now = 0;
  const t = new ProgressTracker(SB, () => now);
  t.startStep(0, 0);
  now += 300;
  let s = t.snapshot();
  assert.equal(s.scene.index, 1);
  assert.ok(s.fraction > 0 && s.fraction < 0.2);
  t.finishStep(0, 0);
  t.startStep(0, 1);
  now += 1500;
  t.finishStep(0, 1);
  t.startStep(1, 0);
  const before = t.snapshot().fraction;
  now += 60_000; // a very long wait
  s = t.snapshot();
  const total = SB.scenes.flatMap((sc) => sc.steps).reduce((n, st) => n + estimateStepMs(st), 0);
  const waitW = estimateStepMs(SB.scenes[1]?.steps[0] as Parameters<typeof estimateStepMs>[0]);
  assert.ok(
    s.fraction < before + waitW / total - 1e-6,
    "an open wait never reaches its end until satisfied",
  );
  assert.equal(s.scenes[0]?.done, 1);
  assert.match(s.step.label, /waiting/);
  assert.ok(s.etaMs > 0);

  t.restartScene(1);
  s = t.snapshot();
  assert.equal(s.scenes[1]?.attempt, 2);
  assert.equal(s.attempt, 2);
  assert.match(formatProgress({ ...s, phase: "recording" }), /retry 1/);
  t.phase = "done";
  assert.equal(t.snapshot().fraction, 1);
  assert.equal(t.snapshot().etaMs, 0);
});

// ---------- discovery progress ----------

test("discoveryProgress: plan mode with ETA from finished areas, capped by budget", () => {
  const start = 0;
  const p = discoveryProgress({
    startedAt: start,
    now: 5 * 60_000,
    areas: [
      { name: "dashboard", startedAt: 0, doneAt: 2 * 60_000 },
      { name: "search", startedAt: 2 * 60_000, doneAt: 4 * 60_000 },
      { name: "assistant", startedAt: 4 * 60_000 },
      { name: "settings" },
    ],
    budgetUsed: { screens: 0.3, actions: 0.2, minutes: 0.25 },
    budgetMinutes: 20,
    storyboardWritten: false,
  });
  assert.equal(p.mode, "plan");
  assert.equal(p.current, "assistant");
  assert.deepEqual(
    p.areas.map((a) => a.status),
    ["done", "done", "current", "todo"],
  );
  // 2 areas left × 2 min avg − 1 min already spent + 1.5 min writing ≈ 4.5 min
  assert.ok(p.etaMs !== undefined && Math.abs(p.etaMs - 4.5 * 60_000) < 1000, String(p.etaMs));
  assert.ok(p.fraction > 0.5 && p.fraction < 0.88);
  assert.match(
    formatDiscoveryProgress(p),
    /area 3\/4 · assistant · ~5 min left \(budget max 15 min\)/,
  );

  const capped = discoveryProgress({
    ...p,
    startedAt: 0,
    now: 19 * 60_000,
    areas: [{ name: "a", startedAt: 0 }, { name: "b" }, { name: "c" }],
    budgetUsed: { screens: 0, actions: 0, minutes: 0.95 },
    budgetMinutes: 20,
    storyboardWritten: false,
  });
  assert.ok(
    (capped.etaMs ?? 0) <= 60_000 + 90_000,
    "never longer than the remaining budget + writing",
  );
  assert.ok(capped.fraction >= 0.95 * 0.88 - 1e-9, "budget burn is a floor");
});

test("discoveryProgress: budget-only without a plan; complete after the storyboard", () => {
  const b = discoveryProgress({
    startedAt: 0,
    now: 60_000,
    areas: [],
    budgetUsed: { screens: 0.5, actions: 0.1, minutes: 0.05 },
    budgetMinutes: 20,
    storyboardWritten: false,
  });
  assert.equal(b.mode, "budget-only");
  assert.equal(b.fraction, 0.5);
  assert.match(formatDiscoveryProgress(b), /50% of budget used · max 19 min left/);
  const done = discoveryProgress({
    startedAt: 0,
    now: 1,
    areas: [{ name: "x" }],
    budgetUsed: { screens: 0, actions: 0, minutes: 0 },
    budgetMinutes: 20,
    storyboardWritten: true,
  });
  assert.equal(done.fraction, 1);
});

// ---------- improvise ----------

test("sanitizeInput: one typeable line within max_chars", () => {
  assert.equal(sanitizeInput('"Why is EMEA’s churn so high?"', 80), "Why is EMEA's churn so high?");
  assert.equal(
    sanitizeInput("Question: what changed — and why…\nsecond line", 80),
    "what changed - and why...",
  );
  assert.equal(
    sanitizeInput("  Why is EMEA churn so much higher than every other region we track?", 30),
    "Why is EMEA churn so much",
  );
  assert.equal(sanitizeInput("emoji 🚀 gone", 80), "emoji gone");
});

function fakeAccess(
  behavior: Record<string, (opts: Record<string, unknown>) => Promise<string>>,
  models: ModelLike[],
): ModelAccess & { calls: { model: string; opts: Record<string, unknown>; context: unknown }[] } {
  const calls: { model: string; opts: Record<string, unknown>; context: unknown }[] = [];
  return {
    calls,
    find: (p, id) => models.find((m) => m.provider === p && m.id === id),
    complete: async (model, context, opts) => {
      const key = `${model.provider}/${model.id}`;
      calls.push({ model: key, opts, context });
      const fn = behavior[key];
      if (!fn) throw new Error("no behavior");
      return { content: [{ type: "text", text: await fn(opts) }], stopReason: "stop" };
    },
  };
}

const HAIKU: ModelLike = {
  provider: "anthropic",
  id: "claude-haiku-4-5",
  api: "anthropic-messages",
  reasoning: true,
  input: ["text", "image"],
};
const MINI: ModelLike = {
  provider: "openai",
  id: "gpt-5.4-mini",
  api: "openai-responses",
  reasoning: true,
  input: ["text", "image"],
};
const REQ = {
  prompt: "a follow-up",
  maxChars: 60,
  target: 'textbox "Ask"',
  digest: "- row EMEA 14.2%",
};

test("improviser: first available model wins; minimal reasoning only for OpenAI-style reasoning models", async () => {
  const access = fakeAccess({ "anthropic/claude-haiku-4-5": async () => "Why EMEA?" }, [
    HAIKU,
    MINI,
  ]);
  const r = await createImproviser(access).generate(REQ);
  assert.equal(r.text, "Why EMEA?");
  assert.equal(r.model, "anthropic/claude-haiku-4-5");
  assert.equal(access.calls[0]?.opts.reasoningEffort, undefined);
  assert.equal(access.calls[0]?.opts.maxTokens, 300);

  const access2 = fakeAccess({ "openai/gpt-5.4-mini": async () => "Why EMEA?" }, [MINI]);
  const r2 = await createImproviser(access2).generate(REQ);
  assert.equal(r2.model, "openai/gpt-5.4-mini");
  assert.deepEqual(
    r2.tried,
    ["anthropic/claude-haiku-4-5", "openai/gpt-5.4-mini"],
    "missing model is skipped",
  );
  assert.equal(access2.calls[0]?.opts.reasoningEffort, "minimal");
});

test("improviser: falls back on errors, sends the screenshot only on request, fails with all reasons", async () => {
  const access = fakeAccess(
    {
      "anthropic/claude-haiku-4-5": async () => {
        throw new Error("overloaded");
      },
      "openai/gpt-5.4-mini": async () => "Which accounts drive it?",
    },
    [HAIKU, MINI],
  );
  const r = await createImproviser(access).generate({ ...REQ, screenshot: Buffer.from("jpg") });
  assert.equal(r.text, "Which accounts drive it?");
  const content = (access.calls[1]?.context as { messages: { content: { type: string }[] }[] })
    .messages[0]?.content;
  assert.equal(content?.[0]?.type, "image");
  const textOnly = fakeAccess({ "anthropic/claude-haiku-4-5": async () => "ok" }, [HAIKU]);
  await createImproviser(textOnly).generate(REQ);
  assert.ok(
    !(
      textOnly.calls[0]?.context as { messages: { content: { type: string }[] }[] }
    ).messages[0]?.content.some((c) => c.type === "image"),
  );

  const dead = fakeAccess({}, [HAIKU]);
  await assert.rejects(
    createImproviser(dead).generate(REQ),
    /improvise failed \(anthropic\/claude-haiku-4-5: no behavior; openai\/gpt-5.4-mini: not available\)/,
  );
  const slow = fakeAccess(
    {
      "anthropic/claude-haiku-4-5": (o) =>
        new Promise((res, rej) => {
          const t = setTimeout(() => res("late"), 1000);
          (o.signal as AbortSignal).addEventListener("abort", () => {
            clearTimeout(t);
            rej(new Error("timeout"));
          });
        }),
    },
    [HAIKU],
  );
  await assert.rejects(
    createImproviser(slow, ["anthropic/claude-haiku-4-5"], 50).generate(REQ),
    /timeout/,
  );
});

test("briefContext pulls audience + goal, ignores TODOs", () => {
  assert.equal(
    briefContext(
      "- **Audience:** CFOs of mid-size SaaS\n- **Goal / key message:** churn is regional\n",
    ),
    "audience: CFOs of mid-size SaaS; goal: churn is regional",
  );
  assert.equal(briefContext("- **Audience:** _TODO_\n"), undefined);
});

test("storyboard: improvise fallback + vision", () => {
  const sb = parseStoryboard(
    "start_url: /\nscenes:\n  - id: a\n    title: A\n    steps:\n      - { do: improvise, kind: type, target: { text: x }, prompt: p, max_chars: 10, fallback: a very long fallback text, vision: true }\n",
    { version: 1 },
  );
  assert.deepEqual(sb.scenes[0]?.steps[0], {
    do: "improvise",
    kind: "type",
    target: { text: "x" },
    prompt: "p",
    max_chars: 10,
    submit: true,
    fallback: "a very lon",
    vision: true,
  });
});

// ---------- config + jobs ----------

test("config: improvise + recording defaults and validation", () => {
  const d = resolveConfig({ env: {}, home: "/h", readFile: () => undefined });
  assert.deepEqual(d.improvise.models, ["anthropic/claude-haiku-4-5", "openai/gpt-5.4-mini"]);
  assert.equal(d.recording.maxRetriesPerScene, 2);
  const c = resolveConfig({
    env: { DEMO_REC_IMPROVISE_MODELS: "openai/gpt-4.1-mini" },
    home: "/h",
    readFile: () => '{"recording":{"typoRate":0.02}}',
  });
  assert.deepEqual(c.improvise.models, ["openai/gpt-4.1-mini"]);
  assert.equal(c.recording.typoRate, 0.02);
  assert.throws(
    () =>
      resolveConfig({ env: {}, home: "/h", readFile: () => '{"improvise":{"models":["haiku"]}}' }),
    /provider\/id/,
  );
  assert.throws(
    () => resolveConfig({ env: {}, home: "/h", readFile: () => '{"recording":{"typoRate":0.5}}' }),
    /typoRate/,
  );
});

test("jobs: one running job per kind, cancel aborts, onFinish always runs", async () => {
  const jobs = new Jobs();
  const finished: string[] = [];
  const job = jobs.start(
    "record",
    "p",
    (signal) =>
      new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => resolve("ok"), 5000);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new Error("recording cancelled"));
        });
      }),
    (j) => finished.push(`${j.id}:${j.status}`),
  );
  assert.throws(() => jobs.start("record", "p", async () => 1), /already running/);
  assert.equal(jobs.running("record")?.id, job.id);
  jobs.cancel();
  await job.done;
  assert.equal(job.status, "cancelled");
  assert.deepEqual(finished, ["record-1:cancelled"]);
  const ok = jobs.start("record", "p", async () => 42);
  await ok.done;
  assert.equal(ok.result, 42);
  assert.equal(jobs.latest("record")?.status, "done");
});
