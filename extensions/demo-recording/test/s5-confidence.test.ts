/**
 * S5 part 11: confidence-guided review (D76–D81) and voice direction (D82–D84).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { TakeAnalysis } from "../src/analysis/take.ts";
import { EventBus } from "../src/bus.ts";
import { annotationConfidence } from "../src/confidence/annotations.ts";
import { agentCap, formatConfidence, judge, summarize } from "../src/confidence/level.ts";
import { storyboardConfidence, writeStoryboardChecks } from "../src/confidence/storyboard.ts";
import { voConfidence } from "../src/confidence/vo.ts";
import { resolveConfig } from "../src/config.ts";
import { panelRoutes } from "../src/panel/routes.ts";
import {
  defaultDirection,
  directionText,
  formatDirection,
  parseDirection,
  voiceRoutes,
} from "../src/panel/voice-routes.ts";
import { Runtime } from "../src/runtime.ts";
import { parseStoryboard } from "../src/storyboard/parse.ts";
import { writeStoryboard } from "../src/storyboard/store.ts";
import type { TtsEngine } from "../src/tts/engines.ts";
import { creditRate, estimateTts } from "../src/tts/estimate.ts";
import { audioDir, cacheKey } from "../src/tts/synthesize.ts";
import { wordDiff } from "../src/util/worddiff.ts";
import { parseVo } from "../src/vo/script.ts";
import {
  editVoSection,
  readPendingDirection,
  readVo,
  readVoMeta,
  writePendingDirection,
  writeVo,
} from "../src/vo/store.ts";
import { readInputs } from "../src/workdir/inputs.ts";
import { ensureProject } from "../src/workdir/layout.ts";
import { getReview, readState, setSceneReview } from "../src/workdir/state.ts";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-conf-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test("levels: worst signal wins, the agent can only lower, carry-over is a positive reason", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(agentCap), ["low", "low", "medium", "high", "high"]);
  const a = judge("s1", [{ level: "medium", text: "changed since v1" }], { score: 5 });
  assert.equal(a.level, "medium", "a 5/5 never raises a medium");
  const b = judge("s2", [], { score: 2, why: "not sure" });
  assert.equal(b.level, "low");
  assert.match(b.reasons[0]?.text ?? "", /the agent rates it 2\/5: not sure/);
  const c = judge("s3", [], undefined, 2);
  assert.deepEqual(
    [c.level, c.approvedIn, c.reasons[0]?.text],
    ["high", 2, "unchanged since v2, where you approved it"],
  );
  const d = judge("s4", [
    { level: "medium", text: "m" },
    { level: "low", text: "l" },
  ]);
  assert.deepEqual(
    d.reasons.map((r) => r.level),
    ["low", "medium"],
    "worst first",
  );
  const s = summarize([a, b, c, d]);
  assert.deepEqual([s.counts, s.needEyes], [{ high: 1, medium: 1, low: 2 }, 3]);
  const text = formatConfidence(s, "scene");
  assert.match(text, /2 low, 1 medium, 1 high — lowest first/);
  assert.ok(text.indexOf("s2") < text.indexOf("s1"), "low before medium");
  assert.doesNotMatch(text, /s3/, "high items are not listed");
});

test("word diff: insertions and deletions, merged runs", () => {
  assert.deepEqual(
    wordDiff("Churn is three point one percent.", "Churn reads three point one percent today."),
    [
      { op: "eq", text: "Churn" },
      { op: "del", text: "is" },
      { op: "ins", text: "reads" },
      { op: "eq", text: "three point one" },
      { op: "del", text: "percent." },
      { op: "ins", text: "percent today." },
    ],
  );
  assert.deepEqual(
    wordDiff("a  b\nc", "a b c"),
    [{ op: "eq", text: "a b c" }],
    "whitespace is not a change",
  );
  assert.deepEqual(wordDiff("", "new words"), [{ op: "ins", text: "new words" }]);
});

test("agent's view: storyboard scene field and a VO comment (never spoken)", () => {
  const sb = parseStoryboard(
    "version: 1\nstart_url: /\nscenes:\n  - id: a\n    title: A\n    confidence: { score: 2, why: the chart may load late }\n    steps: [{ do: pause, ms: 100 }]\n  - id: b\n    title: B\n    confidence: 4\n    steps: [{ do: pause, ms: 100 }]\n",
  );
  assert.deepEqual(sb.scenes[0]?.confidence, { score: 2, why: "the chart may load late" });
  assert.deepEqual(sb.scenes[1]?.confidence, { score: 4 });
  assert.throws(
    () =>
      parseStoryboard(
        "version: 1\nstart_url: /\nscenes:\n  - id: a\n    title: A\n    confidence: 9\n    steps: [{ do: pause, ms: 1 }]\n",
      ),
    /scenes\[0\]\.confidence: must be \{score: 1–5/,
  );
  const vo = parseVo(
    "---\ntake: take-001\n---\n## a\n<!-- confidence: 2 — the number may change -->\nChurn is 3.1 percent.\n<!-- a writer note -->\n## b\nFine.\n",
  );
  assert.deepEqual(vo.sections[0]?.confidence, { score: 2, why: "the number may change" });
  assert.equal(vo.sections[0]?.body, "Churn is 3.1 percent.", "the comment is not spoken");
  assert.equal(vo.sections[1]?.confidence, undefined);
});

const step = (id: string, extra = "") =>
  `  - id: ${id}\n    title: ${id}\n    deep_link: /${id}\n    screen: 20260101-101010/s001\n${extra}    steps:\n`;

test("storyboard: css/unseen targets, failed takes, improvise, changes, carry-over, agent view", () => {
  const p = ensureProject(root, { project: "p", appName: "a", appUrl: "https://a.test" });
  const v1 = `version: 1\nstart_url: /\nscenes:\n${step("01-a")}      - { do: click, target: { role: button, name: Go } }\n${step("02-b")}      - { do: hover, target: { css: "#kpi" } }\n${step("03-c")}      - { do: click, target: { role: link, name: Chat } }\n      - { do: improvise, kind: type, target: { role: textbox, name: Ask }, prompt: ask why, max_chars: 40, fallback: Why? }\n`;
  writeStoryboard(p.dir, v1);
  setSceneReview(p.dir, 1, "01-a", "approved");
  // take-001 of v1: 03-c failed once
  const take = path.join(p.dir, "takes", "take-001");
  fs.mkdirSync(take, { recursive: true });
  fs.writeFileSync(
    path.join(take, "take.json"),
    JSON.stringify({ storyboardVersion: 1, status: "ok" }),
  );
  fs.writeFileSync(
    path.join(take, "attempts.jsonl"),
    `${JSON.stringify({ scene: "03-c", attempt: 1, error: "timeout waiting for Ask\nstack" })}\n`,
  );
  const v2 = v1
    .replace('{ css: "#kpi" }', "{ role: img, name: KPI }")
    .concat(
      "  - id: 04-d\n    title: 04-d\n    deep_link: /d\n    confidence: { score: 2, why: new screen }\n    steps:\n      - { do: pause, ms: 300 }\n",
    );
  writeStoryboard(p.dir, v2);
  writeStoryboardChecks(p.dir, 2, {
    discovery: true,
    unknownTargets: [{ scene: "03-c", step: 0, target: { role: "link", name: "Chat" } }],
  });
  const c1 = storyboardConfidence(p.dir, 1);
  assert.deepEqual(
    c1?.items.map((i) => i.level),
    ["high", "low", "low"],
    "v1: css target low; 03-c failed in a take of v1",
  );
  const c2 = storyboardConfidence(p.dir, 2);
  const by = (id: string) => c2?.items.find((i) => i.id === id);
  assert.deepEqual(
    [by("01-a")?.level, by("01-a")?.approvedIn],
    ["high", 1],
    "unchanged + approved in v1",
  );
  assert.equal(by("02-b")?.level, "medium");
  assert.match(
    by("02-b")
      ?.reasons.map((r) => r.text)
      .join(" | ") ?? "",
    /changed since v1/,
  );
  const c = by("03-c")?.reasons.map((r) => `${r.level}:${r.text}`) ?? [];
  assert.ok(
    c.some((r) => /^low:step 0: link "Chat" was never seen in discovery/.test(r)),
    c.join("\n"),
  );
  assert.ok(
    c.some((r) => /^low:failed 1× while recording \(take-001: timeout waiting for Ask\)/.test(r)),
    "an unchanged scene keeps its earlier failure",
  );
  assert.ok(c.some((r) => /^medium:step 1: improvised input/.test(r)));
  const d = by("04-d");
  assert.equal(d?.level, "low");
  assert.match(
    d?.reasons.map((r) => r.text).join(" | ") ?? "",
    /new since v1.*|the agent rates it 2\/5: new screen/,
  );
  assert.match(d?.reasons.map((r) => r.text).join(" | ") ?? "", /no screen thumbnail/);
  assert.equal(c2?.needEyes, 3);
});

function analysis(): TakeAnalysis {
  const scene = (id: string, start: number, end: number, marks: [string, number, string][]) => ({
    id,
    title: id,
    start,
    end,
    marks: marks.map(([mark, t, dom]) => ({ mark, t, type: "wait-satisfied", dom })),
    typed: [],
    alerts: [],
    idle: [],
    streaming: [],
    motion: [],
    protected: [],
    keyframes: [],
  });
  return {
    take: "take-001",
    takeDir: "/x",
    storyboardVersion: 1,
    durationMs: 30000,
    viewport: { width: 1600, height: 900, dpr: 2 },
    scenes: [
      scene("01-dash", 0, 9000, [["emea-bar", 3000, '- img "Churn 3.1%"\n- bar "EMEA 14.2%"']]),
      scene("02-search", 9000, 15000, [["results", 12000, '- row "EMEA 14.2% Litware Bank"']]),
    ],
    createdAt: "",
  };
}

const VO1 = `---
take: take-001
---
## _intro
Churn looks fine. It isn't.

## 01-dash — Dashboard
Headline churn is 3.1 percent. [@emea-bar] EMEA is the outlier at 14.2 percent.

## 02-search
I just ask. [@results] EMEA leads, and Litware Bank tops the list.

## _outro
Two questions, one answer.
`;

function voProject() {
  const p = ensureProject(root, { project: "p", appName: "a", appUrl: "https://a.test" });
  const takeDir = path.join(p.dir, "takes", "take-001");
  fs.mkdirSync(path.join(takeDir, "analysis"), { recursive: true });
  fs.writeFileSync(path.join(takeDir, "analysis", "analysis.json"), JSON.stringify(analysis()));
  fs.writeFileSync(
    path.join(takeDir, "take.json"),
    JSON.stringify({ take: "take-001", storyboardVersion: 1, status: "ok" }),
  );
  fs.mkdirSync(path.join(p.dir, "storyboard"), { recursive: true });
  fs.writeFileSync(path.join(p.dir, "storyboard", "v1.yaml"), "version: 1\n");
  writeVo(p.dir, VO1);
  setSceneReview(p.dir, 1, "_intro", "approved", undefined, "vo");
  return p;
}

test("VO: numbers not on the page, names, changes vs the base, carry-over, agent view; the direction's base", () => {
  const p = voProject();
  const v1 = voConfidence(p.dir, 1);
  assert.equal(
    v1?.items.find((i) => i.id === "01-dash")?.level,
    "high",
    "3.1 and 14.2 are on the page",
  );
  writePendingDirection(p.dir, 1, { tone: "crisp", length: "shorter" });
  const v2text = VO1.replace("Headline churn is 3.1 percent.", "Headline churn reads 4.2 percent.")
    .replace(
      "I just ask.",
      "<!-- confidence: 2 — the answer may name another bank -->\nI just ask.",
    )
    .replace("Litware Bank tops", "Fabrikam Bank tops");
  const v2 = writeVo(p.dir, v2text);
  assert.deepEqual(readVoMeta(p.dir, v2.version), {
    base: 1,
    direction: { tone: "crisp", length: "shorter" },
  });
  assert.equal(readPendingDirection(p.dir), undefined, "the pending direction is consumed");
  const c = voConfidence(p.dir, 2);
  const by = (id: string) => c?.items.find((i) => i.id === id);
  assert.deepEqual([by("_intro")?.level, by("_intro")?.approvedIn], ["high", 1]);
  const dash = by("01-dash")?.reasons.map((r) => `${r.level}:${r.text}`) ?? [];
  assert.ok(dash.includes("low:says “4.2” — not on the page in 01-dash"), dash.join("\n"));
  assert.ok(dash.includes("medium:changed since v1"));
  const search = by("02-search");
  assert.equal(search?.level, "low", "the agent's 2/5");
  assert.ok(
    search?.reasons.some(
      (r) => r.text === "the name “Fabrikam Bank” isn't on the page in 02-search",
    ),
  );
  assert.equal(by("_outro")?.level, "high");
});

test("panel routes: VO diff + confidence + direction defaults; approve high-confidence (two-phase)", () => {
  const p = voProject();
  writePendingDirection(p.dir, 1, { stance: "evaluator" });
  writeVo(
    p.dir,
    VO1.replace("Headline churn is 3.1 percent.", "Headline churn reads 4.2 percent."),
  );
  const bus = new EventBus();
  const notified: string[] = [];
  const routes = panelRoutes({
    bus,
    activeProject: () => p,
    discovery: () => undefined,
    notifyAgent: (t) => notified.push(t),
  });
  const vo = routes.get.vo?.(new URLSearchParams("version=2")) as {
    base: number;
    sections: { key: string; diff: unknown }[];
    confidence: { needEyes: number };
    meta: { base: number; direction: { stance: string } };
    canGenerate: boolean;
  };
  assert.equal(vo.base, 1);
  assert.equal(vo.sections.find((s) => s.key === "_intro")?.diff, "same");
  assert.deepEqual(
    (vo.sections.find((s) => s.key === "01-dash")?.diff as { op: string; text: string }[]).filter(
      (x) => x.op !== "eq",
    ),
    [
      { op: "del", text: "is 3.1" },
      { op: "ins", text: "reads 4.2" },
    ],
  );
  assert.equal(vo.meta.direction.stance, "evaluator");
  assert.equal(vo.confidence.needEyes, 1, JSON.stringify(vo.confidence));
  assert.equal(vo.canGenerate, false, "not accepted");
  // compare with another version
  const cmp = routes.get.vo?.(new URLSearchParams("version=2&compare=2")) as { base: unknown };
  assert.equal(cmp.base, null, "comparing with itself → no diff");

  const post = (n: string, b: Record<string, unknown>) =>
    (routes.post[n] as (x: Record<string, unknown>) => Record<string, unknown>)(b);
  setSceneReview(p.dir, 2, "_outro", "changes", "shorter", "vo");
  const plan = post("review-approve-high", { artifact: "vo", version: 2 }) as {
    planned: boolean;
    approve: string[];
    skip: { id: string; level: string; why: string }[];
    kept: { id: string; status: string }[];
  };
  assert.equal(plan.planned, true);
  assert.deepEqual(plan.approve, ["_intro", "02-search"]);
  assert.deepEqual(
    plan.skip.map((s) => [s.id, s.level]),
    [["01-dash", "low"]],
  );
  assert.match(plan.skip[0]?.why ?? "", /says “4.2”/);
  assert.deepEqual(plan.kept, [{ id: "_outro", status: "changes" }], "your own marks stay");
  assert.equal(
    Object.keys(getReview(readState(p.dir) ?? p.state, 2, "vo").scenes).length,
    1,
    "planning changes nothing",
  );
  const events: string[] = [];
  bus.subscribe((e) => events.push(`${e.type}:${String(e.data?.message ?? "")}`));
  post("review-approve-high", { artifact: "vo", version: 2, confirm: true });
  const review = getReview(readState(p.dir) ?? p.state, 2, "vo");
  assert.deepEqual(
    Object.entries(review.scenes)
      .map(([k, r]) => [k, r.status])
      .sort(),
    [
      ["02-search", "approved"],
      ["_intro", "approved"],
      ["_outro", "changes"],
    ],
  );
  assert.ok(
    events.some((e) =>
      /^review\.updated:voice-over v2: 2 high-confidence item\(s\) approved, 1 left for you/.test(
        e,
      ),
    ),
    events.join("\n"),
  );
});

test("voice direction: validate, pending + input + agent message, saved default in the brief", () => {
  const p = voProject();
  const notified: string[] = [];
  const told: string[] = [];
  const rt = new Runtime(
    () => ({ ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(root, "none.json") } }), root }),
    { sendUserMessage: (t) => notified.push(t), sendMessage: (m) => told.push(m.content) },
  );
  rt.setActiveProject("p");
  const routes = voiceRoutes(rt);
  const post = (n: string, b: Record<string, unknown>) =>
    (routes.post[n] as (x: Record<string, unknown>) => Record<string, unknown>)(b);
  assert.throws(() => post("vo-direction", { version: 1 }), /pick at least one direction/);
  assert.throws(
    () => post("vo-direction", { version: 1, tone: "shouty" }),
    /"tone" must be one of calm, energetic, conversational, crisp/,
  );
  assert.throws(
    () => post("vo-direction", { version: 9, tone: "calm" }),
    /voice-over v9 does not exist/,
  );
  const r = post("vo-direction", {
    version: 1,
    stance: "evaluator",
    tone: "calm",
    length: "shorter",
    focus: "the EMEA outlier",
    notes: "say each number once",
    saveDefault: true,
  }) as { briefVersion: number };
  assert.deepEqual(readPendingDirection(p.dir)?.direction, {
    stance: "evaluator",
    tone: "calm",
    length: "shorter",
    focus: "the EMEA outlier",
    notes: "say each number once",
  });
  const input = readInputs(p.dir).find((i) => i.kind === "nudge");
  assert.match(
    input?.text ?? "",
    /voice direction on v1: stance: evaluator; tone: calm; length: about 20 % shorter; focus: "the EMEA outlier"/,
  );
  assert.match(
    notified.at(-1) ?? "",
    /VOICE DIRECTION .* rewrite voice-over v1 \(take-001\) as a NEW COMPLETE VERSION/,
  );
  assert.match(notified.at(-1) ?? "", /demo_rec_vo get version=1/);
  assert.ok(r.briefVersion >= 1);
  const brief = fs.readFileSync(path.join(p.dir, "brief.md"), "utf8");
  assert.match(
    brief,
    /- \*\*Voice direction:\*\* stance: evaluator · tone: calm · length: shorter · focus: the EMEA outlier · notes: say each number once/,
  );
  assert.deepEqual(
    defaultDirection(brief),
    readPendingDirection(p.dir)?.direction,
    "the default reads back",
  );
  assert.deepEqual(parseDirection(formatDirection({ tone: "crisp", focus: "a · b" })), {
    tone: "crisp",
    focus: "a, b",
  });
  assert.match(directionText({ length: "fit" }), /fit the footage/);
  // the agent's next version is based on v1
  const v2 = writeVo(p.dir, VO1.replace("It isn't.", "It is not."));
  assert.equal(readVoMeta(p.dir, v2.version)?.base, 1);
  // an inline panel edit never consumes a pending direction
  writePendingDirection(p.dir, 2, { tone: "crisp" });
  const v3 = editVoSection(p.dir, 2, "_outro", "Two questions. One answer.");
  assert.deepEqual(
    readVoMeta(p.dir, v3.version),
    { base: 2 },
    "an inline edit is based on its version, without the direction",
  );
  assert.equal(readPendingDirection(p.dir)?.base, 2, "the direction still waits for the agent");
});

test("generate: gated on an accepted VO on the working line", async () => {
  voProject();
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(root, "none.json") } }),
    root,
  }));
  rt.setActiveProject("p");
  const gen = voiceRoutes(rt).post["vo-generate"] as (
    b: Record<string, unknown>,
  ) => Promise<unknown>;
  await assert.rejects(gen({ version: 1 }), /no accepted voice-over|is not accepted/);
});

test("estimate: cached vs to synthesize, ElevenLabs credits (flash 0.5), money from the config", async () => {
  const p = voProject();
  const vo = readVo(p.dir, 1) as NonNullable<ReturnType<typeof readVo>>;
  const fake = (id: "elevenlabs" | "openai", model: string): TtsEngine => ({
    id,
    health: async () => ({ ok: true, reason: "ok", voice: { id: "v1", name: "Ana" } }),
    identity: (voice) =>
      id === "elevenlabs" ? `elevenlabs:${voice}:${model}:d:d` : `openai:${model}:${voice}:`,
    synthesize: async () => ({ durationSec: 1 }),
  });
  const cfg = resolveConfig({ env: { DEMO_REC_CONFIG: path.join(root, "none.json") } });
  // one section already in the cache
  const intro = vo.validated.resolved.find((s) => s.key === "_intro");
  const text =
    intro?.segments
      .map((g) => g.text)
      .join(" ")
      .trim() ?? "";
  const cache = path.join(audioDir(p.dir), "cache");
  fs.mkdirSync(cache, { recursive: true });
  const key = cacheKey("elevenlabs:v1:eleven_flash_v2_5:d:d", text);
  fs.writeFileSync(path.join(cache, `${key}.wav`), "");
  fs.writeFileSync(path.join(cache, `${key}.json`), "{}");
  const e = await estimateTts(
    p.dir,
    vo.validated.resolved,
    [fake("elevenlabs", "eleven_flash_v2_5")],
    cfg,
  );
  assert.deepEqual(
    [e.engine, e.model, e.cached, e.toSynthesize],
    ["elevenlabs", "eleven_flash_v2_5", 1, 3],
  );
  assert.equal(
    e.chars,
    vo.validated.resolved
      .filter((s) => s.key !== "_intro")
      .reduce(
        (n, s) =>
          n +
          s.segments
            .map((g) => g.text)
            .join(" ")
            .trim().length,
        0,
      ),
  );
  assert.equal(e.credits, Math.ceil(e.chars * 0.5));
  assert.equal(e.cost, +(((e.credits as number) / 1000) * 0.22).toFixed(2));
  assert.equal(e.currency, "$");
  assert.deepEqual([creditRate("eleven_v4"), creditRate("eleven_turbo_v2_5")], [1, 0.5]);
  const o = await estimateTts(p.dir, vo.validated.resolved, [fake("openai", "gpt-4o-mini-tts")], {
    ...cfg,
    tts: { ...cfg.tts, pricePer1kChars: { ...cfg.tts.pricePer1kChars, openai: 1 }, currency: "€" },
  });
  assert.deepEqual(
    [o.credits, o.cached, o.priceUnit, o.currency],
    [null, 0, "per 1,000 characters", "€"],
  );
  assert.equal(o.cost, +(o.chars / 1000).toFixed(2));
});

test("annotations: redaction, box, unplaceable → low; text target, wording, new vs base → medium", () => {
  const file = {
    version: 3,
    basedOn: { vo: 1 },
    take: "take-001",
    items: [
      {
        id: "z1",
        type: "zoom",
        scene: "s",
        anchor: { mark: "m" },
        target: { step: 1 },
        enabled: true,
      },
      {
        id: "r1",
        type: "redact",
        scene: "s",
        anchor: { sceneStart: true },
        target: { layout: "t1#e1" },
        enabled: false,
      },
      {
        id: "h1",
        type: "highlight",
        scene: "s",
        anchor: { mark: "m" },
        target: { box: { x: 0, y: 0, w: 10, h: 10 } },
        enabled: true,
      },
      {
        id: "h2",
        type: "highlight",
        scene: "s",
        anchor: { mark: "m" },
        target: { text: "EMEA" },
        enabled: true,
      },
      {
        id: "c1",
        type: "callout",
        scene: "s",
        anchor: { mark: "m" },
        text: "EMEA 14.2 %",
        enabled: true,
        confidence: { score: 2, why: "wording" },
      },
      {
        id: "z2",
        type: "zoom",
        scene: "s",
        anchor: { mark: "x" },
        target: { step: 2 },
        enabled: true,
      },
    ],
  } as never;
  const c = annotationConfidence(
    file,
    { z2: { problem: "no mark @x in s" } },
    { version: 2, ids: ["z1", "r1", "h1", "h2", "z2"] },
  );
  const lv = Object.fromEntries(c.items.map((i) => [i.id, i.level]));
  assert.deepEqual(lv, { z1: "high", r1: "low", h1: "low", h2: "medium", c1: "low", z2: "low" });
  const c1 = c.items.find((i) => i.id === "c1")?.reasons.map((r) => r.text) ?? [];
  assert.ok(c1.includes("new since v2") && c1.includes("wording: “EMEA 14.2 %”"));
  assert.match(
    c.items.find((i) => i.id === "z2")?.reasons[0]?.text ?? "",
    /can't be placed: no mark @x in s/,
  );
});
