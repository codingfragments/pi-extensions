/**
 * Log cleanup (bugfix sprint 1): every event carries a one-line `message`,
 * the context sits in structured data (the panel's event popup shows it
 * whole), agent messages are kept up to ~4 KB, config changes show
 * before → after, and progress ticks collapse to one log line per job.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "../src/config.ts";
import { configRoutes } from "../src/panel/config-routes.ts";
import { collapseProgress } from "../src/panel/public/logview.js";
import { Runtime } from "../src/runtime.ts";
import { changedBriefFields } from "../src/tools/project.ts";
import { MAX_EVENT_TEXT, capText, jobFacts } from "../src/util/events.ts";
import { ensureProject } from "../src/workdir/layout.ts";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

interface Ev {
  seq: number;
  at: string;
  type: string;
  project?: string;
  data?: Record<string, unknown>;
}
const ev = (seq: number, type: string, data: Record<string, unknown> = {}, project = "p"): Ev => ({
  seq,
  at: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
  type,
  project,
  data,
});

test("collapseProgress: one line per job run, newest state, tick count; runs end at started/finished", () => {
  const events = [
    ev(1, "take.started"),
    ev(2, "take.progress", { message: "a" }),
    ev(3, "take.event", { message: "click" }),
    ev(4, "take.progress", { message: "b" }),
    ev(5, "tts.progress", { message: "voice 1/2" }),
    ev(6, "take.progress", { message: "c" }),
    ev(7, "take.finished"),
    ev(8, "take.started"),
    ev(9, "take.progress", { message: "d" }),
    ev(10, "take.progress", { message: "e" }, "other"),
  ];
  const out = collapseProgress(events) as (Ev & { ticks?: number; firstAt?: string })[];
  assert.deepEqual(
    out.map((e) => `${e.seq}${e.ticks ? `×${e.ticks}` : ""}`),
    ["1", "3", "5×1", "6×3", "7", "8", "9×1", "10×1"],
  );
  const run = out.find((e) => e.seq === 6);
  assert.equal(run?.data?.message, "c", "the newest state");
  assert.equal(run?.firstAt, events[1]?.at, "when the run began");
  assert.equal(events.length, 10, "the input is not changed");
  // job ids keep two parallel jobs apart
  const jobs = collapseProgress([
    ev(1, "render.progress", { job: "j1" }),
    ev(2, "render.progress", { job: "j2" }),
    ev(3, "render.progress", { job: "j1" }),
  ]) as (Ev & { ticks?: number })[];
  assert.deepEqual(
    jobs.map((e) => `${e.seq}×${e.ticks}`),
    ["2×1", "3×2"],
  );
});

test("agent events: report/action/note with the text up to ~4 KB; failures with the error", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-logev-"));
  try {
    ensureProject(root, { project: "p", appName: "Acme", appUrl: "https://a.test" });
    let fail = false;
    const rt = new Runtime(
      () => ({
        ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(root, "none.json") } }),
        root,
      }),
      {
        sendUserMessage: () => {
          if (fail) throw new Error("session gone");
        },
        sendMessage: () => {
          if (fail) throw new Error("session gone");
        },
      },
    );
    rt.setActiveProject("p");
    const long = `[demo-recording] Render v3 ready\n${"x".repeat(6000)}`;
    rt.reportToAgent(long);
    rt.tellAgent("[demo-panel] working line changed\nsecond line");
    rt.notifyAgent("[demo-panel] Apply the review");
    const sent = rt.bus.recent().filter((e) => e.type === "agent.notified");
    assert.deepEqual(
      sent.map((e) => [e.data?.kind, e.data?.startsTurn, e.data?.message]),
      [
        ["report", true, "[demo-recording] Render v3 ready"],
        ["note", false, "[demo-panel] working line changed"],
        ["action", true, "[demo-panel] Apply the review"],
      ],
    );
    const report = sent[0]?.data as { text: string; truncated?: number };
    assert.equal(report.text.length, MAX_EVENT_TEXT, "capped at ~4 KB");
    assert.ok(report.text.endsWith("…"));
    assert.equal(report.truncated, long.length, "how long the original was");
    assert.equal(
      (sent[1]?.data as { text: string }).text,
      "[demo-panel] working line changed\nsecond line",
    );
    assert.equal((sent[1]?.data as { truncated?: number }).truncated, undefined);

    fail = true;
    rt.notifyAgent("[demo-panel] Approve storyboard v2");
    const failed = rt.bus
      .recent()
      .filter((e) => e.type === "agent.notify-failed")
      .at(-1);
    assert.match(String(failed?.data?.message), /couldn't reach the agent: session gone/);
    assert.match(String(failed?.data?.error), /session gone/);
    assert.equal(failed?.data?.about, "[demo-panel] Approve storyboard v2");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("config.changed: before → after in the message and in data", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-logcfg-"));
  try {
    const globalFile = path.join(root, "config.json");
    fs.writeFileSync(globalFile, JSON.stringify({ fps: 30 }));
    const events: { type: string; data: Record<string, unknown> }[] = [];
    const routes = configRoutes({
      activeProject: () => undefined,
      reloadConfig: () => ({ ...resolveConfig({ env: { DEMO_REC_CONFIG: globalFile } }), root }),
      publish: (type, data) => events.push({ type, data }),
      env: { DEMO_REC_CONFIG: globalFile },
      home: os.homedir(),
    });
    const post = (body: Record<string, unknown>) =>
      (routes.post["config-set"] as (b: Record<string, unknown>) => unknown)(body);
    post({ key: "fps", value: 25, confirm: true });
    post({ key: "fps", unset: true, confirm: true });
    assert.deepEqual(
      events.map((e) => [e.type, e.data.message, e.data.before, e.data.after]),
      [
        ["config.changed", "fps: 30 → 25 (global)", 30, 25],
        ["config.changed", "fps: 25 → unset (global)", 25, null],
      ],
    );
    assert.equal(events[0]?.data.by, "panel");
    assert.equal(events[0]?.data.file, globalFile);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("helpers: capText, jobFacts, changedBriefFields", () => {
  assert.equal(capText("abc"), "abc");
  assert.equal(capText("abcdef", 4), "abc…");
  const f = jobFacts({
    id: "j1",
    startedAt: 1000,
    finishedAt: 3500,
    status: "failed",
    error: "boom\nstack",
  });
  assert.deepEqual(f, { job: "j1", status: "failed", durationMs: 2500, error: "boom\nstack" });
  assert.equal(
    "error" in jobFacts({ id: "j2", startedAt: 0, finishedAt: 1, status: "done" }),
    false,
  );
  const before = "# Brief\n**Audience:** ops leads\n**Goal:** show search\n- **Length:** 60 s\n";
  const after =
    "# Brief\n**Audience:** ops leads\n**Goal:** show search and export\n**Voice:** calm\n";
  assert.deepEqual(changedBriefFields(before, after), ["Goal", "Length", "Voice"]);
});

/**
 * Every publish site sets a message — directly, or through one of the event
 * helpers. Only relays (which pass on an event built elsewhere) are exempt.
 */
test("every bus.publish call carries a message", () => {
  const files: string[] = [path.join(SRC, "cli.ts")];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!["node_modules", "public"].includes(e.name)) walk(p);
      } else if (/\.ts$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(SRC, "src"));
  const HELPERS = /\b(agentEvent|failedEvent|renderEvent)\(/;
  const RELAY =
    /^type, (\{ app: this\.appSlug, \.\.\.data \}|data), (project|slug|this\.opts\.project)$/;
  const missing: string[] = [];
  let calls = 0;
  for (const f of files) {
    const s = fs.readFileSync(f, "utf8");
    const re = /\.publish\(/g;
    for (let m = re.exec(s); m; m = re.exec(s)) {
      let depth = 0;
      let end = m.index;
      const open = m.index + m[0].length - 1;
      for (let k = open; k < s.length; k++) {
        if (s[k] === "(") depth++;
        else if (s[k] === ")") {
          depth--;
          if (!depth) {
            end = k;
            break;
          }
        }
      }
      const call = s
        .slice(open + 1, end)
        .replace(/\s+/g, " ")
        .trim();
      calls++;
      if (/\bmessage\b/.test(call) || HELPERS.test(call) || RELAY.test(call)) continue;
      missing.push(
        `${path.relative(SRC, f)}:${s.slice(0, m.index).split("\n").length}  ${call.slice(0, 120)}`,
      );
    }
  }
  assert.ok(calls > 60, `found the publish calls (${calls})`);
  assert.deepEqual(missing, [], "publish calls without a message");
});
