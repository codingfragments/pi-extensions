/**
 * The shared browser for short jobs (item 19, R3-19, R3-22): one launch for many jobs, pages left open are closed, an idle browser goes away, a stalled one is killed and
 * the next job gets a new one, a browser that disconnected is replaced. Real Chromium (skipped when it is not installed).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";
import {
  POOL_IDLE_MS,
  POOL_MAX_JOBS,
  closePool,
  poolStats,
  setPoolIdleMs,
  setPoolMaxJobs,
  withPooledPages,
} from "../src/browser/pool.ts";

async function chromiumOk() {
  try {
    const pw = await import("playwright");
    return fs.existsSync(pw.chromium.executablePath());
  } catch {
    return false;
  }
}
const skip = !(await chromiumOk()) && "chromium not installed";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

after(async () => {
  setPoolIdleMs(250);
  setPoolMaxJobs(POOL_MAX_JOBS);
  await closePool();
});

test("the defaults: idle 45 s, recycled after 200 jobs", () => {
  assert.equal(POOL_IDLE_MS, 45_000);
  assert.equal(POOL_MAX_JOBS, 200);
});

test(
  "many jobs, one launch; a job's pages are closed when it ends; jobs at the same time share the launch",
  { skip, timeout: 60_000 },
  async () => {
    await closePool();
    setPoolIdleMs(60_000);
    const before = poolStats();
    const shot = (html: string) =>
      withPooledPages("test job", async (b) => {
        const page = await b.newPage({ viewport: { width: 200, height: 100 } });
        await page.setContent(html);
        return (await page.screenshot({ type: "png" })).length;
      });
    // three at once: one launch
    const sizes = await Promise.all([shot("<b>a</b>"), shot("<b>b</b>"), shot("<b>c</b>")]);
    assert.ok(sizes.every((n) => n > 100));
    let s = poolStats();
    assert.equal(s.launches - before.launches, 1, "one launch for three jobs at once");
    assert.equal(s.jobs - before.jobs, 3);
    // then more, one after the other: still that one launch
    for (let i = 0; i < 5; i++) await shot(`<i>${i}</i>`);
    s = poolStats();
    assert.equal(s.launches - before.launches, 1, "eight jobs, one browser");
    assert.equal(s.open, 1);
    assert.equal(s.active, 0);
    // a job that leaves a page open (and one that fails) leaves nothing for the next
    let leaked: import("playwright").Page | undefined;
    await withPooledPages("leaky", async (b) => {
      leaked = await b.newPage();
    });
    assert.ok(leaked?.isClosed(), "the page the job left open is closed");
    await assert.rejects(
      withPooledPages("failing", async (b) => {
        leaked = await b.newPage();
        throw new Error("job failed");
      }),
      /job failed/,
    );
    assert.ok(leaked?.isClosed());
    assert.equal(poolStats().open, 1, "a failing job does not take the browser down");
    assert.equal(poolStats().launches - before.launches, 1);
  },
);

test(
  "an idle browser goes away, and the next job starts a new one",
  { skip, timeout: 60_000 },
  async () => {
    await closePool();
    setPoolIdleMs(200);
    const before = poolStats();
    await withPooledPages("one", async (b) => (await b.newPage()).close());
    assert.equal(poolStats().open, 1);
    await sleep(700);
    assert.equal(poolStats().open, 0, "idle: closed");
    await withPooledPages("two", async (b) => (await b.newPage()).close());
    assert.equal(poolStats().launches - before.launches, 2);
  },
);

test(
  "recycled after max jobs (when none runs), and a disconnected browser is replaced",
  { skip, timeout: 60_000 },
  async () => {
    await closePool();
    setPoolIdleMs(60_000);
    setPoolMaxJobs(2);
    const before = poolStats();
    for (let i = 0; i < 5; i++)
      await withPooledPages("job", async (b) => (await b.newPage()).close());
    const s = poolStats();
    assert.equal(s.launches - before.launches, 3, "jobs 1-2, 3-4 and 5: three browsers");
    assert.equal(s.recycled - before.recycled, 2);
    setPoolMaxJobs(POOL_MAX_JOBS);
    // a browser that goes away under a job: the job fails, the next one gets a new browser
    const b0 = poolStats().launches;
    await assert.rejects(
      withPooledPages("dies", async (b) => {
        const page = await b.newPage();
        await page.context().browser()?.close();
        await page.evaluate("1"); // throws: the browser is gone
      }),
    );
    assert.equal(poolStats().open, 0, "a disconnected browser is dropped");
    await withPooledPages("after", async (b) => (await b.newPage()).close());
    assert.equal(poolStats().launches, b0 + 1);
  },
);

test(
  "a job that does not finish is killed and diagnosed; the next job gets a new browser",
  { skip, timeout: 60_000 },
  async () => {
    await closePool();
    setPoolIdleMs(60_000);
    const b0 = poolStats().launches;
    await assert.rejects(
      withPooledPages("hanging job", () => new Promise(() => {}), { deadlineMs: 600 }),
      /hanging job[\s\S]*did not answer and was killed/,
    );
    assert.equal(poolStats().open, 0, "the stalled browser is gone");
    await withPooledPages("next", async (b) => (await b.newPage()).close());
    assert.equal(poolStats().launches, b0 + 2, "one for the hanging job, a new one for the next");
  },
);
