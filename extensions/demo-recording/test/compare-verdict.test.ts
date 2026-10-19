/**
 * Item 9b (D-R2-11): the Director's verdict on two versions. The tool refuses an answer that is not honest in a checkable way:
 * invented evidence, a better/worse verdict without a measured fact, no "against", a recommendation that contradicts the
 * verdict. One stored note per pair; asking again replaces it; nothing is spent and nothing is changed.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { compareVersions } from "../src/compare/facts.ts";
import {
  askVerdict,
  askedVerdict,
  cancelVerdict,
  listVerdicts,
  readVerdict,
  recordVerdict,
  verdictBrief,
  verdictProblems,
} from "../src/compare/verdict.ts";
import { resolveConfig } from "../src/config.ts";
import { compareMessage } from "../src/panel/compare-routes.ts";
import { Runtime } from "../src/runtime.ts";
import { registerCompareTool } from "../src/tools/compare.ts";
import { readState } from "../src/workdir/state.ts";
import { answerDialogs } from "./helpers/panel-dialogs.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

const good = {
  verdict: "better",
  headline: "v2 covers the whole story where v1 stopped at the dashboard",
  points: [
    { evidence: "fact:scenes", said: "three scenes instead of one" },
    { evidence: "scene:02-search", said: "the search scene is new and carries the main finding" },
  ],
  against:
    "v1 is shorter and has nothing to fix: more scenes means more to keep in sync with the narration",
  recommendation: {
    choice: "b",
    why: "it tells the whole story and the extra scenes are not padding",
  },
};

test("a good answer is stored for the pair that was asked; the facts it cites are the engine's", () => {
  const { dir } = seedPanelProject();
  const asked = askVerdict(dir, "storyboard", 1, 2, new Date("2026-10-19T10:00:00Z"));
  assert.deepEqual(
    [asked.id, asked.status, asked.askedAt],
    ["storyboard.v1-v2", "asked", "2026-10-19T10:00:00.000Z"],
  );
  assert.equal(askedVerdict(dir)?.id, "storyboard.v1-v2");
  const v = recordVerdict(dir, good, undefined, new Date("2026-10-19T10:05:00Z"));
  assert.equal(v.status, "answered");
  assert.deepEqual([v.verdict, v.recommendation?.choice, v.points?.length], ["better", "b", 2]);
  assert.equal(readVerdict(dir, "storyboard", 1, 2)?.answeredAt, "2026-10-19T10:05:00.000Z");
  assert.equal(askedVerdict(dir), undefined, "nothing is waiting any more");
  assert.deepEqual(
    listVerdicts(dir).map((x) => x.id),
    ["storyboard.v1-v2"],
  );
  assert.deepEqual(listVerdicts(dir, "vo"), []);
});

test("every rule refuses with a reason the Director can act on, all problems at once", () => {
  const { dir } = seedPanelProject();
  const c = compareVersions(dir, "storyboard", 1, 2);
  const probs = (patch: Record<string, unknown>) => verdictProblems(c, { ...good, ...patch });
  assert.deepEqual(probs({}), []);
  assert.match(
    probs({ verdict: "it depends" }).join("\n"),
    /verdict must be one of: better, worse, different, no meaningful change/,
  );
  assert.match(probs({ headline: "" }).join("\n"), /headline is required/);
  assert.match(probs({ headline: "x".repeat(141) }).join("\n"), /headline is 141 characters/);
  assert.match(probs({ points: [good.points[0]] }).join("\n"), /give 2 to 6 points \(you gave 1\)/);
  assert.match(
    probs({
      points: Array.from({ length: 7 }, (_, i) => ({ evidence: "fact:scenes", said: `p${i}` })),
    }).join("\n"),
    /give 2 to 6 points \(you gave 7\)/,
  );
  // invented evidence is refused and the valid ids are listed
  const bad = probs({
    points: [
      good.points[0],
      { evidence: "scene:99-invented", said: "a scene that does not exist" },
    ],
  }).join("\n");
  assert.match(
    bad,
    /point 2 cites "scene:99-invented", which is not in these facts. Cite one of: .*scene:02-search/,
  );
  assert.match(
    probs({ points: [good.points[0], { evidence: "fact:scenes", said: "same again" }] }).join("\n"),
    /at least 2 different pieces of evidence \(you cited 1\)/,
  );
  assert.match(
    probs({ points: [{ evidence: "fact:scenes", said: "" }, good.points[1]] }).join("\n"),
    /point 1 says nothing/,
  );
  // better and worse need a measured fact
  assert.match(
    probs({
      points: [
        { evidence: "scene:02-search", said: "new" },
        { evidence: "scene:03-compare", said: "new too" },
      ],
    }).join("\n"),
    /a "better" verdict must cite at least one measured fact/,
  );
  assert.deepEqual(
    probs({
      verdict: "different",
      recommendation: { choice: "both", why: "keep both" },
      points: [
        { evidence: "scene:02-search", said: "new" },
        { evidence: "scene:03-compare", said: "new too" },
      ],
    }),
    [],
    "different needs no fact",
  );
  // the anti-flattery rule
  assert.match(
    probs({ against: "" }).join("\n"),
    /against is required: the strongest argument against your own recommendation/,
  );
  assert.match(probs({ against: "no" }).join("\n"), /against is required/);
  assert.match(
    probs({ recommendation: { choice: "c", why: "x" } }).join("\n"),
    /recommendation.choice must be one of: a, b, both, neither/,
  );
  assert.match(
    probs({ recommendation: { choice: "b", why: "" } }).join("\n"),
    /recommendation.why is required/,
  );
  // the recommendation must not contradict the verdict
  assert.match(
    probs({ recommendation: { choice: "a", why: "keep the old" } }).join("\n"),
    /newer version is better but recommend not using it/,
  );
  assert.match(
    probs({ verdict: "worse", recommendation: { choice: "b", why: "use it" } }).join("\n"),
    /newer version is worse but recommend it/,
  );
  assert.deepEqual(
    probs({ verdict: "worse", recommendation: { choice: "a", why: "keep the old" } }),
    [],
  );
  assert.deepEqual(
    probs({
      verdict: "no meaningful change",
      recommendation: { choice: "neither", why: "nothing to choose" },
      points: [
        { evidence: "fact:scenes", said: "x" },
        { evidence: "fact:steps", said: "y" },
      ],
    }),
    [],
  );
  // several at once
  assert.ok(verdictProblems(c, {}).length >= 5, "an empty answer lists every missing part");
});

test("a refused answer stores nothing and the ask stays open; no ask means no answer; asking again replaces; cancel", () => {
  const { dir } = seedPanelProject();
  assert.throws(() => recordVerdict(dir, good), /no comparison is waiting for you/);
  askVerdict(dir, "storyboard", 1, 2);
  assert.throws(
    () => recordVerdict(dir, { ...good, against: "" }),
    /verdict not stored, fix these:\n- against is required/,
  );
  assert.equal(readVerdict(dir, "storyboard", 1, 2)?.status, "asked", "still waiting");
  recordVerdict(dir, good);
  assert.throws(
    () => recordVerdict(dir, good),
    /no comparison is waiting/,
    "an answer is not answered twice",
  );
  // asking again replaces the stored verdict
  const again = askVerdict(dir, "storyboard", 1, 2);
  assert.equal(again.status, "asked");
  assert.equal(
    readVerdict(dir, "storyboard", 1, 2)?.verdict,
    undefined,
    "the earlier verdict is gone",
  );
  assert.equal(cancelVerdict(dir, "storyboard", 1, 2).status, "cancelled");
  assert.throws(() => cancelVerdict(dir, "storyboard", 1, 2), /no ask waiting/);
  assert.throws(() => askVerdict(dir, "storyboard", 1, 1), /two different versions/);
  assert.throws(() => askVerdict(dir, "recording", 1, 2), /not available yet/);
  // a voice-over pair is a pair of its own
  askVerdict(dir, "vo", 1, 2);
  assert.deepEqual(
    listVerdicts(dir)
      .map((x) => x.id)
      .sort(),
    ["storyboard.v1-v2", "vo.v1-v2"],
  );
});

test("what the Director reads: the facts, the ids, the rules; and what it is told when you ask", () => {
  const { dir } = seedPanelProject();
  const ask = askVerdict(dir, "storyboard", 1, 2);
  const brief = verdictBrief(dir, ask);
  assert.match(brief, /# Compare storyboard v1 \(a, older\) with v2 \(b, newer\)/);
  assert.match(brief, /- fact:scenes · Scenes: 1 → 3 \(\+2\)/);
  assert.match(brief, /- scene:02-search · added · /);
  assert.match(brief, /against: the strongest argument AGAINST your own recommendation/);
  assert.match(brief, /Be honest, not kind/);
  assert.match(
    compareMessage("vo", 1, 2),
    /verdict on the voice-over: v2 \(newer\) compared with v1/,
  );
  assert.match(compareMessage("vo", 1, 2), /Do not use, approve or change any version/);
});

test("the tool: context, a refused answer, a stored answer with its event; it changes no version and no line", async () => {
  process.env.DEMO_REC_NO_OPEN = "1";
  const seed = seedPanelProject();
  const cfg = path.join(seed.root, "c.json");
  fs.writeFileSync(cfg, "{}");
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
    root: seed.root,
    panelPort: 0,
  }));
  rt.setActiveProject(seed.slug);
  const tools = new Map<
    string,
    { parameters: unknown; execute: (...a: unknown[]) => Promise<{ content: { text?: string }[] }> }
  >();
  registerCompareTool(
    { registerTool: (t: { name: string }) => tools.set(t.name, t as never) } as never,
    rt,
  );
  const tool = tools.get("demo_rec_compare");
  assert.ok(tool);
  const run = async (params: Record<string, unknown>) =>
    (await tool.execute("id", params, undefined, undefined, undefined)).content
      .map((c) => c.text ?? "")
      .join("\n");
  const line = JSON.stringify(readState(seed.dir)?.line);
  await assert.rejects(() => run({ action: "context" }), /no comparison is waiting/);
  askVerdict(seed.dir, "storyboard", 1, 2);
  assert.match(await run({ action: "context" }), /fact:scenes · Scenes: 1 → 3/);
  await assert.rejects(() => run({ action: "answer", ...good, against: "" }), /verdict not stored/);
  assert.match(
    await run({ action: "answer", ...good }),
    /Stored your verdict on v1 → v2: better\. .*you changed nothing/,
  );
  assert.equal(readVerdict(seed.dir, "storyboard", 1, 2)?.status, "answered");
  assert.equal(JSON.stringify(readState(seed.dir)?.line), line, "the production line is untouched");
  assert.ok(
    !JSON.stringify(Object.keys(tools.get("demo_rec_compare")?.parameters as object)).includes(
      "approve",
    ),
  );
  await rt.shutdown();
  fs.rmSync(seed.root, { recursive: true, force: true });
});

test("the routes: ask starts the Director with the rules and says so; the list; replacing; cancel; refusals", async () => {
  process.env.DEMO_REC_NO_OPEN = "1";
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
  const panel = await rt.ensurePanel();
  const base = `http://127.0.0.1:${panel.port}/api`;
  const auth = { authorization: `Bearer ${panel.token}` };
  const get = async (n: string) =>
    (await (await fetch(`${base}/${n}`, { headers: auth })).json()) as {
      verdicts: { id: string; status: string }[];
    };
  const post = async (n: string, body: unknown) => {
    const res = await fetch(`${base}/${n}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  try {
    assert.deepEqual((await get("compare-verdicts")).verdicts, []);
    const ask = await post("compare-ask", { stage: "storyboard", a: 1, b: 2 });
    assert.equal(ask.status, 200);
    assert.equal(told.length, 1);
    assert.match(told[0] ?? "", /honest verdict on the storyboard: v2 \(newer\) compared with v1/);
    assert.match(told[0] ?? "", /demo_rec_compare context/);
    assert.deepEqual(
      (await get("compare-verdicts")).verdicts.map((v) => [v.id, v.status]),
      [["storyboard.v1-v2", "asked"]],
    );
    assert.deepEqual((await get("compare-verdicts?stage=vo")).verdicts, []);
    // the Director answers (through the tool's function), the panel list shows it; asking again replaces
    recordVerdict(seed.dir, good);
    assert.equal((await get("compare-verdicts")).verdicts[0]?.status, "answered");
    await post("compare-ask", { stage: "storyboard", a: 1, b: 2 });
    assert.equal(told.length, 2);
    assert.equal(
      (await get("compare-verdicts")).verdicts[0]?.status,
      "asked",
      "replaced by the new ask",
    );
    const gone = await post("compare-cancel", { stage: "storyboard", a: 1, b: 2 });
    assert.equal(gone.status, 200);
    assert.equal((await get("compare-verdicts")).verdicts[0]?.status, "cancelled");
    assert.equal(
      (await post("compare-cancel", { stage: "storyboard", a: 1, b: 2 })).status,
      400,
      "nothing waiting",
    );
    assert.equal((await post("compare-ask", { stage: "storyboard", a: 1, b: 1 })).status, 400);
    assert.equal((await post("compare-ask", { stage: "recording", a: 1, b: 2 })).status, 400);
    assert.equal(told.length, 2, "a refused ask tells the Director nothing");
  } finally {
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
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
const skip = !browserType && "needs Playwright Chromium";

test(
  "in the browser: ask, wait, read the verdict with its evidence marked, jump to it, Use, ask again, give up, past comparisons",
  { skip, timeout: 120_000 },
  async () => {
    process.env.DEMO_REC_NO_OPEN = "1";
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
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    // what the tool does when the Director answers: store it and say so
    const directorAnswers = (patch: Record<string, unknown> = {}) => {
      const v = recordVerdict(seed.dir, { ...good, ...patch });
      rt.bus.publish(
        "compare.answered",
        {
          id: v.id,
          stage: v.stage,
          a: v.a,
          b: v.b,
          verdict: v.verdict,
          by: "agent",
          message: `verdict on storyboard v1 → v2: ${v.verdict}`,
        },
        seed.slug,
      );
    };
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
      const dlg = answerDialogs(page);
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${panel.url}#/storyboard/v2`);
      await page.waitForSelector("[data-act=advanced]");
      await page.click("[data-act=advanced]");
      assert.deepEqual(
        await page.locator(".ds-advanced li").allInnerTexts(),
        ["Compare two versions…"],
        "no past comparisons yet",
      );
      await page.click("[data-act=compare-open]");
      await page.waitForSelector("[data-verdict-state=none]");
      // the facts are free; the verdict is asked for
      assert.match(
        await page.locator(".ds-compare").innerText(),
        /Model tokens only: nothing is recorded, spoken or changed/,
      );
      assert.equal(told.length, 0, "opening the window starts nothing");
      await page.click("[data-act=ask-verdict]");
      await page.waitForSelector("[data-verdict-state=asked]");
      assert.match(
        await page.locator("[data-verdict-state=asked]").innerText(),
        /Waiting for the Director/,
      );
      assert.equal(told.length, 1);
      assert.match(told[0] ?? "", /honest verdict on the storyboard/);
      // the Director answers: the window shows it, marks what it cites
      directorAnswers();
      await page.waitForSelector(".ds-verdict");
      const card = await page.locator(".ds-verdict").innerText();
      assert.match(card, /BETTER|Better/);
      assert.match(card, /v2 covers the whole story where v1 stopped at the dashboard/);
      assert.match(card, /fact:scenes[\s\S]*three scenes instead of one/);
      assert.match(card, /Against this recommendation[\s\S]*v1 is shorter and has nothing to fix/);
      assert.match(card, /Recommendation: Use v2[\s\S]*it tells the whole story/);
      assert.equal(
        await page.locator("[data-fact=scenes]").getAttribute("data-cited"),
        "true",
        "the fact it cites is marked",
      );
      assert.equal(
        await page.locator("[data-change='scene:02-search']").getAttribute("data-cited"),
        "true",
      );
      assert.equal(
        await page.locator("[data-fact=steps]").getAttribute("data-cited"),
        null,
        "what it does not cite is not",
      );
      // an evidence chip jumps to it
      await page.click("[data-evidence='scene:02-search']");
      assert.equal(
        await page.locator("[data-change='scene:02-search']").getAttribute("data-flash"),
        "true",
      );
      // Use: the existing action (it asks for the version plan)
      const planned = page.waitForRequest((q) => q.url().includes("/api/version-plan"));
      await page.click("[data-act=use-recommended]");
      assert.match(
        (await planned).postData() ?? "",
        /"stage":"storyboard"[\s\S]*"version":2|"version":2[\s\S]*"stage":"storyboard"/,
      );
      await page.waitForTimeout(400);
      // ask again replaces it after asking
      const before = dlg.seen.length;
      await page.click("[data-act=ask-verdict]");
      await page.waitForSelector("[data-verdict-state=asked]");
      assert.match(dlg.seen.slice(before).join("\n"), /Replace the earlier verdict\?/);
      assert.equal(await page.locator(".ds-verdict").count(), 0, "the earlier verdict is gone");
      assert.equal(told.length, 2);
      // give up
      await page.click("[data-act=cancel-verdict]");
      await page.waitForSelector("[data-verdict-state=cancelled]");
      assert.match(
        await page.locator("[data-verdict-state=cancelled]").innerText(),
        /You gave up on the last ask/,
      );
      // answer once more, close, and find it under Past comparisons
      await page.click("[data-act=ask-verdict]");
      await page.waitForSelector("[data-verdict-state=asked]");
      directorAnswers({
        verdict: "worse",
        recommendation: { choice: "a", why: "keep the shorter one" },
        headline: "v2 is longer without being clearer",
      });
      await page.waitForSelector(".ds-verdict[data-verdict=worse]");
      assert.match(await page.locator(".ds-verdict").innerText(), /Worse|WORSE/);
      assert.match(await page.locator(".ds-verdict").innerText(), /Recommendation: Keep v1/);
      assert.equal(
        await page.locator("[data-act=use-recommended]").innerText(),
        "Use v1 for next steps",
      );
      await page.keyboard.press("Escape");
      await page.waitForSelector(".ds-compare", { state: "detached" });
      await page.click("[data-act=advanced]");
      assert.match(
        await page.locator(".ds-advanced").innerText(),
        /Past comparisons \(1\)[\s\S]*v1 → v2 · worse/i,
      );
      await page.click("[data-act=past-comparison]");
      await page.waitForSelector(".ds-verdict[data-verdict=worse]");
      assert.equal(await page.inputValue("#cmp-a"), "1");
      assert.equal(await page.inputValue("#cmp-b"), "2");
      // a pair nobody asked about has no verdict
      await page.click("[data-act=compare-swap]");
      await page.waitForSelector("[data-verdict-state=none]");
      dlg.stop();
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
