#!/usr/bin/env node
import { existsSync } from "node:fs";
/**
 * pass1-init — scaffold a poc-video run directory for a target.
 *
 * Usage:
 *   node scripts/pass1-init.ts <target> [--pocs-root ./pocs] [--title "..."] [--start-url "..."]
 *
 * Creates:
 *   <pocs-root>/<target>/
 *   ├── run.yaml          # env-specific values live here (target url, voice) — never in the skill
 *   ├── storyboard.yaml   # template copy — the agent drafts the real one during pass 1
 *   ├── vo.yaml           # template copy
 *   ├── findings/README.md  # exploration notes structure
 *   └── scenes/           # reference screenshots (poc_video_screenshot) land here
 *
 * Idempotent: an existing run.yaml is never overwritten.
 */
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export interface InitOpts {
  title?: string;
  startUrl?: string;
}

export async function initRunDir(
  target: string,
  pocsRoot = "./pocs",
  opts: InitOpts = {},
): Promise<{ runDir: string; created: boolean; reason?: string }> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(target)) {
    throw new Error(`target '${target}' must be kebab-case (e.g. mate-security, turso)`);
  }
  const runDir = path.resolve(pocsRoot, target);
  if (existsSync(path.join(runDir, "run.yaml"))) {
    return { runDir, created: false, reason: "run.yaml already present — never overwritten" };
  }

  await mkdir(path.join(runDir, "findings"), { recursive: true });
  await mkdir(path.join(runDir, "scenes"), { recursive: true });

  await cp(
    path.join(here, "../templates/storyboard.template.yaml"),
    path.join(runDir, "storyboard.yaml"),
  );
  await cp(path.join(here, "../templates/vo.template.yaml"), path.join(runDir, "vo.yaml"));

  const run = [
    "# run.yaml — all environment-specific values for this poc-video run.",
    "# The skill and extension never hardcode these.",
    `target: ${target}`,
    `title: ${JSON.stringify(opts.title ?? `${target} — POC demo`)}`,
    `start_url: ${JSON.stringify(opts.startUrl ?? "TODO: set the URL the user lands on after login")}`,
    "voice:",
    '  name: "Stefan"            # resolved to an ElevenLabs voice_id at TTS time',
    `created: ${new Date().toISOString().slice(0, 10)}`,
  ].join("\n");
  await writeFile(path.join(runDir, "run.yaml"), `${run}\n`);

  const readme = [
    `# Findings — ${target}`,
    "",
    "Exploration notes from pass 1. These feed both the storyboard and the voice-over script.",
    "",
    "Suggested structure — one file per area you explored:",
    "",
    "- `overview.md` — what the product is, the one-liner for the title card",
    "- `flows/<flow>.md` — each candidate walkthrough flow: what it shows, why it matters, rough duration",
    "- `screens/` — notable screenshots beyond the per-scene reference shots (optional)",
    "",
    "Per flow, record: what the user sees, what the primary action is, what the payoff moment is,",
    "and which `scenes/*.png` reference shot belongs to it.",
    "",
    "Remember: every action during exploration is a poc_video_* tool call — the session log is the",
    "ground truth of what was tried. These files are the distilled version.",
  ].join("\n");
  await writeFile(path.join(runDir, "findings/README.md"), `${readme}\n`);

  return { runDir, created: true };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith("--"));
  if (!target) {
    console.error(
      'usage: pass1-init.ts <target> [--pocs-root ./pocs] [--title "…"] [--start-url "…"]',
    );
    return 2;
  }
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const result = await initRunDir(target, opt("pocs-root") ?? "./pocs", {
    title: opt("title"),
    startUrl: opt("start-url"),
  });
  if (!result.created) {
    console.log(`ℹ ${result.reason}`);
    console.log(`  run dir: ${result.runDir}`);
    return 0;
  }
  console.log(`✔ created ${result.runDir}`);
  console.log("next: open it in pass 1 —");
  console.log("  1. poc_video_open (run_dir + start_url) → user logs in manually");
  console.log("  2. explore via poc_video_* tools, screenshots via poc_video_screenshot");
  console.log("  3. draft storyboard.yaml from findings, then validate:");
  console.log(
    `  node extensions/poc-video/scripts/validate-storyboard.mjs ${path.join(result.runDir, "storyboard.yaml")}`,
  );
  return 0;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
