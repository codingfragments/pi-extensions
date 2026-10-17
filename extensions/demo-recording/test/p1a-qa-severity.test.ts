/**
 * P1a PR 10 (Q1a): only real defects stop a final (D-QA-1). The integrity checks (a listed file missing, no picture,
 * a truncated video, no or silent audio), reports from before the change read with the new levels, and the
 * confirm route's typed acknowledgement for a redaction that leaks.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { hasBinary } from "../src/media/ffmpeg.ts";
import { checkIntegrity, listedFiles } from "../src/qa/integrity.ts";
import { LEAK_PHRASE, qaBlocker, qaFile, readQa } from "../src/qa/run.ts";
import type { QaReport } from "../src/qa/types.ts";
import { type RenderRecord, readRender, saveRecord } from "../src/render/store.ts";
import { Runtime } from "../src/runtime.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

const FF = hasBinary("ffmpeg");
const skip = !FF && "needs ffmpeg";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "p1a-sev-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const lavfi = (src: string) => ["-f", "lavfi", "-i", src];

/** A render record whose one variant lists `full` and one scene file, in `dir`. */
function record(files: { full: boolean; scene: boolean }): RenderRecord {
  const rel = path.join("render", "v1", "neutral");
  fs.mkdirSync(path.join(dir, rel), { recursive: true });
  if (files.scene) fs.writeFileSync(path.join(dir, rel, "scene.mp4"), "x");
  return {
    version: 1,
    kind: "final",
    variants: [
      {
        key: "neutral",
        brand: "neutral",
        dir: rel,
        files: { full: "full.mp4", scenes: ["scene.mp4"] },
        durationSec: 3,
      },
    ],
  } as unknown as RenderRecord;
}

/** A 3 s clip: picture, plus a tone / silence / nothing. */
function clip(name: string, audio: "tone" | "silence" | "none"): string {
  const out = path.join(dir, "render", "v1", "neutral", name);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const a =
    audio === "tone"
      ? [...lavfi("sine=frequency=440:duration=3")]
      : audio === "silence"
        ? [...lavfi("anullsrc=r=48000:cl=mono")]
        : [];
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-y",
      ...lavfi("testsrc2=s=64x36:r=10:d=3"),
      ...a,
      "-t",
      "3",
      ...(audio === "none" ? ["-an"] : []),
      "-pix_fmt",
      "yuv420p",
      out,
    ],
    { stdio: "ignore" },
  );
  return out;
}

const run = (rec: RenderRecord, full: string, expectedMs: number, expectsAudio: boolean) =>
  checkIntegrity({ projectDir: dir, rec, full, expectedMs, expectsAudio });

test("an intact render has no integrity finding", { skip }, async () => {
  const rec = record({ full: true, scene: true });
  const full = clip("full.mp4", "tone");
  assert.deepEqual(await run(rec, full, 3000, true), []);
});

test("a listed file that is missing or empty is a hard stop", { skip }, async () => {
  const rec = record({ full: true, scene: false });
  const full = clip("full.mp4", "tone");
  const items = await run(rec, full, 3000, true);
  assert.equal(items.length, 1);
  assert.deepEqual([items[0]?.level, items[0]?.hard], ["blocking", "integrity"]);
  assert.match(items[0]?.message ?? "", /1 file the render lists is missing or empty: scene\.mp4/);
  fs.writeFileSync(path.join(dir, "render", "v1", "neutral", "scene.mp4"), "");
  assert.equal((await run(rec, full, 3000, true)).length, 1, "an empty file counts as missing");
  assert.deepEqual(
    listedFiles(rec).map((f) => path.basename(f.file)),
    ["full.mp4", "scene.mp4"],
  );
});

test(
  "no audio track or a silent one is a hard stop when the edit has narration",
  { skip },
  async () => {
    const rec = record({ full: true, scene: true });
    const none = await run(rec, clip("full.mp4", "none"), 3000, true);
    assert.match(
      none.map((i) => i.message).join(" "),
      /no audio track, but the edit has narration/,
    );
    const silent = await run(rec, clip("full.mp4", "silence"), 3000, true);
    assert.match(silent.map((i) => i.message).join(" "), /the audio is silent \(mean level/);
    assert.ok([...none, ...silent].every((i) => i.level === "blocking" && i.hard === "integrity"));
  },
);

test(
  "a silent edit may have silent audio; a video much shorter than the edit is cut off",
  { skip },
  async () => {
    const rec = record({ full: true, scene: true });
    assert.deepEqual(
      await run(rec, clip("full.mp4", "none"), 3000, false),
      [],
      "no narration expected",
    );
    const cut = await run(rec, clip("full.mp4", "tone"), 10000, true);
    assert.equal(cut.length, 1);
    assert.match(
      cut[0]?.message ?? "",
      /the video is 7\.0 s shorter than the edit \(3\.0 s of 10\.0 s\): the render is cut off/,
    );
    // within 3 s of the edit is fine (title and end cards only add length; rounding differs)
    assert.deepEqual(await run(rec, clip("full.mp4", "tone"), 5500, true), []);
  },
);

test("a file that is not a video is a hard stop, not a crash", { skip }, async () => {
  const rec = record({ full: true, scene: true });
  const junk = path.join(dir, "render", "v1", "neutral", "full.mp4");
  fs.writeFileSync(junk, "not a video");
  const items = await run(rec, junk, 3000, true);
  assert.match(items[0]?.message ?? "", /^the video cannot be read/);
  assert.equal(items[0]?.hard, "integrity");
});

// --- reports from before the change -------------------------------------------------------

function legacyProject() {
  const rec = record({ full: true, scene: true });
  rec.status = "done";
  rec.qa = {
    status: "blocked",
    blocking: 2,
    confirmed: 0,
    warnings: 0,
    info: 0,
    ranAt: "2026-10-01T00:00:00Z",
  };
  saveRecord(dir, rec);
  const report: QaReport = {
    render: 1,
    variant: "neutral",
    createdAt: "2026-10-01T00:00:00Z",
    whisper: true,
    items: [
      {
        id: "values-1",
        check: "values",
        level: "blocking",
        message: "the narration says 14.3: it isn't on screen",
      },
      {
        id: "annotations-2",
        check: "annotations",
        level: "blocking",
        message: "redaction r1 doesn't cover its element here — it moved",
      },
    ],
  };
  fs.writeFileSync(qaFile(dir, 1), JSON.stringify(report));
  return rec;
}

test("an older report reads with the new levels: a wrong number needs your eyes, a leaking redaction stays a hard stop", () => {
  legacyProject();
  const report = readQa(dir, 1) as QaReport;
  const [num, redact] = report.items;
  assert.deepEqual([num?.level, num?.high, num?.hard], ["warning", true, undefined]);
  assert.deepEqual([redact?.level, redact?.hard], ["blocking", "redaction"]);
  // the record's summary is read from the report: one hard stop, one needing your eyes
  const rec = readRender(dir, 1) as RenderRecord;
  assert.deepEqual([rec.qa?.status, rec.qa?.blocking, rec.qa?.high], ["blocked", 1, 1]);
  assert.match(qaBlocker(rec) ?? "", /1 hard stop\(s\)/);
});

test("an older report whose only blockers were judgement calls reads as passed", () => {
  const rec = legacyProject();
  const f = qaFile(dir, 1);
  const report = JSON.parse(fs.readFileSync(f, "utf8")) as QaReport;
  report.items = report.items.slice(0, 1);
  fs.writeFileSync(f, JSON.stringify(report));
  const read = readRender(dir, rec.version) as RenderRecord;
  assert.deepEqual([read.qa?.status, read.qa?.blocking, read.qa?.high], ["pass", 0, 1]);
  assert.equal(qaBlocker(read), undefined);
});

// --- the confirm route --------------------------------------------------------------------

test("render-qa-confirm: a leaking redaction needs the reason and the typed acknowledgement; a broken file cannot be confirmed", async () => {
  const seed = seedPanelProject();
  const cfg = path.join(seed.root, "c.json");
  fs.writeFileSync(cfg, "{}");
  const rt = new Runtime(
    () => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
      root: seed.root,
      panelPort: 0,
    }),
    { sendUserMessage: () => {}, sendMessage: () => {} },
  );
  rt.setActiveProject(seed.slug);
  try {
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
            id: "annotations-1",
            check: "annotations",
            level: "blocking",
            hard: "redaction",
            message: "redaction r1 doesn't cover its element here",
          },
          {
            id: "media-2",
            check: "media",
            level: "blocking",
            hard: "integrity",
            message: "the audio is silent",
          },
        ],
      }),
    );
    const post = rt.routeTables().post["render-qa-confirm"] as (
      b: Record<string, unknown>,
    ) => unknown;
    assert.throws(
      () => post({ version: 1, id: "annotations-1", reason: "test data" }),
      /type “accept the leak”/,
    );
    assert.throws(
      () => post({ version: 1, id: "media-2", reason: "x", acknowledge: LEAK_PHRASE }),
      /cannot be confirmed: render again/,
    );
    const r = post({
      version: 1,
      id: "annotations-1",
      reason: "all test data",
      acknowledge: LEAK_PHRASE,
    }) as {
      summary: { status: string; confirmed: number };
      blocker: string | null;
    };
    assert.equal(r.summary.confirmed, 1);
    assert.equal(r.summary.status, "blocked", "the broken file still stops it");
    assert.match(r.blocker ?? "", /1 hard stop\(s\)/);
  } finally {
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});
