/**
 * After a fresh login the Director asks whether to start discovery (R3-9): never by itself, never when it would be noise, and "start" is the explicit yes that sends the request.
 * No browser: the login's own tests cover the window.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { pendingRequest, presetBudgets, readRequests } from "../src/discovery/requests.ts";
import { answerFor, loginSaved } from "../src/question-flow.ts";
import { askQuestion, pendingQuestions, readQuestions } from "../src/questions.ts";
import { Runtime } from "../src/runtime.ts";
import { ensureProject } from "../src/workdir/layout.ts";
import { setPhase } from "../src/workdir/state.ts";

function setup() {
  process.env.DEMO_REC_NO_OPEN = "1";
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "s7offer-"));
  const told: string[] = [];
  const shown: string[] = [];
  const agent = {
    sendUserMessage: (t: string) => told.push(t),
    sendMessage: (m: { content: string }) => shown.push(m.content),
  };
  const rt = new Runtime(
    () => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(root, "none.json") } }),
      root,
      panelPort: 0,
    }),
    agent as never,
  );
  const p = ensureProject(root, { project: "p", appName: "Fixture", appUrl: "http://127.0.0.1:9" });
  rt.setActiveProject(p.slug);
  return {
    rt,
    p,
    told,
    shown,
    done: async () => {
      await rt.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("a fresh login asks: start, choose first or not now; nothing starts by itself", async () => {
  const { rt, p, told, shown, done } = setup();
  try {
    loginSaved(rt, p.app.slug, p.app.name);
    const [q, ...more] = pendingQuestions(p.dir);
    assert.equal(more.length, 0);
    assert.equal(q?.role, "Director");
    assert.match(
      q?.what ?? "",
      /^Your login for Fixture is saved and works\. Start discovery now\?$/,
    );
    assert.deepEqual(
      q?.options.map((o) => o.word),
      ["start", "choose", "not"],
    );
    assert.match(
      q?.why ?? "",
      /scouting run: the engine surveys the app's navigation.*model tokens and browser time, no money\. Nothing starts unless you say so/,
    );
    assert.equal(q?.discovery?.app, p.app.slug);
    assert.ok(
      shown.some((m) => /Start discovery now\?/.test(m)),
      "the chat shows it",
    );
    assert.equal(pendingRequest(p.dir), undefined, "no request");
    assert.deepEqual(told, [], "the Director is not woken by the question itself");
    // a second login while it waits does not ask twice
    loginSaved(rt, p.app.slug, p.app.name);
    assert.equal(pendingQuestions(p.dir).length, 1);
  } finally {
    await done();
  }
});

test("Start sends a scouting request (0.4 of Config's screens and minutes) and wakes the Director; the history says who asked", async () => {
  const { rt, p, told, done } = setup();
  try {
    loginSaved(rt, p.app.slug, p.app.name);
    const q = pendingQuestions(p.dir)[0];
    const r = answerFor(rt, q?.id as string, "start", "panel");
    assert.equal(r.ok, true);
    const req = pendingRequest(p.dir);
    assert.equal(req?.mode, "start");
    assert.equal(req?.preset, "scout");
    assert.deepEqual(req?.budget, presetBudgets(rt.getConfig().budgets, "scout"));
    assert.equal(told.length, 1);
    assert.match(told[0] ?? "", /asks to start discovery of Fixture .* \(request dr-1\)/);
    assert.match(told[0] ?? "", /^\[demo-panel/);
    assert.ok(rt.bus.recent().some((e) => e.type === "discovery.offer-taken"));
    assert.equal(pendingQuestions(p.dir).length, 0);
    // a request waits for the Director: a later login does not ask again
    loginSaved(rt, p.app.slug, p.app.name);
    assert.equal(pendingQuestions(p.dir).length, 0);
  } finally {
    await done();
  }
});

test("Choose and Not now start nothing; Choose points to the Project page", async () => {
  const { rt, p, told, done } = setup();
  try {
    loginSaved(rt, p.app.slug, p.app.name);
    answerFor(rt, pendingQuestions(p.dir)[0]?.id as string, "choose", "chat");
    assert.equal(readRequests(p.dir).length, 0);
    assert.ok(
      rt.bus
        .recent()
        .some(
          (e) =>
            e.type === "discovery.offer-deferred" && /Project page/.test(String(e.data?.message)),
        ),
    );
    loginSaved(rt, p.app.slug, p.app.name);
    answerFor(rt, pendingQuestions(p.dir)[0]?.id as string, "not", "panel");
    assert.equal(readRequests(p.dir).length, 0);
    assert.deepEqual(told, [], "the Director heard nothing");
  } finally {
    await done();
  }
});

test("no offer when it would be noise: a recording waited for this login, a session is open, the project is past discovery", async () => {
  const { rt, p, done } = setup();
  try {
    // a recording paused for this login: the login answers that question, and nothing else is asked
    askQuestion(p.dir, {
      what: "The login expired. What now?",
      options: [{ label: "Login: I will log in now" }, { label: "Stop the recording" }],
      auth: { app: p.app.slug },
    });
    loginSaved(rt, p.app.slug, p.app.name);
    assert.equal(readQuestions(p.dir).filter((q) => q.discovery).length, 0);
    assert.equal(pendingQuestions(p.dir).length, 0);
    // a discovery session is open
    (rt as unknown as { discovery: unknown }).discovery = { isClosed: false };
    loginSaved(rt, p.app.slug, p.app.name);
    assert.equal(readQuestions(p.dir).filter((q) => q.discovery).length, 0);
    (rt as unknown as { discovery: unknown }).discovery = undefined;
    // the project is already past discovery
    setPhase(p.dir, "recording");
    loginSaved(rt, p.app.slug, p.app.name);
    assert.equal(readQuestions(p.dir).filter((q) => q.discovery).length, 0);
    // and back in discovery it asks
    setPhase(p.dir, "discovery");
    loginSaved(rt, p.app.slug, p.app.name);
    assert.equal(readQuestions(p.dir).filter((q) => q.discovery).length, 1);
  } finally {
    await done();
  }
});
