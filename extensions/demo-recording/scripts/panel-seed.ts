/**
 * Try the control room by hand on a throwaway demo project ("keycraft": storyboard, take, voice-over,
 * annotations, final and draft renders, one QA-blocked final). Seeds the folder, starts the full panel
 * (the same runtime the Director uses, so every route exists) and waits for Ctrl-C. Your real recordings
 * and config are not touched.
 *
 *   node extensions/demo-recording/scripts/panel-seed.ts [folder] [--port N]
 *
 * Note: `cli.ts panel` is the old standalone panel without stage routes; it cannot show the map.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveConfig } from "../src/config.ts";
import { Runtime } from "../src/runtime.ts";
import { seedPanelProject } from "../test/helpers/panel-seed.ts";

const args = process.argv.slice(2);
const portAt = args.indexOf("--port");
const port = portAt >= 0 ? Number(args[portAt + 1]) : 0;
const folder = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--port");
const root = path.resolve(folder ?? "/tmp/demo-try");
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
const seed = seedPanelProject(root);

process.env.DEMO_REC_NO_OPEN = "1";
const rt = new Runtime(() => ({
  ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(root, "none.json") } }),
  root,
  panelPort: port,
}));
rt.setActiveProject(seed.slug);
const panel = await rt.ensurePanel();
console.log(`seeded project "${seed.slug}" in ${root}`);
console.log(`panel: ${panel.url}  (Ctrl-C to stop)`);
await new Promise<void>((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});
await rt.shutdown();
process.exit(0);
