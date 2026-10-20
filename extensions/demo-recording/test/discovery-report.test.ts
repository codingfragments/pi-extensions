/**
 * Item 10, D2 (F2): the discovery report. A project artifact, versioned, written by the Director through a tool that REFUSES a claim
 * without real evidence (a finding, a screen the session saw, a source of the project); the coverage in it is the engine's own
 * measurement; the project context and the storyboard point at it.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import {
  type ReportAnswer,
  coverageOf,
  evidenceKind,
  formatReport,
  projectSources,
  readReport,
  reportBrief,
  reportFor,
  reportProblems,
  reportVersions,
  writeReport,
} from "../src/discovery/report.ts";
import { writeSessionRecord } from "../src/discovery/state.ts";
import { Runtime } from "../src/runtime.ts";
import { registerDiscoveryReportTool } from "../src/tools/discovery-report.ts";
import { registerStoryboardTool } from "../src/tools/storyboard.ts";
import { projectContext } from "../src/workdir/context.ts";
import { recordFinding } from "../src/workdir/findings.ts";
import { recordInput } from "../src/workdir/inputs.ts";
import { appDir } from "../src/workdir/layout.ts";
import { answerDialogs } from "./helpers/panel-dialogs.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

const SESSION = "20261019-090000";

/** A project with two findings, a session that saw two screens and planned two areas, and (optionally) sources. */
function world(opts: { sources?: boolean } = {}) {
  const seed = seedPanelProject();
  const cfg = path.join(seed.root, "c.json");
  fs.writeFileSync(cfg, "{}");
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
    root: seed.root,
    panelPort: 0,
  }));
  const told: string[] = [];
  const r = rt as unknown as { notifyAgent: (t: string) => void; tellAgent: (t: string) => void };
  r.notifyAgent = (t) => told.push(t);
  r.tellAgent = () => undefined;
  rt.setActiveProject(seed.slug);
  const app = appDir(seed.root, rt.requireProject().app.slug);
  const f1 = recordFinding(seed.dir, {
    stage: "discovery",
    kind: "weakness",
    text: "The concierge mirrors the question instead of answering",
    evidence: [{ type: "screen", id: `${SESSION}/s001` }],
  });
  const f2 = recordFinding(seed.dir, {
    stage: "discovery",
    kind: "friction",
    text: "Search ignores product descriptions",
  });
  const dir = path.join(app, "discovery", SESSION);
  fs.mkdirSync(path.join(dir, "screens"), { recursive: true });
  for (const s of ["s001", "s002"]) fs.writeFileSync(path.join(dir, "screens", `${s}.jpg`), "x");
  const log = [
    {
      at: "2026-10-19T07:00:01Z",
      kind: "plan",
      areas: ["Chat", "Search", "FAQ"],
      routes: { Chat: ["/chat"], Search: ["/search"], FAQ: ["/faq"] },
    },
    {
      at: "2026-10-19T07:00:02Z",
      kind: "look",
      screen: `${SESSION}/s001`,
      url: "https://k.example/chat",
    },
    {
      at: "2026-10-19T07:00:03Z",
      kind: "look",
      screen: `${SESSION}/s002`,
      url: "https://k.example/search",
    },
    { at: "2026-10-19T07:00:09Z", kind: "area-dropped", area: "FAQ", why: "static text" },
  ];
  fs.writeFileSync(
    path.join(dir, "actions.jsonl"),
    `${log.map((x) => JSON.stringify(x)).join("\n")}\n`,
  );
  writeSessionRecord(app, {
    id: SESSION,
    startedAt: "2026-10-19T07:00:00Z",
    closedAt: "2026-10-19T07:10:00Z",
    usage: { screens: 2, actions: 0, minutes: 10 },
    exhausted: false,
  });
  if (opts.sources) {
    fs.mkdirSync(path.join(seed.dir, "context"), { recursive: true });
    fs.writeFileSync(path.join(seed.dir, "context", "pricing.pdf"), "pdf");
    recordInput(seed.dir, {
      stage: "project",
      source: "panel",
      kind: "source",
      text: "the pricing page",
      refs: ["https://k.example/pricing"],
    });
  }
  return {
    seed,
    rt,
    app,
    told,
    f1: f1.id,
    f2: f2.id,
    done: async () => {
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    },
  };
}

type Cite = { text: string; evidence: string[] };
type Guide = { title: string; why: string; evidence: string[] };
type Good = {
  summary: string;
  found: Cite[];
  research: Cite[];
  guidance: Record<"useCases" | "mustShow" | "risks" | "avoid", Guide[]>;
};
const good = (w: { f1: string; f2: string }, research = false): Good => ({
  summary: "The app looks modern, but the concierge never answers and search only reads names.",
  found: [
    {
      text: "The concierge mirrors the question back and then plugs a product",
      evidence: [w.f1, `${SESSION}/s001`],
    },
    { text: "Search ignores descriptions", evidence: [w.f2] },
  ],
  research: research
    ? [
        {
          text: "The pricing page says compare is coming soon",
          evidence: ["ref:https://k.example/pricing", "file:context/pricing.pdf"],
        },
      ]
    : [],
  guidance: {
    useCases: [
      {
        title: "Ask the concierge about a product",
        why: "it is the clearest weakness on camera",
        evidence: [w.f1],
      },
    ],
    mustShow: [
      {
        title: "The empty search state",
        why: "it shows the name-only search",
        evidence: [w.f2, `${SESSION}/s002`],
      },
    ],
    risks: [
      {
        title: "The concierge may answer differently next time",
        why: "it is an AI: record twice if needed",
        evidence: [w.f1],
      },
    ],
    avoid: [],
  },
});

test("evidence: a finding, a screen the session saw, a source of the project; nothing else exists", () => {
  const w = world({ sources: true });
  try {
    const k = (id: string) => evidenceKind(w.seed.dir, w.app, id);
    assert.deepEqual([k(w.f1), k("f-0099"), k("f-x")], ["finding", undefined, undefined]);
    assert.deepEqual(
      [k(`${SESSION}/s001`), k(`${SESSION}/s009`), k("nope/s001")],
      ["screen", undefined, undefined],
    );
    assert.deepEqual(
      [
        k("file:context/pricing.pdf"),
        k("file:context/gone.pdf"),
        k("ref:https://k.example/pricing"),
        k("ref:https://other.example"),
      ],
      ["source", undefined, "source", undefined],
    );
    assert.equal(k("input:in-0001"), "source", "a note or link the user gave");
    assert.equal(k("input:in-0999"), undefined);
    assert.equal(k(""), undefined);
    assert.deepEqual(projectSources(w.seed.dir).files, ["context/pricing.pdf"]);
  } finally {
    void w.done();
  }
});

test("every rule refuses with the reason, all at once; research follows what the project has", () => {
  const w = world();
  try {
    const probs = (patch: Partial<ReportAnswer> = {}, base = good(w)) =>
      reportProblems(w.seed.dir, w.app, { ...base, ...patch }).join("\n");
    assert.equal(probs(), "");
    assert.match(probs({ summary: "" }), /summary is required/);
    assert.match(probs({ summary: "x".repeat(601) }), /summary is 601 characters/);
    assert.match(
      probs({ found: [good(w).found?.[0]] as never }),
      /found: give 2 to 12 items \(you gave 1\)/,
    );
    assert.match(
      probs({ found: [{ text: "a", evidence: [] }, good(w).found?.[1]] as never }),
      /found 1 cites no evidence: name a finding or screen/,
    );
    assert.match(
      probs({ found: [{ text: "a", evidence: ["f-0099"] }, good(w).found?.[1]] as never }),
      /found 1 cites "f-0099", which does not exist here/,
    );
    assert.match(
      probs({ found: [{ text: "a", evidence: [`${SESSION}/s777`] }, good(w).found?.[1]] as never }),
      /cites "20261019-090000\/s777", which does not exist/,
    );
    assert.match(
      probs({ found: [{ text: "", evidence: [w.f1] }, good(w).found?.[1]] as never }),
      /found 1 says nothing/,
    );
    assert.match(
      probs({ found: [{ text: "y".repeat(261), evidence: [w.f1] }, good(w).found?.[1]] as never }),
      /found 1 is 261 characters/,
    );
    // research without sources must be empty: nothing may be invented
    assert.match(
      probs({ research: [{ text: "the docs say so", evidence: ["file:context/x.pdf"] }] as never }),
      /research must be empty: the project has no sources/,
    );
    // guidance
    assert.match(
      probs({ guidance: { ...good(w).guidance, useCases: [] } as never }),
      /guidance use cases: give 1 to 6 items \(you gave 0\)/,
    );
    assert.match(
      probs({
        guidance: {
          ...good(w).guidance,
          risks: [{ title: "", why: "x", evidence: [w.f1] }],
        } as never,
      }),
      /risks 1 needs a title/,
    );
    assert.match(
      probs({
        guidance: {
          ...good(w).guidance,
          avoid: [{ title: "t", why: "", evidence: [w.f1] }],
        } as never,
      }),
      /avoid 1 needs a why/,
    );
    assert.match(
      probs({
        guidance: {
          ...good(w).guidance,
          mustShow: [{ title: "t", why: "w", evidence: [] }],
        } as never,
      }),
      /must show 1 cites no evidence/,
    );
    assert.match(
      probs({
        guidance: {
          ...good(w).guidance,
          mustShow: [{ title: "T".repeat(91), why: "w", evidence: [w.f1] }],
        } as never,
      }),
      /the title is 91 characters/,
    );
    assert.ok(
      reportProblems(w.seed.dir, w.app, {}).length >= 3,
      "an empty answer lists every missing part",
    );
  } finally {
    void w.done();
  }
});

test("with sources: research is required and must cite a source, a finding is not a source", () => {
  const w = world({ sources: true });
  try {
    const run = (research: unknown) =>
      reportProblems(w.seed.dir, w.app, { ...good(w), research } as ReportAnswer).join("\n");
    assert.equal(run(good(w, true).research), "");
    assert.match(
      run([]),
      /research: the project has 2 source\(s\) \(context\/pricing\.pdf, https:\/\/k\.example\/pricing\); say what they added/,
    );
    assert.match(
      run([{ text: "a finding is not a source", evidence: [w.f1] }]),
      /research 1 cites "f-0001", a finding: this part must cite a source/,
    );
    assert.match(
      reportProblems(w.seed.dir, w.app, {
        ...good(w),
        found: [{ text: "x", evidence: ["file:context/pricing.pdf"] }, good(w).found?.[1]],
      } as ReportAnswer).join("\n"),
      /found 1 cites "file:context\/pricing\.pdf", a source: this part must cite a finding or screen/,
    );
  } finally {
    void w.done();
  }
});

test("storing: the next version each time, the coverage is the engine's, evidence de-duplicated; reading, formatting, which report a storyboard had", () => {
  const w = world({ sources: true });
  try {
    assert.equal(readReport(w.seed.dir), undefined);
    assert.throws(
      () => writeReport(w.seed.dir, w.app, { ...good(w, true), summary: "" }),
      /report not stored, fix these:\n- summary is required/,
    );
    assert.deepEqual(reportVersions(w.seed.dir), [], "a refused report consumes no version");
    const a = writeReport(
      w.seed.dir,
      w.app,
      {
        ...good(w, true),
        found: [{ text: "dup", evidence: [w.f1, w.f1, `${SESSION}/s001`] }, good(w).found?.[1]],
      } as ReportAnswer,
      new Date("2026-10-19T10:00:00Z"),
    );
    assert.deepEqual([a.version, a.found[0]?.evidence], [1, [w.f1, `${SESSION}/s001`]]);
    // the coverage is measured, whatever the Director said
    assert.deepEqual(
      a.coverage.sessions[0]?.areas.map((x) => [x.name, x.status, x.looks]),
      [
        ["Chat", "current", 1],
        ["Search", "seen", 1],
        ["FAQ", "dropped", 0],
      ],
    );
    assert.deepEqual([a.coverage.findings, a.coverage.sources], [2, { files: 1, refs: 1 }]);
    assert.deepEqual(
      coverageOf(w.seed.dir, w.app).sessions[0]?.areas[2]?.droppedWhy,
      "static text",
    );
    const b = writeReport(w.seed.dir, w.app, good(w, true), new Date("2026-10-19T12:00:00Z"));
    assert.equal(b.version, 2);
    assert.deepEqual(reportVersions(w.seed.dir), [1, 2]);
    assert.equal(readReport(w.seed.dir)?.version, 2);
    assert.equal(readReport(w.seed.dir, 1)?.found[0]?.text, "dup");
    // formatting
    const short = formatReport(b);
    assert.match(short, /^Discovery report v2 \(2026-10-19 12:00\): The app looks modern/);
    assert.match(
      short,
      /Use cases:\n- Ask the concierge about a product: it is the clearest weakness on camera/,
    );
    assert.match(
      short,
      /Coverage \(measured\): 2 of 3 areas seen in session 20261019-090000, 1 left out\./,
    );
    assert.doesNotMatch(short, /Found:/, "the short form is the summary and the guidance");
    assert.match(
      formatReport(b, { full: true }),
      /Found:\n- The concierge mirrors[\s\S]*\[f-0001, 20261019-090000\/s001\]/,
    );
    assert.match(formatReport(b, { full: true }), /What the research added:/);
    // which report a storyboard had: the newest stored before its file was last written
    const file = path.join(w.seed.root, "sb.yaml");
    fs.writeFileSync(file, "x");
    const at = (iso: string) => fs.utimesSync(file, new Date(iso), new Date(iso));
    at("2026-10-19T09:00:00Z");
    assert.equal(reportFor(w.seed.dir, file), undefined, "written before any report");
    at("2026-10-19T11:00:00Z");
    assert.equal(reportFor(w.seed.dir, file)?.version, 1);
    at("2026-10-19T13:00:00Z");
    assert.equal(reportFor(w.seed.dir, file)?.version, 2);
    assert.equal(reportFor(w.seed.dir, path.join(w.seed.root, "gone.yaml")), undefined);
  } finally {
    void w.done();
  }
});

test("the Director's brief lists what it may cite and the rules; the project context carries the report", () => {
  const w = world({ sources: true });
  try {
    const before = reportBrief(w.seed.dir, w.app);
    assert.match(before, /## Findings \(2\)[\s\S]*- f-0001 \[weakness\] The concierge mirrors/);
    assert.match(before, /20261019-090000: 2 screen\(s\) \(s001 to s002\)/);
    assert.match(before, /- Chat: 1 look\(s\), 0 action\(s\)/);
    assert.match(before, /- FAQ: left out \(static text\)/);
    assert.match(before, /- file:context\/pricing\.pdf[\s\S]*- ref:https:\/\/k\.example\/pricing/);
    assert.match(before, /## No report yet/);
    assert.match(before, /A claim without evidence, or with an id that does not exist, is refused/);
    assert.doesNotMatch(projectContext(w.seed.dir, w.seed.slug), /Discovery report/);
    writeReport(w.seed.dir, w.app, good(w, true));
    assert.match(
      reportBrief(w.seed.dir, w.app),
      /## The latest report \(v1\)[\s\S]*update it where the project changed/,
    );
    const ctx = projectContext(w.seed.dir, w.seed.slug);
    assert.match(
      ctx,
      /## Discovery report \(follow its guidance when writing the storyboard; demo_rec_discovery get for the evidence\)\nDiscovery report v1/,
    );
    assert.match(ctx, /Must show:\n- The empty search state/);
    const none = world();
    try {
      assert.match(reportBrief(none.seed.dir, none.app), /- none: leave research empty/);
    } finally {
      void none.done();
    }
  } finally {
    void w.done();
  }
});

test("the tool: context, a refused report, a stored one with its event, get; the storyboard says which report it follows", async () => {
  const w = world();
  try {
    const tools = new Map<
      string,
      { execute: (...a: unknown[]) => Promise<{ content: { text?: string }[] }> }
    >();
    const pi = { registerTool: (t: { name: string }) => tools.set(t.name, t as never) } as never;
    registerDiscoveryReportTool(pi, w.rt);
    registerStoryboardTool(pi, w.rt);
    const run = async (name: string, params: Record<string, unknown>) =>
      (
        await (tools.get(name) as NonNullable<ReturnType<typeof tools.get>>).execute(
          "id",
          params,
          undefined,
          undefined,
          undefined,
        )
      ).content
        .map((c) => c.text ?? "")
        .join("\n");
    const events: string[] = [];
    w.rt.bus.subscribe((e: { type: string }) => events.push(e.type));
    assert.match(await run("demo_rec_discovery", { action: "get" }), /no discovery report yet/);
    assert.match(await run("demo_rec_discovery", { action: "context" }), /## Findings \(2\)/);
    await assert.rejects(
      () =>
        run("demo_rec_discovery", {
          action: "report",
          ...good(w),
          found: [
            { text: "x", evidence: ["f-0099"] },
            { text: "y", evidence: [w.f1] },
          ],
        }),
      /report not stored[\s\S]*"f-0099", which does not exist/,
    );
    assert.deepEqual(reportVersions(w.seed.dir), []);
    assert.match(
      await run("demo_rec_discovery", { action: "report", ...good(w) }),
      /Stored discovery report v1/,
    );
    assert.ok(events.includes("discovery.reported"));
    assert.match(
      await run("demo_rec_discovery", { action: "get" }),
      /Discovery report v1[\s\S]*Found:[\s\S]*\(versions: 1\)/,
    );
    // a storyboard written after a session with no report says so; with one, nothing
    const yaml = fs.readFileSync(path.join(w.seed.dir, "storyboard", "v2.yaml"), "utf8");
    const sbStale = await run("demo_rec_storyboard", { action: "write", yaml, skipAreas: [] });
    assert.doesNotMatch(sbStale, /no discovery report yet/, "there is a report");
    fs.rmSync(path.join(w.seed.dir, "discovery-report"), { recursive: true });
    assert.match(
      await run("demo_rec_storyboard", { action: "write", yaml }),
      /no discovery report yet: write it with demo_rec_discovery report/,
    );
    await run("demo_rec_discovery", { action: "report", ...good(w) });
    // a newer session the report does not cover
    writeSessionRecord(w.app, {
      id: "20261020-090000",
      startedAt: "2026-10-20T07:00:00Z",
      closedAt: "2026-10-20T07:10:00Z",
      usage: { screens: 0, actions: 0, minutes: 10 },
      exhausted: false,
    });
    fs.mkdirSync(path.join(w.app, "discovery", "20261020-090000"), { recursive: true });
    assert.match(
      await run("demo_rec_storyboard", { action: "write", yaml }),
      /the discovery report v1 does not cover the newest discovery session: update it/,
    );
  } finally {
    await w.done();
  }
});

test("the routes: the report with its versions and newer sessions, asking, and the refusals", async () => {
  const w = world();
  try {
    const panel = await w.rt.ensurePanel();
    const base = `http://127.0.0.1:${panel.port}/api`;
    const auth = { authorization: `Bearer ${panel.token}` };
    const get = async (q = "") =>
      (await (await fetch(`${base}/discovery-report${q}`, { headers: auth })).json()) as {
        versions: number[];
        report: { version: number } | null;
        newer: string[];
        canAsk: boolean;
        now: { sessions: unknown[] };
      };
    const post = async (n: string) => {
      const res = await fetch(`${base}/${n}`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: "{}",
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    const g0 = await get();
    assert.deepEqual(
      [g0.versions, g0.report, g0.newer, g0.canAsk, g0.now.sessions.length],
      [[], null, [], true, 1],
    );
    // ask for the first one
    const first = await post("discovery-report-ask");
    assert.equal(first.status, 200);
    assert.match(
      w.told[0] ?? "",
      /asks you to WRITE the discovery report of "keycraft"[\s\S]*demo_rec_discovery context[\s\S]*Do not write the storyboard; stop after report/,
    );
    writeReport(w.seed.dir, w.app, good(w));
    writeReport(w.seed.dir, w.app, { ...good(w), summary: "Second look, same story." });
    const g1 = await get();
    assert.deepEqual([g1.versions, g1.report?.version, g1.newer], [[1, 2], 2, []]);
    assert.equal((await get("?version=1")).report?.version, 1);
    // a session after the report: it is named, and asking updates
    writeSessionRecord(w.app, {
      id: "20261020-090000",
      startedAt: "2026-10-20T07:00:00Z",
      closedAt: "2026-10-20T07:10:00Z",
      usage: { screens: 0, actions: 0, minutes: 10 },
      exhausted: false,
    });
    fs.mkdirSync(path.join(w.app, "discovery", "20261020-090000"), { recursive: true });
    assert.deepEqual((await get()).newer, ["20261020-090000"]);
    assert.deepEqual(
      (await get("?version=1")).newer,
      [],
      "an old version says nothing about newer sessions",
    );
    await post("discovery-report-ask");
    assert.match(
      w.told[1] ?? "",
      /UPDATE the discovery report of "keycraft" \(the latest is v2; there are 1 newer session\(s\) it does not cover\)/,
    );
    // a running session: wait
    (w.rt as unknown as { discovery: unknown }).discovery = { isClosed: false, id: "x" };
    assert.match(
      String((await post("discovery-report-ask")).json.error),
      /a discovery session is running/,
    );
    (w.rt as unknown as { discovery: unknown }).discovery = undefined;
    assert.equal(w.told.length, 2, "a refused ask tells the Director nothing");
  } finally {
    await w.done();
  }
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
  "in the browser: no report yet, the report with its evidence, versions, a newer session, asking; the storyboard names the report it follows",
  { skip: !browserType && "needs Playwright Chromium", timeout: 120_000 },
  async () => {
    const w = world({ sources: true });
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const panel = await w.rt.ensurePanel();
      const page = await browser.newPage({ viewport: { width: 1400, height: 1400 } });
      const dlg = answerDialogs(page);
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${panel.url}#/project?group=discovery`);
      await page.waitForSelector("[data-report=none]");
      assert.match(
        await page.locator("[data-report=none]").innerText(),
        /No report yet\. At the end of a discovery the Director writes one/,
      );
      await page.click("[data-act=ask-report]");
      for (let i = 0; i < 100 && !w.told.length; i++) await new Promise((r) => setTimeout(r, 50));
      assert.match(w.told[0] ?? "", /WRITE the discovery report/);
      // the Director writes it
      writeReport(w.seed.dir, w.app, good(w, true), new Date("2026-10-19T10:00:00Z"));
      w.rt.bus.publish(
        "discovery.reported",
        { version: 1, by: "agent", message: "report v1" },
        w.seed.slug,
      );
      await page.waitForSelector("[data-report='1']");
      const t = await page.locator("[data-report='1']").innerText();
      assert.match(t, /Report v1/);
      assert.match(t, /The app looks modern, but the concierge never answers/);
      assert.match(t, /What it found about the app[\s\S]*The concierge mirrors the question back/i);
      assert.match(
        t,
        /What your sources added[\s\S]*The pricing page says compare is coming soon/i,
      );
      assert.match(
        t,
        /Guidance for the storyboard[\s\S]*USE CASES[\s\S]*Ask the concierge about a product[\s\S]*MUST SHOW[\s\S]*RISKS/i,
      );
      assert.match(
        t,
        /Coverage, counted by the engine: 2 of 3 areas seen in session 20261019-090000, 1 left out on purpose · 2 findings · 2 sources/,
      );
      // the evidence: a source goes straight to its file or link; a finding and a screen open a popup first
      assert.match(
        (await page
          .locator("[data-evidence='file:context/pricing.pdf']")
          .first()
          .getAttribute("href")) ?? "",
        /\/media\/project\/context\/pricing\.pdf/,
      );
      assert.equal(
        await page
          .locator("[data-evidence='ref:https://k.example/pricing']")
          .first()
          .getAttribute("href"),
        "https://k.example/pricing",
      );
      assert.equal(
        await page.evaluate("document.querySelector(\"[data-evidence='f-0001']\").tagName"),
        "BUTTON",
        "a finding is looked at first",
      );
      assert.equal(
        await page.evaluate(
          "document.querySelector(\"[data-evidence='20261019-090000/s001']\").tagName",
        ),
        "BUTTON",
        "and so is a screen",
      );
      assert.equal(await page.locator("[data-newer]").count(), 0);
      // a second version and a session after the first: versions, the notice, asking again
      writeReport(
        w.seed.dir,
        w.app,
        { ...good(w, true), summary: "Second look, same story." },
        new Date("2026-10-19T12:00:00Z"),
      );
      writeSessionRecord(w.app, {
        id: "20261020-090000",
        startedAt: "2026-10-20T07:00:00Z",
        closedAt: "2026-10-20T07:10:00Z",
        usage: { screens: 0, actions: 0, minutes: 10 },
        exhausted: false,
      });
      fs.mkdirSync(path.join(w.app, "discovery", "20261020-090000"), { recursive: true });
      w.rt.bus.publish(
        "discovery.reported",
        { version: 2, by: "agent", message: "report v2" },
        w.seed.slug,
      );
      await page.waitForSelector("[data-report='2']");
      assert.match(
        await page.locator("[data-newer]").innerText(),
        /1 discovery session ran after this report \(20261020-090000\)/,
      );
      assert.deepEqual(await page.locator("[data-field=report-version] option").allInnerTexts(), [
        "v2 (newest)",
        "v1",
      ]);
      await page.selectOption("[data-field=report-version]", "1");
      await page.waitForSelector("[data-report='1']");
      assert.equal(
        await page.locator("[data-newer]").count(),
        0,
        "an old version does not claim newer sessions",
      );
      await page.selectOption("[data-field=report-version]", "2");
      await page.waitForSelector("[data-report='2']");
      assert.equal(
        await page.locator("[data-act=ask-report]").innerText(),
        "Ask the Director to update the report",
      );
      // the storyboard names the report that was current when it was written (the seeded file is newer than both: v2)
      await page.goto(`${panel.url}#/storyboard`);
      await page.waitForSelector("[data-act=open-report]");
      assert.match(
        await page.locator(".stage-summary").innerText(),
        /Based on discovery report v2/,
      );
      await page.click("[data-act=open-report]");
      await page.waitForSelector("[data-report]");
      assert.match(await page.evaluate("location.hash"), /group=discovery/);
      dlg.stop();
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await w.done();
    }
  },
);

test(
  "in the browser: a finding or a screen chip opens a popup first, with the way on to the real finding or the full picture",
  { skip: !browserType && "needs Playwright Chromium", timeout: 120_000 },
  async () => {
    const w = world({ sources: true });
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      writeReport(w.seed.dir, w.app, good(w, true));
      const panel = await w.rt.ensurePanel();
      const page = await browser.newPage({ viewport: { width: 1400, height: 1400 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${panel.url}#/project?group=discovery`);
      await page.waitForSelector("[data-report='1']");
      // a finding chip: the finding itself, its marks, its own picture, and how the report uses it
      await page.click("[data-report='1'] [data-evidence='f-0001']");
      await page.waitForSelector("[data-popup=finding]");
      const t = await page.locator("[data-popup=finding]").innerText();
      assert.match(t, /weakness/);
      assert.match(t, /The concierge mirrors the question instead of answering/);
      assert.match(t, /auto: the Director decides/);
      assert.match(
        t,
        /How the report uses it[\s\S]*found 1[\s\S]*use case 1[\s\S]*Ask the concierge about a product[\s\S]*risk 1/,
      );
      assert.equal(
        await page.locator("[data-part=finding-media] img").count(),
        1,
        "the finding's own screen",
      );
      assert.equal(await page.locator("[data-act=go-to-finding]").count(), 1);
      await page.keyboard.press("Escape");
      await page.waitForSelector("[data-popup]", { state: "detached" });
      // the way on: the real finding, scrolled to and marked, whatever the filters were
      await page.click("[data-report='1'] [data-evidence='f-0001']");
      await page.waitForSelector("[data-act=go-to-finding]");
      await page.click("[data-act=go-to-finding]");
      await page.waitForSelector("[data-popup]", { state: "detached" });
      await page.waitForSelector("#finding-f-0001[data-focused=true]");
      assert.match(
        await page.evaluate("location.hash"),
        /group=findings&finding=f-0001|finding=f-0001&group=findings/,
      );
      assert.equal(await page.locator("[data-focused=true]").count(), 1, "only that one is marked");
      assert.equal(await page.locator("#finding-f-0002[data-focused]").count(), 0);
      // a filter that would hide it does not, when you arrive from the report
      await page.goto(`${panel.url}#/project?group=findings`);
      await page.waitForSelector(".findings");
      await page.click(".ds-chip:text-is('ignore')");
      await page.waitForFunction("document.querySelectorAll('.findings li').length === 0");
      await page.evaluate("location.hash = '#/project?group=findings&finding=f-0002'");
      await page.waitForSelector("#finding-f-0002[data-focused=true]");
      await page.goto(`${panel.url}#/project?group=discovery`);
      await page.waitForSelector("[data-report='1']");
      // a screen chip: the picture large, the findings that cite it, a way to the full-size picture
      await page.click("[data-report='1'] [data-evidence='20261019-090000/s001']");
      await page.waitForSelector("[data-popup=screen]");
      assert.match(
        (await page.locator("[data-popup=screen] img").first().getAttribute("src")) ?? "",
        /\/media\/app\/discovery\/20261019-090000\/screens\/s001\.jpg/,
      );
      assert.match(
        await page.locator("[data-part=screen-findings]").innerText(),
        /Findings that cite this screen[\s\S]*f-0001[\s\S]*The concierge mirrors/,
      );
      assert.match(await page.locator("[data-part=cited-by]").innerText(), /found 1/);
      assert.match(
        (await page.locator("[data-act=open-full-screen]").getAttribute("href")) ?? "",
        /screens\/s001\.jpg/,
      );
      assert.equal(
        await page.locator("[data-act=open-full-screen]").getAttribute("target"),
        "_blank",
      );
      // from the screen to a finding that cites it
      await page.click("[data-popup=screen] [data-act=open-finding]");
      await page.waitForSelector("[data-popup=finding]");
      assert.equal(
        await page.locator("[data-popup=screen]").count(),
        0,
        "the screen popup gave way",
      );
      await page.click("[data-act=go-to-finding]");
      await page.waitForSelector("#finding-f-0001[data-focused=true]");
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await w.done();
    }
  },
);
