/**
 * UX19b (D132): the Voice inspector shows the picture at each anchor of the narration (the take's keyframe at that mark),
 * so the words can be checked against what is on screen.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { sectionAnchors } from "../src/panel/anchors.ts";
import { Runtime } from "../src/runtime.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

// biome-ignore lint/suspicious/noExplicitAny: the tests index into replies of many shapes
type Reply = Record<string, any>;
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** The seeded take has marks m1 and m2 in 01-dash but no keyframe files: give m1 one, and leave m2 without. */
function withKeyframe(dir: string) {
  const kf = path.join(
    dir,
    "takes",
    "take-001",
    "analysis",
    "keyframes",
    "01-dash",
    "001350-m1.jpg",
  );
  fs.mkdirSync(path.dirname(kf), { recursive: true });
  fs.writeFileSync(kf, Buffer.from(PNG, "base64"));
  const file = path.join(dir, "takes", "take-001", "analysis", "analysis.json");
  const a = JSON.parse(fs.readFileSync(file, "utf8"));
  a.scenes[0].marks[0].keyframe = kf; // absolute, as the analysis writes it
  fs.writeFileSync(file, JSON.stringify(a));
  return kf;
}
const segs = [
  { text: "Headline churn is 3.1 percent." },
  { anchor: "m1", text: "Three point one, steady." },
  { anchor: "m2", text: "But EMEA is the outlier." },
  { anchor: "m1", text: "again" },
];

test("anchors: in spoken order, once each, with the keyframe path inside the project and the page text", () => {
  const { dir } = seedPanelProject();
  withKeyframe(dir);
  const a = sectionAnchors(dir, "take-001", "01-dash", segs);
  assert.deepEqual(
    a.map((x) => [x.mark, x.atMs, x.image]),
    [
      ["m1", 1000, "takes/take-001/analysis/keyframes/01-dash/001350-m1.jpg"],
      ["m2", 3000, null],
    ],
  );
  assert.equal(a[0]?.dom, '- img "Churn 3.1%"');
});

test("anchors: none for a section without a scene or anchors, an unknown take or mark, or a picture outside the project", () => {
  const { dir } = seedPanelProject();
  assert.deepEqual(sectionAnchors(dir, "take-001", undefined, segs), []);
  assert.deepEqual(sectionAnchors(dir, "take-001", "01-dash", [{ text: "no anchors" }]), []);
  assert.deepEqual(sectionAnchors(dir, "take-009", "01-dash", segs), []);
  assert.deepEqual(sectionAnchors(dir, "take-001", "99-none", segs), []);
  assert.deepEqual(sectionAnchors(dir, "take-001", "01-dash", [{ anchor: "nope", text: "x" }]), []);
  // a keyframe path that leaves the project is not offered
  const file = path.join(dir, "takes", "take-001", "analysis", "analysis.json");
  const a = JSON.parse(fs.readFileSync(file, "utf8"));
  const outside = path.join(path.dirname(dir), "outside.jpg");
  fs.writeFileSync(outside, Buffer.from(PNG, "base64"));
  a.scenes[0].marks[0].keyframe = outside;
  fs.writeFileSync(file, JSON.stringify(a));
  assert.equal(sectionAnchors(dir, "take-001", "01-dash", segs)[0]?.image, null);
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
const skip = !browserType && "needs Playwright Chromium";

test(
  "Voice inspector: the picture at each anchor, a note where there is none, nothing for sections without anchors",
  { skip, timeout: 90_000 },
  async () => {
    process.env.DEMO_REC_NO_OPEN = "1";
    const seed = seedPanelProject();
    withKeyframe(seed.dir);
    const cfg = path.join(seed.root, "c.json");
    fs.writeFileSync(cfg, "{}");
    process.env.DEMO_REC_CONFIG = cfg;
    const rt = new Runtime(() => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
      root: seed.root,
      panelPort: 0,
    }));
    rt.tellAgent = () => undefined;
    rt.setActiveProject(seed.slug);
    // the route carries it
    const vo = (await (rt.routeTables().get.vo as (q: URLSearchParams) => unknown)(
      new URLSearchParams("version=1"),
    )) as Reply;
    assert.deepEqual(
      vo.sections.map((s: Reply) => [s.key, s.anchors.length]),
      [
        ["_intro", 0],
        ["01-dash", 2],
        ["_outro", 0],
      ],
    );
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    const page = await (
      await browser.newContext({ viewport: { width: 1400, height: 1100 } })
    ).newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await page.goto(`${panel.url}#/voice/v1`);
      await page.waitForSelector(".ds-split-list .ds-item");
      assert.equal(await page.locator(".ds-anchors").count(), 0, "_intro has no anchors");
      await page.click(".ds-item[data-key='01-dash']");
      await page.waitForSelector(".ds-anchor");
      const items = page.locator(".ds-anchor");
      assert.equal(await items.count(), 2);
      assert.match(
        await items.nth(0).innerText(),
        /\[@m1\][\s\S]*0:01 into the take[\s\S]*Churn 3\.1%/,
      );
      assert.match(await items.nth(1).innerText(), /no picture for this moment[\s\S]*\[@m2\]/);
      const img = items.nth(0).locator("img");
      await img.waitFor();
      assert.match((await img.getAttribute("alt")) ?? "", /\[@m1\], 0:01/);
      await page.waitForFunction("document.querySelector('.ds-anchor img')?.complete");
      assert.equal(
        await page.evaluate("document.querySelector('.ds-anchor img').naturalWidth > 0"),
        true,
        "the picture is served and shown",
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
