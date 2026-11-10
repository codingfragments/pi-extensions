/**
 * The previews' queues (item 19, R3-19): the server's (one render at a time, shared by whoever asks for the same still, nothing done for a caller that went away),
 * the tab's (the thumbnails in view first, the ones that left the screen dropped), the brand memo, the log, and the panel passing "the client went away" to a route.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BRAND_MEMO_MS, brandMemoStats, prepareBrandMemo } from "../src/annotations/brand-memo.ts";
import { PreviewCancelled, PreviewQueue } from "../src/annotations/preview-queue.ts";
import { logPreview } from "../src/annotations/preview.ts";
import { notifyBrandChanged } from "../src/brand/changed.ts";
import { EventBus } from "../src/bus.ts";
import { AbortedError, createPreviewQueue } from "../src/panel/public/preview-queue-core.js";
import { type PostRoute, startPanel } from "../src/panel/server.ts";
import { setDiagnosticsDir } from "../src/util/bounded.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function gate() {
  let open: () => void = () => {};
  const p = new Promise<void>((r) => {
    open = r;
  });
  return { p, open };
}

test("server queue: one at a time, in order; the same still asked twice is one render both callers get", async () => {
  const q = new PreviewQueue();
  const order: string[] = [];
  const g = gate();
  const a = q.run("a", async () => {
    order.push("a:start");
    await g.p;
    order.push("a:end");
    return "A";
  });
  const b = q.run("b", async () => {
    order.push("b");
    return "B";
  });
  const a2 = q.run("a", async () => {
    order.push("a-AGAIN");
    return "never";
  });
  assert.equal(q.pending, 2, "a and b; the second ask for a joined the first");
  await sleep(20);
  assert.deepEqual(order, ["a:start"], "b waits behind a");
  g.open();
  assert.deepEqual(await Promise.all([a, b, a2]), ["A", "B", "A"]);
  assert.deepEqual(order, ["a:start", "a:end", "b"]);
  assert.equal(q.stats.shared, 1);
  assert.equal(q.pending, 0);
  // after it finished, asking again renders again (the render's own file cache makes that instant)
  assert.equal(await q.run("a", async () => "A2"), "A2");
});

test("server queue: a caller that went away stops waiting at once; a render nobody waits for is skipped; one that is running finishes", async () => {
  const q = new PreviewQueue();
  const ran: string[] = [];
  const g = gate();
  const first = q.run("first", async () => {
    ran.push("first");
    await g.p;
    return 1;
  });
  const left = new AbortController();
  const gone = q.run(
    "gone",
    async () => {
      ran.push("gone");
      return 2;
    },
    left.signal,
  );
  const stays = q.run("stays", async () => {
    ran.push("stays");
    return 3;
  });
  await sleep(10);
  left.abort();
  await assert.rejects(
    gone,
    PreviewCancelled,
    "the aborted caller is released immediately, while first still runs",
  );
  g.open();
  assert.deepEqual(await Promise.all([first, stays]), [1, 3]);
  assert.deepEqual(ran, ["first", "stays"], "the render nobody waited for never started");
  assert.equal(q.stats.skipped, 1);

  // two callers share a render: one leaving does not cancel it for the other
  const q2 = new PreviewQueue();
  const g2 = gate();
  const blocker = q2.run("blocker", async () => {
    await g2.p;
  });
  const c1 = new AbortController();
  const x1 = q2.run("same", async () => "shared", c1.signal);
  const x2 = q2.run("same", async () => "shared");
  c1.abort();
  await assert.rejects(x1, PreviewCancelled);
  g2.open();
  await blocker;
  assert.equal(await x2, "shared");

  // a render that has started is finished even if its only caller leaves
  const q3 = new PreviewQueue();
  const started = gate();
  const end = gate();
  let finished = false;
  const c3 = new AbortController();
  const r3 = q3.run(
    "run",
    async () => {
      started.open();
      await end.p;
      finished = true;
    },
    c3.signal,
  );
  await started.p;
  c3.abort();
  await assert.rejects(r3, PreviewCancelled);
  end.open();
  await sleep(20);
  assert.equal(finished, true, "its result is cached on disk for the next ask");
  // already aborted before asking: nothing is queued
  const dead = new AbortController();
  dead.abort();
  await assert.rejects(
    q3.run("late", async () => 1, dead.signal),
    PreviewCancelled,
  );
  assert.equal(q3.pending, 0);
});

test("the tab's queue: the thumbnails in view go first, then the rest in the order asked; an abort drops a waiting one and `first` jumps the line", async () => {
  const q = createPreviewQueue();
  const ran: string[] = [];
  const g = gate();
  const job = (name: string, hold?: Promise<void>) => async () => {
    ran.push(name);
    if (hold) await hold;
    return name;
  };
  const none = new AbortController();
  const p0 = q.enqueue(job("running", g.p), { signal: none.signal });
  const view = { b: false, d: false };
  const pa = q.enqueue(job("a"), { signal: none.signal, visible: () => false });
  const pb = q.enqueue(job("b"), { signal: none.signal, visible: () => view.b });
  const left = new AbortController();
  const pc = q.enqueue(job("c"), { signal: left.signal, visible: () => true });
  const pd = q.enqueue(job("d"), { signal: none.signal, visible: () => view.d });
  assert.equal(q.pending(), 5);
  left.abort();
  await assert.rejects(pc, AbortedError);
  assert.equal(q.pending(), 4, "the aborted one left the queue at once");
  // b and d scroll into view while "running" runs: they go before a
  view.d = true;
  view.b = true;
  const pe = q.enqueue(job("e"), { signal: none.signal, visible: () => false, first: false });
  const pf = q.enqueue(job("f"), { signal: none.signal, visible: () => true, first: true });
  g.open();
  await Promise.all([p0, pa, pb, pd, pe, pf]);
  assert.deepEqual(
    ran,
    ["running", "f", "b", "d", "a", "e"],
    "a clicked clip first, then what is in view in order, then the rest in order",
  );
  // pending is announced
  const seen: number[] = [];
  const off = q.subscribe((n) => seen.push(n));
  await q.enqueue(job("g"), { signal: none.signal });
  await sleep(5);
  off();
  assert.ok(seen.includes(1) && seen.at(-1) === 0, `announced: ${seen}`);
  // an abort of the one that is running rejects it and the queue goes on
  const q2 = createPreviewQueue();
  const ctl = new AbortController();
  const hung = q2.enqueue(
    (signal) =>
      new Promise((_, rej) => signal.addEventListener("abort", () => rej(new AbortedError()))),
    { signal: ctl.signal },
  );
  const next = q2.enqueue(async () => "next", { signal: none.signal });
  ctl.abort();
  await assert.rejects(hung, AbortedError);
  assert.equal(await next, "next");
  // asked with a signal that is already aborted: refused at once
  await assert.rejects(
    q2.enqueue(async () => 1, { signal: ctl.signal }),
    AbortedError,
  );
});

test("brand memo: prepared once per burst and shared; dropped after the memo time, when a brand changes, and when it failed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brand-memo-"));
  try {
    const dir = path.join(root, "p");
    fs.mkdirSync(path.join(dir, "takes", "take-001"), { recursive: true });
    const cfg = { root, output: { width: 960, height: 540 }, brand: "neutral" } as never;
    const base = { ...brandMemoStats };
    const t = 1_000_000;
    const [a, b] = await Promise.all([
      prepareBrandMemo(dir, cfg, "take-001", "neutral", t),
      prepareBrandMemo(dir, cfg, "take-001", "neutral", t + 5),
    ]);
    assert.equal(a, b, "the same prepared brand");
    assert.equal(brandMemoStats.made - base.made, 1);
    assert.equal(brandMemoStats.reused - base.reused, 1);
    assert.equal(await prepareBrandMemo(dir, cfg, "take-001", "neutral", t + BRAND_MEMO_MS - 1), a);
    assert.notEqual(
      await prepareBrandMemo(dir, cfg, "take-001", "neutral", t + BRAND_MEMO_MS + 1),
      a,
      "after the memo time: new",
    );
    const c = await prepareBrandMemo(dir, cfg, "take-001", "neutral", t + BRAND_MEMO_MS + 2);
    notifyBrandChanged();
    assert.notEqual(
      await prepareBrandMemo(dir, cfg, "take-001", "neutral", t + BRAND_MEMO_MS + 3),
      c,
      "a brand changed: new",
    );
    // another size or another take is another entry
    const other = await prepareBrandMemo(
      dir,
      { ...(cfg as object), output: { width: 480, height: 270 } } as never,
      "take-001",
      "neutral",
      t + BRAND_MEMO_MS + 4,
    );
    assert.notEqual(other, c);
    // a brand that does not exist fails, and is not kept as a failure
    await assert.rejects(prepareBrandMemo(dir, cfg, "take-001", "no-such-brand", t + 1));
    await assert.rejects(prepareBrandMemo(dir, cfg, "take-001", "no-such-brand", t + 2));
    assert.equal(brandMemoStats.made - base.made >= 5, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the log: one line per preview with where the time went", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "previews-log-"));
  try {
    setDiagnosticsDir(dir);
    logPreview({
      id: "zm",
      kind: "still",
      queuedMs: 3,
      brandMs: 0,
      overlayMs: 55,
      renderMs: 190,
      totalMs: 250,
      cached: false,
    });
    logPreview({ id: "zm", kind: "still", cached: true, totalMs: 10 });
    const lines = fs
      .readFileSync(path.join(dir, "previews.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.deepEqual(
      [lines[0].id, lines[0].overlayMs, lines[0].renderMs, lines[1].cached],
      ["zm", 55, 190, true],
    );
    assert.match(lines[0].at, /^\d{4}-\d\d-\d\dT/);
  } finally {
    setDiagnosticsDir(undefined as never);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the panel tells a route when the client went away (an aborted request), and not when it was answered", async () => {
  const bus = new EventBus();
  const seen: { name: string; aborted: () => boolean }[] = [];
  const hold = gate();
  const panel = await startPanel({
    bus,
    token: "t",
    port: 0,
    getState: () => ({}),
    post: {
      slow: (async (_b, ctx) => {
        seen.push({ name: "slow", aborted: () => !!ctx?.signal.aborted });
        await hold.p;
        return { ok: true };
      }) as PostRoute,
      quick: (async (_b, ctx) => {
        seen.push({ name: "quick", aborted: () => !!ctx?.signal.aborted });
        return { ok: true };
      }) as PostRoute,
    },
  } as never);
  try {
    const url = (n: string) => `http://127.0.0.1:${panel.port}/api/${n}`;
    const headers = { authorization: "Bearer t", "content-type": "application/json" };
    await fetch(url("quick"), { method: "POST", headers, body: "{}" });
    await sleep(30);
    assert.equal(seen.find((s) => s.name === "quick")?.aborted(), false, "answered: not aborted");
    const ctl = new AbortController();
    const pending = fetch(url("slow"), {
      method: "POST",
      headers,
      body: "{}",
      signal: ctl.signal,
    }).catch(() => "aborted");
    await sleep(80);
    ctl.abort();
    await pending;
    await sleep(80);
    assert.equal(seen.find((s) => s.name === "slow")?.aborted(), true, "the client left: aborted");
    hold.open();
  } finally {
    await panel.close();
  }
});
