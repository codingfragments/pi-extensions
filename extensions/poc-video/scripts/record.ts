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
 *   --mode dry-run  slowMo walk, NO recordVideo, RAW input — cheap selector validation
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
 * Usage: node scripts/record.ts <run-dir> [--mode watch|step|dry-run] [--headless] [--auto-start] [--raw-input] [--bus [--bus-port N]]
 */
import { parse, stringify } from "yaml";
import { ControlBus } from "../control-bus.ts";
import type { BusCommand } from "../control-bus.ts";
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
  retake?: boolean;
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
  /** start the control bus (localhost WebSocket) — events out, commands in */
  bus?: boolean;
  /** fixed port for the bus (default: pick a free one) */
  busPort?: number;
  /** called with the ws:// URL once the bus is listening */
  onBusReady?: (url: string) => void;
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
  /** 1 = original take, 2+ = retake attempts (control-bus `retake` command) */
  attempt?: number;
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

/** Scene fields a control-bus `set` command may mutate — validated before persist. */
const EDITABLE_FIELDS = new Set([
  "settle_ms",
  "hold_ms",
  "budget_s",
  "title",
  "intent",
  "narration_gist",
  "skip",
  "retake",
]);

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

  // runner-managed flags reset at run start (schema: authored values are dropped)
  for (const s of sb.scenes) {
    s.skip = false;
    s.retake = false;
  }

  // ---- control bus — the runner is the SINGLE WRITER of storyboard.yaml ----
  let bus: ControlBus | null = null;
  const paused = { flag: false };
  let abortRequested = false;
  let storyboardDirty = false;

  const waitIfPaused = async (): Promise<void> => {
    while (paused.flag) await sleep(150);
  };

  const persistStoryboard = async (): Promise<void> => {
    // NOTE: the runner is the single writer; its rewrites drop hand-authored
    // YAML comments (the panel is the surface, the file is the state).
    await fs.promises.writeFile(sbPath, `${stringify(sb)}\n`);
    storyboardDirty = false;
    bus?.broadcast({ type: "storyboard_state_changed", storyboard: sb });
  };

  const sceneById = (id: string): Scene | undefined => sb.scenes.find((s) => s.id === id);

  const handleCommand = async (cmd: BusCommand): Promise<void> => {
    if (!bus) return;
    try {
      switch (cmd.type) {
        case "pause":
          paused.flag = true;
          bus.broadcast({ type: "run_status", status: "paused" });
          break;
        case "resume":
          paused.flag = false;
          bus.broadcast({ type: "run_status", status: "recording" });
          break;
        case "abort":
          abortRequested = true;
          bus.broadcast({ type: "run_status", status: "aborted" });
          break;
        case "retake": {
          const scene = sceneById(cmd.id);
          if (!scene) {
            bus.broadcast({
              type: "error",
              message: `retake: unknown scene '${cmd.id}'`,
              command: cmd,
            });
            break;
          }
          scene.retake = true;
          await persistStoryboard();
          break;
        }
        case "skip": {
          const scene = sceneById(cmd.id);
          if (!scene) {
            bus.broadcast({
              type: "error",
              message: `skip: unknown scene '${cmd.id}'`,
              command: cmd,
            });
            break;
          }
          scene.skip = cmd.value ?? true;
          await persistStoryboard();
          break;
        }
        case "set": {
          const scene = sceneById(cmd.id);
          if (!scene) {
            bus.broadcast({
              type: "error",
              message: `set: unknown scene '${cmd.id}'`,
              command: cmd,
            });
            break;
          }
          if (!EDITABLE_FIELDS.has(cmd.field)) {
            bus.broadcast({
              type: "error",
              message: `set: field '${cmd.field}' is not editable (known: ${[...EDITABLE_FIELDS].join(", ")})`,
              command: cmd,
            });
            break;
          }
          const holder = scene as unknown as Record<string, unknown>;
          const prev = holder[cmd.field];
          holder[cmd.field] = cmd.value;
          const r = new Report();
          validateStoryboard(sb, r);
          if (!r.ok) {
            holder[cmd.field] = prev; // rejected edits never touch disk
            bus.broadcast({
              type: "error",
              message: `edit rejected: ${r.errors.join("; ")}`,
              command: cmd,
            });
            break;
          }
          await persistStoryboard();
          break;
        }
        case "get_state":
          bus.broadcast({ type: "storyboard_state_changed", storyboard: sb });
          break;
      }
    } catch (e) {
      bus.broadcast({ type: "error", message: `command failed: ${errText(e)}`, command: cmd });
    }
  };

  if (opts.bus) {
    bus = new ControlBus();
    const port = await bus.start(opts.busPort ?? 0);
    const url = `ws://localhost:${port}`;
    console.log(`control bus: ${url} — events out; pause/resume/retake/skip/set in`);
    opts.onBusReady?.(url);
    bus.onConnect(() => {
      bus?.broadcast({ type: "run_status", status: paused.flag ? "paused" : "recording" });
      bus?.broadcast({ type: "storyboard_state_changed", storyboard: sb });
    });
    bus.onCommand((cmd) => {
      void handleCommand(cmd);
    });
  }

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
  // Human input is a RECORDING property. In dry-run it actively hurts: each
  // ghost-cursor glide is dozens of mouse.move calls, and slowMo (on in
  // dry-run) delays every one of them — a 1s validation pass ballooned to
  // 15-25s. Dry-run is selector validation; it runs raw by default.
  const human = opts.rawInput || dryRun ? null : await createHumanInput(page);
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

  // in bus mode, wait for the first client before starting — someone is
  // watching (panel or scripted client); the URL was printed above
  if (bus) {
    while (bus.clientCount === 0) await sleep(150);
    bus.broadcast({
      type: "run_started",
      mode,
      sceneIds: sb.scenes.map((s) => s.id),
      storyboard: sb,
    });
  }

  const executeScene = async (scene: Scene, index: number, attempt = 1): Promise<SceneRecord> => {
    bus?.broadcast({
      type: "scene_started",
      index,
      id: scene.id,
      title: scene.title,
      intent: scene.intent,
    });
    const rec: SceneRecord = {
      id: scene.id,
      status: "recorded",
      start_s: now(),
      end_s: 0,
      hold_ms: scene.hold_ms ?? 0,
      steps: [],
      attempt,
    };
    let sceneError: string | null = null;

    for (let j = 0; j < scene.steps.length; j++) {
      const step = scene.steps[j];
      if (!step) continue;
      bus?.broadcast({
        type: "action",
        index,
        stepIndex: j,
        stepType: step.type,
        selector: step.selector,
      });
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
    bus?.broadcast({ type: "scene_finished", record: rec });
    return rec;
  };

  let aborted = false;
  for (let i = 0; i < sb.scenes.length && !aborted; i++) {
    await waitIfPaused();
    if (abortRequested) {
      aborted = true;
      break;
    }
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

    const rec = await executeScene(scene, i);
    out.scenes.push(rec);
    if (opts.onSceneEnd) await opts.onSceneEnd(rec, i);

    if (rec.status === "failed" && !dryRun) {
      console.log(`✖ scene '${scene.id}' failed — aborting (${rec.error})`);
      console.log(
        "partial scenes.json written; fix the storyboard (or the selector), then re-run.",
      );
      aborted = true;
    } else if (rec.status === "failed") {
      console.log(`✖ scene '${scene.id}' failed (continuing dry run): ${rec.error}`);
    } else if (mode === "step" && i < sb.scenes.length - 1) {
      await pressEnter(
        `✔ scene '${scene.id}' done (${(rec.end_s - rec.start_s).toFixed(1)}s) — ENTER for next, Ctrl+C to stop\n> `,
      );
    }
  }

  // retake pass: scenes marked retake (by command, mid-run or after the fact)
  // are replayed; their record is replaced by the new attempt
  for (const scene of sb.scenes) {
    if (abortRequested) {
      aborted = true;
      break;
    }
    if (!scene?.retake || scene.skip) continue;
    await waitIfPaused();
    console.log(`↺ retaking scene '${scene.id}'`);
    const rec = await executeScene(scene, sb.scenes.indexOf(scene), 2);
    const idx = out.scenes.findIndex((r) => r.id === scene.id);
    if (idx >= 0) out.scenes[idx] = rec;
    else out.scenes.push(rec);
    scene.retake = false;
    storyboardDirty = true;
  }
  if (abortRequested) aborted = true;

  if (storyboardDirty) await persistStoryboard();

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
  if (bus) {
    bus.broadcast({ type: "run_finished", scenes: out.scenes, video: out.meta.video });
    bus.broadcast({ type: "run_status", status: aborted ? "aborted" : "finished" });
    await bus.stop();
  }
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
  const intOpt = (name: string): number | undefined => {
    const i = args.indexOf(`--${name}`);
    const v = i >= 0 ? Number(args[i + 1]) : undefined;
    return Number.isFinite(v) ? v : undefined;
  };
  const modeArg = args[args.indexOf("--mode") + 1] as RunMode | undefined;
  const mode: RunMode =
    modeArg === "step" || modeArg === "dry-run" || modeArg === "watch" ? modeArg : "watch";

  const out = await runRecording({
    runDir,
    mode,
    headless: has("headless"),
    autoStart: has("auto-start"),
    rawInput: has("raw-input"),
    bus: has("bus"),
    busPort: intOpt("bus-port"),
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
