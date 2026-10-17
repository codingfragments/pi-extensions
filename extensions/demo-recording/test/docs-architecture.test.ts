/**
 * The architecture and actor docs (S5 part 12, D90): every diagram source has
 * its rendered image, every image and link in the docs resolves (including
 * heading anchors), every diagram is shown somewhere, and the documented
 * roles and settings match the code.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { PROMPT_SECTIONS, skillSections } from "../src/annotations/designer-run.ts";
import { CONFIG_DOCS, ENV_KEYS } from "../src/config-edit.ts";
import { SEPARABLE_ROLES } from "../src/config.ts";

const ROOT = path.join(import.meta.dirname, "..");
const DOCS = path.join(ROOT, "docs");
const read = (f: string) => fs.readFileSync(f, "utf8");

/** GitHub's heading anchor: lowercase, punctuation dropped, spaces → "-". */
const slug = (h: string) =>
  h
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^\p{L}\p{N} -]/gu, "")
    .trim()
    .replace(/ /g, "-");
const anchors = (md: string) =>
  new Set([...md.matchAll(/^#{1,6} +(.+?)\s*$/gm)].map((m) => slug(m[1] as string)));

const MAIN = [
  "ARCHITECTURE.md",
  "ACTORS.md",
  "CONFIDENCE.md",
  "BRANCHING.md",
  "GUIDE.md",
  "CONTROL_ROOM.md",
  "TUTORIAL-101.md",
].map((f) => path.join(DOCS, f));
const diagrams = fs
  .readdirSync(path.join(DOCS, "diagrams"))
  .filter((f) => f.endsWith(".mmd"))
  .map((f) => f.slice(0, -4));

test("every diagram source has its rendered PNG and SVG, and is shown in the docs", () => {
  assert.ok(diagrams.length >= 11, `the diagram sources (${diagrams.length})`);
  const shown = MAIN.map(read).join("\n");
  for (const d of diagrams) {
    for (const ext of ["png", "svg"]) {
      const f = path.join(DOCS, "images", "architecture", `${d}.${ext}`);
      assert.ok(fs.existsSync(f) && fs.statSync(f).size > 1000, `${d}.${ext} is rendered`);
    }
    assert.ok(shown.includes(`images/architecture/${d}.png`), `${d} is shown in a doc`);
    const src = read(path.join(DOCS, "diagrams", `${d}.mmd`));
    assert.match(src, /^(flowchart (TB|LR)|sequenceDiagram)/, `${d} starts with a diagram type`);
  }
});

test("images and relative links in the docs resolve, with their heading anchors", () => {
  const cache = new Map<string, Set<string>>();
  const anchorsOf = (f: string) => {
    if (!cache.has(f)) cache.set(f, anchors(read(f)));
    return cache.get(f) as Set<string>;
  };
  const problems: string[] = [];
  for (const file of MAIN) {
    const md = read(file);
    for (const m of md.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = m[1] as string;
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [rel, hash] = target.split("#") as [string, string | undefined];
      const dest = rel ? path.resolve(path.dirname(file), rel) : file;
      if (!fs.existsSync(dest)) {
        problems.push(`${path.basename(file)}: ${target} → missing file`);
        continue;
      }
      if (hash && dest.endsWith(".md") && !anchorsOf(dest).has(hash))
        problems.push(`${path.basename(file)}: ${target} → no such heading`);
    }
  }
  assert.deepEqual(problems, []);
});

test("ACTORS.md documents every role of the cast, the separable roles and their settings", () => {
  const actors = read(path.join(DOCS, "ACTORS.md"));
  for (const role of [
    "Director",
    "Researcher",
    "Storyboard writer",
    "Operator",
    "Voice writer",
    "Cutter",
    "Annotation designer",
    "Brand designer",
    "QA reviewer",
    "Privacy officer",
  ])
    assert.match(
      actors,
      new RegExp(`### .*${role}|\\| \\*\\*${role}\\*\\*`),
      `${role} has its entry`,
    );
  assert.match(actors, /### You \(human\)/);
  for (const r of SEPARABLE_ROLES)
    assert.ok(actors.includes(`roles.${r}.model`), `${r} setting is documented`);
  assert.ok(CONFIG_DOCS["roles.annotationDesigner.model"]);
  assert.equal(ENV_KEYS["roles.annotationDesigner.model"], "DEMO_REC_ANNOTATION_MODEL");
  assert.ok(actors.includes("DEMO_REC_ANNOTATION_MODEL"));
  assert.ok(actors.includes("improvise.models"));
});

test("the separate run's documented prompt sections exist in the skill file", () => {
  const skill = skillSections(read(path.join(ROOT, "skills", "demo-annotations", "SKILL.md")));
  const actors = read(path.join(DOCS, "ACTORS.md"));
  for (const h of PROMPT_SECTIONS) assert.ok(skill.has(h), `skill has "${h}"`);
  assert.match(actors, /What to suggest.*Writing rules.*Privacy/s);
});

test("decisions D85–D97 are recorded, and the architecture doc points at the decision record", () => {
  const vision = read(path.join(DOCS, "VISION.md"));
  for (let n = 85; n <= 97; n++) assert.match(vision, new RegExp(`^\\| D${n} \\|`, "m"), `D${n}`);
  const arch = read(path.join(DOCS, "ARCHITECTURE.md"));
  assert.match(arch, /\(VISION\.md\)/);
  assert.match(arch, /## 13\. Decision map/);
});
