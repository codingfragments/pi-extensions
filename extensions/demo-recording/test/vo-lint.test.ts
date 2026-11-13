/**
 * "Mostly reads the screen" (item 23 PR 4, R3-24): the three signals, the warning in the validation, and the calibration on run 3 (the screen-reading v1 against
 * the rewritten v4 of the same take; the page vocabulary is cut down to the words the two scripts use, so no page text from the app is kept).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TakeAnalysis } from "../src/analysis/take.ts";
import { MAX_NUMBERS, READING_OVERLAP, readingWarning, readsTheScreen } from "../src/vo/lint.ts";
import { parseVo, validateVo } from "../src/vo/script.ts";

const PAGE =
  "Issues Feed CAIRN-2 the store failed Events 768 Users 9 Priority High Assignee backend Stack Trace Breadcrumbs Logs Metrics Trace Preview";

test("numbers: more than two in a section", () => {
  assert.equal(MAX_NUMBERS, 2);
  const r = readsTheScreen("The store failed with 768 events, 9 users and 12 releases.", PAGE);
  assert.deepEqual(
    r.signals.map((s) => s.kind),
    ["numbers"],
  );
  assert.match(r.signals[0]?.why ?? "", /^3 numbers: keep the one that proves the point/);
  assert.equal(
    readsTheScreen("768 events from only 9 users, so it is frequent but narrow.", PAGE).signals
      .length,
    0,
  );
});

test("labels: short label sentences in a row, or a long list of on-screen items", () => {
  const run = readsTheScreen("Stack trace. Breadcrumbs. Logs and metrics. Trace preview.", PAGE);
  assert.ok(
    run.signals.some(
      (s) => s.kind === "labels" && /short label-like sentences in a row/.test(s.why),
    ),
  );
  const list = readsTheScreen(
    "It has the stack trace, breadcrumbs, logs, metrics and the trace preview.",
    PAGE,
  );
  assert.ok(
    list.signals.some((s) => s.kind === "labels" && /a list of \d+ on-screen items/.test(s.why)),
  );
  assert.equal(
    readsTheScreen(
      "The issue page keeps the context in one place, so you don't switch tools to build the picture.",
      PAGE,
    ).signals.length,
    0,
  );
});

test("reading: most words on the page and nothing that explains", () => {
  assert.equal(READING_OVERLAP, 0.6);
  const r = readsTheScreen(
    "The store failed issue shows events, users, priority high, assignee backend, stack trace and breadcrumbs.",
    PAGE,
  );
  assert.ok(r.signals.some((s) => s.kind === "reading"));
  assert.ok(r.overlap >= 0.6);
  assert.equal(r.explains, false);
  const explained = readsTheScreen(
    "The store failed issue shows events and users, which points to a narrow failure for backend.",
    PAGE,
  );
  assert.equal(
    explained.signals.some((s) => s.kind === "reading"),
    false,
    "an explaining word: it interprets",
  );
  assert.match(
    readingWarning(r),
    /^reads the screen \(.*\): say what it means for the viewer instead of what they can see$/,
  );
});

test("calibrated on run 3: the screen-reading v1 fires on most sections, the rewritten v4 on none", () => {
  const fx = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, "fixtures", "vo-lint", "run3.json"), "utf8"),
  ) as Record<string, { v1: string; v4: string; page: string[] }>;
  const fired = (v: "v1" | "v4") =>
    Object.entries(fx)
      .filter(([, s]) => readsTheScreen(s[v], s.page.join(" ")).signals.length)
      .map(([k]) => k);
  const v1 = fired("v1");
  const v4 = fired("v4");
  assert.equal(Object.keys(fx).length, 15);
  assert.ok(v1.length >= 9, `v1 fires on ${v1.length} of 15: ${v1.join(", ")}`);
  assert.deepEqual(v4, [], "v4 explains: no section fires");
  for (const k of ["02-issue-detail", "07-explore-entities", "09-agent-conversation"])
    assert.ok(v1.includes(k), k);
});

test("the validation warns with the reason, against the page text at the section's anchors", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vo-lint-"));
  try {
    fs.writeFileSync(path.join(dir, "m1.yaml"), `- main:\n  - text: ${PAGE}\n`);
    const analysis = {
      take: "take-001",
      takeDir: "/x",
      storyboardVersion: 1,
      durationMs: 30_000,
      viewport: { width: 1600, height: 900, dpr: 2 },
      scenes: [
        {
          id: "01-a",
          title: "A",
          start: 0,
          end: 20_000,
          marks: [{ mark: "m1", t: 500, type: "wait-satisfied" }],
          typed: [],
          alerts: [],
          idle: [],
          streaming: [],
          motion: [],
          protected: [],
          keyframes: [],
        },
      ],
      createdAt: "",
    } as unknown as TakeAnalysis;
    const v = (body: string) =>
      validateVo(
        parseVo(`---\ntake: take-001\n---\n## 01-a — A\n${body}\n`),
        analysis,
        dir,
      ).issues.filter((i) => /reads the screen/.test(i.message));
    const bad = v(
      "[@m1] Stack trace. Breadcrumbs. Logs and metrics. Trace preview. Events 768, users 9, priority 12.",
    );
    assert.equal(bad.length, 1);
    assert.equal(bad[0]?.level, "warning", "a warning, never an error");
    assert.match(bad[0]?.message ?? "", /reads the screen \(3 numbers.*short label-like sentences/);
    assert.deepEqual(
      v(
        "[@m1] 768 events from only 9 users, so it is frequent but narrow: a failure worth fixing today.",
      ),
      [],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
