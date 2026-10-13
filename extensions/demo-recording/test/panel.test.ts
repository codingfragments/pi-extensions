import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, test } from "node:test";
import WebSocket from "ws";
import { EventBus } from "../src/bus.ts";
import { type PanelHandle, startPanel } from "../src/panel/server.ts";

const TOKEN = "t".repeat(64);
let panel: PanelHandle | undefined;

afterEach(async () => {
  await panel?.close();
  panel = undefined;
});

function get(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("bus: ring buffer, replay after seq, broken listener isolation", () => {
  const bus = new EventBus(3);
  bus.subscribe(() => {
    throw new Error("boom");
  });
  for (let i = 1; i <= 5; i++) bus.publish("t", { i });
  assert.deepEqual(
    bus.recent().map((e) => e.seq),
    [3, 4, 5],
  );
  assert.deepEqual(
    bus.recent(4).map((e) => e.seq),
    [5],
  );
});

test("panel: static files open, API requires token, loopback Host only", async () => {
  const bus = new EventBus();
  panel = await startPanel({ bus, port: 0, token: TOKEN, getState: () => ({ hello: "world" }) });
  assert.match(panel.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=t+$/);

  const index = await get(panel.port, "/");
  assert.equal(index.status, 200);
  assert.match(index.body, /demo-recording/);
  assert.equal((await get(panel.port, "/vendor/preact-htm.module.js")).status, 200);
  assert.equal((await get(panel.port, "/../server.ts")).status, 404, "no path traversal");

  assert.equal((await get(panel.port, "/api/health")).status, 200);
  assert.equal((await get(panel.port, "/api/state")).status, 401);
  assert.equal((await get(panel.port, "/api/state?token=wrong")).status, 401);
  const ok = await get(panel.port, "/api/state", { authorization: `Bearer ${TOKEN}` });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body), { hello: "world" });

  const rebinding = await get(panel.port, `/api/state?token=${TOKEN}`, { host: "evil.example:80" });
  assert.equal(rebinding.status, 403, "DNS-rebinding style Host is rejected");
});

test("panel: ws rejects bad token, replays history, then streams live events", async () => {
  const bus = new EventBus();
  bus.publish("before.connect", { n: 1 });
  panel = await startPanel({ bus, port: 0, token: TOKEN, getState: () => ({}) });
  const base = `ws://127.0.0.1:${panel.port}/ws`;

  await assert.rejects(
    new Promise((resolve, reject) => {
      const bad = new WebSocket(`${base}?token=nope`);
      bad.on("open", resolve);
      bad.on("error", reject);
    }),
  );

  const ws = new WebSocket(`${base}?token=${TOKEN}`);
  const received: string[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.on("error", reject);
    ws.on("message", (raw) => {
      received.push(JSON.parse(String(raw)).type);
      if (received.length === 1) bus.publish("after.connect");
      if (received.length === 2) resolve();
    });
  });
  ws.close();
  assert.deepEqual(received, ["before.connect", "after.connect"]);
});

test("panel: falls back to the next port when the preferred one is taken", async () => {
  const blocker = http.createServer();
  await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
  const taken = (blocker.address() as { port: number }).port;
  try {
    panel = await startPanel({ bus: new EventBus(), port: taken, getState: () => ({}) });
    assert.notEqual(panel.port, taken);
    assert.ok(panel.port > taken && panel.port <= taken + 20);
    assert.equal(panel.token.length, 64, "random 32-byte hex token by default");
  } finally {
    blocker.close();
  }
});
