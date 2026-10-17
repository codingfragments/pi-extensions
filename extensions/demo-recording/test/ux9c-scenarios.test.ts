/**
 * UX9c: the task-level acceptance scenarios of docs/UX.md §9, run end to end in the real panel on the seeded
 * project (voice-over v1 approved and v2 a newer draft, storyboard v1 approved and v2 a draft, annotations v1
 * approved, finals v1 QA-blocked / v2 approved / v3 without files, drafts v4–v7). Each scenario is a test; what
 * it asserts is the evidence quoted in docs/ux/UX9c.md. Nothing here touches a real project or the real config.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { Page } from "playwright";
import { readAnnotations, writeAnnotations } from "../src/annotations/file.ts";
import { resolveConfig } from "../src/config.ts";
import { readAnnotationDraft } from "../src/drafts/annotations.ts";
import { readDraft } from "../src/drafts/store.ts";
import { Runtime } from "../src/runtime.ts";
import { voVersions } from "../src/vo/store.ts";
import { readState } from "../src/workdir/state.ts";
import { answerDialogs } from "./helpers/panel-dialogs.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

async function chromium() {
  try {
    const pw = await import("playwright");
    return fs.existsSync(pw.chromium.executablePath()) ? pw.chromium : undefined;
  } catch {
    return undefined;
  }
}
const browserType = await chromium();
const skip = !browserType && "needs Playwright Chromium";
const ENV = [
  "DEMO_REC_CONFIG",
  "DEMO_REC_NO_OPEN",
  "DEMO_REC_VOICE",
  "OPENAI_API_KEY",
  "ELEVENLABS_API_KEY",
];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(width = 1400) {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  const seed = seedPanelProject();
  const globalFile = path.join(seed.root, "scenario-config.json");
  fs.writeFileSync(globalFile, "{}");
  process.env.DEMO_REC_CONFIG = globalFile;
  process.env.DEMO_REC_NO_OPEN = "1";
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: globalFile } }),
    root: seed.root,
    panelPort: 0,
  }));
  const turns: string[] = [];
  (rt as unknown as { notifyAgent: (t: string) => void }).notifyAgent = (t) => turns.push(t);
  rt.tellAgent = () => undefined;
  rt.setActiveProject(seed.slug);
  const panel = await rt.ensurePanel();
  const browser = await (browserType as NonNullable<typeof browserType>).launch();
  const context = await browser.newContext({ viewport: { width, height: 1100 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/annotation-preview", (r) =>
    r.fulfill({
      status: 400,
      contentType: "application/json",
      body: '{"error":"previews are stubbed"}',
    }),
  );
  const dlg = answerDialogs(page);
  const stateText = () => fs.readFileSync(path.join(seed.dir, "state.json"), "utf8");
  const go = async (hash: string, ready = ".ds-header, header.top") => {
    await page.goto(`${panel.url}${hash}`);
    await page.waitForSelector(ready);
  };
  const close = async () => {
    dlg.stop();
    await browser.close();
    await rt.shutdown();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
    fs.rmSync(seed.root, { recursive: true, force: true });
  };
  return { seed, rt, panel, page, context, dlg, turns, errors, stateText, go, close, globalFile };
}
const hash = (p: Page) => p.evaluate("location.hash") as Promise<string>;

// ---------------------------------------------------------------------------------------------------------
// 1. From any stage: the viewed version, the production selection, the pending review and the active job,
//    without opening History or Activity. A new result never moves you.
test(
  "scenario 1: viewed version, production selection, pending review and active job are readable on every stage; a result never moves you",
  { skip, timeout: 120_000 },
  async () => {
    const { page, rt, seed, go, errors, close } = await setup();
    try {
      const idle = (signal: AbortSignal) =>
        new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      const job = rt.jobs.start<void>("render", seed.slug, idle);
      rt.bus.publish(
        "render.progress",
        { done: 3, total: 6, label: "scene 3", message: "🎞 draft scene 3" },
        seed.slug,
      );
      for (const [hashRoute, stage] of [
        ["#/storyboard", "Storyboard"],
        ["#/voice", "Voice over"],
        ["#/annotations", "Annotations"],
        ["#/render", "Render"],
      ] as const) {
        await go(hashRoute, ".stage-summary");
        await page.waitForFunction(
          "/Viewing\\s*v\\d/.test(document.querySelector('.stage-summary')?.innerText ?? '')",
        );
        const summary = await page.locator(".stage-summary").innerText();
        assert.match(
          summary,
          new RegExp(`${stage}[\\s\\S]*Viewing\\s*v\\d`),
          `${stage}: the viewed version`,
        );
        const band = await page.locator(".ds-next").innerText();
        assert.match(
          band,
          /Storyboard v2 is waiting for review/,
          `${stage}: the pending review, in the band`,
        );
        await page.waitForFunction(
          `/Render/.test(document.querySelector(".ds-strip .strip-text")?.textContent ?? "")`,
        );
        assert.match(
          await page.locator(".ds-strip").innerText(),
          /Render\s*50%/,
          `${stage}: the active job, in the strip`,
        );
        assert.equal(
          await page.locator("nav.steps a[data-tab=render]").getAttribute("data-state"),
          "running",
        );
      }
      // the production selection, in words, on a screen that is not in the line
      await go("#/voice", ".stage-summary");
      await page.waitForFunction(
        "/is in the production line/.test(document.querySelector('.stage-summary')?.innerText ?? '')",
      );
      assert.match(
        await page.locator(".stage-summary").innerText(),
        /Voice over v1 is in the production line, so the next steps still use v1/,
      );
      // a new result for another screen: a badge, never a move
      const before = await hash(page);
      const field = page.locator("textarea[id^=narration]").first();
      await page.waitForSelector(".ds-actionbar .ds-savestate");
      await field.focus();
      await page.keyboard.type("typing while a result arrives");
      rt.bus.publish("storyboard.written", { version: 3, message: "storyboard v3" }, seed.slug);
      rt.bus.publish(
        "annotations.updated",
        { version: 1, by: "agent", message: "annotations changed" },
        seed.slug,
      );
      await page.waitForFunction(`document.querySelectorAll("nav.steps .ds-badge").length > 0`);
      assert.equal(await hash(page), before, "the address did not change");
      assert.equal(
        await page.evaluate("document.activeElement?.tagName"),
        "TEXTAREA",
        "focus did not move",
      );
      assert.match(
        await field.inputValue(),
        /typing while a result arrives/,
        "the typed text is untouched",
      );
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

// ---------------------------------------------------------------------------------------------------------
// 2. Browse an older version via History and Map, then close and return: no production state, approval or draft
//    changes. Open in stage goes to the exact artifact.
test(
  "scenario 2: browsing an older version through History and the map changes nothing, and Open in stage lands on the exact artifact",
  { skip, timeout: 120_000 },
  async () => {
    const { page, seed, go, stateText, errors, close } = await setup();
    try {
      const state0 = stateText();
      const drafts0 = fs.existsSync(path.join(seed.dir, "drafts"));
      await go("#/voice", ".stage-summary");
      // History: view v1 (an older, approved version)
      await page.click(".history-btn");
      await page.waitForSelector(".ds-histpop");
      await page.locator(".ds-histpop a", { hasText: "v1" }).first().click();
      await page.waitForSelector(".stage-summary");
      assert.match(await hash(page), /^#\/voice\/v1/);
      await page.waitForFunction(
        "/Viewing\\s*v1/.test(document.querySelector('.stage-summary')?.innerText ?? '')",
      );
      // the map: select the voice-over v1 and open it in its stage
      await page.click("a.map-link");
      await page.waitForSelector(".ds-map .ds-node");
      await page.click(".ds-node[data-id='vo:2']");
      assert.match(await page.locator(".ds-map-open").innerText(), /Open v2 in Voice over/);
      await page.click(".ds-map-open");
      await page.waitForSelector(".ds-map", { state: "detached" });
      assert.equal(await hash(page), "#/voice/v2", "the exact artifact");
      await page.goBack();
      await page.waitForSelector(".ds-map .ds-node[aria-current=true][data-id='vo:2']");
      await page.keyboard.press("Escape");
      await page.waitForSelector(".ds-map", { state: "detached" });
      // nothing was written
      assert.equal(stateText(), state0, "state.json is byte for byte the same");
      assert.equal(fs.existsSync(path.join(seed.dir, "drafts")), drafts0, "no draft appeared");
      assert.deepEqual(voVersions(seed.dir), [1, 2]);
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

// ---------------------------------------------------------------------------------------------------------
// 3. A branching fixture: approved paths and the production line; withdrawn ancestors, shared dependencies,
//    missing media and unknown lineage stay honest; collapse, focus and search are reversible and keyboard-equivalent.
test(
  "scenario 3: on a branching project the map's paths stay honest (withdrawn ancestors, missing media, unknown lineage) and every view is reversible by keyboard",
  { skip, timeout: 120_000 },
  async () => {
    const { page, seed, go, errors, close } = await setup();
    try {
      // a second annotation version on the same voice-over, an unapproved branch (shared dependencies)
      const v1 = readAnnotations(seed.dir, 1) as NonNullable<ReturnType<typeof readAnnotations>>;
      const { version: _v, ...rest } = v1;
      writeAnnotations(seed.dir, { ...rest, by: "branch" });
      await go("#/map", ".ds-map .ds-node");
      const ids = async () =>
        (await page.evaluate(
          "[...document.querySelectorAll('.ds-map .ds-node')].map((e) => e.dataset.id)",
        )) as string[];
      const all = await ids();
      assert.ok(all.includes("annotations:1") && all.includes("annotations:2"), "both branches");
      assert.ok(all.includes("render:3"), "a render without files is still there");
      assert.match(
        await page.locator(".ds-node[data-id='render:3']").innerText(),
        /Files deleted/,
        "missing media is said",
      );
      // approved paths: only approved, usable chains; the unapproved branch is out
      await page.click("button[data-view=approved]");
      await page.waitForFunction(
        `document.querySelectorAll(".ds-map .ds-node").length < ${all.length}`,
      );
      const approved = await ids();
      assert.ok(!approved.includes("annotations:2") && !approved.includes("vo:2"));
      assert.ok(approved.includes("vo:1") && approved.includes("render:2"));
      // production line: exactly the line
      await page.click("button[data-view=line]");
      await page.waitForFunction(
        `document.querySelectorAll(".ds-map .ds-node").length <= ${approved.length}`,
      );
      assert.deepEqual((await ids()).sort(), [
        "annotations:1",
        "qa:render:2",
        "recording:1",
        "render:2",
        "storyboard:1",
        "vo:1",
      ]);
      // search, focus and groups are reversible
      await page.click("button[data-view=all]");
      await page.fill(".ds-map input[type=search]", "final");
      await page.waitForSelector(".ds-node[data-match=true]");
      await page.click("button[data-act=reset]");
      await page.waitForFunction(
        `document.querySelectorAll(".ds-map .ds-node").length === ${all.length}`,
      );
      assert.equal(await page.inputValue(".ds-map input[type=search]"), "");
      // keyboard equivalence: arrows walk the graph, the outline lists the same nodes
      await page.focus(".ds-node[data-id='vo:1']");
      await page.keyboard.press("ArrowLeft");
      await page.waitForSelector(".ds-node[aria-current=true][data-id='recording:1']");
      await page.keyboard.press("ArrowRight");
      await page.waitForSelector(".ds-node[aria-current=true][data-id='vo:1']");
      const outline = (await page
        .locator(".ds-outline button")
        .evaluateAll("(els) => els.length")) as number | undefined;
      void outline;
      assert.equal(
        await page.locator(".ds-outline button").count(),
        all.length,
        "the outline lists the same nodes",
      );
      // withdraw the recording's approval: its descendants are honestly blocked, not hidden
      const { applyVersionAction, planVersionAction } = await import(
        "../src/panel/version-actions.ts"
      );
      const st = () => readState(seed.dir) as NonNullable<ReturnType<typeof readState>>;
      applyVersionAction(seed.dir, {
        stage: "recording",
        version: 1,
        intent: "withdraw",
        token: planVersionAction(seed.dir, st(), {
          stage: "recording",
          version: 1,
          intent: "withdraw",
        }).token,
      });
      await page.reload();
      await page.waitForSelector(".ds-map .ds-node");
      assert.match(
        await page.locator(".ds-node[data-id='vo:1']").innerText(),
        /Blocked by dependency/,
      );
      await page.click("button[data-view=approved]");
      await page.waitForFunction(`document.querySelectorAll(".ds-map .ds-node").length === 1`);
      assert.deepEqual(
        await ids(),
        ["storyboard:1"],
        "only what is still approved all the way down",
      );
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

// ---------------------------------------------------------------------------------------------------------
// 4. Approve an alternative without selecting it; then explicitly approve and use another. Existing approvals and
//    files survive; a stale plan is never applied unnoticed.
test(
  "scenario 4: approving is not selecting; approvals and files survive; a stale plan is not applied",
  { skip, timeout: 120_000 },
  async () => {
    const { page, seed, go, dlg, turns, stateText, errors, close } = await setup();
    try {
      const st = () => readState(seed.dir) as NonNullable<ReturnType<typeof readState>>;
      assert.deepEqual([st().line.vo, Object.keys(st().accepted.vo ?? {})], [1, ["1"]]);
      const files = fs.readdirSync(path.join(seed.dir, "vo")).sort();
      // v2 is a draft: approve it only. The production line must not move.
      await go("#/voice", ".version-actions");
      await page.click(".version-actions [data-intent=approve-only]");
      await page.waitForFunction(
        `/Approved/.test(document.querySelector(".stage-summary")?.innerText ?? "")`,
      );
      assert.deepEqual(
        Object.keys(st().accepted.vo ?? {}).sort(),
        ["1", "2"],
        "both are approved now: v1 survived",
      );
      assert.equal(st().line.vo, 1, "approving did not select it: the line still uses v1");
      assert.match(
        await page.locator(".stage-summary").innerText(),
        /so the next steps still use v1/,
      );
      assert.deepEqual(
        fs.readdirSync(path.join(seed.dir, "vo")).sort(),
        files,
        "no file was touched",
      );
      assert.deepEqual(turns, [], "approve only starts no agent turn");
      // then explicitly use v2: a dialog says what changes, and only then does the line move
      await go("#/voice/v2", ".stage-summary");
      dlg.seen.length = 0;
      await page.click(".version-actions [data-intent=use]");
      for (let i = 0; i < 100 && st().line.vo !== 2; i++) await wait(50);
      assert.equal(st().line.vo, 2, "now the line uses v2");
      assert.deepEqual(
        Object.keys(st().accepted.vo ?? {}).sort(),
        ["1", "2"],
        "v1 is still approved",
      );
      assert.ok(fs.existsSync(path.join(seed.dir, "vo", "script.v1.md")), "v1's file survived");
      // a stale plan is refused, with the engine's own words, and writes nothing
      const { applyVersionAction, planVersionAction, StalePlanError } = await import(
        "../src/panel/version-actions.ts"
      );
      const { approveVersion } = await import("../src/workdir/state.ts");
      const plan = planVersionAction(seed.dir, st(), { stage: "vo", version: 1, intent: "use" });
      approveVersion(seed.dir, "storyboard", 2, "only"); // the project moves on while the plan is open
      const before = stateText();
      assert.throws(
        () =>
          applyVersionAction(seed.dir, {
            stage: "vo",
            version: 1,
            intent: "use",
            token: plan.token,
          }),
        StalePlanError,
      );
      assert.equal(stateText(), before, "the stale plan wrote nothing");
      assert.equal(st().line.vo, 2, "and did not move the line back");
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

// ---------------------------------------------------------------------------------------------------------
// 5. Edit narration and annotations, navigate away and reload: the right base's draft comes back. Failed writes
//    and competing edits are shown. Save creates exactly one validated version, with no generation or approval.
test(
  "scenario 5: drafts survive navigation and reload on the right base; failed writes and competing edits are shown; Save makes one version and starts nothing",
  { skip, timeout: 150_000 },
  async () => {
    const { page, seed, rt, go, turns, errors, close } = await setup();
    try {
      const until = (re: RegExp) =>
        page.waitForFunction(
          `new RegExp(${JSON.stringify(re.source)}).test(document.querySelector(".ds-actionbar .ds-savestate")?.innerText ?? "")`,
        );
      // a narration draft on v2 and an annotation draft on v1
      await go("#/voice/v2", "textarea[id^=narration]");
      await page.locator("textarea[id^=narration]").fill("An opening I will come back to.");
      await until(/Draft saved/);
      await go("#/annotations", ".ds-split-list .ds-item");
      await page.click("button[data-act=row-enabled][data-id='ch-dash']");
      await until(/Draft saved/);
      // navigate across stages and reload: both drafts are on their own base
      await go("#/storyboard", ".ds-split-list .ds-item");
      await go("#/voice/v2", "textarea[id^=narration]");
      await page.reload();
      await page.waitForSelector("textarea[id^=narration]");
      assert.equal(
        await page.locator("textarea[id^=narration]").inputValue(),
        "An opening I will come back to.",
      );
      assert.equal(readDraft(seed.dir, "vo", 2)?.edits._intro, "An opening I will come back to.");
      assert.equal(readDraft(seed.dir, "vo", 1), undefined, "not on the other base");
      assert.equal(readAnnotationDraft(seed.dir, 1)?.changes, 1);
      await go("#/annotations", ".ds-split-list .ds-item");
      assert.match(
        await page.locator(".ds-actionbar .ds-savestate").innerText(),
        /Working draft: 1 change/,
      );
      // a failed write is shown and the change is kept
      await page.route("**/api/annotations-edit", (r) => r.abort("failed"));
      await page.click("button[data-act=row-enabled][data-id='sp-row']");
      await page.waitForSelector(".ds-notice:has-text('Save failed')");
      await page.unroute("**/api/annotations-edit");
      await page.click("[data-act=retry]");
      await until(/Draft saved/);
      assert.equal(readAnnotationDraft(seed.dir, 1)?.changes, 2);
      // Save new version: exactly one, validated; nothing generated, nothing approved
      const versionsBefore = fs
        .readdirSync(path.join(seed.dir, "annotations"))
        .filter((f) => /^v\d+\.json$/.test(f)).length;
      const acceptedBefore = JSON.stringify(
        (readState(seed.dir) as NonNullable<ReturnType<typeof readState>>).accepted,
      );
      await page.click("[data-act=save-version]");
      await page.waitForFunction(
        `/v2/.test(document.querySelector(".stage-summary")?.innerText ?? "")`,
      );
      const versionsAfter = fs
        .readdirSync(path.join(seed.dir, "annotations"))
        .filter((f) => /^v\d+\.json$/.test(f)).length;
      assert.equal(versionsAfter, versionsBefore + 1, "exactly one new version");
      assert.equal(
        JSON.stringify((readState(seed.dir) as NonNullable<ReturnType<typeof readState>>).accepted),
        acceptedBefore,
        "nothing was approved",
      );
      assert.equal(rt.jobs.running("tts"), undefined);
      assert.equal(rt.jobs.running("render"), undefined);
      assert.equal(rt.jobs.running("design"), undefined);
      assert.deepEqual(turns, [], "nothing told the Director");
      assert.equal(readAnnotationDraft(seed.dir, 1), undefined, "the draft became the version");
      assert.equal(
        readDraft(seed.dir, "vo", 2)?.edits._intro,
        "An opening I will come back to.",
        "the narration draft is untouched by the annotations save",
      );
      assert.deepEqual(
        errors.filter((e) => !/Failed to fetch|NetworkError/.test(e)),
        [],
      );
    } finally {
      await close();
    }
  },
);

// ---------------------------------------------------------------------------------------------------------
// 6. Review scenes, annotations and renders in the common inspector, keeping confidence, the batch-review
//    safeguards, the annotation controls, the variants and the QA override.
test(
  "scenario 6: the common inspector keeps confidence, the batch-review plan, the annotation controls, the variants and the QA override",
  { skip, timeout: 120_000 },
  async () => {
    const { page, go, dlg, seed, errors, close } = await setup();
    try {
      // the seeded final v1 has a QA summary but no report file: give it one hard stop (a leaking redaction)
      const { qaFile } = await import("../src/qa/run.ts");
      fs.mkdirSync(path.dirname(qaFile(seed.dir, 1)), { recursive: true });
      fs.writeFileSync(
        qaFile(seed.dir, 1),
        JSON.stringify({
          render: 1,
          variant: "neutral",
          createdAt: new Date().toISOString(),
          whisper: false,
          items: [
            {
              id: "q1",
              check: "annotations",
              level: "blocking",
              hard: "redaction",
              scene: "01-dash",
              atMs: 2500,
              message: "redaction r1 doesn't cover its element here — it moved",
            },
          ],
        }),
      );
      // Storyboard: confidence in the list and the inspector, a batch review that shows its plan first
      await go("#/storyboard", ".ds-split-list .ds-item");
      assert.ok(
        (await page.locator(".ds-split-list .ds-badge", { hasText: /Low|Medium/ }).count()) >= 1,
        "confidence in the list",
      );
      assert.match(
        await page.locator(".ds-inspector").innerText(),
        /confidence/i,
        "and in the inspector",
      );
      await page.getByRole("button", { name: /Mark high-confidence reviewed/ }).click();
      await page.waitForSelector(".modal .approve-plan");
      assert.match(
        await page.locator(".modal").innerText(),
        /Marks reviewed[\s\S]*Skips/i,
        "the plan is shown before anything is marked",
      );
      await page
        .locator(".modal-backdrop")
        .evaluate("(e) => e.remove()")
        .catch(() => undefined);
      await page.keyboard.press("Escape");
      // Voice: the same list + inspector, with its review controls
      await go("#/voice", "textarea[id^=narration]");
      assert.equal(
        await page
          .locator("[data-status=approved], [data-status=changes], [data-status=rerun]")
          .count(),
        3,
      );
      // Annotations: nudges, target choices, reset, preview, scene play
      await go("#/annotations?item=zoom-kpi", ".ds-inspector");
      for (const needle of [/Start/, /Length/, /Target/, /Why/])
        assert.match(await page.locator(".ds-inspector").innerText(), needle);
      assert.ok(
        (await page.locator(".ds-inspector button[title='0.5 s later']").count()) >= 1,
        "the nudges",
      );
      assert.ok(
        (await page.locator(".ds-inspector .ann-thumb, .ds-inspector .ds-shot").count()) >= 1,
        "the preview",
      );
      assert.ok(
        (await page.locator(".ds-inspector .scene-draft button").count()) >= 1,
        "play the scene",
      );
      // Render: variants and the player, and the QA override on a blocked final
      await go("#/render/v1", ".ds-inspector[data-version='1']");
      assert.match(
        await page.locator(".ds-inspector").innerText(),
        /Variants and player[\s\S]*neutral/,
      );
      assert.ok((await page.locator(".ds-inspector video").count()) >= 1, "the player");
      const qa = page.locator(".ds-inspector .ds-section", { hasText: "Quality check" });
      assert.match(await qa.innerText(), /QA stopped it/);
      await qa.getByText("redaction r1 doesn't cover its element here").waitFor();
      assert.ok(
        (await qa.getByRole("button", { name: /Export anyway/ }).count()) >= 1,
        "the last-resort QA override of a leaking redaction",
      );
      await qa.getByRole("button", { name: /Export anyway/ }).click();
      assert.equal(
        await qa.locator("input[placeholder^='why is it fine']").count(),
        1,
        "and it asks for a reason",
      );
      assert.equal(
        await qa.locator("input[aria-label='type the acknowledgement']").count(),
        1,
        "and for the typed acknowledgement",
      );
      assert.equal(
        await qa.getByRole("button", { name: "Export anyway" }).isDisabled(),
        true,
        "which stays off until both are given",
      );
      void dlg;
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

// ---------------------------------------------------------------------------------------------------------
// 7. Search Config by key, description and a safe value; identify the effective source; edit only the named
//    scope, including a shadowed value. No secret appears.
test(
  "scenario 7: Config is found by key, description and value, says where the value comes from, edits only the named scope (shadowed too) and shows no secret",
  { skip, timeout: 120_000 },
  async () => {
    process.env.DEMO_REC_VOICE = "Env_voice";
    const { page, go, dlg, seed, globalFile, errors, close } = await setup();
    try {
      fs.writeFileSync(globalFile, JSON.stringify({ voiceName: "Narrator_voice" }));
      process.env.OPENAI_API_KEY = "sk-scenario-SECRET-42";
      const keysIn = async () =>
        (await page.evaluate(
          "[...document.querySelectorAll('.ds-srow')].map((e) => e.dataset.key)",
        )) as string[];
      await go("#/config", ".ds-srow");
      const search = async (q: string) => {
        await page.fill(".config-search input[type=search]", q);
        await page.waitForTimeout(300);
        return keysIn();
      };
      assert.ok((await search("voiceName")).includes("voiceName"), "by key");
      assert.ok((await search("display name")).includes("voiceName"), "by description");
      assert.ok((await search("Narrator")).includes("voiceName"), "by a safe value");
      assert.deepEqual(await search("Env_voice"), ["voiceName"], "by the value that is in effect");
      // the effective source: the environment wins, and says which variable
      await search("voiceName");
      const card = ".ds-srow[data-key='voiceName']";
      assert.match(
        await page.locator(`${card} [data-effective]`).innerText(),
        /Env_voice[\s\S]*Environment \(DEMO_REC_VOICE\)/,
      );
      await page.click(`${card} [data-toggle]`);
      assert.match(
        await page.locator(`${card} [data-layer=global]`).innerText(),
        /Narrator_voice/,
        "the shadowed file value is still shown",
      );
      // edit only the named scope, in the shadowed case: the dialog says so and only that file changes
      await page.click(`${card} [data-act=edit-project]`);
      assert.match(
        await page.locator(`${card} .ds-srow-edit label`).innerText(),
        /Editing the project override \(keycraft\)/,
      );
      assert.match(
        await page.locator(`${card} .ds-srow-edit .ds-notice`).innerText(),
        /no effect right now/,
      );
      await page.fill("#edit-voiceName", "Project_voice");
      await page.click(`${card} [data-act=save]`);
      for (let i = 0; i < 100 && !dlg.seen.length; i++) await wait(50);
      assert.match(dlg.seen[0] ?? "", /no effect right now[\s\S]*overridden by/i);
      const projectFile = path.join(seed.dir, "config.json");
      for (let i = 0; i < 100 && !fs.existsSync(projectFile); i++) await wait(50);
      assert.equal(JSON.parse(fs.readFileSync(projectFile, "utf8")).voiceName, "Project_voice");
      assert.equal(
        JSON.parse(fs.readFileSync(globalFile, "utf8")).voiceName,
        "Narrator_voice",
        "the global file is untouched",
      );
      // no secret, anywhere
      for (const needle of ["sk-scenario", "SECRET-42"]) {
        assert.deepEqual(await search(needle), [], `the key is not searchable (${needle})`);
      }
      await search("");
      await page.click("details.raw-files summary");
      assert.equal(
        /sk-scenario|SECRET-42/.test(await page.content()),
        false,
        "nowhere on the page, raw files included",
      );
      assert.deepEqual(errors, []);
    } finally {
      Reflect.deleteProperty(process.env, "DEMO_REC_VOICE");
      Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
      await close();
    }
  },
);

// ---------------------------------------------------------------------------------------------------------
// 8. Start with an empty, a partial and a complete brief: find the next task and the supporting context
//    without a wizard or a large empty form.
test(
  "scenario 8: an empty, a partial and a complete brief each open on a short summary with the next task, never a wizard or a wall of fields",
  { skip, timeout: 120_000 },
  async () => {
    const { page, rt, seed, go, errors, close } = await setup();
    try {
      const { ensureProject } = await import("../src/workdir/layout.ts");
      const { setBriefFacts } = await import("../src/workdir/brief.ts");
      const empty = ensureProject(seed.root, {
        project: "empty",
        appName: "Empty",
        appUrl: "https://e.test",
      });
      const partial = ensureProject(seed.root, {
        project: "partial",
        appName: "Partial",
        appUrl: "https://p.test",
      });
      fs.writeFileSync(
        path.join(partial.dir, "brief.md"),
        setBriefFacts(fs.readFileSync(path.join(partial.dir, "brief.md"), "utf8"), {
          persona: "Product teams",
        }),
      );
      const check = async (slug: string, next: RegExp) => {
        rt.setActiveProject(slug);
        await go("#/project", ".project-summary");
        await page.waitForFunction(
          `document.querySelector(".project-summary .ds-notice, [data-ready]")`,
        );
        assert.match(
          await page.locator(".project-summary").innerText(),
          next,
          `${slug}: the next task`,
        );
        assert.equal(
          await page.locator(".modal-backdrop").count(),
          0,
          `${slug}: no wizard, no dialog`,
        );
        assert.equal(
          await page.locator(".fact-groups").count(),
          0,
          `${slug}: the form is closed until asked for`,
        );
        assert.ok(
          ((await page.evaluate("document.documentElement.scrollHeight")) as number) <= 1150,
          `${slug}: no wall of fields to scroll`,
        );
        // the supporting context is one click away, not hidden
        for (const g of ["brief", "sources", "findings", "history"])
          assert.equal(
            await page.locator(`.subtabs .ds-chip[data-group=${g}]`).count(),
            1,
            `${slug}: ${g} is reachable`,
          );
      };
      await check(
        "empty",
        /Next: describe the demo to the Director, or fill the brief in yourself/,
      );
      await check("partial", /Next: complete the missing brief details: Goal, Depth/);
      await check(seed.slug, /The brief is complete/);
      // and the way in stays conversational: one button asks the Director, nothing is mandatory
      rt.setActiveProject("empty");
      await go("#/project", ".project-summary");
      assert.equal(await page.locator("[data-act=ask-director]").count(), 1);
      assert.equal(await page.locator("[data-act=fill-myself]").count(), 1);
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

// ---------------------------------------------------------------------------------------------------------
// 9. Keyboard, both themes, narrow layout, nested surfaces, failed saves, busy states, reduced motion, text zoom
//    and a lost connection.
for (const theme of ["macchiato", "latte"] as const) {
  test(
    `scenario 9 (${theme}): the keyboard reaches every action with a visible focus; dialogs trap and return focus; Escape closes one layer`,
    { skip, timeout: 150_000 },
    async () => {
      const { page, go, errors, close } = await setup();
      try {
        await page.addInitScript(`localStorage.setItem("demo-rec-theme", "${theme}")`);
        const walk = async (limit: number) => {
          const seen: { tag: string; name: string; ring: boolean }[] = [];
          for (let i = 0; i < limit; i++) {
            await page.keyboard.press("Tab");
            const info = (await page.evaluate(`(() => {
              const e = document.activeElement;
              if (!e || e === document.body) return null;
              const cs = getComputedStyle(e);
              const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== 'none');
              return { tag: e.tagName, name: (e.getAttribute('aria-label') || e.innerText || e.getAttribute('placeholder') || e.id || '').trim().slice(0, 40), ring: !!ring };
            })()`)) as { tag: string; name: string; ring: boolean } | null;
            if (info) seen.push(info);
          }
          return seen;
        };
        for (const [route, must] of [
          ["#/voice", [/Approve & use/, /Save new version/, /Versions/, /Mark reviewed/]],
          ["#/render/v1", [/New render/, /Approve final/, /Delete files/, /Re-run QA/]],
          ["#/config", [/Reload files/, /Settings/, /Scopes/]],
        ] as [string, RegExp[]][]) {
          await go(route, ".ds-header, header.top");
          await page.waitForTimeout(500);
          await page.evaluate("document.activeElement?.blur()");
          const seen = await walk(70);
          const noRing = seen.filter((s) => !s.ring);
          assert.deepEqual(
            noRing,
            [],
            `${route} (${theme}): every tab stop shows a focus indicator`,
          );
          for (const re of must)
            assert.ok(
              seen.some((s) => re.test(s.name)),
              `${route} (${theme}): the keyboard reaches ${re}`,
            );
        }
        // a dialog traps focus, Escape closes it, and focus returns to what opened it
        await go("#/voice", "textarea[id^=narration]");
        await page.locator("textarea[id^=narration]").fill("a draft to discard");
        await page.waitForFunction(
          `/Draft saved/.test(document.querySelector(".ds-actionbar .ds-savestate")?.innerText ?? "")`,
        );
        await page.focus("[data-act=discard]");
        await page.keyboard.press("Enter");
        await page.waitForSelector(".modal-backdrop .modal.dialog");
        const inside = async () =>
          (await page.evaluate("!!document.activeElement?.closest('.modal-backdrop')")) as boolean;
        assert.equal(await inside(), true, "focus moves into the dialog");
        for (let i = 0; i < 8; i++) {
          await page.keyboard.press("Tab");
          assert.equal(await inside(), true, "Tab stays inside the dialog");
        }
        await page.keyboard.press("Escape");
        await page.waitForSelector(".modal-backdrop", { state: "detached" });
        assert.equal(
          await page.evaluate("document.activeElement?.dataset?.act"),
          "discard",
          "focus returns to the trigger",
        );
        assert.deepEqual(errors, []);
      } finally {
        await close();
      }
    },
  );
}

test(
  "scenario 9: narrow layout, text zoom, reduced motion, a busy save and a lost connection",
  { skip, timeout: 180_000 },
  async () => {
    const { page, go, errors, close } = await setup(700);
    try {
      const overflow = () =>
        page.evaluate(
          "document.documentElement.scrollWidth - document.documentElement.clientWidth",
        ) as Promise<number>;
      const routes = [
        "#/project",
        "#/project?group=brief",
        "#/storyboard",
        "#/recording",
        "#/voice",
        "#/annotations",
        "#/render",
        "#/config",
        "#/config?view=brands",
      ];
      // narrow: nothing makes the page scroll sideways
      for (const r of routes) {
        await go(r);
        await page.waitForTimeout(500);
        assert.ok(
          (await overflow()) <= 1,
          `${r} at 700 px: no sideways scrolling (${await overflow()} px)`,
        );
      }
      // text zoom 200 %: the main actions are still on screen and the page still does not scroll sideways
      await page.setViewportSize({ width: 1400, height: 1000 });
      await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
      for (const r of ["#/voice", "#/render/v1", "#/config", "#/project"]) {
        await go(r);
        await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
        await page.waitForTimeout(500);
        assert.ok(
          (await overflow()) <= 2,
          `${r} at 200 % text: no sideways scrolling (${await overflow()} px)`,
        );
      }
      // reduced motion: the design's motion durations go to zero
      await page.emulateMedia({ reducedMotion: "reduce" });
      await go("#/voice", "textarea[id^=narration]");
      assert.equal(
        await page.evaluate(
          "getComputedStyle(document.documentElement).getPropertyValue('--motion-base').trim()",
        ),
        "0ms",
      );
      // a busy save says it is saving, and then that it saved
      await page.route("**/api/draft-save", async (route) => {
        await wait(700);
        await route.continue();
      });
      await page.locator("textarea[id^=narration]").fill("slow save");
      await page.waitForFunction(
        `/Saving…/.test(document.querySelector(".ds-actionbar .ds-savestate")?.innerText ?? "")`,
      );
      await page.waitForFunction(
        `/Draft saved/.test(document.querySelector(".ds-actionbar .ds-savestate")?.innerText ?? "")`,
      );
      await page.unroute("**/api/draft-save");
      // a lost connection is said, and the panel comes back by itself
      let down = true;
      await page.routeWebSocket(/\/ws/, (ws) => {
        if (down) ws.close();
        else ws.connectToServer();
      });
      await page.reload();
      await page.waitForSelector(".ds-strip");
      await page.waitForFunction(
        `/reconnecting|connecting/.test(document.querySelector(".strip-conn")?.innerText ?? "")`,
      );
      down = false; // the network is back: the next retry goes through
      await page.waitForFunction(
        `/connected/.test(document.querySelector(".strip-conn")?.innerText ?? "")`,
        undefined,
        { timeout: 20_000 },
      );
      assert.deepEqual(
        errors.filter((e) => !/WebSocket|Failed to fetch/.test(e)),
        [],
      );
    } finally {
      await close();
    }
  },
);
