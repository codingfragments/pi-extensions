/** A generated project of about 320 graph nodes (6 storyboards, 14 takes, 24 voice-overs, 30 annotations, 220 renders). */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeOptions } from "../../src/render/run.ts";
import { saveRecord, startRecord } from "../../src/render/store.ts";
import { writeStoryboard } from "../../src/storyboard/store.ts";
import { ensureProject } from "../../src/workdir/layout.ts";
import { approve } from "../../src/workdir/state.ts";

export function bigProject(): { root: string; dir: string; slug: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-big-"));
  const p = ensureProject(root, { project: "big", appName: "Big", appUrl: "https://big.test" });
  const sb = (v: number) =>
    `version: ${v}\napp: big\nstart_url: /\nscenes:\n  - id: s1\n    title: One\n    steps:\n      - { do: pause, ms: 100 }\n`;
  for (let i = 1; i <= 6; i++) writeStoryboard(p.dir, sb(i));
  for (let t = 1; t <= 14; t++) {
    const d = path.join(p.dir, "takes", `take-${String(t).padStart(3, "0")}`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(d, "take.json"),
      JSON.stringify({
        take: `take-${t}`,
        status: "ok",
        storyboardVersion: 1 + (t % 6),
        durationMs: 60000 + t,
      }),
    );
  }
  fs.mkdirSync(path.join(p.dir, "vo"), { recursive: true });
  for (let v = 1; v <= 24; v++)
    fs.writeFileSync(
      path.join(p.dir, "vo", `script.v${v}.md`),
      `---\ntake: take-${String(1 + (v % 14)).padStart(3, "0")}\n---\n## s1\ntext\n`,
    );
  fs.mkdirSync(path.join(p.dir, "annotations"), { recursive: true });
  for (let v = 1; v <= 30; v++)
    fs.writeFileSync(
      path.join(p.dir, "annotations", `v${v}.json`),
      JSON.stringify({ basedOn: { vo: 1 + (v % 24) }, take: "take-001", items: [] }),
    );
  for (let r = 1; r <= 220; r++) {
    const rec = startRecord(p.dir, {
      kind: r % 9 === 0 ? "final" : "draft",
      basedOn: { annotations: r <= 40 ? 1 : 1 + (r % 30) }, // the first forty drafts share one group
      timeline: 1,
      voVersion: 1,
      take: "take-001",
      by: "panel",
      options: normalizeOptions({}),
      brands: ["neutral"],
      size: { width: 960, height: 540 },
    });
    rec.status = "done";
    saveRecord(p.dir, rec);
  }
  approve(p.dir, "storyboard", 2);
  return { root, dir: p.dir, slug: "big" };
}
