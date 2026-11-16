/**
 * Cancel from the panel (item 24, R3-15): an engine job, the discovery session and the Director's turn; the Director is told quietly; a cancel the agent started is not
 * reported as a turn; the Activity drawer's Cancel / Stop buttons.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { CANCELLABLE } from "../src/panel/cancel-routes.ts";
import { STOPPABLE } from "../src/panel/public/stop-core.js";
import { Runtime } from "../src/runtime.ts";
import { answerDialogs } from "./helpers/panel-dialogs.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

function setup() {
  process.env.DEMO_REC_NO_OPEN = "1";
  const seed = seedPanelProject();
  const told: string[] = [];
  const turns: string[] = [];
  const rt = new Runtime(
    () => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(seed.root, "none.json") } }),
      root: seed.root,
      panelPort: 0,
    }),
    {
      sendUserMessage: (t: string) => turns.push(t),
      sendMessage: (m: { content: string }) => told.push(m.content),
    } as never,
  );
  rt.setActiveProject(seed.slug);
  return { rt, seed, told, turns };
}

/** A job that runs until it is aborted. */
const hang = (rt: Runtime, kind: string, slug: string) =>
  rt.jobs.start(
    kind,
    slug,
    (signal) =>
      new Promise((_, rej) =>
        signal.addEventListener("abort", () => rej(new Error(`${kind} cancelled`))),
      ),
  );

async function post(rt: Runtime, route: string, body: unknown = {}) {
  const panel = await rt.ensurePanel();
  const res = await fetch(`http://127.0.0.1:${panel.port}/api/${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${panel.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test("every Activity row that runs an engine job can be cancelled, and the panel knows each one", () => {
  assert.deepEqual(Object.keys(CANCELLABLE).sort(), ["design", "edit", "render", "take", "tts"]);
  assert.deepEqual(Object.keys(STOPPABLE).sort(), [
    "design",
    "director",
    "discovery",
    "edit",
    "render",
    "take",
    "tts",
  ]);
  for (const k of ["take", "tts", "discovery"])
    assert.ok(STOPPABLE[k as keyof typeof STOPPABLE].ask, `${k} asks first`);
  for (const k of ["edit", "render", "design", "director"])
    assert.equal("ask" in STOPPABLE[k as keyof typeof STOPPABLE], false, `${k} stops at once`);
});

test("job-cancel: aborts the running job, says what is kept, tells the Director quietly; nothing running and a wrong kind are said", async () => {
  const { rt, seed, told, turns } = setup();
  try {
    const events: { type: string; data: Record<string, unknown> }[] = [];
    rt.bus.subscribe((e) => events.push(e as never));
    const j = hang(rt, "tts", seed.slug);
    const r = await post(rt, "job-cancel", { kind: "tts" });
    assert.equal(r.json.cancelled, true);
    assert.match(
      String(r.json.message),
      /you cancelled the voice synthesis \(tts-\d+\)\. Sections already synthesized are billed and cached/,
    );
    await j.done;
    assert.equal(j.status, "cancelled");
    assert.ok(events.some((e) => e.type === "job.cancel-asked" && e.data.kind === "tts"));
    assert.match(
      told.join("\n"),
      /The user CANCELLED the voice synthesis .* Do not start it again unless they ask/,
    );
    assert.deepEqual(turns, [], "no turn");
    assert.deepEqual((await post(rt, "job-cancel", { kind: "tts" })).json, {
      cancelled: false,
      message: "the voice synthesis is not running",
    });
    assert.match(
      String((await post(rt, "job-cancel", { kind: "nope" })).json.error),
      /"kind" must be one of take, tts, edit, render, design/,
    );
    // a take: the record job
    const take = hang(rt, "record", seed.slug);
    assert.equal((await post(rt, "job-cancel", { kind: "take" })).json.cancelled, true);
    await take.done;
    assert.equal(take.status, "cancelled");
  } finally {
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});

test("discovery-stop closes the open session and keeps what it saw; director-stop aborts a working turn, and says when there is nothing to stop", async () => {
  const { rt, seed, told } = setup();
  try {
    assert.deepEqual((await post(rt, "discovery-stop")).json, {
      stopped: false,
      message: "no discovery session is open",
    });
    let closed = false;
    (rt as unknown as { discovery: unknown }).discovery = {
      id: "20261101-100000",
      isClosed: false,
      budget: () => ({ screens: "12/40", actions: "30/150", minutes: "4/20", exhausted: false }),
      close: async () => {
        closed = true;
      },
    };
    const s = await post(rt, "discovery-stop");
    assert.equal(s.json.stopped, true);
    assert.match(
      String(s.json.message),
      /you stopped discovery session 20261101-100000 \(screens 12\/40, actions 30\/150\); what it saw is kept/,
    );
    assert.equal(closed, true);
    assert.equal(rt.discovery, undefined);
    assert.match(
      told.join("\n"),
      /STOPPED the discovery session 20261101-100000 .* Do not reopen it/,
    );

    assert.deepEqual((await post(rt, "director-stop")).json, {
      stopped: false,
      message: "the Director is not working (nothing to stop)",
    });
    let aborted = 0;
    let idle = false;
    rt.setAgentControl({ abort: () => aborted++, isIdle: () => idle });
    const d = await post(rt, "director-stop");
    assert.equal(d.json.stopped, true);
    assert.equal(aborted, 1);
    assert.match(told.join("\n"), /The user STOPPED your last turn from the panel/);
    idle = true;
    assert.equal(
      (await post(rt, "director-stop")).json.stopped,
      false,
      "an idle Director is not aborted",
    );
    assert.equal(aborted, 1);
  } finally {
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});

test("a cancelled render or voice the agent started is a quiet note, not a turn", () => {
  const src = (f: string) =>
    fs.readFileSync(path.join(import.meta.dirname, "..", "src", "tools", f), "utf8");
  assert.match(
    src("render.ts"),
    /if \(request\.by === "agent" && j\.status !== "cancelled"\) rt\.reportToAgent\(text\);/,
  );
  assert.match(
    src("render.ts"),
    /if \(by === "agent" && j\.status !== "cancelled"\) rt\.reportToAgent\(text\);/,
  );
  assert.match(
    src("tts.ts"),
    /opts\.quietReport \|\| j\.status === "cancelled" \? rt\.tellAgent\(t\) : rt\.reportToAgent\(t\)/,
  );
});

async function chromium() {
  try {
    const pw = await import("playwright");
    return fs.existsSync(pw.chromium.executablePath()) ? pw.chromium : undefined;
  } catch {
    return undefined;
  }
}
const browserType = await chromium();

test(
  "in the Activity drawer: a running job has Cancel; a take asks first; the job is cancelled",
  { skip: !browserType && "needs Playwright Chromium", timeout: 120_000 },
  async () => {
    const { rt, seed } = setup();
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${panel.url}#/recording`);
      await page.click(".ds-strip button[aria-controls=activity]");
      const take = hang(rt, "record", seed.slug);
      rt.bus.publish(
        "take.started",
        { job: take.id, version: 1, message: "recording storyboard v1" },
        seed.slug,
      );
      const edit = hang(rt, "edit", seed.slug);
      rt.bus.publish("edit.progress", { done: 1, total: 4, message: "editing" }, seed.slug);
      await page.waitForSelector("aside#activity [data-stop=take]");
      await page.waitForSelector("aside#activity [data-stop=edit]");
      // the edit stops at once
      await page.click("aside#activity [data-stop=edit]");
      await edit.done;
      assert.equal(edit.status, "cancelled");
      // the take asks first: refuse, then accept
      const dialogs = answerDialogs(page, { accept: false });
      await page.click("aside#activity [data-stop=take]");
      await page.waitForFunction(() => true, undefined, { timeout: 500 }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 600));
      assert.equal(take.status, "running", "refused: still running");
      assert.match(dialogs.seen.join("\n"), /Cancel the recording\? The take is marked cancelled/);
      dialogs.answer.accept = true;
      await page.click("aside#activity [data-stop=take]");
      await take.done;
      assert.equal(take.status, "cancelled");
      dialogs.stop();
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
