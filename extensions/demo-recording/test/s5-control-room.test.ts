/**
 * S5 part 4 — control room: stage routes (lineage + next step for every tab
 * header), approval dry run (cascade warning), accepting a take from the
 * Recording tab, the take list with keyframes (also for moved projects), the
 * live frame, re-record requests, and a browser smoke test of the shell:
 * every tab renders, Live collapses/expands (and becomes a bottom drawer on
 * narrow windows), and accepting another take shows the cascade warning.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { hasBinary } from "../src/media/ffmpeg.ts";
import { liveFrame, localize } from "../src/panel/stage-routes.ts";
import { Runtime } from "../src/runtime.ts";
import { readInputs } from "../src/workdir/inputs.ts";
import { ensureProject } from "../src/workdir/layout.ts";
import { nextStep, previewApproval } from "../src/workdir/stages.ts";
import { acceptTake, approve, readState } from "../src/workdir/state.ts";

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

let root: string;
const savedCfg = process.env.DEMO_REC_CONFIG;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-cr-"));
  process.env.DEMO_REC_CONFIG = path.join(root, "none.json");
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (savedCfg === undefined) Reflect.deleteProperty(process.env, "DEMO_REC_CONFIG");
  else process.env.DEMO_REC_CONFIG = savedCfg;
});

const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);

/** A project with storyboards v1+v2, takes 1 (sb v1) and 2–3 (sb v2), take 2 analyzed with keyframes stored at a foreign absolute path. */
function fixtureProject() {
  const h = ensureProject(root, { project: "p", appName: "Acme", appUrl: "https://a.test" });
  const dir = h.dir;
  fs.mkdirSync(path.join(dir, "storyboard"), { recursive: true });
  for (const v of [1, 2])
    fs.writeFileSync(
      path.join(dir, "storyboard", `v${v}.yaml`),
      `version: ${v}\nstart_url: /\nscenes:\n  - id: 01-a\n    title: First\n    steps:\n      - do: press\n        key: Enter\n`,
    );
  for (const [n, sb] of [
    [1, 1],
    [2, 2],
    [3, 2],
  ] as const) {
    const t = path.join(dir, "takes", `take-00${n}`);
    fs.mkdirSync(path.join(t, "analysis", "keyframes", "01-a"), { recursive: true });
    fs.writeFileSync(
      path.join(t, "take.json"),
      JSON.stringify({
        take: `take-00${n}`,
        storyboardVersion: sb,
        status: "ok",
        durationMs: 12000 + n,
        startedAt: "2026-10-14T10:00:00Z",
      }),
    );
  }
  const kf = path.join(dir, "takes", "take-002", "analysis", "keyframes", "01-a", "k1.jpg");
  fs.writeFileSync(kf, JPEG);
  // Keyframe path from an older location of the project (moved/copied): must be re-anchored.
  const foreign = path.join(
    "/elsewhere/projects/p",
    "takes",
    "take-002",
    "analysis",
    "keyframes",
    "01-a",
    "k1.jpg",
  );
  fs.writeFileSync(
    path.join(dir, "takes", "take-002", "analysis", "analysis.json"),
    JSON.stringify({
      take: "take-002",
      scenes: [
        {
          id: "01-a",
          title: "First",
          start: 0,
          end: 9000,
          keyframes: [
            { t: 10, label: "start", file: foreign },
            { t: 5000, label: "settled", file: foreign },
          ],
        },
      ],
    }),
  );
  fs.mkdirSync(path.join(dir, "vo"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "vo", "script.v1.md"),
    "---\ntake: take-002\n---\n## 01-a\nhello\n",
  );
  return dir;
}

function runtime() {
  return new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(root, "none.json") } }),
    root,
    panelPort: 0,
  }));
}

test("nextStep walks the chain: user reviews fresh drafts, the agent produces missing ones", () => {
  const dir = fixtureProject();
  assert.deepEqual(nextStep(dir, {}), {
    who: "user",
    stage: "storyboard",
    text: "review and approve storyboard v2",
  });
  approve(dir, "storyboard", 2);
  assert.deepEqual(nextStep(dir, readState(dir)?.approved ?? {}), {
    who: "user",
    stage: "recording",
    text: "accept take-003 (Recording tab)",
  });
  acceptTake(dir, "take-002");
  assert.equal(
    nextStep(dir, readState(dir)?.approved ?? {}).text,
    "review and approve voice-over v1",
  );
  approve(dir, "vo", 1);
  assert.match(nextStep(dir, readState(dir)?.approved ?? {}).text, /generate the voice and render/);
  assert.equal(nextStep(dir, readState(dir)?.approved ?? {}, { rendered: true }).who, null);
  // A storyboard v3 without takes: the agent records.
  fs.writeFileSync(path.join(dir, "storyboard", "v3.yaml"), "version: 3\n");
  approve(dir, "storyboard", 3);
  assert.deepEqual(nextStep(dir, readState(dir)?.approved ?? {}), {
    who: "agent",
    stage: "recording",
    text: "the agent records a take of storyboard v3",
  });
});

test("previewApproval lists resets without changing anything", () => {
  const dir = fixtureProject();
  approve(dir, "storyboard", 2);
  acceptTake(dir, "take-002");
  approve(dir, "vo", 1);
  const before = fs.readFileSync(path.join(dir, "state.json"), "utf8");
  const resets = previewApproval(dir, readState(dir)?.approved ?? {}, "recording", 3);
  assert.deepEqual(
    resets.map((r) => [r.stage, r.version]),
    [["vo", 1]],
  );
  assert.equal(fs.readFileSync(path.join(dir, "state.json"), "utf8"), before);
  assert.throws(
    () => previewApproval(dir, readState(dir)?.approved ?? {}, "recording", 1),
    /based on storyboard v1, but storyboard v2 is approved/,
  );
});

test("localize re-anchors moved paths; liveFrame finds the newest fresh frame", () => {
  const dir = fixtureProject();
  const moved = localize(
    dir,
    "/elsewhere/projects/p/takes/take-002/analysis/keyframes/01-a/k1.jpg",
  );
  assert.equal(
    moved,
    path.join(dir, "takes", "take-002", "analysis", "keyframes", "01-a", "k1.jpg"),
  );
  assert.equal(localize(dir, "/elsewhere/nothing.jpg"), undefined);
  assert.equal(liveFrame(dir), null);
  const frames = path.join(dir, "takes", "take-003", "frames");
  fs.mkdirSync(frames);
  fs.writeFileSync(path.join(frames, "000001.jpg"), JPEG);
  fs.writeFileSync(path.join(frames, "000002.jpg"), JPEG);
  assert.deepEqual(liveFrame(dir), { take: "take-003", media: "takes/take-003/frames/000002.jpg" });
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(frames, "000002.jpg"), old, old);
  assert.equal(liveFrame(dir), null, "a stale frames/ folder (crashed take) is not 'live'");
});

test("panel routes: stages, recordings, approve-preview, accept a take, rerecord", async () => {
  const dir = fixtureProject();
  approve(dir, "storyboard", 2);
  acceptTake(dir, "take-002");
  approve(dir, "vo", 1);
  const rt = runtime();
  const notified: string[] = [];
  (rt as unknown as { notifyAgent: (t: string) => void }).notifyAgent = (t) => notified.push(t);
  rt.setActiveProject("p");
  const panel = await rt.ensurePanel();
  const base = `http://127.0.0.1:${panel.port}`;
  const auth = { authorization: `Bearer ${panel.token}` };
  const get = async (n: string) =>
    (await (await fetch(`${base}/api/${n}`, { headers: auth })).json()) as Record<string, unknown>;
  const post = async (n: string, body: unknown) => {
    const r = await fetch(`${base}/api/${n}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
  try {
    const st = (await get("stages")) as {
      stages: { stage: string; approved?: number; downstreamApproved: string[]; stale?: string }[];
      next: { who: string };
    };
    const rec = st.stages.find((s) => s.stage === "recording");
    assert.equal(rec?.approved, 2);
    assert.deepEqual(rec?.downstreamApproved, ["voice-over v1"]);
    assert.deepEqual(st.stages.find((s) => s.stage === "storyboard")?.downstreamApproved, [
      "recording take-002",
      "voice-over v1",
    ]);

    const recs = (await get("recordings")) as {
      takes: {
        id: string;
        accepted: boolean;
        onApprovedStoryboard: boolean;
        analyzed: boolean;
        scenes: { keyframe: string | null }[];
      }[];
    };
    assert.deepEqual(
      recs.takes.map((t) => t.id),
      ["take-003", "take-002", "take-001"],
      "newest first",
    );
    const t2 = recs.takes[1];
    assert.ok(t2?.accepted && t2.analyzed && t2.onApprovedStoryboard);
    assert.equal(
      t2?.scenes[0]?.keyframe,
      "takes/take-002/analysis/keyframes/01-a/k1.jpg",
      "foreign path re-anchored",
    );
    assert.equal(recs.takes[2]?.onApprovedStoryboard, false);
    const img = await fetch(
      `${base}/media/project/${t2?.scenes[0]?.keyframe}?token=${panel.token}`,
    );
    assert.equal(img.status, 200);
    await img.arrayBuffer();

    const pre = await post("approve-preview", { artifact: "recording", version: 3 });
    assert.deepEqual(
      (pre.json.resets as { label: string }[]).map((r) => r.label),
      ["voice-over v1"],
    );
    assert.equal(
      (await post("approve-preview", { artifact: "recording", version: 1 })).status,
      400,
    );
    assert.equal((await post("approve-preview", { artifact: "nope", version: 1 })).status, 400);

    const acc = await post("approve", { artifact: "recording", version: 3 });
    assert.equal(acc.status, 200);
    assert.deepEqual(
      (acc.json.resets as { stage: string }[]).map((r) => r.stage),
      ["vo"],
    );
    assert.deepEqual(readState(dir)?.approved, { storyboard: 2, recording: 3 });
    assert.match(
      notified.at(-1) ?? "",
      /take-003 .* ACCEPTED[\s\S]*Cascade reset[\s\S]*voice-over v1 is no longer approved/,
    );
    assert.equal(
      (await post("approve", { artifact: "recording", version: 1 })).status,
      400,
      "off-chain take refused",
    );

    const rr = await post("rerecord", { note: "slower typing" });
    assert.equal(rr.status, 200);
    assert.match(notified.at(-1) ?? "", /new take of storyboard v2 .* notes: "slower typing"/);
    assert.equal(readInputs(dir).at(-1)?.text, "re-record requested: slower typing");
    assert.deepEqual((await get("live-frame")).frame, null);
  } finally {
    await rt.shutdown();
  }
});

test(
  "control room in the browser: every tab, Live collapse/drawer, cascade warning on accept",
  { skip: noBrowser },
  async () => {
    const dir = fixtureProject();
    approve(dir, "storyboard", 2);
    acceptTake(dir, "take-002");
    approve(dir, "vo", 1);
    const rt = runtime();
    rt.setActiveProject("p");
    const panel = await rt.ensurePanel();
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(panel.url);
      await page.waitForSelector("aside.live");
      for (const tab of [
        "Storyboard",
        "Recording",
        "Voice over",
        "Annotations",
        "Render",
        "Config",
      ]) {
        await page.locator("nav button", { hasText: tab }).first().click();
        await page.waitForTimeout(300);
      }
      await page.locator("nav button", { hasText: "Recording" }).first().click();
      await page.waitForSelector(".card.take");
      assert.equal(
        await page.locator(".stage-head .stage-name").first().textContent(),
        "recording",
      );
      assert.match(
        (await page.locator(".stage-head").first().textContent()) ?? "",
        /approved take-002/,
      );
      assert.equal(await page.locator(".card.take").count(), 3);
      assert.equal(await page.locator(".keyframes img").count(), 1);

      // Accept take-003: the dry run lists the voice-over reset; cancel keeps everything.
      const dialogs: string[] = [];
      page.once("dialog", async (d) => {
        dialogs.push(d.message());
        await d.dismiss();
      });
      await page
        .locator(".card.take", { hasText: "take-003" })
        .getByRole("button", { name: "Accept take" })
        .click();
      await page.waitForTimeout(400);
      assert.match(dialogs[0] ?? "", /Approve take-003\?[\s\S]*resets[\s\S]*voice-over v1/);
      assert.equal(readState(dir)?.approved.recording, 2, "cancelled: nothing changed");

      // Live panel: collapse → strip; preference persists over a reload.
      await page.getByRole("button", { name: "▼ collapse" }).click();
      await page.waitForSelector(".live-strip");
      await page.reload();
      await page.waitForSelector(".live-strip");
      assert.equal(await page.locator("aside.live").count(), 0);
      // Narrow window: the open panel is a bottom drawer.
      await page.setViewportSize({ width: 900, height: 900 });
      await page.locator(".live-strip").click();
      await page.waitForSelector("aside.live");
      const pos = await page.evaluate(
        `(() => { const cs = getComputedStyle(document.querySelector("aside.live")); return { position: cs.position, bottom: cs.bottom }; })()`,
      );
      assert.deepEqual(pos, { position: "fixed", bottom: "0px" });
      // Per-tab section toggles persist.
      await page.locator(".live-toggles .chip", { hasText: "Log" }).click();
      assert.equal(await page.locator(".live-sec h3", { hasText: "Log" }).count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await rt.shutdown();
    }
  },
);
