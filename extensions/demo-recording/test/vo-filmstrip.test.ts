/**
 * Item 8a (F16): the voice-over shows every moment of the scene under the narration, in time order: the start, each mark (used
 * by the narration with the words it pins, or "not mentioned"), notable moments, the end. An intro shows how the first scene
 * opens, an outro how the last one ends. Clicking an unused mark puts its [@mark] into the narration where the cursor was.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { sectionFrames } from "../src/panel/anchors.ts";
import { marksSpoken } from "../src/panel/public/chapters-core.js";
import { Runtime } from "../src/runtime.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
// biome-ignore lint/suspicious/noExplicitAny: the tests index into replies of many shapes
type Reply = Record<string, any>;

/**
 * The seeded take has one scene with marks m1 and m2 (the voice-over uses both) and no frames: give it a start, the two marks,
 * a toast, a third mark the narration does not use, and an end, each with a still except the toast.
 */
function withFrames(dir: string) {
  const kfDir = path.join(dir, "takes", "take-001", "analysis", "keyframes", "01-dash");
  fs.mkdirSync(kfDir, { recursive: true });
  const still = (name: string) => {
    const f = path.join(kfDir, `${name}.jpg`);
    fs.writeFileSync(f, Buffer.from(PNG, "base64"));
    return f;
  };
  const file = path.join(dir, "takes", "take-001", "analysis", "analysis.json");
  const a = JSON.parse(fs.readFileSync(file, "utf8"));
  const sc = a.scenes[0];
  sc.marks.push({ mark: "m3", t: 4500, type: "wait-satisfied", dom: '- text "Done"' });
  sc.keyframes = [
    { t: 5700, label: "end", file: still("end") },
    { t: 300, label: "start", file: still("start") },
    { t: 1350, label: "m1", file: still("m1") },
    { t: 3350, label: "m2", file: still("m2") },
    { t: 3900, label: "alert", file: path.join(kfDir, "gone.jpg") },
    { t: 4850, label: "m3", file: still("m3") },
  ];
  fs.writeFileSync(file, JSON.stringify(a));
}

const segs = [
  { text: "Headline churn is 3.1 percent." },
  { anchor: "m1", text: "Three point one, steady, and not moving at all this quarter." },
  { anchor: "m2", text: "But EMEA is the outlier." },
];

test("frames of a scene: time order, kinds, used marks with the words they pin, an unused mark, a missing still", () => {
  const { dir } = seedPanelProject();
  withFrames(dir);
  const f = sectionFrames(dir, "take-001", { kind: "scene", scene: "01-dash" }, segs);
  assert.deepEqual(
    f.map((x) => [x.label, x.kind, x.used, x.image === null ? null : "file"]),
    [
      ["start", "start", false, "file"],
      ["m1", "mark", true, "file"],
      ["m2", "mark", true, "file"],
      ["alert", "event", false, null],
      ["m3", "mark", false, "file"],
      ["end", "end", false, "file"],
    ],
  );
  assert.equal(
    f[1]?.pins,
    "Three point one, steady, and not moving at all…",
    "the first nine words",
  );
  assert.equal(f[2]?.pins, "But EMEA is the outlier.");
  assert.equal(f[4]?.pins, undefined, "an unused mark pins nothing");
  assert.equal(f[1]?.image, "takes/take-001/analysis/keyframes/01-dash/m1.jpg");
});

test("intro and outro show how the scene opens and ends; a bridge, an unknown scene or take nothing", () => {
  const { dir } = seedPanelProject();
  withFrames(dir);
  assert.deepEqual(
    sectionFrames(dir, "take-001", { kind: "intro" }, []).map((x) => [x.label, x.scene]),
    [["start", "01-dash"]],
  );
  assert.deepEqual(
    sectionFrames(dir, "take-001", { kind: "outro" }, []).map((x) => [x.label, x.scene]),
    [["end", "01-dash"]],
  );
  assert.deepEqual(sectionFrames(dir, "take-001", { kind: "bridge" }, []), []);
  assert.deepEqual(sectionFrames(dir, "take-001", { kind: "scene", scene: "99-none" }, segs), []);
  assert.deepEqual(sectionFrames(dir, "take-009", { kind: "scene", scene: "01-dash" }, segs), []);
});

test("the marks of a draft as it is typed: the first words after each, a hint is not part of the mark, only the first use counts", () => {
  const m = marksSpoken("Intro words. [@m1] one two [@m2 +300ms] three [@m1] again [@m3]");
  assert.deepEqual(
    [...m],
    [
      ["m1", "one two"],
      ["m2", "three"],
      ["m3", ""],
    ],
  );
  assert.equal(marksSpoken("[@a] 1 2 3 4 5 6 7 8 9 10 11").get("a"), "1 2 3 4 5 6 7 8 9…");
  assert.equal(marksSpoken("no anchors, [@ broken] and [@x y] are not marks").size, 0);
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
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test(
  "in the browser: the scene's moments with used and not mentioned; a click inserts the mark at the cursor; intro and outro; no sideways scroll",
  { skip, timeout: 90_000 },
  async () => {
    process.env.DEMO_REC_NO_OPEN = "1";
    const seed = seedPanelProject();
    withFrames(seed.dir);
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
    const vo = (await (rt.routeTables().get.vo as (q: URLSearchParams) => unknown)(
      new URLSearchParams("version=1"),
    )) as Reply;
    assert.deepEqual(
      vo.sections.map((s: Reply) => [s.key, s.frames.length]),
      [
        ["_intro", 1],
        ["01-dash", 6],
        ["_outro", 1],
      ],
      "the route carries the frames",
    );
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const page = await (
        await browser.newContext({ viewport: { width: 1400, height: 1100 } })
      ).newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${panel.url}#/voice/v1`);
      await page.waitForSelector(".ds-split-list .ds-item");
      // the intro opens on how the first scene starts
      await page.waitForSelector(".ds-filmstrip");
      assert.match(
        await page.locator(".ds-filmstrip > .ds-label").innerText(),
        /How 01-dash opens/,
      );
      assert.equal(await page.locator(".ds-filmstrip li").count(), 1);
      await page.click(".ds-item[data-key='01-dash']");
      await page.waitForSelector(".ds-filmstrip li[data-label=m3]");
      assert.deepEqual(
        await page.evaluate(
          "[...document.querySelectorAll('.ds-filmstrip li')].map((e) => e.dataset.label)",
        ),
        ["start", "m1", "m2", "alert", "m3", "end"],
        "all the moments in time order",
      );
      const cap = (label: string) =>
        page.locator(`.ds-filmstrip li[data-label=${label}]`).innerText();
      assert.match(await cap("m1"), /✓ “Three point one, steady.”/);
      assert.match(await cap("m3"), /not mentioned in the narration/);
      assert.match(await cap("alert"), /notable moment/);
      assert.match(
        await page.locator("[data-filmstrip-summary]").innerText(),
        /2 of 3 marks used; 1 not mentioned/,
      );
      assert.equal(
        await page.locator(".ds-filmstrip li[data-label=m1] button").count(),
        0,
        "a used mark is not a button",
      );
      assert.equal(
        await page.locator(".ds-filmstrip li[data-label=m3] button").count(),
        1,
        "an unused mark is",
      );
      // a picture that exists is shown, a missing one says so
      await page.waitForFunction(
        "document.querySelector('.ds-filmstrip li[data-label=start] img')?.complete",
      );
      assert.equal(
        await page.evaluate(
          "document.querySelector('.ds-filmstrip li[data-label=start] img').naturalWidth > 0",
        ),
        true,
      );
      assert.match(await cap("alert"), /no frame/);
      // click inserts [@m3] where the cursor was: put it after the first sentence
      const ta = page.locator("textarea[id^=narration]");
      const text = await ta.inputValue();
      const at = text.indexOf("percent.") + "percent.".length;
      await ta.focus();
      await page.evaluate(
        `document.querySelector("textarea[id^=narration]").setSelectionRange(${at}, ${at})`,
      );
      await page.click(".ds-filmstrip li[data-label=m3] button");
      await page.waitForFunction(
        "document.querySelector('textarea[id^=narration]').value.includes('[@m3]')",
      );
      const after = await ta.inputValue();
      assert.equal(
        after.slice(0, at + 6),
        `${text.slice(0, at)} [@m3]`,
        "inserted at the cursor, with a space before",
      );
      assert.match(after.slice(at), /^ \[@m3\] /);
      assert.ok(after.includes(text.slice(at).trim()), "nothing else changed");
      // the caret sits after the inserted mark and the box has the focus
      await page.waitForFunction("document.activeElement?.tagName === 'TEXTAREA'");
      assert.equal(
        await page.evaluate("document.querySelector('textarea[id^=narration]').selectionStart"),
        at + " [@m3] ".length,
      );
      // now used: the card list has it and the frame says so, no longer a button
      await page.waitForFunction(
        "document.querySelector('.ds-filmstrip li[data-label=m3]')?.dataset.used === 'true'",
      );
      assert.equal(await page.locator(".ds-filmstrip li[data-label=m3] button").count(), 0);
      // the outro shows how the last scene ends
      await page.click(".ds-item[data-key='_outro']");
      await page.waitForFunction(
        "/How 01-dash ends/.test(document.querySelector('.ds-filmstrip > .ds-label')?.textContent ?? '')",
      );
      assert.equal(await page.locator(".ds-filmstrip li").count(), 1);
      assert.equal(
        await page.locator("[data-filmstrip-summary]").count(),
        0,
        "no marks line for an outro",
      );
      // 900 px: no sideways scroll
      await page.click(".ds-item[data-key='01-dash']");
      await page.setViewportSize({ width: 900, height: 900 });
      await wait(250);
      assert.equal(await page.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
