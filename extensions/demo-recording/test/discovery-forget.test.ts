/**
 * "Forget discovery…": a project sets aside everything its discovery has found and starts again; nothing is deleted, other projects of the app keep theirs. The engine
 * part on a project folder, then the routes, then the button in the panel.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { reportVersions } from "../src/discovery/report.ts";
import { addRequest, readRequests } from "../src/discovery/requests.ts";
import { forgetDiscovery, forgetPreview } from "../src/discovery/reset.ts";
import { listSessions, writeSessionRecord } from "../src/discovery/state.ts";
import { Runtime } from "../src/runtime.ts";
import { discoveryCutoff, readResets } from "../src/workdir/discovery-cutoff.ts";
import { listFindings, recordFinding } from "../src/workdir/findings.ts";
import { readInputs, recordInput } from "../src/workdir/inputs.ts";
import { appDir, ensureProject } from "../src/workdir/layout.ts";
import { answerDialogs } from "./helpers/panel-dialogs.ts";

const BUD = { discoveryScreens: 40, discoveryActions: 150, discoveryMinutes: 20 };
const tmp = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "forget-"));

function seed(root: string, slug: string, appName = "Acme") {
  const p = ensureProject(root, { project: slug, appName, appUrl: "http://127.0.0.1:9" });
  const app = appDir(root, p.app.slug);
  const at = (h: number) => `2026-10-20T0${h}:00:00.000Z`;
  for (const [id, h] of [
    ["20261020-010000", 1],
    ["20261020-020000", 2],
  ] as const) {
    fs.mkdirSync(path.join(app, "discovery", id), { recursive: true });
    writeSessionRecord(app, { id, startedAt: at(h), closedAt: at(h + 0), budgets: BUD });
  }
  recordFinding(
    p.dir,
    { stage: "discovery", kind: "weakness", text: "shows an email", evidence: [] },
    new Date(at(2)),
  );
  recordFinding(
    p.dir,
    { stage: "recording", kind: "friction", text: "a retried scene", evidence: [] },
    new Date(at(2)),
  );
  fs.mkdirSync(path.join(p.dir, "discovery-report"), { recursive: true });
  fs.writeFileSync(path.join(p.dir, "discovery-report", "report.v1.json"), "{}");
  addRequest(p.dir, { mode: "start", budget: BUD, preset: "standard" });
  recordInput(p.dir, {
    stage: "discovery",
    source: "panel",
    kind: "direction",
    text: "start discovery (40 screens)",
  });
  recordInput(p.dir, {
    stage: "discovery",
    source: "chat",
    kind: "source",
    text: "the vendor docs: https://x.test/docs",
  });
  return { p, app };
}

test("forgetting: the sessions, the discovery findings, the report, the requests and the earlier runs' history are set aside, and nothing is deleted", () => {
  const root = tmp();
  try {
    const { p, app } = seed(root, "one");
    assert.deepEqual(forgetPreview(p.dir, app), {
      sessions: 2,
      findings: 1,
      reportVersions: 1,
      requests: 1,
      inputs: 1,
    });
    assert.equal(discoveryCutoff(p.dir), undefined);
    const rec = forgetDiscovery(p.dir, app, new Date("2026-10-21T10:00:00.000Z"));
    assert.deepEqual(
      [rec.sessions, rec.findings, rec.reportVersions, rec.requests, rec.inputs],
      [2, 1, 1, 1, 1],
    );
    assert.deepEqual(rec.setAside, [
      "discovery-report.set-aside-20261021T100000Z",
      "discovery-requests.set-aside-20261021T100000Z.json",
    ]);
    // what the project sees now: nothing of it
    assert.deepEqual(listSessions(app, p.dir), []);
    assert.deepEqual(
      listFindings(p.dir, { appDir: app }).filter((f) => f.stage === "discovery"),
      [],
    );
    assert.equal(
      listFindings(p.dir, { appDir: app }).filter((f) => f.stage === "recording").length,
      1,
      "a recording finding is not discovery",
    );
    assert.deepEqual(reportVersions(p.dir), []);
    assert.deepEqual(readRequests(p.dir), []);
    const inputs = readInputs(p.dir, { includeOutdated: true });
    assert.match(
      inputs.find((e) => e.kind === "direction")?.outdated?.reason ?? "",
      /discovery was forgotten on 2026-10-21 10:00/,
    );
    assert.equal(
      inputs.find((e) => e.kind === "source")?.outdated,
      undefined,
      "what the user gave as a source stays",
    );
    assert.deepEqual(forgetPreview(p.dir, app), {
      sessions: 0,
      findings: 0,
      reportVersions: 0,
      requests: 0,
      inputs: 0,
    });
    // nothing deleted: the sessions are still on disk for anyone who asks without a project, the report and requests are next to where they were
    assert.equal(listSessions(app).length, 2);
    assert.ok(
      fs.existsSync(
        path.join(p.dir, "discovery-report.set-aside-20261021T100000Z", "report.v1.json"),
      ),
    );
    assert.ok(
      fs.existsSync(path.join(p.dir, "discovery-requests.set-aside-20261021T100000Z.json")),
    );
    assert.deepEqual(
      readResets(p.dir).map((r) => r.at),
      ["2026-10-21T10:00:00.000Z"],
    );
    // a session after the reset is remembered again, an earlier one is not
    fs.mkdirSync(path.join(app, "discovery", "20261021-110000"), { recursive: true });
    writeSessionRecord(app, {
      id: "20261021-110000",
      startedAt: "2026-10-21T11:00:00.000Z",
      budgets: BUD,
    });
    assert.deepEqual(
      listSessions(app, p.dir).map((s) => s.id),
      ["20261021-110000"],
    );
    // forgetting twice is fine: nothing to set aside, a second record
    const again = forgetDiscovery(p.dir, app, new Date("2026-10-21T12:00:00.000Z"));
    assert.deepEqual([again.sessions, again.reportVersions, again.setAside], [1, 0, []]);
    assert.equal(readResets(p.dir).length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("another project of the same app keeps its discovery", () => {
  const root = tmp();
  try {
    const a = seed(root, "one");
    const b = ensureProject(root, {
      project: "two",
      appName: "Acme",
      appUrl: "http://127.0.0.1:9",
    });
    assert.equal(b.app.slug, a.p.app.slug, "the same app");
    forgetDiscovery(a.p.dir, a.app);
    assert.equal(listSessions(a.app, a.p.dir).length, 0);
    assert.equal(listSessions(a.app, b.dir).length, 2, "project two still sees both sessions");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function browserType() {
  try {
    const pw = await import("playwright");
    return fs.existsSync(pw.chromium.executablePath()) ? pw.chromium : undefined;
  } catch {
    return undefined;
  }
}
const chromium = await browserType();

test(
  "the route and the button: counts, refusals while a request waits or a session runs, the confirmation names what is set aside, and the Start window opens",
  { skip: !chromium && "needs Playwright Chromium", timeout: 120_000 },
  async () => {
    process.env.DEMO_REC_NO_OPEN = "1";
    const root = tmp();
    const told: string[] = [];
    const rt = new Runtime(() => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(root, "none.json") } }),
      root,
      panelPort: 0,
    }));
    (rt as unknown as { tellAgent: (t: string) => void }).tellAgent = (t) => told.push(t);
    const { p, app } = seed(root, "one");
    // the request must not be waiting for the route to work: it was seeded as pending, take it back first
    rt.setActiveProject(p.slug);
    const panel = await rt.ensurePanel();
    const base = `http://127.0.0.1:${panel.port}/api`;
    const auth = { authorization: `Bearer ${panel.token}` };
    const post = async (n: string) => {
      const res = await fetch(`${base}/${n}`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: "{}",
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    const get = async () =>
      (await (await fetch(`${base}/discovery`, { headers: auth })).json()) as {
        forget: Record<string, number>;
        status: string;
        sessions: unknown[];
      };
    const browser = await (chromium as NonNullable<typeof chromium>).launch();
    try {
      assert.deepEqual((await get()).forget, {
        sessions: 2,
        findings: 1,
        reportVersions: 1,
        requests: 1,
        inputs: 1,
      });
      const refused = await post("discovery-forget");
      assert.equal(refused.status, 400);
      assert.match(
        String(refused.json.error),
        /has been asked to start discovery and has not picked it up: take the request back first/,
      );
      assert.equal((await post("discovery-cancel")).status, 200);
      (rt as unknown as { discovery: unknown }).discovery = { isClosed: false, id: "x" };
      const running = await post("discovery-forget");
      assert.match(String(running.json.error), /a discovery session is running/);
      (rt as unknown as { discovery: unknown }).discovery = undefined;

      // the button
      const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const dlg = answerDialogs(page, { accept: false });
      await page.goto(`${panel.url}#/project?group=discovery`);
      await page.waitForSelector("[data-act=forget-discovery]");
      await page.click("[data-act=forget-discovery]");
      await page.waitForFunction(
        "document.body.innerText.includes('Forget the discovery so far?')",
      );
      assert.match(dlg.seen[0] ?? "", /sets aside 2 sessions, 1 finding, the report \(1 version\)/);
      assert.match(dlg.seen[0] ?? "", /Nothing is deleted/);
      assert.equal((await get()).sessions.length, 2, "cancelled: nothing happened");
      dlg.answer.accept = true;
      await page.click("[data-act=forget-discovery]");
      await page.waitForSelector("[data-act=ask-discovery]"); // the Start window opens by itself
      const after = await get();
      assert.equal(after.sessions.length, 0);
      assert.equal(after.status, "never");
      // the history line the route itself wrote ("forgot the discovery so far") is the one input left
      assert.deepEqual(after.forget, {
        sessions: 0,
        findings: 0,
        reportVersions: 0,
        requests: 0,
        inputs: 1,
      });
      assert.ok(
        told.some((t) =>
          /FORGOT the discovery of "one": 2 sessions, 1 finding, the report \(1 version\)/.test(t),
        ),
        "the Director is told",
      );
      await page.click("[data-act=ask-discovery]").catch(() => undefined);
      dlg.stop();
      assert.deepEqual(errors, []);
      assert.equal(readResets(p.dir).length, 1);
      assert.ok(
        readInputs(p.dir).some((e) => /forgot the discovery so far/.test(e.text)),
        "the history says so, and is not outdated itself",
      );
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
