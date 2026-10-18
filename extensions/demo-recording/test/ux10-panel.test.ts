/**
 * UX10: the Versions selector (whole-row target, separate extras, a name that says what the list is) and the
 * Render screen after the UX0 comparison (finals first, drafts folded, New render as a header button, the
 * QA checklist beside the player, the decision pinned with its consequence).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { qaFile } from "../src/qa/run.ts";
import { Runtime } from "../src/runtime.ts";
import { answerDialogs } from "./helpers/panel-dialogs.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

async function chromium() {
  try {
    const pw = await import("playwright");
    return fs.existsSync(pw.chromium.executablePath()) ? pw.chromium : undefined;
  } catch {
    return undefined;
  }
}
const browserType = await chromium();
const skip = !browserType && "needs Playwright Chromium";
const ENV = ["DEMO_REC_CONFIG", "DEMO_REC_NO_OPEN"];

async function setup(width = 1400, height = 1000) {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  const seed = seedPanelProject();
  const cfg = path.join(seed.root, "ux10-config.json");
  fs.writeFileSync(cfg, "{}");
  process.env.DEMO_REC_CONFIG = cfg;
  process.env.DEMO_REC_NO_OPEN = "1";
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
    root: seed.root,
    panelPort: 0,
  }));
  rt.tellAgent = () => undefined;
  rt.setActiveProject(seed.slug);
  const panel = await rt.ensurePanel();
  const browser = await (browserType as NonNullable<typeof browserType>).launch();
  const page = await (await browser.newContext({ viewport: { width, height } })).newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const dlg = answerDialogs(page);
  const go = async (hash: string, ready: string) => {
    await page.goto(`${panel.url}${hash}`);
    await page.waitForSelector(ready);
  };
  const close = async () => {
    dlg.stop();
    await browser.close();
    await rt.shutdown();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
    fs.rmSync(seed.root, { recursive: true, force: true });
  };
  return { seed, page, errors, go, close };
}
const hash = (p: { evaluate: (s: string) => Promise<unknown> }) =>
  p.evaluate("location.hash") as Promise<string>;

test(
  "Versions: named for what it lists; the whole row selects; Show in map stays its own button; the keyboard and the focus ring follow the row",
  { skip, timeout: 120_000 },
  async () => {
    const { page, go, errors, close } = await setup();
    try {
      await go("#/voice/v2", ".history-btn");
      assert.match(await page.locator(".history-btn").innerText(), /^Versions · 2$/);
      assert.equal(await page.getByRole("button", { name: /^History/ }).count(), 0);
      // a click on the row's plain text (not on the v-number) selects that version
      await page.click(".history-btn");
      await page.waitForSelector(".ds-histpop .ds-version--row");
      const row = page.locator(".ds-histpop .ds-version--row", { hasText: "v1" }).first();
      const muted = (await row.locator(".ds-muted").first().boundingBox()) as {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      await page.mouse.click(muted.x + muted.width / 2, muted.y + muted.height / 2);
      await page.waitForFunction("location.hash.startsWith('#/voice/v1')");
      assert.equal(await page.locator(".ds-histpop").count(), 0, "the list closes on a choice");
      // a click on the empty end of the row selects too
      await page.click(".history-btn");
      const box = (await page
        .locator(".ds-histpop .ds-version--row", { hasText: "v2" })
        .first()
        .boundingBox()) as { x: number; y: number; width: number; height: number };
      await page.mouse.click(box.x + box.width * 0.55, box.y + box.height - 4);
      await page.waitForFunction("location.hash.startsWith('#/voice/v2')");
      // Show in map is its own target: it opens the map, not the version
      await page.click(".history-btn");
      await page.locator(".ds-histpop .show-in-map").first().click();
      await page.waitForFunction("location.hash.startsWith('#/map')");
      await page.keyboard.press("Escape");
      await go("#/voice/v1", ".history-btn");
      // keyboard: the first stop is the row, the next is that row's own button; Enter selects; the ring is on the row
      await page.focus(".history-btn");
      await page.keyboard.press("Enter");
      await page.waitForSelector(".ds-histpop .ds-version--row");
      const focusedIsFirstRowLink = await page.evaluate(
        "document.activeElement?.classList.contains('ds-version-main')",
      );
      assert.equal(focusedIsFirstRowLink, true, "focus moves onto the first row");
      const ring = await page.evaluate(
        "getComputedStyle(document.activeElement.closest('.ds-version--row')).outlineStyle",
      );
      assert.notEqual(ring, "none", "the whole row shows the focus ring");
      await page.keyboard.press("Tab");
      assert.equal(
        await page.evaluate("document.activeElement?.classList.contains('show-in-map')"),
        true,
        "then the row's own button",
      );
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Enter");
      await page.waitForFunction("location.hash.startsWith('#/voice/v2')");
      // every row is at least the target size
      await page.click(".history-btn");
      for (const h of (await page.evaluate(
        "[...document.querySelectorAll('.ds-histpop .ds-version--row')].map((e) => e.getBoundingClientRect().height)",
      )) as number[])
        assert.ok(h >= 32, `row height ${h}`);
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "Render: no Versions button (the runs are the versions); New render is a header button; finals first with the drafts folded; the decision is pinned with its consequence",
  { skip, timeout: 120_000 },
  async () => {
    const { page, go, errors, close } = await setup();
    try {
      await go("#/render", ".ds-runs .ds-run");
      assert.equal(await page.locator(".stage-summary .history-btn").count(), 0);
      assert.match(
        await page.locator(".stage-summary [data-act=new-render]").innerText(),
        /New render/,
      );
      assert.equal(await page.locator("#new-render").count(), 0, "the form is not the first thing");
      // one status in the header, the rest in the list and the detail
      const head = await page.locator(".stage-summary").innerText();
      assert.match(head, /Viewing\s*v2/);
      assert.equal((head.match(/Approved|In production line/g) ?? []).length, 1, head);
      // the table: Run, Based on, QA, Files, Created; finals first, drafts under one line
      assert.deepEqual(await page.locator(".ds-run-head span").allInnerTexts(), [
        "",
        "Run",
        "Based on",
        "QA",
        "Files",
        "Created",
      ]);
      assert.equal(
        await page.locator(".ds-runs .ds-run").count(),
        3,
        "three finals, no drafts yet",
      );
      assert.match(
        await page.locator("[data-act=toggle-drafts]").innerText(),
        /4 draft renders · only the newest 3 keep files/,
      );
      // the decision bar is visible without scrolling, and says what approving would do
      const bar = page.locator(".render-actionbar");
      const r = (await bar.boundingBox()) as { y: number; height: number };
      const vh = (await page.evaluate("window.innerHeight")) as number;
      assert.ok(r.y + r.height <= vh, "pinned inside the window");
      assert.match(await bar.innerText(), /This final is the delivered version/);
      await page.click(".ds-item[data-key='1']");
      await page.waitForSelector(".ds-inspector[data-version='1']");
      assert.match(await bar.innerText(), /Approving makes this final the delivered version/);
      // a blocked reason is said once, not once per button
      assert.equal(
        await page.locator(".render-actionbar .ds-why").count(),
        1,
        "one reason for the two blocked approve buttons",
      );
      // New render opens on request and closes again
      await page.click("[data-act=new-render]");
      await page.waitForSelector("#new-render [data-act=render-now]");
      await page.click("[data-act=new-render]");
      assert.equal(await page.locator("#new-render").count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "Render QA: findings first, then the checks that found nothing in plain words, beside the player",
  { skip, timeout: 120_000 },
  async () => {
    const { page, seed, go, errors, close } = await setup();
    try {
      fs.mkdirSync(path.dirname(qaFile(seed.dir, 1)), { recursive: true });
      fs.writeFileSync(
        qaFile(seed.dir, 1),
        JSON.stringify({
          render: 1,
          variant: "neutral",
          createdAt: new Date().toISOString(),
          whisper: true,
          items: [
            {
              id: "q1",
              check: "values",
              level: "blocking",
              scene: "01-dash",
              atMs: 2500,
              message: "the number 14.2 is said but not on the page",
            },
          ],
        }),
      );
      await go("#/render/v1", ".ds-inspector[data-version='1']");
      const qa = page.locator(".ds-inspector .ds-section", { hasText: "Quality check" });
      await qa.getByText("the number 14.2 is said but not on the page").waitFor();
      const passes = await qa.locator(".qa-passes li").allInnerTexts();
      assert.equal(passes.length, 4, "the values check found something; four found nothing");
      assert.ok(passes.every((t) => t.includes("✓")));
      assert.ok(!passes.join(" ").includes("narrated value"), "no pass line for the failed check");
      assert.match(passes.join(" "), /No frozen, black or silent stretches/);
      // beside the player, not under it, on a wide screen
      const player = (await page.locator(".render-player-col").boundingBox()) as {
        x: number;
        y: number;
        width: number;
      };
      const q = (await qa.boundingBox()) as { x: number; y: number };
      assert.ok(q.x > player.x + player.width - 4, "QA sits to the right of the player");
      assert.ok(Math.abs(q.y - player.y) < 8, "and starts at the same height");
      // stacked on a narrow screen
      await page.setViewportSize({ width: 800, height: 1000 });
      const q2 = (await qa.boundingBox()) as { y: number };
      const p2 = (await page.locator(".render-player-col").boundingBox()) as {
        y: number;
        height: number;
      };
      assert.ok(q2.y >= p2.y + p2.height - 4, "stacked under the player when narrow");
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);
