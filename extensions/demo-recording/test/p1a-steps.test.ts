/**
 * P1a PR 13 (A3, F11 F22 F30): what the panel does when something happens is written down once (steps.js) and a test
 * keeps it complete; a result that arrives by itself is a badge, a toast on its screen and a line in Activity; an
 * alert is never silent; a draft with no annotations says so; Approve & use says what happens next.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { STEPS, STEP_CLASSES, stepOf } from "../src/panel/public/steps.js";
import { nextAfterApproval } from "../src/panel/version-routes.ts";
import { Runtime } from "../src/runtime.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

const SRC = path.join(import.meta.dirname, "..", "src");

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((f) => {
    const full = path.join(dir, f.name);
    if (f.isDirectory()) return f.name === "public" ? [] : sources(full);
    return f.name.endsWith(".ts") ? [full] : [];
  });
}

/** Events the engine publishes with a literal type, plus the ones built from a template or a ternary. */
function published(): Set<string> {
  const found = new Set<string>();
  for (const file of sources(SRC)) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/(?:publish|emit)\(\s*"([a-z][a-z.-]+)"/g))
      found.add(m[1] as string);
  }
  // `h.created ? "project.created" : "project.opened"`, `${stage}.approved`, take.accepted for a recording
  for (const t of [
    "project.created",
    "project.opened",
    "storyboard.approved",
    "vo.approved",
    "annotations.approved",
    "render.approved",
    "take.accepted",
  ])
    found.add(t);
  return found;
}

test("every event the engine publishes has a class, and the table has nothing stale", () => {
  const events = published();
  const classed = new Set(Object.keys(STEPS));
  assert.deepEqual(
    [...events].filter((e) => !classed.has(e)).sort(),
    [],
    "an event with no class: add it to src/panel/public/steps.js (ask, run-and-tell, progress, alert or quiet)",
  );
  assert.deepEqual(
    [...classed].filter((e) => !events.has(e)).sort(),
    [],
    "a class for an event nothing publishes any more",
  );
  for (const [type, s] of Object.entries(STEPS)) {
    assert.ok(STEP_CLASSES.includes(s.class), `${type}: a known class`);
    if (s.class === "run-and-tell")
      assert.ok(s.tab, `${type}: run-and-tell names the screen it concerns`);
  }
});

test("a run-and-tell step is news only when it arrived without you; a quiet echo of your own is not", () => {
  assert.equal(stepOf({ type: "vo.written", data: { by: "agent" } })?.class, "run-and-tell");
  assert.equal(stepOf({ type: "vo.written", data: { by: "user" } })?.class, "quiet");
  assert.equal(
    stepOf({ type: "annotations.updated", data: { by: "annotation-designer (a/one)" } })?.tab,
    "annotations",
  );
  assert.equal(stepOf({ type: "annotations.updated", data: { by: "panel" } })?.class, "quiet");
  // the QA that runs after a final is news; your own confirm or ignore is not
  assert.equal(stepOf({ type: "render.qa", data: {} })?.class, "run-and-tell");
  assert.equal(stepOf({ type: "render.qa", data: { ignore: "ig-1" } })?.class, "quiet");
  assert.equal(stepOf({ type: "render.qa", data: { reason: "x" } })?.class, "quiet");
  // a job that failed or was cancelled is not a result: the strip says so
  assert.equal(stepOf({ type: "design.finished", data: { status: "failed" } })?.class, "quiet");
  assert.equal(stepOf({ type: "render.finished", data: { status: "cancelled" } })?.class, "quiet");
  assert.equal(
    stepOf({ type: "render.finished", data: { status: "done" } })?.class,
    "run-and-tell",
  );
  // problems are never silent, progress is not a notification
  assert.equal(stepOf({ type: "model.warning" })?.class, "alert");
  assert.equal(stepOf({ type: "agent.notify-failed" })?.class, "alert");
  assert.equal(stepOf({ type: "edit.progress" })?.class, "progress");
  assert.equal(stepOf({ type: "no.such.event" }), undefined);
});

test("what happens next is said for every stage; Approve & use returns it, Approve only does not", async () => {
  for (const stage of ["storyboard", "recording", "vo", "annotations", "render"] as const)
    assert.match(nextAfterApproval(stage), /^(Next|Done): /);
  assert.match(nextAfterApproval("storyboard"), /waits for your Allow/);
  assert.match(nextAfterApproval("vo"), /estimate comes with the request/);

  const seed = seedPanelProject();
  const cfg = path.join(seed.root, "c.json");
  fs.writeFileSync(cfg, "{}");
  const rt = new Runtime(
    () => ({ ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }), root: seed.root, panelPort: 0 }),
    { sendUserMessage: () => {}, sendMessage: () => {} },
  );
  rt.setActiveProject(seed.slug);
  try {
    const post = rt.routeTables().post;
    const act = async (stage: string, version: number, intent: string) => {
      const plan = (await post["version-plan"]?.({ stage, version, intent })) as { token: string };
      return (await post["version-act"]?.({ stage, version, intent, token: plan.token })) as {
        next?: string;
      };
    };
    const only = await act("storyboard", 2, "approve-only");
    assert.equal(only.next, undefined, "approve only changes nothing that follows");
    const use = await act("vo", 2, "approve-use");
    assert.match(use.next ?? "", /^Next: the Director asks to synthesize the voice/);
  } finally {
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
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
  "in the browser: a toast on its screen, a badge elsewhere, a line in Activity, alerts are loud, and the draft says it has no annotations",
  { skip: !browserType && "needs Playwright Chromium", timeout: 90_000 },
  async () => {
    process.env.DEMO_REC_NO_OPEN = "1";
    const seed = seedPanelProject();
    // a draft made by the voice step, before there are annotations
    const rec = path.join(seed.dir, "render", "v4.json");
    const r4 = JSON.parse(fs.readFileSync(rec, "utf8"));
    assert.equal(r4.kind, "draft");
    r4.basedOn = {};
    fs.writeFileSync(rec, JSON.stringify(r4));
    const cfg = path.join(seed.root, "c.json");
    fs.writeFileSync(cfg, "{}");
    const rt = new Runtime(() => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
      root: seed.root,
      panelPort: 0,
    }));
    rt.setActiveProject(seed.slug);
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
      await page.goto(`${panel.url}#/render/v4`);
      await page.waitForSelector(".ds-inspector[data-version='4']");
      // the draft says it has no annotations (in its name and in the list)
      assert.ok(
        (await page
          .locator(".ds-inspector h2 ~ .ds-badge", { hasText: "no annotations" })
          .count()) >= 1,
      );
      await page.waitForTimeout(500);

      // a result for the screen you are on: a toast
      rt.bus.publish(
        "edit.finished",
        { message: "edit and draft render v8 ready (by itself after the voice step)" },
        seed.slug,
      );
      await page.locator(".toast", { hasText: "draft render v8 ready" }).waitFor();
      // a result for another screen: a badge, no toast
      rt.bus.publish("design.finished", { message: "designer v3 on a/one · 12 s" }, seed.slug);
      await page.locator("a.ds-step[data-tab=annotations] .ds-badge", { hasText: "new" }).waitFor();
      assert.equal(
        await page.locator(".toast", { hasText: "designer v3" }).count(),
        0,
        "no toast for another screen",
      );
      // an alert is never silent
      rt.bus.publish(
        "model.warning",
        { message: "the session model cannot see images" },
        seed.slug,
      );
      await page.locator(".toast", { hasText: "cannot see images" }).waitFor();
      // progress and your own actions are not announced
      rt.bus.publish("edit.progress", { message: "cutting scene 2" }, seed.slug);
      rt.bus.publish("config.changed", { message: "fps = 30" }, seed.slug);
      await page.waitForTimeout(300);
      assert.equal(
        await page.locator(".toast", { hasText: /cutting scene 2|fps = 30/ }).count(),
        0,
      );

      // Activity lists what happened by itself
      await page.getByRole("button", { name: /Activity/ }).click();
      const by = page.getByRole("region", { name: "Happened by itself" });
      await by.waitFor();
      const text = await by.innerText();
      assert.match(text, /draft render v8 ready/);
      assert.match(text, /designer v3/);
      assert.doesNotMatch(text, /cutting scene 2|fps = 30/);
      if (process.env.P1A_SHOTS)
        await page.screenshot({ path: `${process.env.P1A_SHOTS}-steps.png` });
      await page.close();
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
