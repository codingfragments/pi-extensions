import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { Report, validateStoryboard, validateVo } from "../scripts/validate-storyboard.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function check(sb: object, vo?: object) {
  const report = new Report();
  const ids = validateStoryboard(sb ?? {}, report);
  if (vo) validateVo(vo, report, ids);
  return report;
}

test("template storyboard + vo validate clean", async () => {
  const sb = parse(
    await readFile(path.join(here, "../templates/storyboard.template.yaml"), "utf8"),
  );
  const vo = parse(await readFile(path.join(here, "../templates/vo.template.yaml"), "utf8"));
  const report = check(sb, vo);
  assert.deepEqual(report.errors, []);
  // vo covers every storyboard scene -> no warnings either
  assert.deepEqual(report.warnings, []);
});

test("duplicate and non-kebab scene ids are rejected", () => {
  const report = check({
    meta: { target: "t", title: "T", voice: { name: "S" }, target_duration_s: 60 },
    scenes: [
      { id: "dup", title: "a", intent: "i", steps: [{ type: "navigate", url: "https://x" }] },
      { id: "dup", title: "b", intent: "i", steps: [{ type: "navigate", url: "https://x" }] },
      { id: "Not Kebab", title: "c", intent: "i", steps: [{ type: "navigate", url: "https://x" }] },
    ],
  });
  assert.ok(report.errors.some((e) => e.includes("duplicate id 'dup'")));
  assert.ok(report.errors.some((e) => e.includes("must be kebab-case")));
});

test("missing intent, empty steps, unknown step type are rejected", () => {
  const report = check({
    meta: { target: "t", title: "T", voice: { name: "S" }, target_duration_s: 60 },
    scenes: [
      { id: "s", title: "a", steps: [] },
      { id: "s2", title: "b", intent: "i", steps: [{ type: "teleport", to: "moon" }] },
    ],
  });
  assert.ok(report.errors.some((e) => e.includes("missing intent")));
  assert.ok(report.errors.some((e) => e.includes("non-empty steps")));
  assert.ok(report.errors.some((e) => e.includes("unknown step type 'teleport'")));
});

test("budget sum exceeding target_duration_s is rejected", () => {
  const report = check({
    meta: { target: "t", title: "T", voice: { name: "S" }, target_duration_s: 10 },
    scenes: [
      {
        id: "a",
        title: "a",
        intent: "i",
        budget_s: 6,
        steps: [{ type: "navigate", url: "https://x" }],
      },
      {
        id: "b",
        title: "b",
        intent: "i",
        budget_s: 6,
        steps: [{ type: "navigate", url: "https://x" }],
      },
    ],
  });
  assert.ok(report.errors.some((e: string) => e.includes("exceeds target_duration_s")));
});

test("authored runner-managed flags warn but do not fail", () => {
  const report = check({
    meta: { target: "t", title: "T", voice: { name: "S" }, target_duration_s: 60 },
    scenes: [
      {
        id: "a",
        title: "a",
        intent: "i",
        retake: true,
        steps: [{ type: "navigate", url: "https://x" }],
      },
    ],
  });
  assert.deepEqual(report.errors, []);
  assert.ok(report.warnings.some((w: string) => w.includes("runner-managed field 'retake'")));
});

test("vo with unknown scene id, bad status, and invalid pace is rejected", () => {
  const sb = {
    meta: { target: "t", title: "T", voice: { name: "S" }, target_duration_s: 60 },
    scenes: [
      { id: "scene-a", title: "a", intent: "i", steps: [{ type: "navigate", url: "https://x" }] },
      { id: "scene-b", title: "b", intent: "i", steps: [{ type: "navigate", url: "https://x" }] },
    ],
  };
  const report = check(sb, {
    meta: { voice: { name: "S" }, pace_words_per_sec: 99 },
    scenes: [
      { id: "ghost-scene", text: "boo", status: "approved" },
      { id: "scene-a", text: "hi", status: "shipped" },
    ],
  });
  assert.ok(
    report.errors.some((e: string) => e.includes("'ghost-scene' has no matching storyboard scene")),
  );
  assert.ok(report.errors.some((e: string) => e.includes("status 'shipped' invalid")));
  assert.ok(report.errors.some((e: string) => e.includes("pace_words_per_sec")));
  assert.ok(report.warnings.some((w: string) => w.includes("has no vo entry yet")));
});
