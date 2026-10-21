/**
 * The survey and the batched actions, through the tool the Director uses (real Chromium, the fixture app): the engine walks the navigation itself, the pages do not use
 * the screen budget, a route walk is one call that stops at the first failure.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { linkKey, outlineOf, surveyLine } from "../src/discovery/survey.ts";
import { type FixtureHandle, serveFixture } from "../src/fixture/server.ts";
import { hasBinary } from "../src/media/ffmpeg.ts";
import { Runtime } from "../src/runtime.ts";
import { registerBrowserTool } from "../src/tools/browser.ts";
import { ensureProject } from "../src/workdir/layout.ts";

async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}
const skip = !(await chromiumAvailable()) && "chromium not installed";

test("links are keyed by path and query, never by the hash or a trailing slash", () => {
  assert.equal(linkKey("https://x.test/issues/#a"), "https://x.test/issues");
  assert.equal(linkKey("https://x.test/issues?q=1"), "https://x.test/issues?q=1");
  assert.equal(linkKey("https://x.test/"), "https://x.test/");
});

test("the outline of a page: its headings and how much of what there is", () => {
  const o = outlineOf(`- heading "Traces" [level=1]
- table:
  - row "a"
  - row "b"
- button "Filter"
- textbox "Search"
- heading "Traces" [level=2]
- img "chart"`);
  assert.deepEqual(o, {
    headings: ["Traces"],
    rows: 2,
    tables: 1,
    buttons: 1,
    links: 0,
    inputs: 1,
    charts: 1,
  });
  assert.match(
    surveyLine({
      screen: "d/s004",
      url: "u",
      path: "/traces/",
      title: "Traces",
      outline: o,
      status: "seen",
      extends: { rows: 20, px: 800 },
    }),
    /^d\/s004 {2}\/traces\/ {2}“Traces” {2}h: Traces · 1 table, 2 rows, 1 buttons, 1 inputs, 1 images\/charts · LOADS MORE ON SCROLL \(\+20 rows after one extension; do not scroll it further\)$/,
  );
  assert.match(
    surveyLine({ screen: "", url: "u", path: "/x", title: "", status: "failed", note: "timeout" }),
    /^— {2}\/x {2}FAILED: timeout$/,
  );
});

let fixture: FixtureHandle;
before(async () => {
  fixture = await serveFixture(0);
});
after(async () => {
  await fixture.close();
});

type Tool = {
  execute: (...a: unknown[]) => Promise<{ content: { type: string; text?: string }[] }>;
};

test(
  "demo_rec_browser: survey visits the navigation itself, the pages are real screens that do not use the screen budget; steps is one call that stops at the first failure",
  { skip, timeout: 180_000 },
  async () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "survey-"));
    process.env.DEMO_REC_NO_OPEN = "1";
    const rt = new Runtime(() => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(root, "none.json") } }),
      root,
      panelPort: 0,
    }));
    try {
      const p = ensureProject(root, { project: "p", appName: "Acme", appUrl: fixture.url });
      rt.setActiveProject(p.slug);
      const tools = new Map<string, Tool>();
      registerBrowserTool(
        { registerTool: (t: { name: string }) => tools.set(t.name, t as never) } as never,
        rt,
      );
      const tool = tools.get("demo_rec_browser") as Tool;
      const call = (params: Record<string, unknown>) =>
        tool.execute("1", params, undefined, undefined, undefined);
      const textOf = (r: Awaited<ReturnType<typeof call>>) =>
        r.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n");

      const opened = await call({ action: "open" });
      assert.match(textOf(opened), /screens 1\/40/);

      // the survey
      const sv = await call({ action: "survey", max: 10 });
      const out = textOf(sv);
      assert.match(out, /^survey: \d+ pages? seen/);
      for (const route of ["/search", "/chat", "/live", "/settings"])
        assert.match(out, new RegExp(`  ${route}  `), `${route} was surveyed`);
      assert.match(out, /they did not use the screen budget/);
      const d = rt.discovery;
      assert.ok(d);
      assert.equal(
        d.budget().screens,
        "1/40",
        "the survey's pages did not use the screen budget: only the first look counts",
      );
      const screens = fs
        .readdirSync(path.join(d.dir, "screens"))
        .filter((f) => /^s\d+\.jpg$/.test(f));
      assert.ok(screens.length >= 5, `the survey's pages are real screens (${screens.length})`);
      const log = fs
        .readFileSync(path.join(d.dir, "actions.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      assert.ok(
        log.filter((r) => r.kind === "look" && r.survey).length >= 4,
        "the survey's looks are in the log (progress and coverage count them)",
      );
      if (hasBinary("ffmpeg"))
        assert.ok(
          sv.content.some((c) => c.type === "image"),
          "a contact sheet came back",
        );

      // a route walk in one call: two steps work, the third fails, the rest is not run, and a look of where it ended follows
      const walk = await call({
        action: "act",
        steps: [
          { step: "goto", url: "/search" },
          { step: "scroll", dy: 200 },
          { step: "click", target: { role: "button", name: "NoSuchButtonXYZ" } },
          { step: "goto", url: "/chat" },
        ],
      });
      const w = textOf(walk);
      assert.match(w, /^3 of 4 steps \(stopped at the first failure\):/);
      assert.match(w, /1\. goto: SAFE/);
      assert.match(w, /2\. scroll: SAFE/);
      assert.match(w, /3\. click FAILED: target not visible within 8000 ms/);
      assert.doesNotMatch(w, /4\. /, "nothing after the failure ran");
      assert.ok(
        walk.content.some((c) => c.type === "image"),
        "a look of where it ended",
      );
      assert.match(w, /\/search/);

      // the digest: the second look of the same app does not repeat what did not change; full_digest does
      const again = await call({ action: "look" });
      assert.match(textOf(again), /\(unchanged since the last look/);
      const full = await call({ action: "look", full_digest: true });
      assert.doesNotMatch(textOf(full), /\(unchanged since the last look/);
    } finally {
      await rt.closeDiscovery();
      await rt.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
