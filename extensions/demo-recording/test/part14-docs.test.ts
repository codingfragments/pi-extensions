/**
 * Part 14: the user guide, the control room tour and the tutorial stay true to the product. Every picture they show is
 * made by scripts/guide-shots.ts and exists; every picture the script makes is shown; every `/demo` command they name
 * exists; every keyboard shortcut the panel has is in the tour; the sample commands the tutorial gives are real options.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { GUIDE_SHOTS } from "../scripts/guide-shots.ts";
import { SUBCOMMANDS } from "../src/commands/demo.ts";
import { SHORTCUTS } from "../src/panel/public/shortcuts.js";

const DOCS = path.join(import.meta.dirname, "..", "docs");
const read = (f: string) => fs.readFileSync(path.join(DOCS, f), "utf8");
const FILES = ["GUIDE.md", "CONTROL_ROOM.md", "TUTORIAL-101.md"];
const all = FILES.map(read).join("\n");

test("the three documents exist and are linked from the README and the architecture doc", () => {
  for (const f of FILES) assert.ok(fs.existsSync(path.join(DOCS, f)), f);
  const readme = fs.readFileSync(path.join(DOCS, "..", "README.md"), "utf8");
  for (const f of FILES) assert.ok(readme.includes(`docs/${f}`), `${f} is linked from the README`);
  const arch = read("ARCHITECTURE.md");
  for (const f of FILES) assert.ok(arch.includes(f), `${f} is linked from ARCHITECTURE.md`);
});

test("every picture the documents show is one the screenshot script makes, it exists, and every picture the script makes is shown", () => {
  const shown = [...all.matchAll(/images\/guide\/([\w-]+)\.jpg/g)].map((m) => m[1] as string);
  const known = new Set<string>(GUIDE_SHOTS);
  for (const name of new Set(shown)) {
    assert.ok(known.has(name), `${name} is made by scripts/guide-shots.ts`);
    const file = path.join(DOCS, "images", "guide", `${name}.jpg`);
    assert.ok(fs.existsSync(file) && fs.statSync(file).size > 10_000, `${name}.jpg exists`);
  }
  for (const name of GUIDE_SHOTS) assert.ok(shown.includes(name), `${name} is shown in a document`);
  const onDisk = fs
    .readdirSync(path.join(DOCS, "images", "guide"))
    .map((f) => f.replace(/\.jpg$/, ""));
  assert.deepEqual(
    onDisk.sort(),
    [...GUIDE_SHOTS].sort(),
    "no picture without a script, no script without a picture",
  );
});

test("every /demo command named in the documents exists", () => {
  const named = new Set([...all.matchAll(/`\/demo ([a-z]+)/g)].map((m) => m[1] as string));
  assert.ok(named.size >= 6, [...named].join(", "));
  for (const c of named)
    assert.ok((SUBCOMMANDS as readonly string[]).includes(c), `/demo ${c} exists`);
});

test("every keyboard shortcut of the panel is in the tour", () => {
  const tour = read("CONTROL_ROOM.md");
  const flat = (s: string) => s.replace(/[\s·`]/g, "").toLowerCase();
  for (const [keys] of SHORTCUTS) {
    // the sheet writes "Tab · Shift+Tab", the table "Tab, Shift+Tab": compare the keys, not the punctuation
    const parts = keys.split(/\s*·\s*/).map((k) => flat(k).replace(/inthemap$/, ""));
    for (const k of parts.filter(Boolean))
      assert.ok(
        flat(tour).includes(k) || flat(tour).includes(k.replace("−", "-")),
        `"${k}" (from "${keys}") is in CONTROL_ROOM.md`,
      );
  }
});

test("the tutorial's sample commands use real options", () => {
  const seedScript = fs.readFileSync(path.join(DOCS, "..", "scripts", "panel-seed.ts"), "utf8");
  const tutorial = read("TUTORIAL-101.md");
  for (const opt of ["--new", "--branching", "--port"]) {
    assert.ok(tutorial.includes(opt), `the tutorial uses ${opt}`);
    assert.ok(seedScript.includes(opt), `scripts/panel-seed.ts has ${opt}`);
  }
  assert.ok(
    tutorial.includes("env DEMO_REC_NO_OPEN=1 DEMO_REC_CONFIG="),
    "overrides are in a subshell env, not exported",
  );
});
