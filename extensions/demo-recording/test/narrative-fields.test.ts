/**
 * Item 23 PR 2 (R3-24): the narrative layer. The brief's Viewer's questions / Already knows / Compare with, a scene's why / so_what / contrast, the warning for a scene
 * without them, the comparison of two versions, and the voice-over template built on them.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { TakeAnalysis } from "../src/analysis/take.ts";
import { compareStoryboardData } from "../src/compare/facts.ts";
import { NARRATIVE_MAX, parseStoryboard } from "../src/storyboard/parse.ts";
import { voTemplate } from "../src/tools/vo.ts";
import { BRIEF_FIELDS, readBriefFacts, setBriefFacts } from "../src/workdir/brief.ts";

const SB = `start_url: /
scenes:
  - id: 01-feed
    title: Feed
    takeaway: One feed for every kind of problem
    why: separate tools for errors, crons and slow queries split the on-call's attention
    so_what: one ranked queue to work
    contrast: Datadog keeps monitors and error tracking apart
    steps:
      - { do: pause, ms: 1s }
  - id: 02-detail
    title: Detail
    steps:
      - { do: pause, ms: 1s }
`;

test("the brief's viewer fields are read and written like every field", () => {
  for (const k of ["viewerQuestions", "alreadyKnows", "compareWith"])
    assert.ok(
      BRIEF_FIELDS.some((f) => f.key === k),
      k,
    );
  const brief = setBriefFacts("# b\n\n- **Persona:** Datadog engineers\n", {
    viewerQuestions: "Is Sentry a good implementation of error tracking?",
    alreadyKnows: "APM, Error Tracking, RUM, logs",
    compareWith: "Datadog Error Tracking",
  });
  assert.match(
    brief,
    /\*\*Viewer's questions:\*\* Is Sentry a good implementation of error tracking\?/,
  );
  const f = readBriefFacts(brief);
  assert.deepEqual(
    [f.viewerQuestions, f.alreadyKnows, f.compareWith],
    [
      "Is Sentry a good implementation of error tracking?",
      "APM, Error Tracking, RUM, logs",
      "Datadog Error Tracking",
    ],
  );
});

test("a scene's why / so_what / contrast: parsed, optional, one line each", () => {
  const sb = parseStoryboard(SB, { version: 1 });
  const [a, b] = sb.scenes;
  assert.equal(
    a?.why,
    "separate tools for errors, crons and slow queries split the on-call's attention",
  );
  assert.equal(a?.so_what, "one ranked queue to work");
  assert.equal(a?.contrast, "Datadog keeps monitors and error tracking apart");
  assert.equal(b?.why, undefined, "optional: an older storyboard stays valid");
  assert.equal(NARRATIVE_MAX, 200);
  assert.throws(
    () =>
      parseStoryboard(
        SB.replace("so_what: one ranked queue to work", `so_what: ${"x".repeat(201)}`),
        { version: 1 },
      ),
    /scenes\[0\]\.so_what: keep it to one line \(200 characters at most\)/,
  );
});

test("comparing two versions names a changed, added or removed why / so_what / contrast", () => {
  const a = parseStoryboard(SB, { version: 1 });
  const b = parseStoryboard(
    SB.replace("so_what: one ranked queue to work", "so_what: one queue, ranked by rules").replace(
      "    contrast: Datadog keeps monitors and error tracking apart\n",
      "",
    ),
    { version: 2 },
  );
  const text = JSON.stringify(compareStoryboardData(a, b));
  assert.match(text, /so_what changed/);
  assert.match(text, /contrast removed/);
});

const take = (): TakeAnalysis =>
  ({
    take: "take-001",
    takeDir: "/x",
    storyboardVersion: 1,
    durationMs: 12_000,
    viewport: { width: 1600, height: 900, dpr: 2 },
    scenes: ["01-feed", "02-detail"].map((id, i) => ({
      id,
      title: id,
      start: i * 5000,
      end: i * 5000 + 5000,
      marks: [],
      typed: [],
      alerts: [],
      idle: [],
      streaming: [],
      motion: [],
      protected: [],
      keyframes: [],
    })),
    createdAt: "",
  }) as unknown as TakeAnalysis;

test("the template is built on the narrative: the viewer's questions in the intro and outro, each scene's claim, why, so what and contrast", () => {
  const sb = parseStoryboard(SB, { version: 1 });
  const t = voTemplate(take(), 2.4, {
    viewerQuestions: "Is Sentry a good implementation of error tracking?",
    alreadyKnows: "APM, logs",
    compareWith: "Datadog Error Tracking",
    scenes: Object.fromEntries(
      sb.scenes.map((s) => [
        s.id,
        { takeaway: s.takeaway, why: s.why, so_what: s.so_what, contrast: s.contrast },
      ]),
    ) as never,
  });
  assert.match(
    t,
    /## _intro\n<!-- full video only: 1–2 sentences\. State the viewer's question and your position\. Their questions: Is Sentry a good implementation of error tracking\? They already know: APM, logs \(don't explain it\)\. -->/,
  );
  assert.match(
    t,
    /## 01-feed — 01-feed\n<!-- ~5\.0s usable[^\n]*-->\n<!-- build it as claim → why it matters → how it works → one piece of evidence → so what\. claim: One feed for every kind of problem · why it matters: separate tools [^·]+ · so what: one ranked queue to work · against: Datadog keeps monitors and error tracking apart -->/,
  );
  assert.match(
    t,
    /## 02-detail — 02-detail\n<!-- ~5\.0s usable[^\n]*-->\n<!-- build it as [^\n]*against: the viewer's Datadog Error Tracking -->/,
    "no scene fields: the brief's anchor still says what to set it against",
  );
  assert.match(
    t,
    /## _outro\n<!-- full video only: one or two sentences that answer the viewer's question \(your verdict\), no recap\. The question: Is Sentry/,
  );
  // without a narrative: the plain skeleton, no empty comments
  const plain = voTemplate(take());
  assert.doesNotMatch(plain, /build it as/);
  assert.doesNotMatch(plain, /Their questions/);
  // a comment end inside a field cannot break the comment
  assert.doesNotMatch(voTemplate(take(), 2.4, { viewerQuestions: "a --> b" }), /a --> b/);
});

test("the skills say to write the narrative layer and build each section on it", () => {
  const root = path.join(import.meta.dirname, "..", "skills");
  const vo = fs.readFileSync(path.join(root, "demo-voiceover", "SKILL.md"), "utf8");
  assert.match(
    vo,
    /Build each scene section\*\* as claim → why it matters → how it works → one piece of evidence → so what/,
  );
  assert.match(vo, /\*\*Viewer's questions\*\*, \*\*Already knows\*\* and \*\*Compare with\*\*/);
  const rec = fs.readFileSync(path.join(root, "demo-recording", "SKILL.md"), "utf8");
  assert.match(rec, /\*\*Every scene gets the narrative layer\*\*: `why`/);
  assert.match(rec, /so_what: look at churn by region before trusting the KPI/);
  const brief = fs.readFileSync(path.join(root, "demo-brief", "SKILL.md"), "utf8");
  assert.match(brief, /- \*\*Viewer's questions:\*\*/);
  assert.match(brief, /- \*\*Compare with:\*\*/);
});

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
  "the Storyboard tab shows a scene's why, so what and contrast under its takeaway, and says when a scene has none",
  { skip: !browserType && "needs Playwright Chromium", timeout: 120_000 },
  async () => {
    process.env.DEMO_REC_NO_OPEN = "1";
    const { seedPanelProject } = await import("./helpers/panel-seed.ts");
    const { resolveConfig } = await import("../src/config.ts");
    const { Runtime } = await import("../src/runtime.ts");
    const { writeStoryboard } = await import("../src/storyboard/store.ts");
    const seed = seedPanelProject();
    writeStoryboard(seed.dir, SB);
    const rt = new Runtime(() => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(seed.root, "none.json") } }),
      root: seed.root,
      panelPort: 0,
    }));
    rt.setActiveProject(seed.slug);
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${panel.url}#/storyboard`);
      await page.waitForSelector("[data-narrative]");
      const box = page.locator("[data-narrative]");
      assert.match(
        await box.innerText(),
        /Why\s+separate tools for errors, crons and slow queries split the on-call's attention\s+So what\s+one ranked queue to work\s+Against\s+Datadog keeps monitors and error tracking apart/,
      );
      await page
        .locator(".ds-list [data-key='02-detail'], .ds-list button", { hasText: "Detail" })
        .first()
        .click();
      await page.waitForSelector("[data-narrative-missing]");
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
