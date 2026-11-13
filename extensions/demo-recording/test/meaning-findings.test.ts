/**
 * Item 23 PR 3 (R3-24): discovery records what an area means. The `meaning` finding kind, its mark in the panel, the report's rules asking for it, the storyboard
 * warning when no scene uses one, and the research rule in the skills.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { KIND_ICON } from "../src/panel/public/discovery-core.js";
import { AGENT_KINDS, listFindings, recordFinding } from "../src/workdir/findings.ts";

test("meaning is a finding kind with its own mark", () => {
  assert.ok((AGENT_KINDS as readonly string[]).includes("meaning"));
  assert.equal(KIND_ICON.meaning, "◎");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meaning-"));
  try {
    const f = recordFinding(dir, {
      stage: "discovery",
      kind: "meaning",
      text: "The issue page keeps the context in one place: an engineer does not switch tools to build the picture.",
      evidence: [{ type: "screen", id: "20261021-155520/s006" }],
    });
    assert.equal(f.kind, "meaning");
    assert.equal(listFindings(dir).find((x) => x.id === f.id)?.kind, "meaning");
    assert.throws(
      () => recordFinding(dir, { stage: "discovery", kind: "nonsense" as never, text: "x" }),
      /unknown finding kind "nonsense" \(.*meaning.*\)/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the skills: one meaning finding per explored area, research to explain meaning allowed and cited, the brief keeps research on request", () => {
  const root = path.join(import.meta.dirname, "..", "skills");
  const rec = fs.readFileSync(path.join(root, "demo-recording", "SKILL.md"), "utf8");
  assert.match(rec, /one `meaning` finding per explored area/);
  assert.match(rec, /The scenes'\s+`why` and `so_what` are built from these/);
  assert.match(rec, /\*\*Research to explain meaning\*\* is allowed without being asked/);
  assert.match(rec, /goes on the finding as `url:` evidence/);
  assert.match(rec, /Never put private details from the app or the brief into a query/);
  const brief = fs.readFileSync(path.join(root, "demo-brief", "SKILL.md"), "utf8");
  assert.match(brief, /\*\*Research only on request\*\* for the brief itself/);
  assert.match(
    brief,
    /Discovery may look up\s+the app's public docs to explain what a feature means, citing each page/,
  );
});
