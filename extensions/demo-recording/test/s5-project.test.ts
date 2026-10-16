/**
 * S5 part 5a — Project screen: brief fields (facts, depth defaults, editing),
 * findings (agent + engine, dedupe, marks, coverage, length check), project
 * context, title-card subtitle, the Project panel routes, and a browser
 * walk-through of the Project tab.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { titleInfoFor } from "../src/edit/pipeline.ts";
import { hasBinary } from "../src/media/ffmpeg.ts";
import { Runtime } from "../src/runtime.ts";
import { parseStoryboard } from "../src/storyboard/parse.ts";
import {
  DEPTH_DEFAULTS,
  effectiveFacts,
  formatLength,
  parseDepth,
  parseTargetLength,
  readBriefFacts,
  setBriefFacts,
} from "../src/workdir/brief.ts";
import { appDirOf, projectContext } from "../src/workdir/context.ts";
import {
  formatFindings,
  listFindings,
  markFinding,
  recordFinding,
  uncoveredUseFindings,
} from "../src/workdir/findings.ts";
import { readInputs } from "../src/workdir/inputs.ts";
import { ensureProject } from "../src/workdir/layout.ts";
import { listVersions } from "../src/workdir/versioning.ts";
import { answerDialogs } from "./helpers/panel-dialogs.ts";

async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}
const noBrowser =
  !((await chromiumAvailable()) && hasBinary("ffmpeg")) && "needs Playwright Chromium + ffmpeg";

let root: string;
const savedCfg = process.env.DEMO_REC_CONFIG;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-proj-"));
  process.env.DEMO_REC_CONFIG = path.join(root, "none.json");
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (savedCfg === undefined) Reflect.deleteProperty(process.env, "DEMO_REC_CONFIG");
  else process.env.DEMO_REC_CONFIG = savedCfg;
});

const BRIEF = `# Demo brief: kc

- **App:** KeyCraft
- **URL:** https://k.test/
- **Audience:** Developers who evaluate test targets
- **Stance:** _champion | evaluator | teacher_
- **Goal / key message:** _TODO_
- **Target length:** 3–4 min total
- **Language:** English

## Background

Free text.
`;

test("brief facts: aliases, placeholders, depth defaults, length parsing", () => {
  const f = readBriefFacts(BRIEF);
  assert.equal(f.persona, "Developers who evaluate test targets", "Audience is read as Persona");
  assert.equal(f.stance, undefined, "placeholder = empty");
  assert.equal(f.goal, undefined);
  assert.deepEqual(parseTargetLength("3–4 min total"), [180, 240]);
  assert.deepEqual(parseTargetLength("60-90 s"), [60, 90]);
  assert.deepEqual(parseTargetLength("2:30–3:30"), [150, 210]);
  assert.deepEqual(parseTargetLength("90s"), [77, 103], "single value = ±15 %");
  assert.equal(parseTargetLength("soon"), undefined);
  assert.equal(parseDepth("PoC"), "poc");
  assert.equal(parseDepth("Sales demo"), "sales");
  assert.equal(formatLength([180, 240]), "3–4 min");
  assert.equal(formatLength([60, 90]), "60 s–90 s");

  const withDepth = setBriefFacts(BRIEF, { depth: "sales" });
  const e = effectiveFacts(withDepth);
  assert.equal(e.depth, "sales");
  assert.equal(e.stance, DEPTH_DEFAULTS.sales.stance);
  assert.equal(e.stanceFromDepth, true);
  assert.deepEqual(e.length, [180, 240], "the brief's length wins over the depth default");
  assert.equal(e.lengthFromDepth, false);
  const noLength = effectiveFacts(setBriefFacts(withDepth, { length: "" }));
  assert.deepEqual(noLength.length, [60, 90], "depth default when the brief has none");
});

test("setBriefFacts: replace in place, rename aliases, insert, remove — prose untouched", () => {
  let t = setBriefFacts(BRIEF, {
    persona: "Platform engineers",
    title: "Honest keyboards",
    stance: "evaluator",
    extraUrls: "https://k.test/admin",
  });
  assert.match(t, /- \*\*Persona:\*\* Platform engineers/);
  assert.doesNotMatch(t, /Audience/, "alias renamed to the current label");
  assert.match(t, /- \*\*Stance:\*\* evaluator/);
  assert.match(t, /- \*\*Title:\*\* Honest keyboards\n/);
  assert.ok(
    t.indexOf("**Title:**") < t.indexOf("## Background"),
    "inserted inside the field block",
  );
  assert.match(t, /## Background\n\nFree text\.\n$/);
  t = setBriefFacts(t, { title: "" });
  assert.doesNotMatch(t, /\*\*Title:\*\*/, "empty value removes the line");
  assert.throws(() => setBriefFacts(t, { colour: "red" }), /unknown brief field "colour"/);
});

/** A project with two takes (same error in both), a fallback, dead time, a resume, a discovery audit and a long timeline. */
function fixture() {
  const p = ensureProject(root, { project: "kc", appName: "KeyCraft", appUrl: "https://k.test" });
  const dir = p.dir;
  fs.writeFileSync(path.join(dir, "brief.md"), BRIEF);
  for (const [n, resumed] of [
    [1, false],
    [2, true],
  ] as const) {
    const t = path.join(dir, "takes", `take-00${n}`);
    fs.mkdirSync(path.join(t, "analysis"), { recursive: true });
    fs.writeFileSync(
      path.join(t, "take.json"),
      JSON.stringify({
        take: `take-00${n}`,
        storyboardVersion: 1,
        status: "ok",
        startedAt: `2026-10-1${n}T10:00:00Z`,
        segments: resumed
          ? [{ start: 0 }, { start: 40000, resumedAfter: "scene 03 failed: target not found" }]
          : [{ start: 0 }],
      }),
    );
    fs.writeFileSync(
      path.join(t, "analysis", "analysis.json"),
      JSON.stringify({
        scenes: [
          {
            id: "02-search",
            alerts: [
              { t: 12000 + n, text: "Couldn't load results", level: "error" },
              { t: 13000, text: "Saved", level: "info" },
            ],
            typed: [
              {
                t: 9000,
                text: "wireless keyboard",
                improvised: true,
                source: n === 2 ? "fallback" : "model",
              },
            ],
            idle: [
              { start: 20000, end: 27500, source: "observer" },
              { start: 30000, end: 31000, source: "observer" },
            ],
          },
        ],
      }),
    );
  }
  const disc = path.join(appDirOf(dir, "keycraft"), "discovery", "20261013-153705");
  fs.mkdirSync(disc, { recursive: true });
  fs.writeFileSync(
    path.join(disc, "audit.jsonl"),
    [
      {
        at: "2000-01-01T00:00:00Z",
        action: "click",
        target: 'button "Old"',
        level: "blocked",
        reason: "before the project",
        page: "https://k.test/",
      },
      {
        at: "2099-01-01T00:00:00Z",
        action: "click",
        target: 'button "Proceed to Checkout"',
        level: "blocked",
        reason: "denylisted",
        page: "https://k.test/cart",
      },
      {
        at: "2099-01-01T00:00:01Z",
        action: "click",
        target: 'button "Add to Cart"',
        level: "mutating",
        page: "https://k.test/p/1",
      },
      {
        at: "2099-01-01T00:00:02Z",
        action: "click",
        target: 'button "Add to Cart"',
        level: "mutating",
        page: "https://k.test/p/2",
      },
      {
        at: "2099-01-01T00:00:03Z",
        action: "click",
        target: 'link "Docs"',
        level: "safe",
        page: "https://k.test/",
      },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n"),
  );
  fs.mkdirSync(path.join(dir, "edit"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "edit", "timeline.v1.json"),
    JSON.stringify({
      full: [{ type: "card", durationMs: 8000 }],
      scenes: [{ durationMs: 300000 }],
    }),
  );
  return p;
}

test("findings: engine signals deduped across takes, discovery since project creation, length vs target, agent findings and marks", () => {
  const p = fixture();
  const opts = { appDir: appDirOf(p.dir, "keycraft"), since: p.state.createdAt };
  const f = recordFinding(p.dir, {
    stage: "discovery",
    kind: "weakness",
    text: "Ratings change on every reload",
    evidence: [{ type: "screen", id: "20261013-153705/s014" }],
  });
  assert.equal(f.id, "f-0001");
  assert.throws(
    () => recordFinding(p.dir, { stage: "discovery", kind: "nope" as never, text: "x" }),
    /unknown finding kind/,
  );
  const list = listFindings(p.dir, opts);
  const by = (kind: string) => list.filter((x) => x.kind === kind);
  assert.equal(by("error").length, 1, "the same error in two takes is one finding");
  assert.equal(by("error")[0]?.evidence.length, 2, "…with both takes as evidence");
  assert.equal(by("fallback").length, 1);
  assert.equal(by("retry").length, 1);
  assert.match(by("retry")[0]?.text ?? "", /scene 03 failed/);
  assert.equal(by("dead-time").length, 1, "only idle ranges ≥ 5 s, deduped");
  assert.deepEqual(
    by("blocked").map((x) => x.text),
    ['blocked: click button "Proceed to Checkout" — denylisted'],
    "older sessions are excluded",
  );
  assert.equal(by("state-change").length, 1);
  assert.equal(by("state-change")[0]?.evidence.length, 2);
  assert.equal(by("length").length, 1);
  assert.match(by("length")[0]?.text ?? "", /308 s, the target is 3–4 min/);
  assert.match(by("length")[0]?.suggestion ?? "", /target length/);
  assert.ok(
    list.every((x) => x.state === "auto"),
    "auto by default",
  );

  // Stable engine ids: marks stick across reads.
  const err = by("error")[0]?.id as string;
  assert.equal(listFindings(p.dir, opts).find((x) => x.kind === "error")?.id, err);
  markFinding(p.dir, err, "ignore", opts);
  markFinding(p.dir, "f-0001", "use", opts);
  assert.throws(() => markFinding(p.dir, "e-00000000", "use", opts), /no finding/);
  const marked = listFindings(p.dir, opts);
  assert.equal(marked.find((x) => x.id === err)?.state, "ignore");
  const text = formatFindings(marked);
  assert.match(text, /USE — must appear[\s\S]*f-0001/);
  assert.doesNotMatch(text, /Couldn't load results/, "ignored findings are left out");
  assert.match(text, /1 marked IGNORE/);
  assert.deepEqual(
    uncoveredUseFindings(marked, [{ id: "01-a" }]).map((x) => x.id),
    ["f-0001"],
  );
  assert.deepEqual(uncoveredUseFindings(marked, [{ id: "01-a", findings: ["f-0001"] }]), []);
});

test("storyboard scenes list covered findings; project context shows facts and findings; subtitle on the title card", () => {
  const sb = parseStoryboard(
    "version: 1\nstart_url: /\nscenes:\n  - id: 01-a\n    title: A\n    findings: [f-0001, e-1a2b3c4d]\n    steps:\n      - do: press\n        key: Enter\n",
    { version: 1 },
  );
  assert.deepEqual(sb.scenes[0]?.findings, ["f-0001", "e-1a2b3c4d"]);
  assert.throws(
    () =>
      parseStoryboard(
        "version: 1\nstart_url: /\nscenes:\n  - id: 01-a\n    title: A\n    findings: [nope]\n    steps:\n      - do: press\n        key: Enter\n",
        { version: 1 },
      ),
    /findings/,
  );

  const p = fixture();
  fs.writeFileSync(
    path.join(p.dir, "brief.md"),
    setBriefFacts(BRIEF, {
      depth: "poc",
      title: "Honest keyboards",
      subtitle: "What holds up, and what doesn't",
    }),
  );
  recordFinding(p.dir, { stage: "discovery", kind: "strength", text: "Typeahead under 100 ms" });
  const ctx = projectContext(p.dir, "kc");
  assert.match(
    ctx,
    /## Project facts\ntitle: Honest keyboards \/ subtitle: What holds up, and what doesn't · persona: Developers who evaluate test targets · depth: poc/,
  );
  assert.match(ctx, /stance: evaluator \(depth default\)/);
  assert.match(ctx, /## Findings[\s\S]*Typeahead under 100 ms/);

  const cfg = { ...resolveConfig({ env: {}, readFile: () => undefined }), root };
  const info = titleInfoFor(p.dir, cfg);
  assert.equal(info.title, "Honest keyboards");
  assert.equal(info.subtitle, "What holds up, and what doesn't");
});

function runtime() {
  return new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(root, "none.json") } }),
    root,
    panelPort: 0,
  }));
}

test("panel routes: project facts (two-phase brief version), brief diff, context, input marks, findings + marks", async () => {
  const p = fixture();
  const rt = runtime();
  const told: string[] = [];
  (rt as unknown as { tellAgent: (t: string) => void }).tellAgent = (t) => told.push(t);
  rt.setActiveProject("kc");
  const panel = await rt.ensurePanel();
  const base = `http://127.0.0.1:${panel.port}`;
  const auth = { authorization: `Bearer ${panel.token}` };
  const get = async (n: string) =>
    (await (await fetch(`${base}/api/${n}`, { headers: auth })).json()) as Record<string, unknown>;
  const post = async (n: string, body: unknown) => {
    const r = await fetch(`${base}/api/${n}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
  try {
    const proj = (await get("project")) as {
      facts: Record<string, string>;
      effective: { length: string };
      login: { saved: boolean };
      briefVersions: number[];
    };
    assert.equal(proj.facts.persona, "Developers who evaluate test targets");
    assert.equal(proj.effective.length, "3–4 min");
    assert.equal(proj.login.saved, false);

    assert.equal((await post("project-facts", { patch: { depth: "enterprise" } })).status, 400);
    assert.equal((await post("project-facts", { patch: { url: "k.test" } })).status, 400);
    const plan = await post("project-facts", { patch: { depth: "poc", subtitle: "Honest notes" } });
    assert.match(String(plan.json.diff), /\+ - \*\*Depth:\*\* poc/);
    assert.equal(
      fs.readFileSync(path.join(p.dir, "brief.md"), "utf8"),
      BRIEF,
      "planning writes nothing",
    );
    const saved = await post("project-facts", {
      patch: { depth: "poc", subtitle: "Honest notes" },
      confirm: true,
    });
    assert.equal(saved.json.saved, true);
    assert.match(fs.readFileSync(path.join(p.dir, "brief.md"), "utf8"), /\*\*Depth:\*\* poc/);
    assert.deepEqual(listVersions(path.join(p.dir, "brief"), "v", ".md"), [saved.json.version]);
    assert.match(
      readInputs(p.dir).at(-1)?.text ?? "",
      /project facts edited in the panel \(depth, subtitle\)/,
    );
    assert.match(told.at(-1) ?? "", /edited the project facts/);

    const b = (await get(`brief?version=${saved.json.version}`)) as {
      text: string;
      diff: string | null;
    };
    assert.match(b.text, /Depth/);

    fs.mkdirSync(path.join(p.dir, "context"), { recursive: true });
    fs.writeFileSync(path.join(p.dir, "context", "notes.md"), "hello");
    const ctx = (await get("context")) as {
      inputs: { id: string }[];
      sources: { files: { path: string }[] };
      lineText: string;
    };
    assert.deepEqual(
      ctx.sources.files.map((f) => f.path),
      ["context/notes.md"],
    );
    const id = ctx.inputs[0]?.id as string;
    assert.equal(
      (await post("input-mark", { id, outdated: true })).status,
      400,
      "outdated needs a reason",
    );
    assert.equal(
      (
        (await post("input-mark", { id, outdated: true, reason: "changed" })).json.input as {
          outdated: unknown;
        }
      ).outdated !== undefined,
      true,
    );

    const fl = (await get("findings")) as {
      findings: { id: string; kind: string; state: string }[];
    };
    const err = fl.findings.find((f) => f.kind === "error")?.id as string;
    assert.equal((await post("finding-mark", { id: err, state: "maybe" })).status, 400);
    const mk = await post("finding-mark", { id: err, state: "use" });
    assert.equal((mk.json.finding as { state: string }).state, "use");
    assert.match(told.at(-1) ?? "", /marked finding e-[0-9a-f]+ .* as USE/);
  } finally {
    await rt.shutdown();
  }
});

test(
  "Project tab in the browser: first step, facts save via diff, finding marks, mark an input outdated",
  { skip: noBrowser },
  async () => {
    const p = fixture();
    recordFinding(p.dir, {
      stage: "discovery",
      kind: "weakness",
      text: "Ratings change on every reload",
    });
    const rt = runtime();
    rt.setActiveProject("kc");
    const panel = await rt.ensurePanel();
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const dlg = answerDialogs(page, { text: "not relevant anymore" });
      await page.goto(panel.url);
      // the Project screen opens on the summary; the form is a group chosen on purpose (D124)
      await page.waitForSelector(".project-summary");
      assert.equal(
        await page.locator(".fact-groups").count(),
        0,
        "the form is closed until chosen",
      );
      await page.locator(".subtabs .ds-chip", { hasText: "Brief" }).click();
      await page.waitForSelector(".fact-groups");
      assert.equal(
        (await page.locator("header.top > a.ds-step").first().textContent())?.trim(),
        "Project",
        "Project comes first, before the production stages",
      );
      assert.match(
        await page.evaluate("location.hash"),
        /^#\/project/,
        "a new project starts at Project",
      );
      assert.deepEqual(await page.locator(".fact-group legend").allTextContents(), [
        "Title card",
        "Audience & length",
        "App & access",
        "Goal / key message",
      ]);
      await page.locator(".ds-seg button", { hasText: "sales" }).click();
      assert.match(
        (await page.locator(".ds-seg button", { hasText: "default" }).getAttribute("title")) ?? "",
        /champion/,
        "stance default follows depth",
      );
      await page
        .locator(".field:has(.field-label:text-is('Title')) input")
        .fill("Keyboards that sell");
      assert.equal(
        await page.locator(".tp-title").textContent(),
        "Keyboards that sell",
        "live title-card preview",
      );
      await page.locator(".length-picker .ds-chip", { hasText: /^1 min–1:30$/ }).click();
      await page.locator(".length-picker .sliders input").nth(1).fill("1800");
      assert.match(
        (await page.locator(".length-picker small").textContent()) ?? "",
        /target 1 min–30 min/,
        "max goes up to 30 min",
      );
      assert.equal(
        await page.locator(".length-picker .ds-chip", { hasText: /^15 min–30 min$/ }).count(),
        1,
      );
      await page.locator(".length-picker .sliders input").nth(1).fill("120");
      assert.match(
        (await page.locator(".length-picker small").textContent()) ?? "",
        /target 1 min–2 min/,
      );
      await page.locator(".url-add input").fill("https://k.test/admin");
      await page.locator(".url-add button").click();
      assert.equal(await page.locator(".url-list li input").count(), 1);
      await page
        .locator(".fact-group.goal textarea")
        .fill("KeyCraft's cart is solid, its data is not");
      await page.getByRole("button", { name: "Save facts" }).click();
      await page.waitForTimeout(700);
      const brief = fs.readFileSync(path.join(p.dir, "brief.md"), "utf8");
      assert.match(brief, /\*\*Depth:\*\* sales/);
      assert.match(brief, /\*\*Title:\*\* Keyboards that sell/);
      assert.match(brief, /\*\*Target length:\*\* 1–2 min/);
      assert.match(brief, /\*\*Extra URLs:\*\* https:\/\/k\.test\/admin/);
      assert.match(brief, /\*\*Goal \/ key message:\*\* KeyCraft's cart is solid, its data is not/);

      await page.locator(".subtabs .ds-chip", { hasText: "Findings" }).click();
      await page.waitForSelector("li.finding");
      await page
        .locator("li.finding", { hasText: "Ratings change" })
        .getByRole("button", { name: "use" })
        .click();
      await page.waitForTimeout(500);
      const st = listFindings(p.dir, { appDir: appDirOf(p.dir, "keycraft") }).find(
        (f) => f.id === "f-0001",
      );
      assert.equal(st?.state, "use");

      await page.locator(".subtabs .ds-chip", { hasText: "Project history" }).click();
      await page.waitForSelector("ul.inputs li");
      await page
        .locator("ul.inputs li")
        .first()
        .getByRole("button", { name: "mark outdated" })
        .click();
      await page.waitForTimeout(500);
      assert.equal(
        readInputs(p.dir, { includeOutdated: true }).at(-1)?.outdated?.reason,
        "not relevant anymore",
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await rt.shutdown();
    }
  },
);
