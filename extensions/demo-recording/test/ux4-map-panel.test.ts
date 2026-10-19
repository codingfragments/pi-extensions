/**
 * UX4b in the browser (D100, D112, D119): the project map as a route-backed overlay: entry points, filters,
 * search with dim context, focus, groups, the synced outline, the keyboard, layering with dialogs, "Open in
 * stage", the updated indicator. Runs on the seeded project (test/helpers/panel-seed.ts).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { Runtime } from "../src/runtime.ts";
import { readState } from "../src/workdir/state.ts";
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

async function setup(width = 1400) {
  process.env.DEMO_REC_NO_OPEN = "1";
  const seed = seedPanelProject();
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(seed.root, "none.json") } }),
    root: seed.root,
    panelPort: 0,
  }));
  rt.setActiveProject(seed.slug);
  const panel = await rt.ensurePanel();
  const browser = await (browserType as NonNullable<typeof browserType>).launch();
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const close = async () => {
    await browser.close();
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  };
  return { seed, rt, panel, page, errors, close, state: () => readState(seed.dir) };
}
const hash = (page: import("playwright").Page) => page.evaluate("location.hash") as Promise<string>;
const nodes = (page: import("playwright").Page) =>
  page.evaluate(
    "[...document.querySelectorAll('.ds-map .ds-node')].map((e) => e.dataset.id)",
  ) as Promise<string[]>;

test(
  "entry points, the route and closing: Map button, History 'Show in map', the blocked band; Escape and Back",
  { skip, timeout: 120_000 },
  async () => {
    const { panel, page, errors, close, seed, rt } = await setup();
    try {
      await page.goto(`${panel.url}#/voice`);
      await page.waitForSelector(".stage-summary");
      // header button opens the map; the screen under keeps its place
      await page.click("a.map-link");
      await page.waitForSelector(".ds-map .ds-node");
      assert.equal(await hash(page), "#/map");
      assert.equal(await page.locator(".ds-map [role=status]").innerText(), "12 shown");
      assert.equal(
        await page.evaluate("document.querySelector('#app > .ds-body').inert"),
        true,
        "the page behind is inert",
      );
      assert.equal(
        await page.evaluate("document.activeElement?.id"),
        "",
        "focus is inside the dialog",
      );
      assert.equal(await page.evaluate("!!document.activeElement.closest('.ds-map')"), true);
      // Escape closes it and returns to the screen and the opener
      await page.keyboard.press("Escape");
      await page.waitForSelector(".ds-map", { state: "detached" });
      assert.equal(await hash(page), "#/voice");
      assert.equal(
        await page.evaluate("document.activeElement?.className.includes('map-link')"),
        true,
        "focus returns to the opener",
      );
      // History row: Show in map selects and focuses that version
      await page.click(".stage-summary button:has-text('Versions')");
      await page.locator(".show-in-map").first().click();
      await page.waitForSelector(".ds-map .ds-node");
      assert.match(await hash(page), /^#\/map\?sel=vo%3A\d&focus=1$/);
      assert.equal(await page.locator(".ds-map .ds-node[aria-current=true]").count(), 1);
      // a reload brings the same map back; Back closes it
      await page.reload();
      await page.waitForSelector(".ds-map .ds-node[aria-current=true]");
      await page.goBack();
      await page.waitForSelector(".ds-map", { state: "detached" });
      // a blocked step offers Show in map: the line still points at a voice-over whose take lost its approval
      const { applyVersionAction, planVersionAction } = await import(
        "../src/panel/version-actions.ts"
      );
      const { updateState } = await import("../src/workdir/state.ts");
      const st = () => readState(seed.dir) as NonNullable<ReturnType<typeof readState>>;
      applyVersionAction(seed.dir, {
        stage: "recording",
        version: 1,
        intent: "withdraw",
        token: planVersionAction(seed.dir, st(), {
          stage: "recording",
          version: 1,
          intent: "withdraw",
        }).token,
      });
      updateState(seed.dir, "test.line", (s) => {
        s.line.vo = 1;
      });
      rt.bus.publish("storyboard.written", { version: 1 }, seed.slug);
      await page.goto(`${panel.url}#/voice`);
      await page.reload();
      await page.waitForSelector(".band-map");
      assert.match(await page.locator(".ds-next").innerText(), /blocked/i);
      await page.click(".band-map");
      await page.waitForSelector(".ds-map .ds-node[aria-current=true]");
      assert.match(await hash(page), /sel=vo%3A1&focus=1/);
      assert.match(await page.locator(".ds-map-selected").innerText(), /Blocked by dependency/);
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "views, search, focus, groups: the map shows what it says and never touches the line",
  { skip, timeout: 120_000 },
  async () => {
    const { panel, page, errors, close, seed } = await setup();
    try {
      const before = JSON.stringify(readState(seed.dir));
      await page.goto(`${panel.url}#/map`);
      await page.waitForSelector(".ds-map .ds-node");
      assert.equal((await nodes(page)).length, 12);
      // Approved paths
      await page.click("button[data-view=approved]");
      await page.waitForFunction("document.querySelectorAll('.ds-map .ds-node').length === 6");
      assert.equal(
        await page.locator("button[data-view=approved]").getAttribute("aria-pressed"),
        "true",
      );
      assert.match(await page.locator(".ds-map-hidden").innerText(), /6 hidden/);
      assert.equal(await hash(page), "#/map?view=approved");
      await page.click(".ds-map-hidden");
      await page.waitForFunction("document.querySelectorAll('.ds-map .ds-node').length === 12");
      // search: matches, dim context, the rest hidden; Escape clears the search first
      await page.fill(".ds-map input[type=search]", "final");
      await page.waitForSelector(".ds-node[data-match=true]");
      assert.equal(await page.locator(".ds-node[data-match=true]").count(), 3);
      assert.ok(
        (await page.locator(".ds-node[data-dim=true]").count()) >= 3,
        "dependencies stay as dim context",
      );
      assert.match(await hash(page), /q=final/);
      await page.keyboard.press("Escape");
      assert.equal(
        await page.locator(".ds-map").count(),
        1,
        "the first Escape only clears the search",
      );
      assert.equal(await page.inputValue(".ds-map input[type=search]"), "");
      await page.waitForFunction("document.querySelectorAll('.ds-map .ds-node').length === 12");
      // nothing matches → an empty state with a way out
      await page.fill(".ds-map input[type=search]", "no such thing");
      await page.waitForSelector(".ds-map .ds-state");
      await page.click(".ds-map .ds-state button");
      await page.waitForFunction("document.querySelectorAll('.ds-map .ds-node').length === 12");
      // a draft group opens in place, and "Collapse groups" folds it again
      await page.click(".ds-node[data-kind=drafts]");
      await page.waitForFunction("document.querySelectorAll('.ds-map .ds-node').length === 15");
      await page.click("button[data-act=collapse]");
      await page.waitForFunction("document.querySelectorAll('.ds-map .ds-node').length === 12");
      // select + focus connections, the outline follows, the details name what it is built on
      await page.click(".ds-node[data-id='vo:2']");
      assert.match(
        await page.locator(".ds-map-selected").innerText(),
        /Voice-over v2[\s\S]*Built on[\s\S]*Storyboard v1 → Recording take-001/i,
      );
      assert.equal(
        await page.locator(".ds-outline button[aria-current=true]").getAttribute("data-id"),
        "vo:2",
      );
      await page.click("button[data-act=focus]");
      await page.waitForFunction("document.querySelectorAll('.ds-map .ds-node').length === 3");
      await page.click("button[data-act=reset]");
      await page.waitForFunction("document.querySelectorAll('.ds-map .ds-node').length === 12");
      // hiding the selection says so, and "Show it" brings it back
      await page.click(".ds-node[data-id='vo:2']");
      await page.click("button[data-view=line]");
      await page.waitForSelector(".ds-map-notice");
      assert.match(
        await page.locator(".ds-map-notice").innerText(),
        /hidden by the “Production line” view/,
      );
      await page.click("button[data-act=reveal]");
      await page.waitForFunction("document.querySelectorAll('.ds-map .ds-node').length === 12");
      assert.equal(
        JSON.stringify(readState(seed.dir)),
        before,
        "looking never changes the project",
      );
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "the keyboard walks the graph; Open in stage navigates to the exact version and Back returns to the map",
  { skip, timeout: 120_000 },
  async () => {
    const { panel, page, errors, close } = await setup();
    try {
      await page.goto(`${panel.url}#/map?sel=vo%3A1`);
      await page.waitForSelector(".ds-node[aria-current=true]");
      await page.focus(".ds-node[data-id='vo:1']");
      await page.keyboard.press("ArrowLeft");
      await page.waitForSelector(".ds-node[aria-current=true][data-id='recording:1']");
      assert.equal(
        await page.evaluate("document.activeElement.dataset.id"),
        "recording:1",
        "focus follows the selection",
      );
      await page.keyboard.press("ArrowRight");
      await page.waitForSelector(".ds-node[aria-current=true][data-id='vo:1']");
      // "/" jumps to the search
      await page.focus(".ds-node[data-id='vo:1']");
      await page.keyboard.press("/");
      assert.equal(await page.evaluate("document.activeElement.type"), "search");
      // Open in stage
      await page.click(".ds-node[data-id='vo:2']");
      assert.match(await page.locator(".ds-map-open").innerText(), /Open v2 in Voice over/);
      await page.click(".ds-map-open");
      await page.waitForSelector(".ds-map", { state: "detached" });
      assert.equal(await hash(page), "#/voice/v2");
      await page.goBack();
      await page.waitForSelector(".ds-map .ds-node[aria-current=true][data-id='vo:2']");
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "layers: Escape closes only the top layer; a changed project offers a refresh, never moves the map",
  { skip, timeout: 120_000 },
  async () => {
    const { panel, page, errors, close, seed, rt } = await setup();
    try {
      await page.goto(`${panel.url}#/map`);
      await page.waitForSelector(".ds-map .ds-node");
      // a dialog opened on top of the map (e.g. a toast/confirm) takes the Escape
      await page.evaluate(
        "(() => { const d = document.createElement('div'); d.className = 'modal-backdrop'; d.id = 'fake'; document.body.appendChild(d); })()",
      );
      await page.keyboard.press("Escape");
      assert.equal(await page.locator(".ds-map").count(), 1, "the map stays under a dialog");
      await page.evaluate("document.getElementById('fake').remove()");
      // the project changes underneath: a new draft render appears
      const { startRecord, saveRecord } = await import("../src/render/store.ts");
      const { normalizeOptions } = await import("../src/render/run.ts");
      const rec = startRecord(seed.dir, {
        kind: "draft",
        basedOn: { annotations: 1 },
        timeline: 1,
        voVersion: 1,
        take: "take-001",
        by: "edit",
        options: normalizeOptions({}),
        brands: ["neutral"],
        size: { width: 960, height: 540 },
      });
      rec.status = "done";
      saveRecord(seed.dir, rec);
      rt.bus.publish("render.done", { version: 99 }, seed.slug);
      await page.waitForSelector(".ds-map-update");
      assert.equal(
        await page.locator(".ds-map [role=status]").innerText(),
        "12 shown",
        "the map does not move by itself",
      );
      await page.click(".ds-map-update");
      await page.waitForFunction(
        "document.querySelector('.ds-map [role=status]').innerText === '12 shown'",
      );
      await page.waitForSelector(".ds-map-update", { state: "detached" });
      await page.keyboard.press("Escape");
      await page.waitForSelector(".ds-map", { state: "detached" });
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "the view is remembered per project; an unknown selection is explained",
  { skip, timeout: 90_000 },
  async () => {
    const { panel, page, errors, close } = await setup(900);
    try {
      await page.goto(`${panel.url}#/map?view=line`);
      await page.waitForSelector(".ds-map .ds-node");
      await page.click("button[aria-label='Close the map']");
      await page.waitForSelector(".ds-map", { state: "detached" });
      await page.click("a.map-link");
      await page.waitForSelector(".ds-map .ds-node");
      assert.equal(
        await page.locator("button[data-view=line]").getAttribute("aria-pressed"),
        "true",
        "the view you left is the one you get",
      );
      await page.goto(`${panel.url}#/map?sel=vo%3A99`);
      await page.waitForSelector(".ds-map-notice");
      assert.match(
        await page.locator(".ds-map-notice").innerText(),
        /vo:99 is not in this project/,
      );
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  },
);

test(
  "drawn nodes never overlap, at any width, with wrapped badges and an open group",
  { skip, timeout: 90_000 },
  async () => {
    for (const width of [1400, 900, 700]) {
      const { panel, page, errors, close } = await setup(width);
      try {
        await page.goto(`${panel.url}#/map?open=drafts%3Arender%3Aannotations%3A1`);
        await page.waitForSelector(".ds-map .ds-node");
        await page.waitForTimeout(400); // measured, then laid out again
        const overlaps = (await page.evaluate(`(() => {
          const r = [...document.querySelectorAll('.ds-map .ds-node')].map((e) => [e.dataset.id, e.getBoundingClientRect()]);
          const bad = [];
          for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
            const [a, A] = r[i]; const [b, B] = r[j];
            if (A.left < B.right - 1 && B.left < A.right - 1 && A.top < B.bottom - 1 && B.top < A.bottom - 1) bad.push(a + ' / ' + b);
          }
          return bad;
        })()`)) as string[];
        assert.deepEqual(overlaps, [], `no overlap at ${width}px`);
        // a node's content stays inside its box
        const clipped = (await page.evaluate(
          "[...document.querySelectorAll('.ds-map .ds-node')].filter((e) => e.scrollHeight > e.clientHeight + 1).map((e) => e.dataset.id)",
        )) as string[];
        assert.deepEqual(clipped, [], `no clipped content at ${width}px`);
        assert.deepEqual(errors, []);
      } finally {
        await close();
      }
    }
  },
);
