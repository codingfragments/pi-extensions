/**
 * The Director's fix loop is a window (a modal), not a long block among the findings: you flag findings in the list, open the window, give
 * context, ask, read the proposals and decide, ask again or apply, and stay there. Closing it (Esc, ×, Close) never cancels the Director and loses
 * nothing: the list says where the loop stands and reopens it. Cancelling an ask is its own explicit button.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { askedRound, readFixSet, recordProposals } from "../src/qa/fixes.ts";
import { qaFile } from "../src/qa/run.ts";
import { Runtime } from "../src/runtime.ts";
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

const REPORT = {
  render: 1,
  stage: "render",
  version: 1,
  variant: "neutral",
  createdAt: "2026-10-18T10:00:00.000Z",
  whisper: true,
  items: [
    {
      id: "values-1",
      check: "values",
      level: "warning",
      high: true,
      scene: "01-dash",
      atMs: 2100,
      message: "the narration says 14.3: it isn't on screen",
      identity: { value: "14.3" },
    },
    {
      id: "drift-2",
      check: "drift",
      level: "warning",
      high: true,
      scene: "01-dash",
      atMs: 9000,
      message: "the narration for @emea-bar starts 1004 ms after its moment",
      identity: { anchor: "emea-bar" },
    },
    {
      id: "annotations-3",
      check: "annotations",
      level: "blocking",
      hard: "redaction",
      scene: "01-dash",
      atMs: 2500,
      message: "redaction r1 doesn't cover its element here",
      identity: { ref: "r1" },
    },
  ],
};

test(
  "the window: Esc closes it without cancelling the Director, the list says where the loop stands, reopening loses nothing, Cancel is explicit",
  { skip: !browserType && "needs Playwright Chromium", timeout: 120_000 },
  async () => {
    process.env.DEMO_REC_NO_OPEN = "1";
    const seed = seedPanelProject();
    fs.mkdirSync(path.dirname(qaFile(seed.dir, 1)), { recursive: true });
    fs.writeFileSync(qaFile(seed.dir, 1), JSON.stringify(REPORT));
    const cfg = path.join(seed.root, "c.json");
    fs.writeFileSync(cfg, "{}");
    const told: string[] = [];
    const rt = new Runtime(
      () => ({
        ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
        root: seed.root,
        panelPort: 0,
      }),
      { sendUserMessage: (t) => told.push(t), sendMessage: () => {} },
    );
    rt.setActiveProject(seed.slug);
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
      await page.goto(`${panel.url}#/render/v1`);
      const qa = page.locator(".ds-inspector .ds-section", { hasText: "Quality check" });
      await qa.getByText("the narration says 14.3").waitFor();
      const open = qa.locator("[data-act=open-fixes]");
      const modal = page.locator(".modal.fixes");
      // nothing flagged: the window cannot be opened
      assert.equal(await open.isDisabled(), true);
      assert.match(await qa.locator(".fixes-launch").innerText(), /Flag findings as Fix/);
      await qa.locator("[data-act=flag-all]").click();
      await qa.getByText("3 flagged to fix").first().waitFor();
      assert.equal(await open.innerText(), "Suggested fixes…");

      // 1. compose: it names what you flagged and says how to change that; Esc closes it and nothing was asked
      await open.click();
      await modal.waitFor();
      assert.match(
        await modal.innerText(),
        /3 findings to fix[\s\S]*to change which, close this window/,
      );
      assert.equal(
        await modal.locator("[data-flag]").count(),
        0,
        "flags are changed in the list, not in the window",
      );
      await modal.locator("[data-field=guidance]").fill("keep the intro");
      await page.keyboard.press("Escape");
      await modal.waitFor({ state: "detached" });
      assert.equal(readFixSet(seed.dir, "fs-1")?.rounds.length ?? 0, 0, "closing is not asking");

      // 2. ask, then Esc while the Director works: it keeps working, the list says so, the window reopens in the same state
      await open.click();
      assert.equal(
        await modal.locator("[data-field=guidance]").inputValue(),
        "keep the intro",
        "your context was kept",
      );
      await modal.locator("[data-act=ask-fixes]").click();
      await modal.getByText(/Waiting for the Director/).waitFor();
      assert.equal(await modal.locator("[data-act=ask-fixes]").count(), 0, "one ask at a time");
      assert.match(
        await modal.locator("[data-fix-state]").innerText(),
        /Round 1: waiting for the Director/,
      );
      await page.keyboard.press("Escape");
      await modal.waitFor({ state: "detached" });
      const set = readFixSet(seed.dir, "fs-1");
      assert.ok(set && askedRound(set), "Esc did not cancel the Director");
      assert.match(
        await qa.locator("[data-fix-where]").innerText(),
        /Round 1: waiting for the Director/,
      );
      assert.equal(await open.innerText(), "Open suggested fixes");
      await open.click();
      await modal.getByText(/Waiting for the Director/).waitFor();

      // 3. Cancel is its own button, and the window then offers to ask again
      await modal.locator("[data-act=cancel-ask]").click();
      await modal.getByText(/did not get an answer \(you cancelled this ask\)/).waitFor();
      assert.equal(await modal.locator("[data-act=ask-fixes]").isEnabled(), true);
      await modal.locator("[data-act=ask-fixes]").click();
      await modal.getByText(/Waiting for the Director/).waitFor();

      // 4. the answer arrives while the window is CLOSED: the list says so, no toast steals the screen, reopening shows it
      await page.keyboard.press("Escape");
      await modal.waitFor({ state: "detached" });
      recordProposals(seed.dir, "fs-1", {
        nextSteps: ["Approve the new draft", "Render a final"],
        summary: "One voice-over run fixes two findings.",
        proposals: [
          {
            stage: "vo",
            title: "Rewrite the sentence",
            change: "- Say 14.2 where it says 14.3",
            why: "Both come from that sentence.",
            findings: ["values-1", "drift-2"],
            cost: "re-synthesises 1 section",
          },
          {
            stage: "annotations",
            title: "Move redaction r1",
            change: "- Re-place it",
            why: "The element moved.",
            findings: ["annotations-3"],
            cost: "nothing",
          },
        ] as never,
      });
      rt.bus.publish(
        "qa.proposed",
        { message: "fixes proposed for QA of render v1: 2 proposals", by: "agent" },
        seed.slug,
      );
      await qa.getByText(/Round 2: 2 proposals, 0 accepted/).waitFor();
      await open.click();
      await modal.locator(".fix-proposal").first().waitFor();

      // 5. decide, close, reopen: the decisions are there; the footer says how many are accepted
      await modal.locator(".fix-proposal[data-stage=vo] [data-decision=accepted]").click();
      await modal.locator(".fix-proposal[data-stage=vo][data-decision=accepted]").waitFor();
      assert.match(await modal.locator("[data-fix-state]").innerText(), /Round 2: 1 of 2 accepted/);
      await modal.locator("[data-act=close-fixes]").click();
      await modal.waitFor({ state: "detached" });
      await qa.getByText(/Round 2: 2 proposals, 1 accepted/).waitFor();
      await open.click();
      await modal.locator(".fix-proposal[data-stage=vo][data-decision=accepted]").waitFor();
      // 6. the actions are in the footer, pinned: rethink and apply
      const foot = modal.locator(".modal-foot");
      assert.equal(
        await foot.locator("[data-act=apply-fixes]").innerText(),
        "Apply 1 accepted proposal",
      );
      assert.equal(
        await foot.locator("[data-act=ask-fixes]").innerText(),
        "Ask the Director to rethink (3 flagged)",
      );
      const box = (await modal.boundingBox()) as { y: number; height: number };
      const footBox = (await foot.boundingBox()) as { y: number; height: number };
      assert.ok(
        footBox.y + footBox.height <= box.y + box.height + 1 && footBox.y > box.y,
        "the footer sits at the bottom of the window",
      );
      // the × closes too
      await modal.locator(".modal-close").click();
      await modal.waitFor({ state: "detached" });
      assert.equal(readFixSet(seed.dir, "fs-1")?.rounds[1]?.proposals?.[0]?.decision, "accepted");
      assert.ok(told.length >= 2, "two asks went to the Director");
      await page.close();
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
