/**
 * S5 part 12 — the Annotation designer as a separate model run (D85–D90):
 * the system prompt comes from the skill (one source), answers are parsed and
 * checked, ONE repair round, a fallback chain, re-suggest with kept items, the
 * job + events + quiet note, the agent fallback, the panel route and the
 * doctor's cast. A fake model — no real call, no browser.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  DesignerFailed,
  PROMPT_SECTIONS,
  designerSystemPrompt,
  parseDesignerAnswer,
  runDesigner,
  skillSections,
} from "../src/annotations/designer-run.ts";
import { annotationVersions, readAnnotations } from "../src/annotations/file.ts";
import { defaultConfig, resolveConfig } from "../src/config.ts";
import { runDoctor } from "../src/doctor.ts";
import { annotationRoutes } from "../src/panel/annotation-routes.ts";
import type { ModelAccess, ModelLike } from "../src/recorder/improvise.ts";
import { Runtime } from "../src/runtime.ts";
import { startDesigner } from "../src/tools/designer.ts";
import { autoSuggestPending } from "../src/tools/edit.ts";
import { ensureProject } from "../src/workdir/layout.ts";
import { editDraft, saveDraft } from "./helpers/annotation-drafts.ts";
import { TIMELINE, makeProject } from "./helpers/annotation-project.ts";
import { GOOD, fake } from "./helpers/designer-fixture.ts";

const SKILL = path.join(import.meta.dirname, "..", "skills", "demo-annotations", "SKILL.md");

const run = (
  dir: string,
  access: ModelAccess,
  o: { models?: string[]; base?: number; instructions?: string } = {},
) =>
  runDesigner({
    projectDir: dir,
    timeline: TIMELINE,
    timelineVersion: 1,
    access,
    models: o.models ?? ["a/one"],
    ...(o.base !== undefined ? { base: o.base } : {}),
    ...(o.instructions ? { instructions: o.instructions } : {}),
  });

test("prompt: built from the skill file (one source) + the output format; a missing section is an error", () => {
  const sections = skillSections(fs.readFileSync(SKILL, "utf8"));
  for (const h of PROMPT_SECTIONS) assert.ok(sections.get(h)?.length, `the skill has "## ${h}"`);
  const prompt = designerSystemPrompt();
  for (const h of PROMPT_SECTIONS) assert.ok(prompt.includes(`## ${h}`), h);
  assert.ok(
    prompt.includes(sections.get("Writing rules")?.slice(0, 60) ?? "?"),
    "the skill's own words",
  );
  assert.match(prompt, /## Output format[\s\S]*ONE JSON array/);
  assert.doesNotMatch(prompt, /## Workflow|action=suggest/, "the tool workflow stays out");
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "skill-")), "SKILL.md");
  fs.writeFileSync(tmp, "## What to suggest\nx\n");
  assert.throws(() => designerSystemPrompt(tmp), /section "Writing rules" is missing/);
});

test("parse: fenced, wrapped in prose, an object with suggestions; bad elements are named; no JSON is an error", () => {
  const json = JSON.stringify(GOOD);
  assert.equal(parseDesignerAnswer(json).suggestions.length, 3);
  assert.equal(
    parseDesignerAnswer(`Here you go:\n\`\`\`json\n${json}\n\`\`\`\nDone.`).suggestions.length,
    3,
  );
  assert.equal(parseDesignerAnswer(`Sure! ${json} Hope that helps.`).suggestions.length, 3);
  assert.equal(parseDesignerAnswer(JSON.stringify({ suggestions: GOOD })).suggestions.length, 3);
  const bad = parseDesignerAnswer(
    JSON.stringify([
      GOOD[0],
      { type: "sparkle", scene: "x", anchor: { mark: "m" } },
      { type: "zoom" },
      { type: "zoom", scene: "s" },
      7,
    ]),
  );
  assert.equal(bad.suggestions.length, 1);
  assert.deepEqual(bad.problems, [
    'suggestions[1]: "type" must be one of zoom, highlight, spotlight, redact, callout, chapter',
    'suggestions[2]: "scene" is required',
    'suggestions[3]: "anchor" needs a mark, a word or sceneStart',
    "suggestions[4]: not an object",
  ]);
  assert.throws(() => parseDesignerAnswer("I think a zoom would be nice."), /not valid JSON/);
  assert.throws(() => parseDesignerAnswer('{"foo": 1}'), /must be a JSON array/);
});

test("run: one call, the pack and instructions in the user message, one stored version", async () => {
  const dir = makeProject();
  const { access, calls } = fake([JSON.stringify(GOOD)]);
  const r = await run(dir, access, { instructions: "calmer please — no spotlights" });
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.system ?? "", /Annotation designer/);
  assert.match(calls[0]?.user ?? "", /Annotation input pack — edit v1 \(take-001, VO v1\)/);
  assert.match(calls[0]?.user ?? "", /calmer please — no spotlights/);
  assert.deepEqual([r.model, r.repaired, r.suggested, r.report.added], ["a/one", false, 3, 3]);
  assert.deepEqual(annotationVersions(dir), [1]);
  const f = readAnnotations(dir, 1);
  assert.equal(f?.by, "annotation-designer (separate run)");
  assert.equal(f?.instructions, "calmer please — no spotlights");
  assert.ok(f?.items.some((i) => i.id === "zoom-row" && i.weight));
  assert.ok(
    f?.items.some((i) => i.enabled),
    "the engine pre-enables the best half",
  );
});

test("repair: invalid and unplaceable items go back ONCE; the dry run stores nothing extra", async () => {
  const dir = makeProject();
  const first = [
    GOOD[1],
    { ...GOOD[0], id: "zoom-ghost", scene: "99-ghost" },
    { type: "sparkle", scene: "01-dash", anchor: { mark: "m1" } },
  ];
  const { access, calls } = fake([JSON.stringify(first), JSON.stringify([GOOD[1], GOOD[0]])]);
  const r = await run(dir, access);
  assert.equal(calls.length, 2);
  assert.match(calls[1]?.user ?? "", /Your previous answer:/);
  assert.match(calls[1]?.user ?? "", /suggestions\[2\]: "type" must be one of/);
  assert.match(
    calls[1]?.user ?? "",
    /zoom-ghost: not placed — scene "99-ghost" is not in the edit/,
  );
  assert.deepEqual([r.repaired, r.report.added, r.report.dropped.length], [true, 2, 0]);
  assert.deepEqual(annotationVersions(dir), [1], "exactly one version, not one per attempt");
});

test("repair: invalid JSON first, a good answer second; two bad answers move to the next model", async () => {
  const dir = makeProject();
  const a = fake(["Sure, I'd zoom in on the EMEA row.", JSON.stringify(GOOD)]);
  const r = await run(dir, a.access);
  assert.deepEqual([a.calls.length, r.repaired, r.report.added], [2, true, 3]);

  const dir2 = makeProject();
  const b = fake(["no json", "still no json", JSON.stringify(GOOD)]);
  const r2 = await run(dir2, b.access, { models: ["a/one", "b/two"] });
  assert.deepEqual(
    b.calls.map((c) => c.spec),
    ["a/one", "a/one", "b/two"],
  );
  assert.deepEqual([r2.model, r2.tried], ["b/two", ["a/one", "b/two"]]);
  assert.deepEqual(annotationVersions(dir2), [1]);
});

test("failure: every model fails → DesignerFailed with each reason, and no version is stored", async () => {
  const dir = makeProject();
  const { access } = fake([new Error("529 overloaded")]);
  await assert.rejects(
    run(dir, access, { models: ["a/one", "gone/model", "b/two"] }),
    (e: unknown) => {
      assert.ok(e instanceof DesignerFailed);
      assert.deepEqual(e.errors, [
        "a/one: 529 overloaded",
        "gone/model: not available in pi",
        "b/two: 529 overloaded",
      ]);
      return true;
    },
  );
  assert.deepEqual(annotationVersions(dir), []);
  // an answer where nothing can be placed is a failure too, not an empty version
  const b = fake([JSON.stringify([{ ...GOOD[0], scene: "99-ghost" }])]);
  await assert.rejects(
    run(makeProject(), b.access),
    /none of the suggestions could be placed|no usable suggestions/,
  );
});

test("re-suggest: the user's touched items are kept, the base and instructions are recorded", async () => {
  const dir = makeProject();
  await run(dir, fake([JSON.stringify(GOOD)]).access);
  const was = readAnnotations(dir, 1)?.items.find((i) => i.id === "hl-kpi")?.enabled ?? false;
  editDraft(dir, 1, { op: "toggle", id: "hl-kpi", enabled: !was });
  saveDraft(dir);
  const { access, calls } = fake([JSON.stringify([GOOD[0], GOOD[2], { ...GOOD[1], value: 4 }])]);
  const r = await run(dir, access, { base: 2, instructions: "fewer callouts" });
  assert.match(calls[0]?.user ?? "", /fewer callouts/);
  assert.deepEqual(r.report.kept, ["hl-kpi"]);
  assert.equal(r.report.version, 3);
  const f = readAnnotations(dir, 3);
  assert.deepEqual([f?.resuggestedFrom, f?.instructions], [2, "fewer callouts"]);
  assert.equal(f?.items.filter((i) => i.id === "hl-kpi").length, 1, "kept, not duplicated");
});

function runtimeFor(models?: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-designer-"));
  const cfgFile = path.join(root, "config.json");
  fs.writeFileSync(
    cfgFile,
    JSON.stringify(models ? { roles: { annotationDesigner: { model: models } } } : {}),
  );
  const told: { text: string; turn: boolean }[] = [];
  const sent: string[] = [];
  const rt = new Runtime(
    () => ({ ...resolveConfig({ env: { DEMO_REC_CONFIG: cfgFile } }), root }),
    {
      sendUserMessage: (t) => sent.push(t),
      sendMessage: (m, o) => told.push({ text: m.content, turn: !!o?.triggerTurn }),
    },
  );
  const p = ensureProject(root, { project: "p", appName: "Acme", appUrl: "https://a.test" });
  fs.cpSync(makeProject(), p.dir, { recursive: true });
  rt.setActiveProject("p");
  return { rt, root, p, told, sent };
}

test("job: events, the version, a quiet note (no turn); a second run waits for the first", async () => {
  const { rt, root, p, told } = runtimeFor(["a/one"]);
  try {
    const { access } = fake([JSON.stringify(GOOD)]);
    rt.modelAccess = access;
    const events: string[] = [];
    rt.bus.subscribe((e) => events.push(`${e.type}:${String(e.data?.message ?? "")}`));
    const s = startDesigner(rt, {
      trigger: "auto",
      onFallback: () => assert.fail("no fallback expected"),
    });
    assert.ok(s.job);
    assert.equal(
      startDesigner(rt, { trigger: "panel", onFallback: () => {} }).skipped,
      "a designer run is already going",
    );
    await s.job?.done;
    assert.deepEqual(annotationVersions(p.dir), [1]);
    // P1a: an automatic start is run-and-tell: it says so, with the models and the size of the input
    assert.ok(
      events.some((e) =>
        /^design\.announced:🎨 started by itself after the voice step: the annotation designer \(a\/one, about [\d,]+ tokens in, one call\)/.test(
          e,
        ),
      ),
      events.join("\n"),
    );
    assert.ok(
      events.some((e) => /^design\.progress:🎨 designer · calling a\/one/.test(e)),
      events.join("\n"),
    );
    assert.ok(
      events.some((e) => /^annotations\.updated:annotations v1 suggested · 3 placed/.test(e)),
    );
    assert.ok(events.some((e) => /^design\.finished:designer v1 on a\/one/.test(e)));
    const note = told.at(-1);
    assert.match(
      note?.text ?? "",
      /Annotations v1 were suggested by the separate Annotation designer \(a\/one\): 3 placed/,
    );
    assert.equal(note?.turn, false, "a quiet note: no agent turn");
  } finally {
    await rt.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("job: when every model fails the fallback hands over to the agent with the reasons", async () => {
  const { rt, root, p } = runtimeFor(["a/one", "b/two"]);
  try {
    rt.modelAccess = fake([new Error("overloaded")]).access;
    const events: { type: string; data?: Record<string, unknown> }[] = [];
    rt.bus.subscribe((e) => events.push(e));
    const seen: string[][] = [];
    const s = startDesigner(rt, { trigger: "auto", onFallback: (e) => seen.push(e) });
    await s.job?.done;
    assert.equal(seen.length, 1);
    assert.match(seen[0]?.[0] ?? "", /a\/one: overloaded; b\/two: overloaded/);
    assert.deepEqual(annotationVersions(p.dir), []);
    const fin = events.find((e) => e.type === "design.finished");
    assert.equal(fin?.data?.fallback, true);
    assert.match(String(fin?.data?.message), /designer failed .* the agent takes over/);
  } finally {
    await rt.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("job: not configured / no model access → skipped with the reason (the agent turn stays the default)", async () => {
  const none = runtimeFor();
  const noAccess = runtimeFor(["a/one"]);
  try {
    none.rt.modelAccess = fake([""]).access;
    assert.equal(
      startDesigner(none.rt, { trigger: "auto", onFallback: () => {} }).skipped,
      "roles.annotationDesigner.model is not set",
    );
    assert.match(
      startDesigner(noAccess.rt, { trigger: "auto", onFallback: () => {} }).skipped ?? "",
      /model access isn't available yet/,
    );
  } finally {
    for (const x of [none, noAccess]) {
      await x.rt.shutdown();
      fs.rmSync(x.root, { recursive: true, force: true });
    }
  }
});

test("panel route: re-suggest goes to the separate designer when it starts, to the agent when it doesn't", () => {
  const { rt, root, p } = runtimeFor();
  try {
    const sent: string[] = [];
    const events: string[] = [];
    let fallback: ((e: string[]) => void) | undefined;
    const mk = (designer: (o: { onFallback: (e: string[]) => void }) => boolean) =>
      annotationRoutes({
        activeProject: () => rt.activeProject(),
        getConfig: () => rt.getConfig(),
        notifyAgent: (t) => sent.push(t),
        publish: (type, data) => events.push(`${type}:${String(data.by ?? "")}`),
        designer,
      });
    // an accepted VO on the line is needed by the route
    const state = JSON.parse(fs.readFileSync(path.join(p.dir, "state.json"), "utf8"));
    state.line = { ...state.line, vo: 1 };
    fs.writeFileSync(path.join(p.dir, "state.json"), JSON.stringify(state));
    const post = (r: ReturnType<typeof mk>) =>
      (r.post["annotations-resuggest"] as (b: Record<string, unknown>) => Record<string, unknown>)({
        instructions: "calmer",
      });
    const a = post(
      mk((o) => {
        fallback = o.onFallback;
        return true;
      }),
    );
    assert.equal(a.separate, true);
    assert.deepEqual(sent, [], "no agent message while the designer runs");
    assert.deepEqual(events, ["annotations.requested:separate designer run"]);
    fallback?.(["a/one: overloaded"]);
    assert.match(
      sent.at(-1) ?? "",
      /^\(The separate Annotation designer couldn't do it: a\/one: overloaded\.\) \[demo-panel\] Suggest annotations/,
    );
    const b = post(mk(() => false));
    assert.equal(b.separate, false);
    assert.match(sent.at(-1) ?? "", /^\[demo-panel\] Suggest annotations .* "calmer"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("auto-suggest is pending only for a new edit whose VO has no annotations yet", () => {
  const dir = makeProject();
  const r = { timeline: TIMELINE };
  assert.equal(autoSuggestPending(dir, true, "start", r), true);
  assert.equal(autoSuggestPending(dir, false, "start", r), false, "config off");
  assert.equal(autoSuggestPending(dir, true, "rerender", r), false, "a re-render is not an edit");
});

test("doctor: the cast line, and the designer's models (found, context size, missing)", async () => {
  const probes = {
    run: () => ({ status: 0, stdout: "x 1.0" }),
    env: {},
    nodeVersion: "24.1.0",
    chromiumPath: async () => "/c",
    exists: () => true,
    freeBytes: () => 50 * 1024 ** 3,
    ensureWritable: () => {},
  };
  const base = { ...defaultConfig("/home/t"), voiceName: "x" };
  const registry = (models: Record<string, { contextWindow?: number }>) => ({
    find: (p: string, id: string) => models[`${p}/${id}`],
    hasConfiguredAuth: () => true,
  });
  const cast = async (cfg = base, reg?: ReturnType<typeof registry>) =>
    Object.fromEntries(
      (await runDoctor(cfg, { ...probes, ...(reg ? { registry: reg } : {}) })).map((r) => [
        r.name,
        r,
      ]),
    );

  let by = await cast();
  assert.equal(by.roles?.status, "pass");
  assert.match(
    by.roles?.detail ?? "",
    /Annotation designer \(\+ Privacy officer\): the session model · Cutter, QA reviewer: engine \(no model\)/,
  );
  assert.match(
    by.roles?.detail ?? "",
    /Operator: anthropic\/claude-haiku-4-5 → openai\/gpt-5\.4-mini/,
  );
  assert.equal(
    by["annotation designer model"],
    undefined,
    "nothing to check when it isn't configured",
  );

  const cfg = { ...base, roles: { annotationDesigner: { model: ["a/big", "a/small", "a/gone"] } } };
  by = await cast(
    cfg,
    registry({ "a/big": { contextWindow: 200_000 }, "a/small": { contextWindow: 32_000 } }),
  );
  assert.match(by.roles?.detail ?? "", /separate run on a\/big → a\/small → a\/gone/);
  assert.equal(by["annotation designer model"]?.status, "warn");
  assert.match(
    by["annotation designer model"]?.detail ?? "",
    /✔ a\/big \(200k context\); ✔ a\/small \(32k context\) — under 64k.*; ✖ a\/gone \(not in pi's model list\)/,
  );

  by = await cast(
    { ...base, roles: { annotationDesigner: { model: ["a/big"] } } },
    registry({ "a/big": { contextWindow: 200_000 } }),
  );
  assert.equal(by["annotation designer model"]?.status, "pass");

  by = await cast({ ...base, roles: { annotationDesigner: { model: ["a/gone"] } } }, registry({}));
  assert.equal(by["annotation designer model"]?.status, "warn");
  assert.match(
    by["annotation designer model"]?.detail ?? "",
    /the agent turn will do the designing instead/,
  );
});

test("config: roles.annotationDesigner.model — a model or a chain; other roles say why they can't; env; Config tab key", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roles-cfg-"));
  try {
    const load = (roles: unknown, env: NodeJS.ProcessEnv = {}) => {
      const f = path.join(dir, "c.json");
      fs.writeFileSync(f, JSON.stringify({ roles }));
      return resolveConfig({ env: { DEMO_REC_CONFIG: f, ...env } }).roles;
    };
    assert.deepEqual(load({}), {});
    assert.deepEqual(load({ annotationDesigner: { model: "anthropic/claude-sonnet-4-5" } }), {
      annotationDesigner: { model: ["anthropic/claude-sonnet-4-5"] },
    });
    assert.deepEqual(load({ annotationDesigner: { model: ["a/b", "c/d"] }, _comment: "x" }), {
      annotationDesigner: { model: ["a/b", "c/d"] },
    });
    assert.throws(
      () => load({ annotationDesigner: { model: "nonsense" } }),
      /must be "provider\/id" or a non-empty list/,
    );
    assert.throws(
      () => load({ qa: { model: "a/b" } }),
      /"roles\.qa" can't run separately: an engine role: deterministic checks, no model \(D69\)/,
    );
    assert.throws(
      () => load({ operator: { model: "a/b" } }),
      /"roles\.operator" can't run separately: its model is "improvise\.models"/,
    );
    assert.throws(() => load({ cutter: {} }), /an engine role: deterministic, no model/);
    assert.throws(
      () => load({ nope: {} }),
      /"roles\.nope" is not a role \(separable: annotationDesigner\)/,
    );
    assert.deepEqual(
      load({}, { DEMO_REC_ANNOTATION_MODEL: "x/y, z/w" }),
      { annotationDesigner: { model: ["x/y", "z/w"] } },
      "env wins",
    );

    const { knownKeys, CONFIG_DOCS, ENV_KEYS } = await import("../src/config-edit.ts");
    assert.ok(knownKeys().includes("roles.annotationDesigner.model"));
    assert.ok(!knownKeys().includes("roles"), "no bogus empty-object key");
    assert.match(CONFIG_DOCS["roles.annotationDesigner.model"] ?? "", /ONE call on this model/);
    assert.equal(ENV_KEYS["roles.annotationDesigner.model"], "DEMO_REC_ANNOTATION_MODEL");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
