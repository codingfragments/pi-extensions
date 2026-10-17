/**
 * Turns the seeded project into the branching story used by the docs (BRANCHING.md, GUIDE.md): line A, delivered
 * (storyboard v1 → take-001 → voice-over v1 → annotations v1 → final render v2), branch 1 (voice-over v2 on take-001,
 * approved and kept, with annotations v2 as a draft) and branch 2 (storyboard v2 approved and kept, take-002 just recorded).
 */

import fs from "node:fs";
import path from "node:path";
import { readAnnotations, writeAnnotations } from "../../src/annotations/file.ts";
import { approveVersion } from "../../src/workdir/state.ts";

export function branchSeededProject(dir: string): void {
  // branch 1: a second narration on the same take, kept as an alternative, with annotations drafted on it
  approveVersion(dir, "vo", 2, "only");
  const a1 = readAnnotations(dir, 1) as NonNullable<ReturnType<typeof readAnnotations>>;
  const { version: _v, ...rest } = a1;
  writeAnnotations(dir, { ...rest, basedOn: { vo: 2 }, by: "demo" });
  // branch 2: a second story, kept as an alternative, and a take of it that has just been recorded
  approveVersion(dir, "storyboard", 2, "only");
  const t1 = path.join(dir, "takes", "take-001");
  const t2 = path.join(dir, "takes", "take-002");
  fs.cpSync(t1, t2, { recursive: true });
  const tj = JSON.parse(fs.readFileSync(path.join(t2, "take.json"), "utf8"));
  fs.writeFileSync(
    path.join(t2, "take.json"),
    JSON.stringify({ ...tj, take: "take-002", storyboardVersion: 2 }),
  );
  const aj = path.join(t2, "analysis", "analysis.json");
  if (fs.existsSync(aj)) {
    const a = JSON.parse(fs.readFileSync(aj, "utf8"));
    fs.writeFileSync(aj, JSON.stringify({ ...a, take: "take-002", storyboardVersion: 2 }));
  }
}
