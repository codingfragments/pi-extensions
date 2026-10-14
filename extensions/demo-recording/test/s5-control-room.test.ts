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
import { browserCommand, canOpenBrowser } from "../src/util/open.ts";
import { readInputs } from "../src/workdir/inputs.ts";
import { ensureProject } from "../src/workdir/layout.ts";
import { nextStep } from "../src/workdir/stages.ts";
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

const line = (dir: string) => readState(dir)?.line ?? {};
const acc = (dir: string) => readState(dir)?.accepted ?? {};

test("nextStep walks the working line: the user accepts drafts, the agent produces missing ones", () => {
  const dir = fixtureProject();
  assert.deepEqual(nextStep(dir, acc(dir), line(dir)), {
    who: "user",
    stage: "storyboard",
    text: "review and accept storyboard v2",
  });
  approve(dir, "storyboard", 2);
  assert.deepEqual(nextStep(dir, acc(dir), line(dir)), {
    who: "user",
    stage: "recording",
    text: "accept a take of storyboard v2 (e.g. take-003)",
  });
  acceptTake(dir, "take-002");
  assert.equal(nextStep(dir, acc(dir), line(dir)).text, "review and accept voice-over v1");
  approve(dir, "vo", 1);
  assert.match(nextStep(dir, acc(dir), line(dir)).text, /generate the voice and render/);
  assert.equal(nextStep(dir, acc(dir), line(dir), { rendered: true }).who, null);
  // take-003 accepted → it becomes the line, no VO on it yet: the agent writes one.
  acceptTake(dir, "take-003");
  assert.deepEqual(nextStep(dir, acc(dir), line(dir)), {
    who: "agent",
    stage: "vo",
    text: "the agent writes the voice-over for take-003",
  });
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

test("browser opener: per-platform command, disabled in CI / headless / by env", () => {
  assert.deepEqual(browserCommand("darwin").args("http://x"), ["http://x"]);
  assert.equal(browserCommand("darwin").cmd, "open");
  assert.equal(browserCommand("linux").cmd, "xdg-open");
  assert.equal(browserCommand("win32").cmd, "cmd");
  assert.equal(canOpenBrowser({}, "darwin"), true);
  assert.equal(canOpenBrowser({ DEMO_REC_NO_OPEN: "1" }, "darwin"), false);
  assert.equal(canOpenBrowser({ CI: "true" }, "darwin"), false);
  assert.equal(canOpenBrowser({}, "linux"), false, "no display, nothing to open");
  assert.equal(canOpenBrowser({ DISPLAY: ":0" }, "linux"), true);
});

test("panel routes: stages with inputs, recordings per storyboard, accept several, un-accept → orphans, select, rerecord, VO per take", async () => {
  const dir = fixtureProject();
  approve(dir, "storyboard", 2);
  acceptTake(dir, "take-002");
  approve(dir, "vo", 1);
  const rt = runtime();
  const notified: string[] = [];
  const told: string[] = [];
  const r = rt as unknown as { notifyAgent: (t: string) => void; tellAgent: (t: string) => void };
  r.notifyAgent = (t) => notified.push(t);
  r.tellAgent = (t) => told.push(t);
  rt.setActiveProject("p");
  const panel = await rt.ensurePanel();
  const base = `http://127.0.0.1:${panel.port}`;
  const auth = { authorization: `Bearer ${panel.token}` };
  const get = async (n: string) =>
    (await (await fetch(`${base}/api/${n}`, { headers: auth })).json()) as Record<string, unknown>;
  const post = async (n: string, body: unknown) => {
    const res = await fetch(`${base}/api/${n}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  type St = {
    stage: string;
    inputs: { version: number; label: string }[];
    input?: number;
    selected?: number;
    accepted: { version: number; orphaned?: string }[];
  };
  try {
    let st = (await get("stages")) as { stages: St[]; lineText: string };
    assert.equal(st.lineText, "storyboard v2 → recording take-002 → voice-over v1");
    const vo = st.stages.find((s) => s.stage === "vo");
    assert.deepEqual(vo?.inputs, [
      {
        version: 2,
        label: "take-002 · storyboard v2",
        at: (vo?.inputs[0] as unknown as { at: string }).at,
      },
    ]);

    const recs = (await get("recordings?storyboard=2")) as {
      storyboard: number;
      takes: {
        id: string;
        accepted: boolean;
        onLine: boolean;
        scenes: { keyframe: string | null }[];
      }[];
    };
    assert.deepEqual(
      recs.takes.map((t) => t.id),
      ["take-003", "take-002"],
      "only takes of storyboard v2, newest first",
    );
    assert.equal(
      recs.takes[1]?.scenes[0]?.keyframe,
      "takes/take-002/analysis/keyframes/01-a/k1.jpg",
      "foreign path re-anchored",
    );
    assert.deepEqual(
      ((await get("recordings?storyboard=1")) as { takes: { id: string }[] }).takes.map(
        (t) => t.id,
      ),
      ["take-001"],
    );

    // Accept a second take: nothing reset, it becomes the line (latest decision); its VO slot is empty.
    const a3 = await post("approve", { artifact: "recording", version: 3 });
    assert.equal(a3.status, 200);
    assert.equal(a3.json.onLine, true);
    assert.deepEqual(readState(dir)?.line, { storyboard: 2, recording: 3 });
    assert.ok(readState(dir)?.accepted.vo?.["1"], "vo v1 stays accepted");
    assert.match(notified.at(-1) ?? "", /take-003 .* ACCEPTED/);
    assert.equal(
      (await post("approve", { artifact: "recording", version: 1 })).status,
      400,
      "take-001's storyboard isn't accepted",
    );

    // Select take-002 again: its VO comes back on the line; the agent is told without a turn.
    const sel = await post("select", { artifact: "recording", version: 2 });
    assert.equal(sel.json.lineText, "storyboard v2 → recording take-002 → voice-over v1");
    assert.match(told.at(-1) ?? "", /switched the working line .* take-002 → voice-over v1/);

    // VO tab is scoped to a take.
    const vo2 = (await get("vo?take=2")) as { versions: number[]; input: number };
    assert.deepEqual([vo2.versions, vo2.input], [[1], 2]);
    assert.deepEqual(
      ((await get("vo?take=3")) as { versions: number[]; vo: unknown }).versions,
      [],
    );

    // Un-accept take-002: preview lists the orphan, then it happens; line re-picks take-003.
    const pre = await post("unaccept-preview", { artifact: "recording", version: 2 });
    assert.deepEqual(
      (pre.json.orphans as { label: string }[]).map((o) => o.label),
      ["voice-over v1"],
    );
    const un = await post("unaccept", { artifact: "recording", version: 2 });
    assert.deepEqual(
      (un.json.orphaned as { label: string }[]).map((o) => o.label),
      ["voice-over v1"],
    );
    assert.deepEqual(readState(dir)?.line, { storyboard: 2, recording: 3 });
    st = (await get("stages")) as { stages: St[]; lineText: string };
    assert.match(
      st.stages.find((s) => s.stage === "vo")?.accepted[0]?.orphaned ?? "",
      /take-002 is not accepted/,
    );
    assert.equal(
      (await post("select", { artifact: "vo", version: 1 })).status,
      400,
      "orphans can't be selected",
    );
    assert.match(told.at(-1) ?? "", /UN-ACCEPTED recording take-002 .* orphaned .* voice-over v1/);

    const rr = await post("rerecord", { storyboard: 2, note: "slower typing" });
    assert.equal(rr.status, 200);
    assert.match(
      notified.at(-1) ?? "",
      /new take of storyboard v2 .* storyboard=2 .*|new take of storyboard v2 .* notes: "slower typing"/,
    );
    assert.equal(
      readInputs(dir).at(-1)?.text,
      "re-record requested for storyboard v2: slower typing",
    );
    assert.equal(
      (await post("rerecord", { storyboard: 1 })).status,
      400,
      "storyboard v1 isn't accepted",
    );
    assert.deepEqual((await get("live-frame")).frame, null);
  } finally {
    await rt.shutdown();
  }
});

test(
  "control room in the browser: input pickers, accept several, work on this, un-accept warning, Live drawer",
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
      const dialogs: string[] = [];
      let answer = true;
      page.on("dialog", async (d) => {
        dialogs.push(d.message());
        if (answer) await d.accept();
        else await d.dismiss();
      });
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
        await page.waitForTimeout(250);
      }
      await page.locator("nav button", { hasText: "Recording" }).first().click();
      await page.waitForSelector(".card.take");
      assert.equal(
        await page.locator(".card.take").count(),
        2,
        "takes of the selected storyboard only",
      );
      assert.match(
        (await page.locator(".input-picker").first().textContent()) ?? "",
        /storyboard v2/,
      );

      // Accept take-003 as well: both accepted, take-003 becomes the working line.
      await page
        .locator(".card.take", { hasText: "take-003" })
        .getByRole("button", { name: /^Accept/ })
        .click();
      await page.waitForTimeout(600);
      assert.match(dialogs.at(-1) ?? "", /Accept take-003\?[\s\S]*resets nothing/);
      assert.deepEqual(Object.keys(readState(dir)?.accepted.recording ?? {}).sort(), ["2", "3"]);
      assert.equal(readState(dir)?.line.recording, 3);
      // Work on take-002 again.
      await page
        .locator(".card.take", { hasText: "take-002" })
        .getByRole("button", { name: "Work on this" })
        .click();
      await page.waitForTimeout(600);
      assert.equal(readState(dir)?.line.recording, 2);
      assert.equal(readState(dir)?.line.vo, 1);

      // Voice over tab: input picker lists both accepted takes with lineage.
      await page.locator("nav button", { hasText: "Voice over" }).first().click();
      await page.waitForTimeout(500);
      const options = await page.locator(".input-picker select option").allTextContents();
      assert.ok(
        options.some((o) => /take-002 · storyboard v2/.test(o)) &&
          options.some((o) => /take-003 · storyboard v2/.test(o)),
        options.join(" | "),
      );

      // Un-accept take-002 from the Recording tab: cancel first — the dialog names the orphan.
      await page.locator("nav button", { hasText: "Recording" }).first().click();
      await page.waitForTimeout(400);
      answer = false;
      await page
        .locator(".card.take", { hasText: "take-002" })
        .getByRole("button", { name: "Un-accept" })
        .click();
      await page.waitForTimeout(500);
      assert.match(dialogs.at(-1) ?? "", /Un-accept take-002\?[\s\S]*orphaned[\s\S]*voice-over v1/);
      assert.ok(readState(dir)?.accepted.recording?.["2"], "cancelled: still accepted");
      answer = true;

      // Live panel: collapse → strip; persists; narrow window → bottom drawer.
      await page.getByRole("button", { name: "▼ collapse" }).click();
      await page.waitForSelector(".live-strip");
      await page.reload();
      await page.waitForSelector(".live-strip");
      await page.setViewportSize({ width: 900, height: 900 });
      await page.locator(".live-strip").click();
      await page.waitForSelector("aside.live");
      const pos = await page.evaluate(
        `(() => { const cs = getComputedStyle(document.querySelector("aside.live")); return { position: cs.position, bottom: cs.bottom }; })()`,
      );
      assert.deepEqual(pos, { position: "fixed", bottom: "0px" });
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await rt.shutdown();
    }
  },
);
