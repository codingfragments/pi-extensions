/**
 * S5 part 11 in the panel: confidence badges and "need your eyes" chips (jump),
 * a carried-over section collapsed to one line, the word diff vs the base,
 * "Approve high-confidence" (plan popup → applied), and the Direction box.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TakeAnalysis } from "../src/analysis/take.ts";
import { resolveConfig } from "../src/config.ts";
import { Runtime } from "../src/runtime.ts";
import { writeStoryboard } from "../src/storyboard/store.ts";
import { readPendingDirection, writePendingDirection, writeVo } from "../src/vo/store.ts";
import { ensureProject } from "../src/workdir/layout.ts";
import { acceptTake, approve, getReview, readState, setSceneReview } from "../src/workdir/state.ts";

async function chromium() {
  try {
    const pw = await import("playwright");
    return fs.existsSync(pw.chromium.executablePath()) ? pw.chromium : undefined;
  } catch {
    return undefined;
  }
}
const browserType = await chromium();

const analysis = (): TakeAnalysis =>
  ({
    take: "take-001",
    takeDir: "/x",
    storyboardVersion: 1,
    durationMs: 20000,
    viewport: { width: 1600, height: 900, dpr: 2 },
    scenes: [
      ["01-dash", 0, 9000, "emea-bar", '- img "Churn 3.1%"\n- bar "EMEA 14.2%"'],
      ["02-search", 9000, 15000, "results", '- row "EMEA 14.2% Litware Bank"'],
    ].map(([id, start, end, mark, dom]) => ({
      id,
      title: id,
      start,
      end,
      marks: [{ mark, t: (start as number) + 2000, type: "wait-satisfied", dom }],
      typed: [],
      alerts: [],
      idle: [],
      streaming: [],
      motion: [],
      protected: [],
      keyframes: [],
    })),
    createdAt: "",
  }) as TakeAnalysis;

const VO1 = `---
take: take-001
---
## _intro
Churn looks fine. It isn't.

## 01-dash — Dashboard
Headline churn is 3.1 percent. [@emea-bar] EMEA is the outlier at 14.2 percent.

## 02-search
I just ask. [@results] EMEA leads, and Litware Bank tops the list.

## _outro
Two questions, one answer.
`;

test(
  "panel: badges + jump chips, collapsed carry-over, word diff, approve high-confidence, direction",
  { skip: !browserType && "needs Playwright Chromium", timeout: 90_000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-confpanel-"));
    const p = ensureProject(root, { project: "p", appName: "Acme", appUrl: "https://a.test" });
    writeStoryboard(
      p.dir,
      `version: 1\nstart_url: /\nscenes:\n${["01-dash", "02-search"]
        .map(
          (id) =>
            `  - id: ${id}\n    title: ${id}\n    deep_link: /${id}\n    steps:\n      - { do: pause, ms: 200, mark: ${id === "01-dash" ? "emea-bar" : "results"} }\n`,
        )
        .join("")}`,
    );
    approve(p.dir, "storyboard", 1);
    const takeDir = path.join(p.dir, "takes", "take-001");
    fs.mkdirSync(path.join(takeDir, "analysis"), { recursive: true });
    fs.writeFileSync(path.join(takeDir, "analysis", "analysis.json"), JSON.stringify(analysis()));
    fs.writeFileSync(
      path.join(takeDir, "take.json"),
      JSON.stringify({ take: "take-001", storyboardVersion: 1, status: "ok" }),
    );
    acceptTake(p.dir, "take-001");
    writeVo(p.dir, VO1);
    setSceneReview(p.dir, 1, "_intro", "approved", undefined, "vo");
    writePendingDirection(p.dir, 1, { tone: "crisp" });
    writeVo(
      p.dir,
      VO1.replace("Headline churn is 3.1 percent.", "Headline churn reads 4.2 percent."),
    );
    const notified: string[] = [];
    const rt = new Runtime(
      () => ({
        ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(root, "none.json") } }),
        root,
        panelPort: 0,
      }),
      { sendUserMessage: (t) => notified.push(t), sendMessage: () => {} },
    );
    rt.setActiveProject("p");
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(panel.url);
      await page.getByText("Voice over", { exact: true }).first().click();
      await page.waitForSelector(".vo-diff-head");
      // header: re-directed from v1, 1 of 4 changed; one item needs eyes
      assert.match(
        await page.locator(".vo-diff-head").innerText(),
        /re-directed from v1: changed 1 of 4 sections/,
      );
      assert.match(await page.locator(".eyes").innerText(), /1 needs your eyes/);
      // the carried-over intro is one line
      const intro = page.locator("#item-_intro");
      assert.match((await intro.getAttribute("class")) ?? "", /compact/);
      assert.match(await intro.innerText(), /unchanged since v1, where you approved it/);
      // word diff on the changed section, with its low badge and reasons
      const dash = page.locator("#item-01-dash");
      assert.equal(await dash.locator(".d-ins").first().innerText(), "reads 4.2");
      assert.equal(await dash.locator(".d-del").first().innerText(), "is 3.1");
      assert.equal(await dash.locator(".conf").innerText(), "● low");
      assert.match(
        await dash.locator(".conf-reasons").innerText(),
        /says “4.2” — not on the page in 01-dash/,
      );
      // a chip jumps to the item
      await page.locator(".eyes .conf-chip", { hasText: "01-dash" }).click();
      await page.waitForFunction(
        `document.getElementById("item-01-dash").classList.contains("jumped")`,
      );
      // approve high-confidence: the plan first, then applied
      await page.getByRole("button", { name: /Mark high-confidence reviewed/ }).click();
      const modal = page.locator(".modal");
      await modal.locator(".approve-plan").waitFor();
      assert.match(
        await modal.innerText(),
        /Marks reviewed \(3\)[\s\S]*_intro[\s\S]*02-search[\s\S]*_outro[\s\S]*Skips[\s\S]*01-dash/i,
      );
      await modal.getByRole("button", { name: "Mark 3 section(s) reviewed" }).click();
      await page.waitForFunction(`!document.querySelector(".modal-backdrop")`);
      const review = getReview(readState(p.dir) ?? p.state, 2, "vo");
      assert.deepEqual(Object.keys(review.scenes).sort(), ["02-search", "_intro", "_outro"]);
      // direction: chips + focus → pending direction + an agent message
      await page.locator(".direction summary").click();
      await page.locator(".direction .chip", { hasText: "calm" }).click();
      await page.getByLabel("focus").fill("the EMEA outlier");
      await page.getByRole("button", { name: "Draft new version" }).click();
      await page.locator(".direction .pending").waitFor();
      assert.deepEqual(readPendingDirection(p.dir)?.direction, {
        tone: "calm",
        length: "same",
        focus: "the EMEA outlier",
      });
      assert.match(notified.at(-1) ?? "", /VOICE DIRECTION .* rewrite voice-over v2/);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await panel.close();
      await rt.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
