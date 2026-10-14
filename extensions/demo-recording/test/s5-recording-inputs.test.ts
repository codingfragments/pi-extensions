/**
 * S5 part 6 — recording inputs: `emphasis:` hints (and legacy zoom/callout
 * conversion), layout snapshots (what is in, what is out, the 400 cap, box
 * accuracy, no password values), the snapshot recorder (throttle, discard,
 * lookup), and a real recording on a page where the clicked element moves.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { hasBinary } from "../src/media/ffmpeg.ts";
import {
  LAYOUT_FILE,
  LayoutRecorder,
  MAX_ELEMENTS,
  captureLayout,
  layoutAt,
  readLayout,
} from "../src/recorder/layout.ts";
import { recordTake } from "../src/recorder/runner.ts";
import { parseStoryboard } from "../src/storyboard/parse.ts";

async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}
const noBrowser =
  !((await chromiumAvailable()) && hasBinary("ffmpeg")) && "needs Playwright Chromium + ffmpeg";

test("emphasis: steps and scenes; legacy zoom/callout become hints; length limit", () => {
  const sb = parseStoryboard(
    `version: 1
start_url: /
scenes:
  - id: 01-a
    title: A
    emphasis: show that search is name-only
    steps:
      - { do: hover, target: { text: EMEA }, emphasis: the EMEA outlier is the story }
      - { do: hover, target: { text: APAC }, zoom: true, callout: Regional breakdown }
      - { do: press, key: Enter }
`,
    { version: 1 },
  );
  const sc = sb.scenes[0];
  assert.equal(sc?.emphasis, "show that search is name-only");
  assert.equal(sc?.steps[0]?.emphasis, "the EMEA outlier is the story");
  assert.equal(
    sc?.steps[1]?.emphasis,
    'suggest a zoom here; suggested callout: "Regional breakdown"',
  );
  assert.equal(sc?.steps[2]?.emphasis, undefined);
  assert.throws(
    () =>
      parseStoryboard(
        `version: 1\nstart_url: /\nscenes:\n  - id: 01-a\n    title: A\n    steps:\n      - { do: press, key: Enter, emphasis: "${"x".repeat(201)}" }\n`,
        { version: 1 },
      ),
    /emphasis.*one sentence/,
  );
});

test("layout recorder: settle throttle (marks always kept), discard after a cut, lookup by time", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-layout-"));
  try {
    const r = new LayoutRecorder(dir, 500);
    const snap = (t: number, reason: "settle" | "mark") => ({
      t,
      reason,
      url: "x",
      scroll: { x: 0, y: 0 },
      viewport: { w: 1, h: 1 },
      els: [],
    });
    for (const [t, reason] of [
      [0, "settle"],
      [300, "settle"], // throttled
      [350, "mark"], // marks always kept
      [600, "settle"],
      [900, "settle"], // throttled
      [1200, "settle"],
    ] as const)
      if (r.allow(reason, t)) r.write(snap(t, reason));
    assert.deepEqual(
      readLayout(dir).map((s) => s.t),
      [0, 350, 600, 1200],
    );
    assert.equal(layoutAt(readLayout(dir), 700)?.t, 600);
    assert.equal(layoutAt(readLayout(dir), -1), undefined);
    r.discardFrom(600);
    assert.deepEqual(
      readLayout(dir).map((s) => s.t),
      [0, 350],
    );
    assert.equal(r.count, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const PAGE = `<!doctype html><html><head><style>
  body { margin: 0; font: 16px sans-serif; }
  #banner { height: 120px; background: #fde68a; }
  .row { height: 24px; }
</style></head><body>
  <h1>Orders</h1>
  <p>Showing <b>12</b> of 17 products</p>
  <div id="slot"></div>
  <button id="add" onclick="document.getElementById('slot').innerHTML='<div id=banner>Saved!</div>'">Add banner</button>
  <div id="total">Total: 42 accounts</div>
  <label>Email <input id="email" type="email" value="jane@example.com"></label>
  <label>Password <input id="pw" type="password" value="hunter2"></label>
  <input id="otp" autocomplete="one-time-code" value="123456">
  <div style="display:none">hidden by display</div>
  <div style="visibility:hidden">hidden by visibility</div>
  <div style="opacity:0.05">nearly transparent</div>
  <div style="position:absolute;top:-500px">off screen</div>
  <div id="__demo_rec_cursor"><span>cursor label</span></div>
  <img alt="Revenue chart" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="200" height="80">
</body></html>`;

test(
  "layout snapshot: visible elements with text/roles/values; hidden, off-screen, cursor and secrets out; boxes exact",
  { skip: noBrowser },
  async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await page.setContent(PAGE);
      const snap = await captureLayout(page);
      assert.ok(snap);
      const texts = snap.els.map((e) => e.text ?? e.name ?? "");
      assert.ok(texts.includes("Orders"), "heading");
      assert.ok(texts.includes("Total: 42 accounts"), "numbers with their text");
      assert.ok(snap.els.some((e) => e.role === "button" && e.text === "Add banner"));
      assert.ok(
        snap.els.some((e) => e.role === "img" && e.name === "Revenue chart"),
        "images by alt text",
      );
      for (const gone of [
        "hidden by display",
        "hidden by visibility",
        "nearly transparent",
        "off screen",
        "cursor label",
      ])
        assert.ok(!texts.includes(gone), `${gone} must not be in the snapshot`);
      const values = snap.els.map((e) => e.value).filter(Boolean);
      assert.deepEqual(
        values,
        ["jane@example.com"],
        "password and one-time-code values never captured",
      );
      const total = snap.els.find((e) => e.text === "Total: 42 accounts");
      const bb = await page.locator("#total").boundingBox();
      assert.ok(total && bb);
      assert.ok(
        Math.abs(total.box.x - bb.x) <= 1 &&
          Math.abs(total.box.y - bb.y) <= 1 &&
          Math.abs(total.box.w - bb.width) <= 1 &&
          Math.abs(total.box.h - bb.height) <= 1,
        "box matches getBoundingClientRect",
      );
      assert.deepEqual(snap.viewport, { w: 1280, h: 720 });

      // Cap: 1000 rows → 400, interactive elements kept first.
      await page.setContent(
        `<button>Keep me</button>${Array.from({ length: 1000 }, (_, i) => `<div style="height:1px;font-size:1px">row ${i}</div>`).join("")}`,
      );
      await page.evaluate(
        "document.querySelectorAll('div').forEach((d) => (d.style.height = '2px'))",
      );
      const big = await captureLayout(page);
      assert.ok(big && big.els.length <= MAX_ELEMENTS);
      assert.ok(
        big.els.some((e) => e.role === "button"),
        "interactive first under the cap",
      );
    } finally {
      await browser.close();
    }
  },
);

let server: http.Server;
let baseUrl = "";
before(() => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
  });
  return new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    }),
  );
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

test(
  "recording: layout snapshots after steps and at marks, target-settled when the target moved, events stay ordered",
  { skip: noBrowser },
  async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-rec-"));
    try {
      const storyboard = parseStoryboard(
        `version: 1
start_url: /
scenes:
  - id: 01-banner
    title: Banner pushes content down
    steps:
      - { do: click, target: { role: button, name: Add banner }, mark: banner-added }
      - { do: hover, target: { text: "Total: 42 accounts" }, mark: total-visible, dwell: 600ms }
`,
        { version: 1 },
      );
      const take = await recordTake({
        projectDir,
        storyboard,
        storyboardVersion: 1,
        baseUrl,
        viewport: { width: 1280, height: 720, dpr: 1 },
        fps: 30,
        seed: 7,
      });
      const events = take.events;
      // Event order on the take clock is kept with the background work.
      for (let i = 1; i < events.length; i++)
        assert.ok((events[i]?.t ?? 0) >= (events[i - 1]?.t ?? 0), `event ${i} out of order`);
      // Marks stay unique (they are VO anchors).
      const marks = events.filter((e) => e.mark).map((e) => e.mark);
      assert.deepEqual(marks, ["banner-added", "total-visible"]);
      // The clicked button moved down by the banner's height after the click.
      const settled = events.find((e) => e.type === "target-settled" && e.step === 0);
      const click = events.find((e) => e.type === "click" && e.step === 0);
      assert.ok(settled?.box && click?.box);
      assert.equal(settled.data?.moved, true);
      assert.ok(
        settled.box.y - click.box.y >= 100,
        `moved down by the banner (${click.box.y} → ${settled.box.y})`,
      );
      assert.equal(settled.data?.forMark, "banner-added");
      const hoverSettled = events.find((e) => e.type === "target-settled" && e.step === 1);
      assert.equal(hoverSettled?.data?.moved, false, "the hover target stayed put");
      // Settled events land inside their scene.
      const sceneEnd = events.find((e) => e.type === "scene-end");
      assert.ok(
        sceneEnd &&
          events.filter((e) => e.type === "target-settled").every((e) => e.t <= sceneEnd.t),
      );

      const snaps = readLayout(take.takeDir);
      assert.ok(fs.existsSync(path.join(take.takeDir, LAYOUT_FILE)));
      assert.ok(snaps.some((s) => s.reason === "mark" && s.mark === "total-visible"));
      assert.ok(snaps.some((s) => s.reason === "settle" && s.step === 0));
      const atTotal = layoutAt(snaps, events.find((e) => e.mark === "total-visible")?.t ?? 0);
      assert.ok(atTotal?.els.some((e) => e.text === "Total: 42 accounts"));
      assert.ok(
        snaps.every((s) => !s.els.some((e) => e.value === "hunter2" || e.value === "123456")),
        "no secrets in any snapshot",
      );
      const meta = JSON.parse(fs.readFileSync(path.join(take.takeDir, "take.json"), "utf8"));
      assert.equal(meta.layout.snapshots, snaps.length);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  },
);
