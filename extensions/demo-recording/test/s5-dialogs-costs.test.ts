/**
 * S5 part 13 — in-panel dialogs and cost warnings (D91–D97): the cost-class table
 * covers every panel route, `POST /api/estimate` is a free dry run with exact numbers,
 * `ask()` behaves (Escape, Enter, danger focus, focus trap, skip), errors are toasts,
 * the three blocking checks (new take, designer run, voice) ask first, turn buttons
 * carry a hint — and no native alert/confirm/prompt is left in the panel.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { BLOCKING, ROUTE_COST, SKIPPABLE, estimate } from "../src/panel/cost.ts";
import { Runtime } from "../src/runtime.ts";
import { writeStoryboard } from "../src/storyboard/store.ts";
import { ensureProject } from "../src/workdir/layout.ts";
import { acceptTake, approve } from "../src/workdir/state.ts";
import { makeProject } from "./helpers/annotation-project.ts";
import { GOOD, fake } from "./helpers/designer-fixture.ts";

const PUBLIC = path.join(import.meta.dirname, "..", "src", "panel", "public");

async function chromium() {
  try {
    const pw = await import("playwright");
    return fs.existsSync(pw.chromium.executablePath()) ? pw.chromium : undefined;
  } catch {
    return undefined;
  }
}
const browserType = await chromium();

const STORYBOARD = `version: 1
app: x
start_url: /
scenes:
  - id: 01-dash
    title: Dashboard
    steps:
      - { do: hover, target: { css: '#kpi' }, mark: m1, dwell: 1s }
      - { do: hover, target: { css: '#row' }, mark: m2, dwell: 1s, emphasis: the EMEA row is the story }
      - { do: improvise, kind: type, target: { role: textbox, name: Ask }, prompt: ask why, max_chars: 40, fallback: "Why?" }
`;

/** A project with an accepted storyboard / take / voice-over and an edit; the Director's model is bound. */
function setup(designer?: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-cost-"));
  const cfgFile = path.join(root, "config.json");
  fs.writeFileSync(
    cfgFile,
    JSON.stringify(designer ? { roles: { annotationDesigner: { model: designer } } } : {}),
  );
  const sent: string[] = [];
  const told: string[] = [];
  const rt = new Runtime(
    () => ({ ...resolveConfig({ env: { DEMO_REC_CONFIG: cfgFile } }), root, panelPort: 0 }),
    {
      sendUserMessage: (t) => sent.push(t),
      sendMessage: (m) => told.push(m.content),
    },
  );
  const p = ensureProject(root, { project: "p", appName: "Acme", appUrl: "https://a.test" });
  fs.cpSync(makeProject(), p.dir, { recursive: true });
  fs.writeFileSync(path.join(p.dir, "storyboard", "v1.yaml"), STORYBOARD);
  const takeFile = path.join(p.dir, "takes", "take-001", "take.json");
  fs.writeFileSync(
    takeFile,
    JSON.stringify({
      ...JSON.parse(fs.readFileSync(takeFile, "utf8")),
      status: "ok",
      durationMs: 26_000,
    }),
  );
  approve(p.dir, "storyboard", 1);
  acceptTake(p.dir, "take-001");
  approve(p.dir, "vo", 1);
  rt.setActiveProject("p");
  rt.bindSessionModel({ provider: "anthropic", id: "claude-opus-4-5" });
  // pi's registry, as far as the panel needs it: haiku has credentials, gpt-5.4-mini doesn't
  const f = fake(
    [JSON.stringify(GOOD)],
    ["anthropic/claude-haiku-4-5", "openai/gpt-5.4-mini", "a/one"],
  );
  rt.bindModels({
    ...f.access,
    find: (provider: string, id: string) => f.access.find(provider, id),
    hasConfiguredAuth: (m: { provider: string }) => m.provider !== "openai",
  });
  return { root, rt, p, sent, told, calls: f.calls };
}

test("every panel POST route has a cost class, and the table has no stale entries", () => {
  const rt = new Runtime();
  const routes = Object.keys(rt.routeTables().post).sort();
  const classes = Object.keys(ROUTE_COST).sort();
  assert.deepEqual(
    routes.filter((r) => !classes.includes(r)),
    [],
    "routes without a cost class — add them to ROUTE_COST in src/panel/cost.ts",
  );
  assert.deepEqual(
    classes.filter((c) => !routes.includes(c)),
    [],
    "cost classes without a route",
  );
  const valid = new Set(["none", "local", "turn", "tts", "take", "designer"]);
  for (const [r, cs] of Object.entries(ROUTE_COST)) {
    assert.ok(cs.length && cs.every((c) => valid.has(c)), r);
  }
  // the ones that matter: money and long jobs block (D91), TTS never skips (D95)
  assert.deepEqual(ROUTE_COST["vo-generate"], ["tts"]);
  assert.ok(ROUTE_COST.rerecord?.includes("take") && ROUTE_COST.rerecord.includes("turn"));
  assert.ok(ROUTE_COST["annotations-resuggest"]?.includes("designer"));
  for (const r of ["approve", "review-submit", "vo-direction"])
    assert.ok(ROUTE_COST[r]?.includes("turn"), r);
  assert.deepEqual([...BLOCKING].sort(), ["designer", "take", "tts"]);
  assert.deepEqual([...SKIPPABLE].sort(), ["designer", "take"]);
});

test("estimate: a new take — improvise steps, model status, the last take's length; the Director's turn", async () => {
  const { rt, root } = setup();
  try {
    const e = await estimate(rt, "rerecord", {});
    assert.deepEqual([e.blocking, e.skippable, e.classes], [true, true, ["turn", "take"]]);
    const facts = Object.fromEntries(e.facts);
    assert.equal(facts.Storyboard, "v1 · 1 scene(s)");
    assert.equal(facts.Recording, "about 26 s (like take-001), headless");
    assert.equal(
      facts["Improvised inputs"],
      "1 step(s) on anthropic/claude-haiku-4-5 → openai/gpt-5.4-mini ✖",
    );
    assert.match(facts["The Director"] ?? "", /an agent turn on anthropic\/claude-opus-4-5/);
    assert.equal(e.warnings.length, 1);
    assert.match(
      e.warnings[0] ?? "",
      /^openai\/gpt-5\.4-mini: no credentials for provider "openai".*its steps would use the next model, or type their fallback text/,
    );
  } finally {
    await rt.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("estimate: designer run (tokens, models) or an agent turn; turns only get a hint; local and state routes nothing", async () => {
  const withRole = setup(["a/one", "gone/model"]);
  const without = setup();
  try {
    const d = await estimate(withRole.rt, "annotations-resuggest", {
      version: null,
      instructions: "calmer",
    });
    assert.deepEqual([d.blocking, d.skippable, d.classes], [true, true, ["designer"]]);
    const f = Object.fromEntries(d.facts);
    assert.equal(f.Models, "a/one → gone/model ✖");
    assert.match(f.Input ?? "", /^≈ [\d,]+ tokens in, one call \(\+ at most one repair call\)$/);
    assert.equal(f["No agent turn"], "the Director only gets a quiet note");
    assert.match(
      d.warnings.join("\n"),
      /gone\/model: not in pi's model list — the agent turn takes over if every model fails/,
    );
    // the pack size follows the instructions and the kept items
    const longer = await estimate(withRole.rt, "annotations-resuggest", {
      instructions: "x".repeat(4000),
    });
    const tokens = (s: string) => Number(/≈ ([\d,]+)/.exec(s)?.[1]?.replace(/,/g, ""));
    assert.ok(
      tokens(Object.fromEntries(longer.facts).Input as string) > tokens(f.Input as string) + 900,
    );

    const t = await estimate(without.rt, "annotations-resuggest", {});
    assert.deepEqual(
      [t.blocking, t.classes, t.what],
      [false, ["turn"], "Starts the Director on anthropic/claude-opus-4-5"],
    );
    for (const a of ["approve", "review-submit", "vo-direction"]) {
      const e = await estimate(without.rt, a, {});
      assert.deepEqual([e.blocking, e.classes, e.facts], [false, ["turn"], []], a);
    }
    for (const a of ["render", "config-set", "finding-mark"]) {
      const e = await estimate(without.rt, a, {});
      assert.deepEqual([e.blocking, e.what], [false, ""], a);
    }
    await assert.rejects(estimate(without.rt, "nope", {}), /unknown action "nope"/);
    // a voice-over that isn't accepted can't be generated, and it says so before any estimate
    await assert.rejects(
      estimate(without.rt, "vo-generate", { version: 7 }),
      /not accepted|no accepted|does not exist|missing/,
    );
  } finally {
    for (const x of [withRole, without]) {
      await x.rt.shutdown();
      fs.rmSync(x.root, { recursive: true, force: true });
    }
  }
});

test("no native alert/confirm/prompt is left in the panel scripts", () => {
  const offenders: string[] = [];
  for (const f of fs.readdirSync(PUBLIC).filter((x) => x.endsWith(".js"))) {
    fs.readFileSync(path.join(PUBLIC, f), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (/(?<![.\w$])(alert|confirm|prompt)\(/.test(line))
          offenders.push(`${f}:${i + 1}  ${line.trim().slice(0, 80)}`);
      });
  }
  assert.deepEqual(offenders, []);
});

test(
  "ask(): Escape cancels, Enter confirms, danger starts on Cancel, the focus stays inside, skip, stacking, aria; toasts",
  { skip: !browserType && "needs Playwright Chromium", timeout: 90_000 },
  async () => {
    const { rt, root } = setup();
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("dialog", (d) => {
        errors.push(`native ${d.type()}: ${d.message()}`);
        void d.dismiss();
      });
      await page.goto(panel.url);
      await page.waitForSelector("nav.steps");
      await page.evaluate(`(async () => { window.__d = await import("/dialog.js"); })()`);
      // `fire` starts something without waiting for its promise; `run` reads a value (awaiting a promise)
      const fire = (code: string) => page.evaluate(`(() => { ${code}; })()`);
      const run = (code: string) => page.evaluate(code);
      const active = () => page.evaluate<string>(`document.activeElement?.textContent ?? ""`);

      // Escape cancels → null; focus returns to the opener
      await page.locator("nav.steps a").first().focus();
      await fire(
        `window.__p = window.__d.ask({ title: "Plain", text: "hello\\n\\nsecond paragraph", confirmLabel: "Go" })`,
      );
      await page.waitForSelector(".dialog");
      assert.equal(await page.locator(".dialog h2").innerText(), "Plain");
      assert.equal(await page.locator(".dialog p").count(), 2, "paragraphs");
      assert.equal(await active(), "Go", "a normal dialog starts on Confirm");
      assert.equal(await page.locator(".dialog").getAttribute("role"), "dialog");
      assert.equal(await page.locator(".dialog").getAttribute("aria-modal"), "true");
      const labelled = await page.locator(".dialog").getAttribute("aria-labelledby");
      assert.equal(await page.locator(`#${labelled}`).innerText(), "Plain");
      await page.keyboard.press("Escape");
      assert.equal(await run("window.__p"), null, "cancelled → null");
      assert.equal(await page.locator(".dialog").count(), 0);
      assert.match(await active(), /Storyboard/, "focus returns to where it was");

      // Enter on a normal dialog (focus in the text field) confirms with the trimmed value
      await fire(
        `window.__p = window.__d.ask({ title: "Name", input: { label: "Name", required: true, value: "" }, confirmLabel: "Save" })`,
      );
      await page.waitForSelector(".dialog input");
      assert.equal(
        await page.locator("[data-confirm]").isDisabled(),
        true,
        "required field empty → Confirm disabled",
      );
      await page.keyboard.type("  copy-1 ");
      assert.equal(await page.locator("[data-confirm]").isDisabled(), false);
      await page.keyboard.press("Enter");
      assert.deepEqual(await run("window.__p"), { value: "copy-1", skip: false });

      // a danger dialog starts on Cancel, announces itself, and Enter doesn't confirm it
      await fire(
        `window.__p = window.__d.ask({ title: "Delete?", text: "gone", danger: true, confirmLabel: "Delete" })`,
      );
      await page.waitForSelector(".dialog.danger");
      assert.equal(await page.locator(".dialog").getAttribute("role"), "alertdialog");
      assert.equal(await active(), "Cancel", "danger: the focus starts on Cancel");
      await page.keyboard.press("Enter"); // activates Cancel (the focused button)
      assert.equal(await run("window.__p"), null);

      // Tab stays inside the dialog (wraps both ways)
      await fire(
        `window.__p = window.__d.ask({ title: "Trap", text: "x", confirmLabel: "Yes", cancelLabel: "No" })`,
      );
      await page.waitForSelector(".dialog");
      assert.equal(await active(), "Yes");
      await page.keyboard.press("Tab");
      assert.notEqual(
        await page.evaluate(`document.activeElement.closest(".dialog") !== null`),
        false,
        "still inside after Tab",
      );
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      assert.equal(
        await page.evaluate(`document.activeElement.closest(".dialog") !== null`),
        true,
        "wrapped, not left",
      );
      await page.keyboard.press("Shift+Tab");
      assert.equal(await page.evaluate(`document.activeElement.closest(".dialog") !== null`), true);
      await page.keyboard.press("Escape");
      await run("window.__p");

      // "don't ask again this session": remembered, then answered without a dialog; cleared again
      await fire(
        `sessionStorage.clear(); window.__p = window.__d.ask({ title: "Skippable", skipKey: "k1" })`,
      );
      await page.waitForSelector(".dlg-skip");
      await page.getByLabel("Don't ask again this session").check();
      await page.locator("[data-confirm]").click();
      assert.deepEqual(await run("window.__p"), { skip: true });
      assert.deepEqual(await run(`window.__d.ask({ title: "Skippable", skipKey: "k1" })`), {
        skipped: true,
      });
      assert.equal(await page.locator(".dialog").count(), 0, "no dialog the second time");
      await run("window.__d.clearSkips()");
      await fire(`window.__p = window.__d.ask({ title: "Skippable", skipKey: "k1" })`);
      await page.waitForSelector(".dialog");
      await page.keyboard.press("Escape");
      await run("window.__p");

      // stacking: Escape closes only the top dialog
      await fire(
        `window.__a = window.__d.ask({ title: "Below" }); window.__b = window.__d.ask({ title: "Above" })`,
      );
      await page.waitForFunction(`document.querySelectorAll(".dialog").length === 2`);
      await page.keyboard.press("Escape");
      assert.equal(await run("window.__b"), null);
      assert.equal(await page.locator(".dialog").count(), 1);
      assert.equal(await page.locator(".dialog h2").innerText(), "Below");
      await page.keyboard.press("Escape");
      await run("window.__a");

      // facts, a list, a diff and warnings render; the diff marks + and −
      await fire(
        `window.__p = window.__d.ask({ title: "Rich", facts: [["Voice", "say"], ["Cost", "free"]], list: { title: "Orphaned:", items: ["voice-over v1", "annotations v2"] }, diff: "-old\\n+new\\n same", warnings: ["careful"] })`,
      );
      await page.waitForSelector(".dlg-facts");
      assert.deepEqual(await page.locator(".dlg-facts dt").allTextContents(), ["Voice", "Cost"]);
      assert.equal(await page.locator(".dlg-list li").count(), 2);
      assert.equal(await page.locator(".dlg-diff .d-add").innerText(), "+new");
      assert.equal(await page.locator(".dlg-diff .d-rem").innerText(), "-old");
      assert.match(await page.locator(".dlg-warn").innerText(), /careful/);
      await page.keyboard.press("Escape");
      await run("window.__p");

      // errors: a toast that doesn't block, repeats count up, stays until dismissed; info goes by itself
      await run(`window.__d.errorToast(new Error("boom"), "render")`);
      await run(`window.__d.errorToast(new Error("boom"), "render")`);
      await page.waitForSelector(".toast.error");
      assert.equal(await page.locator(".toast.error").count(), 1, "the same error is one toast");
      assert.match(await page.locator(".toast.error").innerText(), /render: boom\s*×2/);
      assert.equal(await page.locator(".toast.error").getAttribute("role"), "alert");
      assert.equal(await page.getByRole("button", { name: "Copy" }).count(), 1);
      assert.equal(await page.locator(".dialog").count(), 0, "a toast is not a dialog");
      await run(`window.__d.toast("saved", { kind: "info", ms: 250 })`);
      await page.waitForSelector(".toast.info");
      await page.waitForFunction(
        `document.querySelectorAll(".toast.info").length === 0`,
        undefined,
        { timeout: 4000 },
      );
      await page.getByRole("button", { name: "dismiss" }).click();
      assert.equal(await page.locator(".toast").count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await panel.close();
      await rt.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "the panel asks first for a new take and a designer run (skippable), shows a hint on turn buttons",
  { skip: !browserType && "needs Playwright Chromium", timeout: 120_000 },
  async () => {
    const { rt, root, p, sent, told } = setup(["a/one"]);
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("dialog", (d) => {
        errors.push(`native ${d.type()}`);
        void d.dismiss();
      });
      await page.goto(panel.url);
      await page.waitForSelector("nav.steps");

      // --- a new take: the dialog says what runs; Cancel starts nothing
      await page.locator("nav.steps a", { hasText: "Recording" }).click();
      const request = page.getByRole("button", { name: "Request a new take" });
      await request.waitFor();
      await request.click();
      const dlg = page.locator(".dialog");
      await dlg.waitFor();
      assert.equal(await dlg.locator("h2").innerText(), "Record a new take?");
      const text = await dlg.innerText();
      assert.match(text, /Storyboard\s+v1 · 1 scene\(s\)/);
      assert.match(text, /about 26 s \(like take-001\), headless/);
      assert.match(text, /1 step\(s\) on anthropic\/claude-haiku-4-5 → openai\/gpt-5\.4-mini ✖/);
      assert.match(text, /an agent turn on anthropic\/claude-opus-4-5/);
      assert.match(text, /openai\/gpt-5\.4-mini: no credentials for provider "openai"/);
      await dlg.locator("[data-cancel]").click();
      await page.waitForTimeout(400);
      assert.deepEqual(sent, [], "cancelled: the Director was not asked");
      // Confirm (and skip it for the session): the Director gets the request
      await request.click();
      await dlg.waitFor();
      await page.getByLabel("Don't ask again this session").check();
      await dlg.locator("[data-confirm]").click();
      await page.waitForFunction("true");
      await page.waitForTimeout(500);
      assert.equal(sent.length, 1);
      assert.match(sent[0] ?? "", /new take of storyboard v1/);
      // skipped now: one click goes straight through
      await request.click();
      await page.waitForTimeout(600);
      assert.equal(await page.locator(".dialog").count(), 0, 'no dialog after "don\'t ask again"');
      assert.equal(sent.length, 2);

      // --- the designer: a dialog with the model chain and the pack size; Cancel runs nothing
      await page.locator("nav.steps a", { hasText: "Annotations" }).click();
      const suggest = page.getByRole("button", { name: "Suggest annotations" }).last();
      await suggest.waitFor();
      assert.match(
        await page.locator(".resuggest .cost-hint").innerText(),
        /^a separate designer call · one$/,
      );
      await suggest.click();
      await dlg.waitFor();
      assert.equal(await dlg.locator("h2").innerText(), "Run the Annotation designer?");
      assert.match(await dlg.innerText(), /Models\s+a\/one/);
      assert.match(await dlg.innerText(), /Input\s+≈ [\d,]+ tokens in, one call/);
      assert.match(await dlg.innerText(), /No agent turn/);
      await dlg.locator("[data-cancel]").click();
      await page.waitForTimeout(400);
      assert.equal(rt.jobs.running("design"), undefined, "cancelled: no designer run");
      assert.equal(sent.length, 2);
      // Confirm: the engine job runs (no agent turn), the version appears
      await suggest.click();
      await dlg.waitFor();
      await dlg.locator("[data-confirm]").click();
      await page.waitForSelector(".ann-card", { timeout: 30_000 }).catch((e) => {
        throw new Error(
          `${e.message}\n${rt.bus
            .recent()
            .filter((x) => /^design|annotations/.test(x.type))
            .map(
              (x) =>
                `${x.type}: ${String(x.data?.message ?? "")} ${JSON.stringify(x.data?.error ?? "")}`,
            )
            .join("\n")}`,
        );
      });
      assert.equal(sent.length, 2, "no agent turn for the designer run");
      assert.ok(
        told.some((t) => /suggested by the separate Annotation designer \(a\/one\)/.test(t)),
      );
      // the turn buttons carry a visible hint (the Director's model, no price)
      const accept = page.getByRole("button", { name: /^Accept v/ });
      await accept.waitFor();
      assert.match(
        await page.locator(".version-actions .cost-hint").first().innerText(),
        /^starts the Director · claude-opus-4-5$/,
      );
      assert.equal(await page.locator(".dialog").count(), 0);

      // --- voice generation: the same dialog, but money can never be skipped for the session (D95)
      await page.route("**/api/estimate", (route) => {
        const body = JSON.parse(route.request().postData() ?? "{}");
        if (body.action !== "vo-generate") return route.continue();
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            action: "vo-generate",
            classes: ["tts"],
            blocking: true,
            skippable: false,
            title: "Generate voice & render · VO v1",
            confirmLabel: "Generate (≈ $0.41)",
            what: "",
            facts: [
              ["Sections", "5 to synthesize · 2 cached (free)"],
              ["Cost", "≈ $0.41"],
            ],
            warnings: [],
          }),
        });
      });
      const generated: unknown[] = [];
      await page.route("**/api/vo-generate", (route) => {
        generated.push(JSON.parse(route.request().postData() ?? "{}"));
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ job: "tts-1" }),
        });
      });
      const asked = page.evaluate(
        `import("/cost.js").then((c) => c.confirmCost("vo-generate", { version: 1 }))`,
      );
      await dlg.waitFor();
      assert.match(await dlg.innerText(), /Cost\s+≈ \$0\.41/);
      assert.equal(
        await page.getByLabel("Don't ask again this session").count(),
        0,
        "TTS never skips",
      );
      await dlg.locator("[data-confirm]").click();
      assert.equal(await asked, true);
      assert.deepEqual(generated, [], "asking is not generating");
      assert.deepEqual(errors, []);
      void p;
    } finally {
      await browser.close();
      await panel.close();
      await rt.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
