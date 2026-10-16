/**
 * UX8 engine (D124): the brief in human terms with its missing essentials, and "Ask the Director to draft the
 * brief". Missing is orientation: nothing here gates a workflow, writes the brief or changes a version.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { ROUTE_COST } from "../src/panel/cost.ts";
import { Runtime } from "../src/runtime.ts";
import { briefSummary, setBriefFacts } from "../src/workdir/brief.ts";
import { ensureProject } from "../src/workdir/layout.ts";

const STUB_APP = { baseUrl: "https://app.test" };
const fresh = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ux8-"));
  const p = ensureProject(root, { project: "demo", appName: "Demo", appUrl: "https://app.test" });
  return { root, p };
};
const row = (s: ReturnType<typeof briefSummary>, key: string) => s.rows.find((r) => r.key === key);

test("a new project: every essential but the URL is missing; length and voice are never 'missing'", () => {
  const { p } = fresh();
  const s = briefSummary(fs.readFileSync(path.join(p.dir, "brief.md"), "utf8"), p.app);
  assert.deepEqual(s.missing, ["Audience", "Goal", "Depth"]);
  assert.equal(s.empty, true);
  assert.deepEqual(row(s, "length"), {
    key: "length",
    label: "Length",
    value: null,
    essential: false,
    missing: false,
  });
  assert.equal(row(s, "voice")?.value, null);
  assert.equal(row(s, "url")?.value, "https://app.test/", "the app URL counts");
  assert.equal(row(s, "persona")?.value, null, "a placeholder is empty");
});

test("partly filled in: only what is missing is listed; depth brings its length and says so", () => {
  const { p } = fresh();
  let brief = fs.readFileSync(path.join(p.dir, "brief.md"), "utf8");
  brief = setBriefFacts(brief, { persona: "Product teams evaluating search" });
  let s = briefSummary(brief, p.app);
  assert.deepEqual(s.missing, ["Goal", "Depth"]);
  assert.equal(s.empty, false);
  brief = setBriefFacts(brief, { depth: "showcase", goal: "Search, compare, act." });
  s = briefSummary(brief, p.app);
  assert.deepEqual(s.missing, []);
  assert.deepEqual(
    [row(s, "length")?.value, row(s, "length")?.note],
    ["2–3 min", "from depth showcase"],
  );
  assert.equal(row(s, "depth")?.note, "Showcase");
  // an explicit length wins and has no 'from depth' note
  brief = setBriefFacts(brief, { length: "3–4 min", voice: "Stefan_trained" });
  s = briefSummary(brief, p.app);
  assert.deepEqual([row(s, "length")?.value, row(s, "length")?.note], ["3–4 min", undefined]);
  assert.equal(row(s, "voice")?.value, "Stefan_trained");
  assert.equal(
    briefSummary(setBriefFacts(brief, { voice: "default" }), p.app).rows.find(
      (r) => r.key === "voice",
    )?.value,
    null,
  );
});

test("without an app URL the URL is a missing essential", () => {
  const { p } = fresh();
  const brief = setBriefFacts(fs.readFileSync(path.join(p.dir, "brief.md"), "utf8"), { url: "" });
  assert.ok(briefSummary(brief, {}).missing.includes("App URL"));
  assert.ok(!briefSummary(brief, STUB_APP).missing.includes("App URL"));
});

// biome-ignore lint/suspicious/noExplicitAny: the tests index into replies of many shapes
type Reply = Record<string, any>;

function setup() {
  process.env.DEMO_REC_NO_OPEN = "1";
  const { root, p } = fresh();
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(root, "none.json") } }),
    root,
    panelPort: 0,
  }));
  const turns: string[] = [];
  const notes: string[] = [];
  (rt as unknown as { notifyAgent: (t: string) => void }).notifyAgent = (t) => turns.push(t);
  rt.tellAgent = (t) => notes.push(t);
  rt.setActiveProject("demo");
  const t = rt.routeTables();
  return {
    root,
    p,
    rt,
    turns,
    notes,
    get: (n: string) => (t.get[n] as (q: URLSearchParams) => Reply)(new URLSearchParams()),
    post: async (n: string, b: Record<string, unknown> = {}) =>
      (await (t.post[n] as (b: Record<string, unknown>) => unknown)(b)) as Reply,
  };
}

test("GET project carries the summary; brief-draft asks the Director (one turn) and writes nothing", async () => {
  const { rt, p, get, post, turns, notes } = setup();
  try {
    const before = fs.readFileSync(path.join(p.dir, "brief.md"), "utf8");
    const view = get("project");
    assert.deepEqual(view.summary.missing, ["Audience", "Goal", "Depth"]);
    assert.equal(view.summary.empty, true);
    const r = await post("brief-draft", { note: "a 2-minute tour for CTOs" });
    assert.deepEqual(r, { asked: true });
    assert.equal(turns.length, 1);
    assert.match(
      turns[0] ?? "",
      /^\[demo-panel\] The user asks you to draft the brief for project "demo" with them \(their note: "a 2-minute tour for CTOs"\)/,
    );
    assert.match(turns[0] ?? "", /demo-brief skill[\s\S]*ask only for the gaps[\s\S]*write_brief/);
    assert.deepEqual(notes, []);
    assert.equal(
      fs.readFileSync(path.join(p.dir, "brief.md"), "utf8"),
      before,
      "the brief is not written by asking",
    );
    const versions = path.join(p.dir, "brief");
    assert.equal(
      fs.existsSync(versions) ? fs.readdirSync(versions).length : 0,
      0,
      "no brief version either",
    );
    assert.deepEqual(ROUTE_COST["brief-draft"], ["turn"]);
  } finally {
    await rt.shutdown();
  }
});
