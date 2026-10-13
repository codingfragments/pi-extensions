#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { Page } from "playwright";
/**
 * record.ts — poc-video pass-2 recording runner (replay engine).
 *
 * Deterministically replays storyboard.yaml in a persistent-profile Chromium
 * and emits scenes.json (per-scene start/end offsets + per-step timings) —
 * the input the assembler cuts with. Recording is a dumb replay: no LLM, no
 * decisions at record time.
 *
 * Modes:
 *   --mode watch    headed, recordVideo on (default — real runs)
 *   --mode step     like watch, but pauses for ENTER between scenes
 *   --mode dry-run  slowMo walk, NO recordVideo — cheap selector validation
 *
 * Auth handshake: headed modes stop after launch — the user logs in
 * manually, navigates to the start page, presses ENTER. Credentials are
 * never captured. --auto-start skips the handshake (smoke tests only).
 *
 * Failure semantics (plan rule: no silent fallback):
 *   watch/step  a failed step aborts the run (recording is worthless) —
 *               partial scenes.json is still written
 *   dry-run     a failed scene is recorded and the walk continues — you see
 *               every broken selector in one pass; exit code 1 if any failed
 *
 * Human-like input (ghost-cursor Bézier paths + jittered typing + DOM cursor
 * overlay via human.ts) is ON by default — `--raw-input` drops back to instant
 * Playwright input for debugging and fast selector validation.
 *
 * Usage: node scripts/record.ts <run-dir> [--mode watch|step|dry-run] [--headless] [--auto-start] [--raw-input]
 */
import { parse } from "yaml";
import { createHumanInput } from "../human.ts";
import type { HumanInput } from "../human.ts";
import { Report, validateStoryboard } from "./validate-storyboard.mjs";

export interface Step {
  type: string;
  url?: string;
  selector?: string;
  text?: string;
  key?: string;
  dy?: number;
  ms?: number;
}

export interface Scene {
  id: string;
  title: string;
  intent: string;
  budget_s?: number;
  settle_ms?: number;
  hold_ms?: number;
  skip?: boolean;
  steps: Step[];
}

export interface Storyboard {
  meta: {
    target?: string;
    title?: string;
    target_duration_s?: number;
    settle_default_ms?: number;
    [k: string]: unknown;
  };
  scenes: Scene[];
}

export type RunMode = "watch" | "step" | "dry-run";

export interface RecordOptions {
  runDir: string;
  mode?: RunMode;
  headless?: boolean;
  /** skip the manual-auth handshake (smoke tests only) */
  autoStart?: boolean;
  /** drop the human-like input layer (instant Playwright input — debugging/fast validation) */
  rawInput?: boolean;
  /** control-bus seam (next milestone): called before each scene */
  onSceneStart?: (scene: Scene, index: number) => Promise<void> | void;
  /** control-bus seam: called after each scene with its record */
  onSceneEnd?: (record: SceneRecord, index: number) => Promise<void> | void;
}

export interface StepRecord {
  i: number;
  type: string;
  ok: boolean;
  start_s: number;
  end_s: number;
  error?: string;
}

export interface SceneRecord {
  id: string;
  status: "recorded" | "failed" | "skipped";
  start_s: number;
  end_s: number;
  hold_ms: number;
  steps: StepRecord[];
  error?: string;
}

export interface ScenesJson {
  meta: {
    runDir: string;
    mode: RunMode;
    startedAt: string;
    storyboard: string;
    /** relative to runDir; null in dry-run (no recording) */
    video: string | null;
    note: string;
  };
  scenes: SceneRecord[];
}

const DEFAULT_TIMEOUT = 10_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const errText = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";

/** Step types that get a settle beat after them (breathing room). */
const SETTLED = new Set(["navigate", "click", "type", "press", "scroll", "hover"]);

let rl: readline.Interface | null = null;
async function pressEnter(prompt: string): Promise<void> {
  rl ??= readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(prompt);
}

async function execStep(page: Page, step: Step, human: HumanInput | null): Promise<void> {
  switch (step.type) {
    case "navigate":
      await page.goto(step.url ?? "", { waitUntil: "domcontentloaded" });
      if (human) {
        // the new document's cursor overlay starts idle — pick the pointer back up
        await human.recall();
      }
      break;
    case "click":
      if (human) {
        await human.click(step.selector ?? "");
      } else {
        await page.click(step.selector ?? "", { timeout: DEFAULT_TIMEOUT });
      }
      break;
    case "type":
      if (human) {
        await human.type(step.selector ?? "", step.text ?? "");
      } else {
        await page.locator(step.selector ?? "").pressSequentially(step.text ?? "", {
          timeout: DEFAULT_TIMEOUT,
        });
      }
      break;
    case "press":
      await page.keyboard.press(step.key ?? "Enter");
      break;
    case "scroll":
      await page.mouse.wheel(0, step.dy ?? 300);
      break;
    case "hover":
      if (human) {
        await human.hover(step.selector ?? "");
      } else {
        await page.hover(step.selector ?? "", { timeout: DEFAULT_TIMEOUT });
      }
      break;
    case "assert":
      await page.waitForSelector(step.selector ?? "", {
        state: "visible",
        timeout: DEFAULT_TIMEOUT,
      });
      break;
    case "wait":
      await sleep(step.ms ?? 500);
      break;
    default:
      throw new Error(`unknown step type '${step.type}'`);
  }
}

/** Replay a (validated) storyboard. Writes <runDir>/scenes.json and returns it. */
export async function runRecording(opts: RecordOptions): Promise<ScenesJson> {
  const runDir = path.resolve(opts.runDir);
  const sbPath = path.join(runDir, "storyboard.yaml");
  if (!fs.existsSync(sbPath)) {
    throw new Error(`no storyboard.yaml in ${runDir} — scaffold the run first (pass1-init.ts)`);
  }
  const sb = parse(await fs.promises.readFile(sbPath, "utf8")) as Storyboard;
  const report = new Report();
  validateStoryboard(sb, report);
  for (const w of report.warnings) console.log(`  ⚠ ${w}`);
  if (!report.ok) {
    throw new Error(`storyboard invalid — fix before recording:\n  ${report.errors.join("\n  ")}`);
  }

  const mode: RunMode = opts.mode ?? "watch";
  const dryRun = mode === "dry-run";

  const profileDir = path.join(runDir, ".profile");
  fs.mkdirSync(profileDir, { recursive: true });
  if (!dryRun) fs.mkdirSync(path.join(runDir, "recordings"), { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: opts.headless ?? false,
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2,
    slowMo: dryRun ? 200 : undefined,
    recordVideo: dryRun ? undefined : { dir: path.join(runDir, "recordings") },
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const human = opts.rawInput ? null : await createHumanInput(page);
  const t0 = Date.now();
  const now = () => (Date.now() - t0) / 1000;

  if (!opts.autoStart && !opts.headless) {
    console.log(
      `${dryRun ? "dry run" : "RECORDING"} — log in manually, navigate to the start page, then press ENTER.`,
    );
    console.log("the run does NOT poll or capture credentials — you signal readiness.");
    await pressEnter("> ");
  }

  const settleDefault = sb.meta?.settle_default_ms ?? 800;
  const out: ScenesJson = {
    meta: {
      runDir,
      mode,
      startedAt: new Date().toISOString(),
      storyboard: "storyboard.yaml",
      video: null,
      note: "timestamps are wall-clock offsets from context launch — treat as ±150ms when cutting",
    },
    scenes: [],
  };

  let aborted = false;
  for (let i = 0; i < sb.scenes.length && !aborted; i++) {
    const scene = sb.scenes[i];
    if (!scene) continue;
    if (scene.skip) {
      out.scenes.push({
        id: scene.id,
        status: "skipped",
        start_s: now(),
        end_s: now(),
        hold_ms: 0,
        steps: [],
      });
      continue;
    }
    if (opts.onSceneStart) await opts.onSceneStart(scene, i);

    const rec: SceneRecord = {
      id: scene.id,
      status: "recorded",
      start_s: now(),
      end_s: 0,
      hold_ms: scene.hold_ms ?? 0,
      steps: [],
    };
    let sceneError: string | null = null;

    for (let j = 0; j < scene.steps.length; j++) {
      const step = scene.steps[j];
      if (!step) continue;
      const stepRec: StepRecord = { i: j, type: step.type, ok: true, start_s: now(), end_s: 0 };
      try {
        await execStep(page, step, human);
        if (SETTLED.has(step.type)) await sleep(scene.settle_ms ?? settleDefault);
      } catch (e) {
        stepRec.ok = false;
        stepRec.error = errText(e);
        rec.status = "failed";
        rec.error = `step[${j}] ${step.type} failed: ${stepRec.error}`;
        sceneError = rec.error;
      }
      stepRec.end_s = now();
      rec.steps.push(stepRec);
      if (sceneError) break;
    }

    if (!sceneError && (scene.hold_ms ?? 0) > 0) await sleep(scene.hold_ms ?? 0);
    rec.end_s = now();
    out.scenes.push(rec);
    if (opts.onSceneEnd) await opts.onSceneEnd(rec, i);

    if (sceneError && !dryRun) {
      console.log(`✖ scene '${scene.id}' failed — aborting (${sceneError})`);
      console.log(
        "partial scenes.json written; fix the storyboard (or the selector), then re-run.",
      );
      aborted = true;
    } else if (sceneError) {
      console.log(`✖ scene '${scene.id}' failed (continuing dry run): ${sceneError}`);
    } else if (mode === "step" && i < sb.scenes.length - 1) {
      await pressEnter(
        `✔ scene '${scene.id}' done (${(rec.end_s - rec.start_s).toFixed(1)}s) — ENTER for next, Ctrl+C to stop\n> `,
      );
    }
  }

  if (!dryRun) {
    try {
      const p = await page.video()?.path();
      out.meta.video = p ? path.relative(runDir, p) : null;
    } catch {
      // video path unavailable — leave null, the file is still under recordings/
    }
  }
  await context.close();
  rl?.close();
  await fs.promises.writeFile(
    path.join(runDir, "scenes.json"),
    `${JSON.stringify(out, null, 2)}\n`,
  );
  return out;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const runDir = args.find((a) => !a.startsWith("--"));
  if (!runDir) {
    console.error(
      "usage: record.ts <run-dir> [--mode watch|step|dry-run] [--headless] [--auto-start]",
    );
    return 2;
  }
  const has = (f: string) => args.includes(`--${f}`);
  const modeArg = args[args.indexOf("--mode") + 1] as RunMode | undefined;
  const mode: RunMode =
    modeArg === "step" || modeArg === "dry-run" || modeArg === "watch" ? modeArg : "watch";

  const out = await runRecording({
    runDir,
    mode,
    headless: has("headless"),
    autoStart: has("auto-start"),
    rawInput: has("raw-input"),
  });

  console.log(`\n=== ${out.meta.mode} summary ===`);
  for (const s of out.scenes) {
    const dur = (s.end_s - s.start_s).toFixed(1);
    const mark = s.status === "recorded" ? "✔" : s.status === "skipped" ? "⏭" : "✖";
    console.log(`${mark} ${s.id.padEnd(28)} ${dur}s ${s.status}${s.error ? ` — ${s.error}` : ""}`);
  }
  if (out.meta.video) console.log(`video: ${out.meta.video}`);
  console.log("scenes.json written");
  const failed = out.scenes.some((s) => s.status === "failed");
  if (!failed && out.meta.mode !== "dry-run") {
    console.log("next (pending): vo.py narration → tts.py → assemble.py");
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
