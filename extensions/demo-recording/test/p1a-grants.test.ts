/** P1a PR 2: spending grants: the store, the panel routes and /demo allow. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { SUBCOMMANDS, cmdAnswer } from "../src/commands/demo.ts";
import { GRANT_TTL_MS, GrantStore, REQUEST_TTL_MS } from "../src/grants.ts";
import { ROUTE_COST } from "../src/panel/cost.ts";
import { grantRoutes } from "../src/panel/grant-routes.ts";

function clock() {
  let t = 1_000_000;
  return {
    now: () => t,
    tick: (ms: number) => {
      t += ms;
    },
  };
}

test("a grant is for one thing, once", () => {
  const c = clock();
  const g = new GrantStore(c.now);
  g.issue("tts", "demo", "vo:3", "panel");
  assert.equal(g.consume("tts", "demo", "vo:4"), false, "another target");
  assert.equal(g.consume("take", "demo", "vo:3"), false, "another kind");
  assert.equal(g.consume("tts", "other", "vo:3"), false, "another project");
  assert.equal(g.has("tts", "demo", "vo:3"), true, "has() does not use it up");
  assert.equal(g.consume("tts", "demo", "vo:3"), true);
  assert.equal(g.consume("tts", "demo", "vo:3"), false, "used once");
});

test("a grant and a request expire", () => {
  const c = clock();
  const g = new GrantStore(c.now);
  g.issue("take", "demo", "storyboard:1", "chat");
  const r = g.request("tts", "demo", "vo:1", "voice v1");
  c.tick(GRANT_TTL_MS + 1);
  assert.equal(g.consume("take", "demo", "storyboard:1"), false);
  assert.equal(g.pending("demo").length, 1, "the request outlives the grant");
  c.tick(REQUEST_TTL_MS);
  assert.deepEqual(g.pending("demo"), []);
  assert.equal(g.allow(r.id, "chat"), undefined, "an expired request cannot be allowed");
});

test("a request is deduplicated; allowing it makes a grant and closes it", () => {
  const g = new GrantStore(clock().now);
  const a = g.request("tts", "demo", "vo:2", "voice v2: 474 characters");
  const b = g.request("tts", "demo", "vo:2", "voice v2: 480 characters");
  assert.equal(a.id, b.id);
  assert.equal(g.pending("demo").length, 1);
  assert.equal(g.pending("demo")[0]?.summary, "voice v2: 480 characters");
  assert.ok(g.allow(a.id, "panel"));
  assert.deepEqual(g.pending("demo"), []);
  assert.equal(g.consume("tts", "demo", "vo:2"), true);
});

test("deny removes the request and grants nothing", () => {
  const g = new GrantStore(clock().now);
  const a = g.request("take", "demo", "storyboard:2", "a take");
  assert.ok(g.deny(a.id));
  assert.equal(g.deny(a.id), undefined);
  assert.equal(g.consume("take", "demo", "storyboard:2"), false);
});

// biome-ignore lint/suspicious/noExplicitAny: a fake runtime with only what the routes touch
type Loose = any;

function fakeRt() {
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const told: { how: string; text: string }[] = [];
  const grants = new GrantStore(clock().now);
  const rt = {
    grants,
    activeProject: () => ({ slug: "demo" }),
    requireProject: () => ({ slug: "demo" }),
    bus: { publish: (type: string, data: Record<string, unknown>) => events.push({ type, data }) },
    notifyAgent: (text: string) => told.push({ how: "notify", text }),
    tellAgent: (text: string) => told.push({ how: "tell", text }),
  } as Loose;
  return { rt, grants, events, told };
}

test("POST /api/grant answers a request and starts the Director's turn", async () => {
  const { rt, grants, events, told } = fakeRt();
  const routes = grantRoutes(rt);
  const req = grants.request("tts", "demo", "vo:3", "voice v3: 474 characters");
  const list = (await routes.get.confirmations?.(new URLSearchParams())) as {
    requests: { id: string }[];
  };
  assert.deepEqual(
    list.requests.map((r) => r.id),
    [req.id],
  );
  await routes.post.grant?.({ request: req.id });
  assert.equal(grants.has("tts", "demo", "vo:3"), true);
  assert.equal(events.at(-1)?.type, "confirm.granted");
  assert.deepEqual(
    told.map((t) => t.how),
    ["notify"],
  );
  assert.match(told[0]?.text ?? "", /ALLOWED: voice v3: 474 characters/);
  await assert.rejects(
    async () => routes.post.grant?.({ request: req.id }),
    /gone/,
    "an answered request is gone",
  );
});

test("POST /api/grant takes a dialog's confirmation; bad input is rejected", async () => {
  const { rt, grants } = fakeRt();
  const routes = grantRoutes(rt);
  await routes.post.grant?.({ kind: "take", target: "storyboard:2" });
  assert.equal(grants.consume("take", "demo", "storyboard:2"), true);
  await assert.rejects(
    async () => routes.post.grant?.({ kind: "designer", target: "x" }),
    /required/,
  );
  await assert.rejects(async () => routes.post.grant?.({ kind: "tts" }), /required/);
});

test("POST /api/grant-deny refuses and tells the Director quietly", async () => {
  const { rt, grants, told, events } = fakeRt();
  const routes = grantRoutes(rt);
  const req = grants.request("tts", "demo", "vo:3", "voice v3");
  await routes.post["grant-deny"]?.({ request: req.id });
  assert.equal(grants.has("tts", "demo", "vo:3"), false);
  assert.equal(events.at(-1)?.type, "confirm.denied");
  assert.deepEqual(
    told.map((t) => t.how),
    ["tell"],
  );
  assert.match(told[0]?.text ?? "", /did NOT allow/);
});

test("/demo allow and /demo deny", () => {
  const { rt, grants, told } = fakeRt();
  const said: string[] = [];
  const ctx = { ui: { notify: (m: string) => said.push(m) }, hasUI: true } as Loose;
  cmdAnswer(rt, "allow", [], ctx);
  assert.match(said.at(-1) ?? "", /nothing is waiting/);

  const a = grants.request("tts", "demo", "vo:3", "voice v3");
  cmdAnswer(rt, "allow", [], ctx);
  assert.equal(grants.has("tts", "demo", "vo:3"), true, "one open request: no id needed");
  assert.equal(told.at(-1)?.how, "notify");
  assert.equal(
    grants.pending("demo").some((r) => r.id === a.id),
    false,
  );

  grants.request("tts", "demo", "vo:4", "voice v4");
  grants.request("take", "demo", "storyboard:2", "a take");
  cmdAnswer(rt, "allow", [], ctx);
  assert.match(said.at(-1) ?? "", /2 requests are waiting/, "several: it asks which");
  assert.equal(grants.has("tts", "demo", "vo:4"), false, "and allows nothing");
  cmdAnswer(rt, "allow", ["nope"], ctx);
  assert.match(said.at(-1) ?? "", /no open request "nope"/);
  cmdAnswer(rt, "deny", ["all"], ctx);
  assert.deepEqual(grants.pending("demo"), []);
  assert.equal(grants.has("take", "demo", "storyboard:2"), false);
});

test("the commands and routes are registered", () => {
  assert.ok(SUBCOMMANDS.includes("allow") && SUBCOMMANDS.includes("deny"));
  assert.deepEqual([ROUTE_COST.grant, ROUTE_COST["grant-deny"]], [["none"], ["none"]]);
});
