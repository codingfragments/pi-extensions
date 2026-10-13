/**
 * S1 integration: real browser + screencast + ffmpeg on the fixture.
 * Skipped when Playwright Chromium or ffmpeg is missing (e.g. CI).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { openSession } from "../src/browser/session.ts";
import { type FixtureHandle, serveFixture } from "../src/fixture/server.ts";
import { ffprobe, hasBinary } from "../src/media/ffmpeg.ts";
import { readEvents } from "../src/recorder/events.ts";
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
const ready = (await chromiumAvailable()) && hasBinary("ffmpeg") && hasBinary("ffprobe");
const skip = !ready && "needs Playwright Chromium + ffmpeg";

let fixture: FixtureHandle;
let root: string;
before(async () => {
  fixture = await serveFixture(0);
  root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-s1-"));
});
after(async () => {
  await fixture.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test(
  "virtual cursor follows dispatched mouse events and mirrors cursor styles",
  { skip },
  async () => {
    const s = await openSession({ viewport: { width: 1600, height: 900, dpr: 2 } });
    try {
      await s.page.goto(`${fixture.url}search`);
      // String expressions: browser globals don't type-check under the Node test config.
      const read = () =>
        s.page.evaluate(`(() => {
          const c = window.__demoRecCursor;
          const el = document.getElementById("__demo_rec_cursor");
          return { pos: c.pos, shape: c.shape, present: !!el, pe: el ? getComputedStyle(el).pointerEvents : "" };
        })()`) as Promise<{
          pos: { x: number; y: number };
          shape: string;
          present: boolean;
          pe: string;
        }>;

      await s.page.mouse.move(900, 600);
      let st = await read();
      assert.deepEqual(st.pos, { x: 900, y: 600 });
      assert.equal(st.present, true);
      assert.equal(st.pe, "none", "overlay must not intercept clicks");
      assert.equal(st.shape, "arrow");

      const link = await s.page.getByRole("link", { name: "Dashboard" }).boundingBox();
      assert.ok(link);
      await s.page.mouse.move(link.x + 10, link.y + link.height / 2);
      assert.equal((await read()).shape, "hand");

      const input = await s.page.getByRole("searchbox", { name: "Search" }).boundingBox();
      assert.ok(input);
      await s.page.mouse.move(input.x + 50, input.y + input.height / 2);
      st = await read();
      assert.equal(st.shape, "text");

      // Clicking through the overlay still focuses the input.
      await s.page.mouse.click(input.x + 50, input.y + input.height / 2);
      assert.equal(
        await s.page.evaluate('document.activeElement?.getAttribute("aria-label")'),
        "Search",
      );

      // SPA re-render of <main> keeps the overlay attached.
      await s.page.getByRole("link", { name: "Dashboard" }).click();
      assert.equal((await read()).present, true);
    } finally {
      await s.close();
    }
  },
);

test(
  "recordTake: 3200x1800 frames, monotonic events on the take clock, exact CFR master",
  { skip },
  async () => {
    const storyboard = parseStoryboard(`
version: 1
start_url: /
scenes:
  - id: 01-go
    title: Go to search
    steps:
      - { do: hover, target: { css: '[data-kpi="arr"]' }, mark: arr-kpi, dwell: 300 }
      - { do: click, target: { role: link, name: Search } }
      - { do: type, target: { role: searchbox, name: Search }, text: emea, mark: type-start }
      - { do: press, key: Enter }
      - { do: wait, for: { css: ".hits" }, timeout: 10s, mark: results-visible }
`);
    const projectDir = path.join(root, "p1");
    fs.mkdirSync(projectDir);
    const seen: string[] = [];
    const take = await recordTake({
      projectDir,
      storyboard,
      storyboardVersion: 1,
      baseUrl: fixture.url,
      viewport: { width: 1600, height: 900, dpr: 2 },
      fps: 30,
      seed: 11,
      onEvent: (e) => seen.push(e.type),
    });

    assert.equal(take.takeId, "take-001");
    assert.equal(
      `${take.capture.width}x${take.capture.height}`,
      "3200x1800",
      "true device-pixel frames headless",
    );
    assert.ok(take.capture.frames > 10);

    const events = readEvents(path.join(take.takeDir, "events.jsonl"));
    assert.deepEqual(
      seen,
      events.map((e) => e.type),
      "onEvent mirrors the log",
    );
    assert.equal(events[0]?.type, "take-start");
    assert.equal(events.at(-1)?.type, "take-end");
    for (let i = 1; i < events.length; i++)
      assert.ok((events[i]?.t ?? 0) >= (events[i - 1]?.t ?? 0), "monotonic");
    assert.deepEqual(
      events.filter((e) => e.mark).map((e) => e.mark),
      ["arr-kpi", "type-start", "results-visible"],
    );
    const typed = events.find((e) => e.type === "type-start");
    assert.ok(typed?.box && typed.box.w > 100, "type-start carries the input box");
    assert.deepEqual(
      take.scenes.map((s) => s.id),
      ["01-go"],
    );

    const meta = JSON.parse(fs.readFileSync(path.join(take.takeDir, "take.json"), "utf8"));
    assert.equal(meta.status, "ok");
    assert.equal(meta.seed, 11);
    assert.ok(fs.existsSync(path.join(take.takeDir, "frames.jsonl")));

    assert.ok(take.rawVideo);
    const probe = await ffprobe(take.rawVideo);
    const v = probe.streams.find((s) => s.codec_type === "video");
    assert.equal(`${v?.width}x${v?.height}`, "3200x1800");
    assert.equal(v?.r_frame_rate, "30/1");
    const expected = Math.floor((take.durationMs * 30) / 1000) / 30;
    assert.ok(
      Math.abs(probe.duration - expected) < 0.04,
      `master ${probe.duration}s vs take ${expected}s — no drift`,
    );
  },
);

test("recordTake: a failing step marks the take failed and keeps evidence", { skip }, async () => {
  const storyboard = parseStoryboard(`
version: 1
start_url: /
scenes:
  - id: 01-broken
    title: Broken
    steps:
      - { do: click, target: { role: button, name: Does not exist } }
`);
  const projectDir = path.join(root, "p2");
  fs.mkdirSync(projectDir);
  // Short locator timeout comes from resolveBox's default (10 s); keep the test bounded.
  await assert.rejects(
    recordTake({
      projectDir,
      storyboard,
      storyboardVersion: 1,
      baseUrl: fixture.url,
      viewport: { width: 1280, height: 720, dpr: 1 },
      fps: 30,
      seed: 1,
    }),
    /scene 01-broken, step 0 \(click\): target not visible/,
  );
  const takeDir = path.join(projectDir, "takes", "take-001");
  const meta = JSON.parse(fs.readFileSync(path.join(takeDir, "take.json"), "utf8"));
  assert.equal(meta.status, "failed");
  assert.match(meta.error, /target not visible/);
  assert.ok(readEvents(path.join(takeDir, "events.jsonl")).some((e) => e.type === "error"));
});
