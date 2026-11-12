/**
 * Config render.* (R3-20, item 20): parsed and validated, shown in the Render tab as its starting choices, and said to the Director (who no longer asks).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { approvalMessage } from "../src/panel/bridge.ts";
import { rendersView } from "../src/panel/render-routes.ts";
import { Runtime } from "../src/runtime.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

const read = (json: unknown) =>
  resolveConfig({
    env: { DEMO_REC_CONFIG: "/x.json" },
    home: "/h",
    readFile: () => JSON.stringify(json),
  });

test("defaults: keep 3 drafts, no brands list (= the brand), no subtitles, logo bug on, all types", () => {
  const c = resolveConfig({ env: {}, home: "/h", readFile: () => undefined });
  assert.deepEqual(c.render, {
    keepDrafts: 3,
    brands: [],
    subtitles: false,
    logoBug: true,
    annotationTypes: "all",
  });
});

test("render.* is parsed; mistakes are named", () => {
  const c = read({
    render: {
      brands: ["neutral", "acme", "acme"],
      subtitles: true,
      logoBug: false,
      annotationTypes: ["chapter", "callout", "chapter"],
    },
  });
  assert.deepEqual(c.render, {
    keepDrafts: 3,
    brands: ["neutral", "acme"],
    subtitles: true,
    logoBug: false,
    annotationTypes: ["callout", "chapter"],
  });
  assert.equal(read({ render: { annotationTypes: "all" } }).render.annotationTypes, "all");
  assert.equal(
    read({ render: { annotationTypes: [] } }).render.annotationTypes.length,
    0,
    "[] = plain",
  );
  assert.throws(() => read({ render: { brands: "acme" } }), /render\.brands/);
  assert.throws(() => read({ render: { brands: ["Acme Corp"] } }), /render\.brands/);
  assert.throws(
    () => read({ render: { subtitles: "yes" } }),
    /"render\.subtitles" must be true or false/,
  );
  assert.throws(() => read({ render: { logoBug: 1 } }), /"render\.logoBug" must be true or false/);
  assert.throws(() => read({ render: { annotationTypes: ["arrow"] } }), /render\.annotationTypes/);
  assert.throws(() => read({ render: { annotationTypes: "most" } }), /render\.annotationTypes/);
});

test("the Render tab starts from them; the approval message says what a final uses and tells the Director not to ask", async () => {
  process.env.DEMO_REC_NO_OPEN = "1";
  const seed = seedPanelProject();
  const cfgFile = path.join(seed.root, "c.json");
  fs.writeFileSync(
    cfgFile,
    JSON.stringify({
      render: {
        brands: ["neutral"],
        subtitles: true,
        logoBug: false,
        annotationTypes: ["chapter"],
      },
    }),
  );
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: cfgFile } }),
    root: seed.root,
    panelPort: 0,
  }));
  try {
    rt.setActiveProject(seed.slug);
    const view = rendersView(rt) as { defaults: Record<string, unknown> };
    assert.deepEqual(
      [
        view.defaults.brands,
        view.defaults.subtitles,
        view.defaults.logoBug,
        view.defaults.annotationTypes,
      ],
      [["neutral"], true, false, ["chapter"]],
    );
    // no list configured: the brand is the list
    fs.writeFileSync(cfgFile, "{}");
    rt.getConfig(true);
    const plain = rendersView(rt) as { defaults: Record<string, unknown> };
    assert.deepEqual(
      [
        plain.defaults.brands,
        plain.defaults.subtitles,
        plain.defaults.logoBug,
        plain.defaults.annotationTypes,
      ],
      [["neutral"], false, true, "all"],
    );
    const msg = approvalMessage(
      "p",
      "annotations",
      2,
      "a final render uses the brand neutral, no burned-in subtitles, the logo bug on, all annotation types",
    );
    assert.match(
      msg,
      /Do NOT ask which brands or subtitles: they are settings \(Config render\.\*\), a final render uses the brand neutral, no burned-in subtitles/,
    );
    assert.doesNotMatch(msg, /ask which brands and whether/);
    assert.match(
      approvalMessage("p", "annotations", 2),
      /a final uses the configured brand, no subtitles/,
    );
  } finally {
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});

test("the Director's instructions no longer say to ask (skill, tool description, docs)", () => {
  const root = path.join(import.meta.dirname, "..");
  const skill = fs.readFileSync(path.join(root, "skills", "demo-recording", "SKILL.md"), "utf8");
  assert.doesNotMatch(skill, /asking which brands and whether to burn in subtitles/);
  assert.match(skill, /do not ask the user for them/);
  const tool = fs.readFileSync(path.join(root, "src", "tools", "render.ts"), "utf8");
  assert.match(tool, /so do not ask the user for them/);
  const docs = fs.readFileSync(path.join(root, "docs", "RENDER.md"), "utf8");
  assert.doesNotMatch(docs, /and asks\s+which brands/);
});
