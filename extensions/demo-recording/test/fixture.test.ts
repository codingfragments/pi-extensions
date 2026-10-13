/**
 * Fixture SPA tests (D20). The HTTP-level tests always run; the browser tests
 * run when Playwright's Chromium is installed (`npx playwright install chromium`)
 * and are skipped otherwise.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { ACCOUNTS, ASSISTANT_ANSWERS, CHURN_BY_REGION, KPIS } from "../fixtures/demo-app/data.js";
import { type FixtureHandle, serveFixture } from "../src/fixture/server.ts";

let fixture: FixtureHandle;
before(async () => {
  fixture = await serveFixture(0);
});
after(async () => {
  await fixture.close();
});

test("serves assets and falls back to index.html for deep links", async () => {
  const index = await (await fetch(fixture.url)).text();
  assert.match(index, /Acme Pulse/);
  const deep = await fetch(`${fixture.url}item/106`);
  assert.equal(deep.status, 200);
  assert.match(await deep.text(), /<main id="view"/);
  const js = await fetch(`${fixture.url}app.js`);
  assert.match(js.headers.get("content-type") ?? "", /javascript/);
});

test("seeded data is internally consistent (QA will quote these values)", () => {
  assert.equal(KPIS.find((k) => k.id === "arr")?.value, "$4.82M");
  const emea = CHURN_BY_REGION.find((r) => r.code === "EMEA");
  assert.equal(emea?.churn, 14.2);
  assert.equal(Math.max(...CHURN_BY_REGION.map((r) => r.churn)), 14.2, "EMEA is the outlier");
  assert.equal(
    CHURN_BY_REGION.reduce((n, r) => n + r.accounts, 0),
    1284,
    "matches Active accounts KPI",
  );

  const high = ACCOUNTS.filter((a) => a.risk === "High");
  assert.equal(high.length, 5);
  assert.equal(high.filter((a) => a.region === "EMEA").length, 4);
  assert.equal(
    high.reduce((n, a) => n + a.arr, 0),
    753000,
  );
  const churnAnswer = ASSISTANT_ANSWERS.find((a) => a.keywords.includes("churn"))?.answer ?? "";
  assert.match(churnAnswer, /Five accounts/);
  assert.match(churnAnswer, /\$753K/);
});

async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

const hasChromium = await chromiumAvailable();

test(
  "browser: dashboard, search, deep link, flaky toast, streaming chat",
  { skip: !hasChromium && "chromium not installed" },
  async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

      await page.goto(fixture.url);
      assert.equal(await page.locator('[data-kpi="arr"] .value').textContent(), "$4.82M");

      await page.goto(`${fixture.url}search?q=churn%20by%20region`);
      await page.locator("table.regions").waitFor();
      assert.equal(await page.locator('tr[data-region="EMEA"] td').nth(1).textContent(), "14.2%");

      await page.goto(`${fixture.url}item/106`);
      assert.equal(await page.locator("h1").textContent(), "Litware Bank");

      await page.goto(`${fixture.url}?flaky=1`);
      await page.getByRole("alert").waitFor({ timeout: 4000 });
      assert.match((await page.getByRole("alert").textContent()) ?? "", /Couldn't load segment/);

      await page.goto(`${fixture.url}chat`);
      await page
        .getByRole("textbox", { name: "Ask a question" })
        .fill("Which region has the worst churn in EMEA?");
      await page.getByRole("button", { name: "Send" }).click();
      await page.waitForFunction(
        "!document.querySelector('.caret') && document.querySelectorAll('.msg.assistant').length === 1",
        null,
        { timeout: 15000 },
      );
      assert.match(
        (await page.locator(".msg.assistant").textContent()) ?? "",
        /14\.2% gross churn/,
      );
    } finally {
      await browser.close();
    }
  },
);

test(
  "browser: ?slow=1 shows a spinner for ~4s before results",
  { skip: !hasChromium && "chromium not installed" },
  async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const start = Date.now();
      await page.goto(`${fixture.url}search?q=emea&slow=1`);
      await page.locator(".spinner").waitFor();
      await page.locator(".hits").waitFor({ timeout: 8000 });
      assert.ok(Date.now() - start >= 3500, "spinner should last ~4s");
    } finally {
      await browser.close();
    }
  },
);
