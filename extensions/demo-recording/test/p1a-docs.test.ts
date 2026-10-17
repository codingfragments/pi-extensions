/** P1a PR 5: the guides and skills say what the code does about approvals and spending. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.join(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("the user docs describe The Director asks, Allow and /demo allow", () => {
  for (const f of ["docs/GUIDE.md", "docs/CONTROL_ROOM.md", "docs/TUTORIAL-101.md"])
    assert.match(read(f), /The Director asks/, `${f} explains the request bar`);
  assert.match(read("README.md"), /\/demo allow/);
  assert.match(
    read("docs/CONTROL_ROOM.md"),
    /Allow lets that one thing go \(for 15 minutes,\s+once\)/,
  );
});

test("no skill or guide still tells the agent to accept a take or to go on after an approval", () => {
  for (const f of [
    "skills/demo-recording/SKILL.md",
    "skills/demo-voiceover/SKILL.md",
    "docs/GUIDE.md",
    "docs/ARCHITECTURE.md",
  ])
    assert.doesNotMatch(read(f), /demo_rec_take accept/, f);
  assert.match(read("skills/demo-voiceover/SKILL.md"), /demo_rec_take propose/);
  assert.match(read("skills/demo-voiceover/SKILL.md"), /You cannot approve it/);
  assert.match(read("skills/demo-recording/SKILL.md"), /refused until the user allows them/);
});
