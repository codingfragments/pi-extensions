/**
 * Seed a throwaway demo project ("keycraft": storyboard, take, voice-over, annotations, final and draft
 * renders, one QA-blocked final) into a folder, to try the control room by hand without touching your
 * real recordings.
 *
 *   node extensions/demo-recording/scripts/panel-seed.ts /tmp/demo-try
 *   env DEMO_REC_ROOT=/tmp/demo-try DEMO_REC_CONFIG=/tmp/demo-try/none.json node extensions/demo-recording/cli.ts panel --project keycraft
 */

import fs from "node:fs";
import path from "node:path";
import { seedPanelProject } from "../test/helpers/panel-seed.ts";

const root = path.resolve(process.argv[2] ?? "/tmp/demo-try");
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
seedPanelProject(root);
console.log(`seeded project "keycraft" in ${root}`);
