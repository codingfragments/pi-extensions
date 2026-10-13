/**
 * S2 integration: discovery session on the fixture (real Chromium).
 * Skipped when Playwright Chromium is not installed.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { EventBus } from "../src/bus.ts";
import {
  BlockedActionError,
  BudgetExhaustedError,
  DiscoverySession,
} from "../src/discovery/session.ts";
import { type FixtureHandle, serveFixture } from "../src/fixture/server.ts";
import { ensureApp } from "../src/workdir/layout.ts";

async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}
const skip = !(await chromiumAvailable()) && "chromium not installed";

let fixture: FixtureHandle;
let root: string;
before(async () => {
  fixture = await serveFixture(0);
  root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-disc-"));
});
after(async () => {
  await fixture.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const BUDGETS = { discoveryScreens: 20, discoveryActions: 30, discoveryMinutes: 5 };
const readJsonl = (file: string) =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

test(
  "discovery: look, act, safety verdicts, audit trail, artifacts, target lint",
  { skip, timeout: 120_000 },
  async () => {
    const app = ensureApp(root, "Acme Pulse", fixture.url);
    const bus = new EventBus();
    const events: string[] = [];
    bus.subscribe((e) => events.push(e.type));
    const d = await DiscoverySession.open({
      root,
      app,
      viewport: { width: 1600, height: 900 },
      budgets: BUDGETS,
      bus,
      project: "p",
    });
    try {
      // look: screenshot + digest with exact values and targets
      const look = await d.look();
      assert.match(look.screen, /^\d{8}-\d{6}\/s001$/);
      assert.equal(look.jpeg.subarray(0, 2).toString("hex"), "ffd8", "JPEG screenshot");
      assert.match(look.digest, /\$4\.82M/);
      assert.match(look.digest, /link "Search"/);
      assert.ok(d.seen.has("link|Search"));
      assert.ok(fs.existsSync(path.join(d.dir, "screens", "s001.jpg")));
      assert.ok(fs.existsSync(path.join(d.dir, "dom", "s001.yaml")));

      // safe navigation through the virtual cursor
      const nav = await d.act({ action: "click", target: { role: "link", name: "Search" } });
      assert.equal(nav.verdict.level, "safe");
      assert.equal(nav.urlChanged, true);
      assert.match(nav.url, /\/search$/);
      assert.deepEqual(nav.verifiedTarget, { role: "link", name: "Search" });

      // search submit = safe
      const search = await d.act({
        action: "type",
        target: { role: "searchbox", name: "Search" },
        text: "churn by region",
        submit: true,
      });
      assert.equal(search.verdict.level, "safe", search.verdict.reason);
      await d.act({ action: "wait", target: { css: "table.regions" } });
      assert.match((await d.look()).digest, /14\.2%/);

      // chat send = state change: allowed, audited, announced
      await d.act({ action: "click", target: { role: "link", name: "Assistant" } });
      const chat = await d.act({
        action: "type",
        target: { role: "textbox", name: "Ask a question" },
        text: "Which region churns most?",
        submit: true,
      });
      assert.equal(chat.verdict.level, "mutating", chat.verdict.reason);
      // DOM-quiet settle: the streamed answer is complete without an explicit wait.
      const answered = await d.look();
      assert.match(
        answered.digest,
        /biggest single exposure is Litware Bank at \$310K\./,
        "full streamed answer",
      );
      assert.ok(events.includes("safety.mutation"));

      // destructive action = blocked BEFORE the click (the confirm dialog never opens)
      let dialogs = 0;
      d.page.on("dialog", (dlg) => {
        dialogs++;
        dlg.dismiss().catch(() => {});
      });
      await d.act({ action: "click", target: { role: "link", name: "Settings" } });
      await assert.rejects(
        d.act({ action: "click", target: { role: "button", name: "Delete workspace" } }),
        BlockedActionError,
      );
      assert.equal(dialogs, 0, "blocked click must not reach the page");
      assert.ok(events.includes("safety.blocked"));

      // leaving the origin = blocked
      await assert.rejects(
        d.act({ action: "goto", url: "https://example.com/" }),
        /leaves the app's origin/,
      );

      const audit = readJsonl(path.join(d.dir, "audit.jsonl"));
      assert.deepEqual(
        audit.filter((r) => r.level !== "safe").map((r) => [r.level, r.name ?? r.url]),
        [
          ["mutating", "Ask a question"],
          ["blocked", "Delete workspace"],
          ["blocked", "https://example.com/"],
        ],
      );
      const sitemap = JSON.parse(fs.readFileSync(path.join(d.dir, "sitemap.json"), "utf8"));
      assert.ok(
        sitemap.some((p: { url: string }) => p.url.includes("/search?q=churn")),
        "looked-at pages incl. query",
      );

      // storyboard lint: seen/verified targets pass, invented ones are flagged
      const unknown = d.unknownTargets([
        { role: "link", name: "Search" },
        { role: "searchbox", name: "Search" },
        { role: "button", name: "Export everything" },
        { css: ".never-used" },
      ]);
      assert.deepEqual(unknown, [
        { role: "button", name: "Export everything" },
        { css: ".never-used" },
      ]);
    } finally {
      await d.close();
    }
    assert.ok(events.includes("discovery.closed"));
    await assert.rejects(d.look(), /closed/);
  },
);

test(
  "discovery: policy.json allow turns a state change into safe; budgets are enforced",
  { skip, timeout: 60_000 },
  async () => {
    const app = ensureApp(root, "Acme Policy", fixture.url);
    fs.writeFileSync(
      path.join(root, "apps", app.slug, "policy.json"),
      JSON.stringify({ allow: ["Save view"] }),
    );
    const d = await DiscoverySession.open({
      root,
      app,
      baseUrl: fixture.url,
      viewport: { width: 1280, height: 800 },
      budgets: { discoveryScreens: 2, discoveryActions: 2, discoveryMinutes: 5 },
    });
    try {
      await d.act({ action: "goto", url: "/item/106" });
      const save = await d.act({ action: "click", target: { role: "button", name: "Save view" } });
      assert.equal(save.verdict.level, "safe");
      assert.match(save.verdict.reason, /allowed by policy/);
      await assert.rejects(d.act({ action: "back" }), BudgetExhaustedError);
      await d.look();
      await d.look();
      await assert.rejects(d.look(), /budget exhausted/);
      assert.equal(d.budget().exhausted, true);
    } finally {
      await d.close();
    }
  },
);
