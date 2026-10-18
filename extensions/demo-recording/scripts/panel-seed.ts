/**
 * Try the control room by hand on a throwaway demo project ("keycraft": storyboard, take, voice-over,
 * annotations, final and draft renders, one QA-blocked final). Seeds the folder, starts the full panel
 * (the same runtime the Director uses, so every route exists) and waits for Ctrl-C. Your real recordings
 * and config are not touched.
 *
 *   node extensions/demo-recording/scripts/panel-seed.ts [folder] [--port N] [--new | --branching] [--qa]
 *
 *   --new         an empty project ("demo", nothing in the brief) instead of the seeded one, to see a first run.
 *   --qa          give the seeded final (Final v1) a QA report to look at: a hard stop (a leaking redaction), a wrong
 *                 number and a late narration that need your eyes, a warning, an info line and "sync measured at 11 of
 *                 16 anchors" (Render > Final v1 > All checks…).
 *   --branching   the seeded project with two branches (a second narration, a second story and a new take), the one
 *                 the docs show (GUIDE.md, TUTORIAL-101.md, BRANCHING.md).
 *
 * Note: `cli.ts panel` is the old standalone panel without stage routes; it cannot show the map.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveConfig } from "../src/config.ts";
import { qaFile } from "../src/qa/run.ts";
import { Runtime } from "../src/runtime.ts";
import { ensureProject } from "../src/workdir/layout.ts";
import { branchSeededProject } from "../test/helpers/branching-project.ts";
import { seedPanelProject } from "../test/helpers/panel-seed.ts";

const args = process.argv.slice(2);
const portAt = args.indexOf("--port");
const port = portAt >= 0 ? Number(args[portAt + 1]) : 0;
const fresh = args.includes("--new");
const branching = args.includes("--branching");
const withQa = args.includes("--qa");
const folder = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--port");
const root = path.resolve(folder ?? (fresh ? "/tmp/demo-new" : "/tmp/demo-try"));
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
const seed = fresh
  ? (() => {
      const p = ensureProject(root, {
        project: "demo",
        appName: "Demo",
        appUrl: "https://app.test",
      });
      return { slug: p.slug };
    })()
  : seedPanelProject(root);

if (branching && !fresh)
  branchSeededProject((seed as { dir?: string }).dir ?? path.join(root, "projects", seed.slug));
if (withQa && !fresh) {
  const dir = (seed as { dir?: string }).dir ?? path.join(root, "projects", seed.slug);
  fs.mkdirSync(path.dirname(qaFile(dir, 1)), { recursive: true });
  fs.writeFileSync(
    qaFile(dir, 1),
    JSON.stringify({
      render: 1,
      stage: "render",
      version: 1,
      variant: "neutral",
      createdAt: new Date().toISOString(),
      whisper: true,
      coverage: { anchors: { measured: 11, total: 16 } },
      items: [
        {
          id: "annotations-1",
          check: "annotations",
          level: "blocking",
          hard: "redaction",
          identity: { ref: "r1" },
          scene: "01-dash",
          atMs: 2500,
          message:
            "redaction r1 doesn't cover its element here: it moved; add a redaction for its new position",
        },
        {
          id: "values-2",
          check: "values",
          level: "warning",
          high: true,
          identity: { anchor: "m2", phrase: ["but", "emea", "is"], value: "14.3" },
          scene: "01-dash",
          atMs: 2100,
          message:
            "the narration says “fourteen point three” (14.3): it isn't on screen anywhere in 01-dash. Fix the number in the voice-over, or leave it if it is meant",
        },
        {
          id: "drift-3",
          check: "drift",
          level: "warning",
          high: true,
          identity: { anchor: "emea-bar" },
          scene: "01-dash",
          atMs: 9000,
          message:
            "the narration for @emea-bar starts 1004 ms after its moment (measured; the edit planned +375 ms): the two disagree by 629 ms: the transcript's word start is on a speech onset, so the measurement is probably right and the plan is off",
          fix: {
            kind: "shift-narration",
            scene: "01-dash",
            anchor: "emea-bar",
            deltaMs: -1004,
            label: "move it 1.00 s earlier",
          },
        },
        {
          id: "media-4",
          check: "media",
          level: "warning",
          identity: { kind: "pause", relMs: 1000 },
          scene: "01-dash",
          atMs: 20000,
          message: "no narration for 4.6 s: a long pause",
        },
        {
          id: "drift-5",
          check: "drift",
          level: "info",
          atMs: 30000,
          moments: [30000, 41000],
          message:
            "the narration was measured at 11 of 16 anchors; at @a, @b the transcript did not contain the words, so sync is not checked there",
        },
        {
          id: "media-6",
          check: "media",
          level: "info",
          atMs: 3000,
          moments: [3000, 9000],
          message:
            "9 held frames where the picture stands still (18.4 s in all, the longest 3.4 s): the edit holds a frame on purpose, or the picture is short",
        },
      ],
    }),
  );
}
process.env.DEMO_REC_NO_OPEN = "1";
// by hand, the voice pickers list the voices of your own account (read-only, free), like the real panel
Reflect.deleteProperty(process.env, "DEMO_REC_NO_VOICE_LIST");
const rt = new Runtime(() => ({
  ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(root, "none.json") } }),
  root,
  panelPort: port,
}));
rt.setActiveProject(seed.slug);
const panel = await rt.ensurePanel();
console.log(`${fresh ? "empty" : "seeded"} project "${seed.slug}" in ${root}`);
console.log(`panel: ${panel.url}  (Ctrl-C to stop)`);
await new Promise<void>((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});
await rt.shutdown();
process.exit(0);
