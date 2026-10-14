/**
 * Storyboard runner: records one continuous take (D8) of a storyboard.
 *
 *   takes/take-NNN/
 *     frames/ s1-000001.jpg … frames.ffconcat
 *     frames.jsonl  events.jsonl  attempts.jsonl  take.json  scenes.json  raw.mp4
 *
 * S3:
 * - human motion/typing (cursor/motion.ts, cursor/typing.ts), idle drift on dwell
 * - page observers → route / alert / idle-start|end / console-error events
 * - `improvise` steps: a fast model invents the input while the cursor travels
 * - resume: a failing scene is cut at its start, the app is restored off-camera
 *   (deep_link, or a fast replay of the previous scenes), and capture resumes
 *   as a new SEGMENT stitched at that boundary — previous good footage is kept
 * - progress snapshots for the panel/footer, cancellation via AbortSignal
 */

import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import {
  type CaptureResult,
  type FrameRecord,
  Screencast,
  type ScreencastOptions,
  computeStats,
  encodeMaster,
} from "../browser/capture/screencast.ts";
import { Cursor, type Point, aimPoint } from "../browser/cursor/motion.ts";
import { typeHuman } from "../browser/cursor/typing.ts";
import { installObservers } from "../browser/observers.ts";
import { waitForDomQuiet } from "../browser/quiet.ts";
import { type BrowserSession, openSession } from "../browser/session.ts";
import type { Scene, Step, Storyboard, Target } from "../storyboard/types.ts";
import { sleep } from "../util/duration.ts";
import { type Rng, createRng, randomSeed } from "../util/rng.ts";
import { createNextNumberedDir } from "../workdir/versioning.ts";
import { EventLog, type TakeEvent } from "./events.ts";
import type { Improviser } from "./improvise.ts";
import { LayoutRecorder, captureLayout } from "./layout.ts";
import { DEFAULT_DWELL, type ProgressSnapshot, ProgressTracker } from "./progress.ts";
import { replayHazards } from "./replay-guard.ts";
import { describeTarget, locate, resolveBox } from "./targets.ts";

export interface FaultInjection {
  scene: string;
  step: number;
  /** Attempt numbers (1-based) on which to fail. Default [1]. */
  attempts?: number[];
  /** error: throw; crash: close the browser (simulates a renderer crash). */
  kind?: "error" | "crash";
}

export interface RecordOptions {
  projectDir: string;
  storyboard: Storyboard;
  storyboardVersion: number;
  /** Base URL that relative storyboard URLs resolve against. */
  baseUrl: string;
  viewport: { width: number; height: number; dpr: number };
  fps: number;
  capture?: ScreencastOptions;
  headed?: boolean;
  seed?: number;
  storageState?: string;
  /** Encode raw.mp4 after capture (default true). */
  encode?: boolean;
  onEvent?: (e: TakeEvent) => void;
  onProgress?: (p: ProgressSnapshot) => void;
  signal?: AbortSignal;
  /** Live input generation for `improvise` steps. */
  improviser?: Improviser;
  /** Short brief context passed to the improviser. */
  improviseContext?: string;
  /** How long the cursor may "hesitate" waiting for an improvised input (ms). */
  hesitateMs?: number;
  /** Retries per scene before the take fails (default 2). */
  maxRetriesPerScene?: number;
  /** Typo-and-correct probability per letter (default 0). */
  typoRate?: number;
  /** Resume by replaying even when earlier scenes change state (default false). */
  allowUnsafeReplay?: boolean;
  /** Keep the raw JPEG frames after a successful encode (default false: raw.mp4 is the master). */
  keepFrames?: boolean;
  /** Test hook. */
  faultInjection?: FaultInjection;
}

export interface SceneSpan {
  id: string;
  title: string;
  start: number;
  end: number;
}

export interface SegmentInfo {
  index: number;
  /** Take time where this segment starts. */
  start: number;
  end: number;
  frames: number;
  /** Why the previous segment ended (absent for the first). */
  resumedAfter?: { scene: string; attempt: number; error: string };
}

export interface TakeResult {
  takeId: string;
  takeDir: string;
  events: TakeEvent[];
  scenes: SceneSpan[];
  segments: SegmentInfo[];
  capture: CaptureResult["stats"];
  rawVideo?: string;
  encodeMs?: number;
  durationMs: number;
}

const LEAD_IN_MS = 700;
const TAIL_MS = 900;

class CancelledError extends Error {}

function boxOf(
  bb: { x: number; y: number; width: number; height: number } | null,
): TakeEvent["box"] | undefined {
  return bb
    ? {
        x: Math.round(bb.x),
        y: Math.round(bb.y),
        w: Math.round(bb.width),
        h: Math.round(bb.height),
      }
    : undefined;
}

interface RunCtx {
  page: Page;
  cursor: Cursor;
  rng: Rng;
  log: EventLog;
  /** Fast off-camera replay: no animation, no dwell, nothing logged. */
  fast: boolean;
}

class StepRunner {
  private readonly opts: RecordOptions;
  /** Improvised inputs by `scene:step`, reused verbatim on replay. */
  readonly improvised = new Map<string, string>();
  /** Pending page-text snapshots at marks (awaited at take end). */
  readonly snapshots: Promise<void>[] = [];
  /** Where mark snapshots go (`<take>/dom/<mark>.yaml`). */
  domDir?: string;
  /** Layout snapshots (S5 part 6): after each step settles and at marks. */
  layout?: LayoutRecorder;
  /** Background settle work (layout + settled target boxes); flushed at scene end. */
  private pending: Promise<void>[] = [];

  /** Wait for the background settle work (bounded), so its events stay inside the scene. */
  async flush(maxMs = 2000): Promise<void> {
    const all = this.pending.splice(0);
    if (!all.length) return;
    await Promise.race([Promise.all(all), sleep(maxMs)]);
  }

  private captureLayout(
    c: RunCtx,
    reason: "settle" | "mark",
    fields: { scene?: string; step?: number; mark?: string },
  ): Promise<void> {
    const layout = this.layout;
    if (!layout) return Promise.resolve();
    return captureLayout(c.page).then((snap) => {
      if (!snap) return;
      const t = c.log.toTake(Date.now());
      if (!layout.allow(reason, t)) return;
      layout.write({ t, reason, ...fields, ...snap });
    });
  }

  /**
   * After a step, once the page is quiet (≤ 1.5 s): a layout snapshot, and the
   * step target's box again — elements often move just after an action (a
   * banner appears, a list re-sorts). Runs in the background; the cursor goes on.
   */
  private afterStep(
    c: RunCtx,
    scene: string,
    step: number,
    target: Target | undefined,
    box: TakeEvent["box"] | undefined,
    mark?: string,
  ): void {
    if (c.fast || !this.layout) return;
    this.pending.push(
      (async () => {
        await waitForDomQuiet(c.page, 250, 1500);
        if (target) {
          const settled = boxOf(
            await locate(c.page, target)
              .first()
              .boundingBox({ timeout: 500 })
              .catch(() => null),
          );
          if (settled) {
            const moved =
              !box ||
              Math.abs(settled.x - box.x) > 2 ||
              Math.abs(settled.y - box.y) > 2 ||
              Math.abs(settled.w - box.w) > 2 ||
              Math.abs(settled.h - box.h) > 2;
            c.log.log("target-settled", {
              scene,
              step,
              box: settled,
              // Not a top-level mark: marks are VO anchors and must stay unique per take.
              data: { moved, target: describeTarget(target), ...(mark ? { forMark: mark } : {}) },
            });
          }
        }
        await this.captureLayout(c, "settle", { scene, step });
      })().catch(() => {}),
    );
  }

  constructor(opts: RecordOptions) {
    this.opts = opts;
  }

  private emit(c: RunCtx, type: string, fields: Omit<TakeEvent, "t" | "type"> = {}): void {
    if (c.fast) return;
    c.log.log(type, fields);
    // Exact on-screen values for the voice-over (D4: DOM as the precision layer).
    // Fire-and-forget so the cursor never waits on it.
    if (fields.mark && this.layout) {
      this.pending.push(
        this.captureLayout(c, "mark", {
          mark: fields.mark,
          ...(fields.scene ? { scene: fields.scene } : {}),
          ...(fields.step !== undefined ? { step: fields.step } : {}),
        }).catch(() => {}),
      );
    }
    if (fields.mark && this.domDir) {
      const file = path.join(this.domDir, `${fields.mark}.yaml`);
      const dir = this.domDir;
      this.snapshots.push(
        c.page
          .locator("body")
          .ariaSnapshot({ timeout: 3000 })
          .then((snap) => {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(file, snap);
          })
          .catch(() => {}),
      );
    }
  }

  private async dwell(c: RunCtx, ms: number): Promise<void> {
    if (c.fast || ms <= 0) return;
    await c.cursor.drift(Math.round(ms * c.rng.range(0.9, 1.1)));
  }

  private async moveTo(
    c: RunCtx,
    target: Parameters<typeof resolveBox>[1],
  ): Promise<NonNullable<TakeEvent["box"]>> {
    const { box } = await resolveBox(c.page, target);
    await c.cursor.moveTo(aimPoint(box, c.rng), box.w);
    return box;
  }

  async run(c: RunCtx, step: Step, scene: string, index: number): Promise<void> {
    const at = { scene, step: index };
    const mark = step.mark ? { mark: step.mark } : {};
    // For the settled-box check after the step (steps that act on a target).
    let target: Target | undefined;
    let actedBox: TakeEvent["box"] | undefined;
    switch (step.do) {
      case "goto": {
        await c.page.goto(new URL(step.url, this.opts.baseUrl).toString(), { waitUntil: "load" });
        if (!c.fast) await waitForDomQuiet(c.page, 300, 3000);
        this.emit(c, "navigate", { ...at, ...mark, data: { url: c.page.url() } });
        break;
      }
      case "move":
      case "hover": {
        const box = await this.moveTo(c, step.target);
        target = step.target;
        actedBox = box;
        this.emit(c, step.do, {
          ...at,
          ...mark,
          box,
          data: { target: describeTarget(step.target) },
        });
        break;
      }
      case "click": {
        const box = await this.moveTo(c, step.target);
        target = step.target;
        actedBox = box;
        this.emit(c, "click", {
          ...at,
          ...mark,
          box,
          data: { target: describeTarget(step.target) },
        });
        await c.cursor.click();
        break;
      }
      case "type": {
        let box: TakeEvent["box"];
        if (step.target) {
          box = await this.moveTo(c, step.target);
          target = step.target;
          actedBox = box;
          this.emit(c, "click", {
            ...at,
            box,
            data: { target: describeTarget(step.target), for: "focus" },
          });
          await c.cursor.click();
          if (!c.fast) await sleep(c.rng.range(180, 320));
        }
        if (step.clear) {
          await c.page.keyboard.press("ControlOrMeta+A");
          await c.page.keyboard.press("Backspace");
        }
        this.emit(c, "type-start", {
          ...at,
          ...mark,
          ...(box ? { box } : {}),
          data: { text: step.text },
        });
        await typeHuman(c.page, step.text, c.rng, { typoRate: this.opts.typoRate ?? 0 }, c.fast);
        this.emit(c, "type-end", { ...at });
        break;
      }
      case "improvise": {
        await this.improvise(c, step, scene, index);
        break;
      }
      case "press": {
        this.emit(c, "press", { ...at, ...mark, data: { key: step.key } });
        await c.page.keyboard.press(step.key);
        break;
      }
      case "wait": {
        if ("ms" in step.for) {
          if (!c.fast) await sleep(step.for.ms);
          this.emit(c, "wait-satisfied", { ...at, ...mark });
          break;
        }
        const locator = locate(c.page, step.for);
        try {
          await locator.waitFor({ state: "visible", timeout: step.timeout });
        } catch {
          throw new Error(
            `wait timed out after ${step.timeout} ms for ${describeTarget(step.for)}`,
          );
        }
        const box = boxOf(await locator.boundingBox());
        target = step.for;
        actedBox = box;
        this.emit(c, "wait-satisfied", {
          ...at,
          ...mark,
          ...(box ? { box } : {}),
          data: { for: describeTarget(step.for) },
        });
        break;
      }
      case "pause":
        if (!c.fast) await sleep(step.ms);
        break;
      case "scroll": {
        let dy = step.dy ?? 0;
        if (step.target) {
          const locator = locate(c.page, step.target);
          await locator.waitFor({ state: "attached", timeout: 10000 });
          const bb = await locator.boundingBox();
          const vh = c.page.viewportSize()?.height ?? 900;
          if (bb) dy = Math.round(bb.y + bb.height / 2 - vh * 0.45);
        }
        this.emit(c, "scroll-start", { ...at, ...mark, data: { dy } });
        await c.cursor.scrollBy(dy);
        this.emit(c, "scroll-end", { ...at });
        break;
      }
    }
    this.afterStep(c, scene, index, target, actedBox, step.mark);
    await this.dwell(c, step.dwell ?? DEFAULT_DWELL[step.do]);
  }

  private async improvise(
    c: RunCtx,
    step: Extract<Step, { do: "improvise" }>,
    scene: string,
    index: number,
  ): Promise<void> {
    const at = { scene, step: index };
    const key = `${scene}:${index}`;
    const known = this.improvised.get(key);
    const { box } = await resolveBox(c.page, step.target);

    // Start generation BEFORE the cursor moves: latency hides behind the travel.
    let pending: Promise<{ text: string; model: string; ms: number }> | undefined;
    if (known === undefined && this.opts.improviser) {
      const digest = (
        await c.page
          .locator("body")
          .ariaSnapshot({ timeout: 3000 })
          .catch(() => "")
      ).slice(0, 6000);
      const screenshot = step.vision
        ? await c.page
            .screenshot({ type: "jpeg", quality: 60, scale: "css" })
            .catch(() => undefined)
        : undefined;
      pending = this.opts.improviser.generate({
        prompt: step.prompt,
        maxChars: step.max_chars,
        target: describeTarget(step.target),
        digest,
        ...(screenshot ? { screenshot } : {}),
        ...(this.opts.improviseContext ? { context: this.opts.improviseContext } : {}),
      });
      pending.catch(() => {}); // handled below
      this.emit(c, "improvise-start", { ...at, data: { prompt: step.prompt } });
    }

    await c.cursor.moveTo(aimPoint(box, c.rng), box.w);
    this.emit(c, "click", {
      ...at,
      box,
      data: { target: describeTarget(step.target), for: "focus" },
    });
    await c.cursor.click();

    let text = known;
    let source = known !== undefined ? "replay" : "model";
    if (text === undefined && pending) {
      let settled:
        | { ok: true; v: { text: string; model: string; ms: number } }
        | { ok: false; e: Error }
        | undefined;
      pending.then(
        (v) => {
          settled = { ok: true, v };
        },
        (e: Error) => {
          settled = { ok: false, e };
        },
      );
      const waitStart = Date.now();
      const deadline = waitStart + (this.opts.hesitateMs ?? 3000);
      // A human pause while "thinking" — small hand drift, no dead stop.
      while (!settled && Date.now() < deadline)
        await c.cursor.drift(Math.min(120, deadline - Date.now()));
      const waited = Date.now() - waitStart;
      if (settled?.ok) {
        text = settled.v.text;
        this.emit(c, "improvise-ready", {
          ...at,
          data: { text, model: settled.v.model, ms: settled.v.ms, hesitatedMs: waited },
        });
      } else {
        const reason = settled
          ? settled.e.message
          : `no input within ${this.opts.hesitateMs ?? 3000} ms`;
        this.emit(c, "improvise-failed", { ...at, data: { reason } });
        if (step.fallback) {
          text = step.fallback;
          source = "fallback";
        } else throw new Error(`improvise: ${reason} (add a fallback: to the step to keep going)`);
      }
    } else if (text === undefined) {
      if (!step.fallback)
        throw new Error("improvise: no model access configured and no fallback text");
      text = step.fallback;
      source = "fallback";
    }

    this.improvised.set(key, text);
    this.emit(c, "type-start", {
      ...at,
      ...(step.mark ? { mark: step.mark } : {}),
      box,
      data: { text, improvised: true, source },
    });
    await typeHuman(c.page, text, c.rng, { typoRate: this.opts.typoRate ?? 0 }, c.fast);
    this.emit(c, "type-end", { ...at });
    if (step.submit) {
      if (!c.fast) await sleep(c.rng.range(150, 300));
      this.emit(c, "press", { ...at, data: { key: "Enter" } });
      await c.page.keyboard.press("Enter");
    }
  }
}

function sceneSpans(events: TakeEvent[], storyboard: Storyboard): SceneSpan[] {
  return storyboard.scenes.flatMap((s) => {
    const start = events.find((e) => e.type === "scene-start" && e.scene === s.id);
    const end = events.find((e) => e.type === "scene-end" && e.scene === s.id);
    return start && end ? [{ id: s.id, title: s.title, start: start.t, end: end.t }] : [];
  });
}

interface Segment {
  index: number;
  screencast: Screencast;
  /** Take time at segment start. */
  offset: number;
  t0: number;
  resumedAfter?: SegmentInfo["resumedAfter"];
  frames?: FrameRecord[];
  end?: number;
}

export async function recordTake(opts: RecordOptions): Promise<TakeResult> {
  const { file: takeDir } = createNextNumberedDir(path.join(opts.projectDir, "takes"), "take-");
  const takeId = path.basename(takeDir);
  const seed = opts.seed ?? randomSeed();
  const rng = createRng(seed);
  const log = new EventLog(path.join(takeDir, "events.jsonl"), opts.onEvent);
  const attemptsFile = path.join(takeDir, "attempts.jsonl");
  const maxRetries = opts.maxRetriesPerScene ?? 2;
  const takeMeta: Record<string, unknown> = {
    schema: 2,
    take: takeId,
    storyboardVersion: opts.storyboardVersion,
    baseUrl: opts.baseUrl,
    viewport: opts.viewport,
    fps: opts.fps,
    capture: opts.capture ?? {},
    seed,
    startedAt: new Date().toISOString(),
    status: "recording",
  };
  const writeMeta = () =>
    fs.writeFileSync(path.join(takeDir, "take.json"), `${JSON.stringify(takeMeta, null, 2)}\n`);
  writeMeta();

  const progress = new ProgressTracker(opts.storyboard);
  const report = () => opts.onProgress?.(progress.snapshot());
  const ticker = opts.onProgress ? setInterval(report, 1000) : undefined;
  const checkCancel = () => {
    if (opts.signal?.aborted) throw new CancelledError("recording cancelled");
  };

  let session: BrowserSession | undefined;
  let capturing = false;
  let currentScene: string | undefined;
  const segments: Segment[] = [];
  const runner = new StepRunner(opts);
  runner.domDir = path.join(takeDir, "dom");
  runner.layout = new LayoutRecorder(takeDir);
  let cursor!: Cursor;
  const startPos: Point = {
    x: Math.round(opts.viewport.width * 0.62),
    y: Math.round(opts.viewport.height * 0.58),
  };

  /** (Re)open the browser with the cursor overlay and observers wired to the log. */
  const openBrowser = async (): Promise<BrowserSession> => {
    const s = await openSession({
      viewport: opts.viewport,
      ...(opts.headed ? { headed: true } : {}),
      ...(opts.storageState ? { storageState: opts.storageState } : {}),
    });
    await installObservers(s.context, s.page, (e) => {
      if (!capturing) return;
      const { box, ...data } = e.data as { box?: TakeEvent["box"] } & Record<string, unknown>;
      log.log(
        e.type,
        { ...(currentScene ? { scene: currentScene } : {}), ...(box ? { box } : {}), data },
        e.at,
      );
    });
    return s;
  };

  const startSegment = async (
    offset: number,
    resumedAfter?: SegmentInfo["resumedAfter"],
  ): Promise<void> => {
    if (!session) throw new Error("no browser session");
    const cdp = await session.context.newCDPSession(session.page);
    const index = segments.length + 1;
    const screencast = new Screencast(cdp, path.join(takeDir, "frames"), {
      ...(opts.capture ?? {}),
      prefix: `s${index}-`,
    });
    const t0 = await screencast.start();
    log.setOrigin(t0, offset);
    capturing = true;
    segments.push({ index, screencast, offset, t0, ...(resumedAfter ? { resumedAfter } : {}) });
  };

  /** Stop the current segment and keep only frames before take time `cut`. */
  const endSegment = async (cut?: number): Promise<void> => {
    const seg = segments.at(-1);
    capturing = false;
    if (!seg || seg.frames) return;
    const res = await seg.screencast.stop().catch(() => undefined);
    const toTake = (ts: number) => ts - seg.t0 + seg.offset;
    const all = res?.frames ?? [];
    const end = cut ?? (res ? toTake(res.endTs) : seg.offset);
    seg.frames = all.filter((f) => toTake(f.ts) < end);
    seg.end = end;
    // Drop discarded frame files right away (failed attempts).
    for (const f of all)
      if (toTake(f.ts) >= end) fs.rmSync(path.join(takeDir, "frames", f.file), { force: true });
  };

  const settle = async (page: Page) => {
    await page.waitForLoadState("load").catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    await waitForDomQuiet(page, 400, 4000);
  };

  /** Restore the app to the start of scene k, off-camera. */
  const restoreTo = async (k: number, pos: Point): Promise<void> => {
    const scene = opts.storyboard.scenes[k] as Scene;
    if (!session || !session.browser.isConnected() || session.page.isClosed()) {
      await session?.close();
      session = await openBrowser();
    }
    const page = session.page;
    cursor = new Cursor(page, rng, pos);
    const c: RunCtx = { page, cursor, rng, log, fast: true };
    if (scene.deep_link) {
      await page.goto(new URL(scene.deep_link, opts.baseUrl).toString(), { waitUntil: "load" });
      await settle(page);
    } else {
      await page.goto(new URL(opts.storyboard.start_url, opts.baseUrl).toString(), {
        waitUntil: "load",
      });
      await settle(page);
      cursor.fast = true;
      for (const prev of opts.storyboard.scenes.slice(0, k)) {
        for (const [i, step] of prev.steps.entries()) await runner.run(c, step, prev.id, i);
      }
      await settle(page);
    }
    cursor.fast = false;
    await cursor.place(pos);
    await sleep(300);
  };

  let failure: Error | undefined;
  try {
    session = await openBrowser();
    await session.page.goto(new URL(opts.storyboard.start_url, opts.baseUrl).toString(), {
      waitUntil: "load",
    });
    await settle(session.page);
    cursor = new Cursor(session.page, rng, startPos);
    await cursor.place(startPos);
    await sleep(300);

    await startSegment(0);
    takeMeta.t0 = segments[0]?.t0;
    log.log("take-start", { data: { url: session.page.url() } });
    await sleep(LEAD_IN_MS);

    for (let k = 0; k < opts.storyboard.scenes.length; k++) {
      const scene = opts.storyboard.scenes[k] as Scene;
      let attempt = 1;
      for (;;) {
        checkCancel();
        currentScene = scene.id;
        const scenePos = { ...cursor.pos };
        const startEvent = log.log("scene-start", {
          scene: scene.id,
          data: { title: scene.title, attempt, cursor: scenePos },
        });
        try {
          const c: RunCtx = {
            page: (session as BrowserSession).page,
            cursor,
            rng,
            log,
            fast: false,
          };
          for (const [i, step] of scene.steps.entries()) {
            checkCancel();
            progress.startStep(k, i);
            report();
            const f = opts.faultInjection;
            if (
              f &&
              f.scene === scene.id &&
              f.step === i &&
              (f.attempts ?? [1]).includes(attempt)
            ) {
              if (f.kind === "crash") await (session as BrowserSession).browser.close();
              else throw new Error("injected fault");
            }
            try {
              await runner.run(c, step, scene.id, i);
            } catch (err) {
              throw new Error(
                `scene ${scene.id}, step ${i} (${step.do}): ${(err as Error).message}`,
              );
            }
            progress.finishStep(k, i);
          }
          await runner.flush();
          log.log("scene-end", { scene: scene.id });
          report();
          break;
        } catch (err) {
          if (err instanceof CancelledError) throw err;
          const message = (err as Error).message;
          // Cut the failed attempt out of the take at its scene-start.
          const cut = startEvent.t;
          await runner.flush();
          runner.layout?.discardFrom(cut);
          await endSegment(cut);
          const dropped = log.discardFrom(startEvent);
          fs.appendFileSync(
            attemptsFile,
            `${JSON.stringify({ scene: scene.id, attempt, error: message, events: dropped })}\n`,
          );
          if (attempt > maxRetries)
            throw new Error(`${message} (after ${attempt} attempt${attempt > 1 ? "s" : ""})`);
          const hazards = opts.allowUnsafeReplay ? [] : replayHazards(opts.storyboard.scenes, k);
          if (hazards.length) {
            throw new Error(
              `${message} — not resuming: scene ${scene.id} has no deep_link, and replaying earlier scenes would repeat ` +
                `state changes (${hazards.map((h) => `${h.scene} step ${h.step}: ${h.reason}`).join("; ")}). ` +
                `Add a deep_link to ${scene.id} so it can be re-shot from a URL.`,
            );
          }
          progress.restartScene(k);
          report();
          attempt++;
          await restoreTo(k, scenePos);
          await startSegment(cut, { scene: scene.id, attempt: attempt - 1, error: message });
          log.log("stitch", { scene: scene.id, data: { attempt, after: message } });
        }
      }
    }
    await sleep(TAIL_MS);
    await runner.flush();
    log.log("take-end");
    await endSegment();
    await Promise.all(runner.snapshots);
  } catch (err) {
    failure = err as Error;
    await endSegment().catch(() => {});
  } finally {
    if (ticker) clearInterval(ticker);
    await session?.close();
  }

  // Merge segments onto the take timeline.
  const frames = segments.flatMap((seg) =>
    (seg.frames ?? []).map((f) => ({
      ...f,
      t: Math.round(f.ts - seg.t0 + seg.offset),
      segment: seg.index,
    })),
  );
  frames.sort((a, b) => a.t - b.t);
  fs.writeFileSync(
    path.join(takeDir, "frames.jsonl"),
    frames.map((f) => `${JSON.stringify(f)}\n`).join(""),
  );
  const segmentInfo: SegmentInfo[] = segments.map((s) => ({
    index: s.index,
    start: s.offset,
    end: s.end ?? s.offset,
    frames: s.frames?.length ?? 0,
    ...(s.resumedAfter ? { resumedAfter: s.resumedAfter } : {}),
  }));
  takeMeta.segments = segmentInfo;
  const durationMs = segmentInfo.at(-1)?.end ?? 0;

  if (failure) {
    progress.phase = "failed";
    report();
    takeMeta.status = failure instanceof CancelledError ? "cancelled" : "failed";
    takeMeta.error = failure.message;
    takeMeta.durationMs = durationMs;
    writeMeta();
    throw failure;
  }
  if (!frames.length) throw new Error("screencast produced no frames");

  const scenes = sceneSpans(log.events, opts.storyboard);
  fs.writeFileSync(path.join(takeDir, "scenes.json"), `${JSON.stringify(scenes, null, 2)}\n`);
  const stats = computeStats(
    frames.map((f) => ({ ...f, ts: f.t })),
    0,
    durationMs,
    [],
    segments[0]?.screencast.frameSize,
  );
  takeMeta.durationMs = durationMs;
  takeMeta.captureStats = stats;
  takeMeta.layout = { snapshots: runner.layout?.count ?? 0, file: "layout.jsonl" };
  takeMeta.status = "captured";
  writeMeta();

  const result: TakeResult = {
    takeId,
    takeDir,
    events: log.events,
    scenes,
    segments: segmentInfo,
    capture: stats,
    durationMs,
  };
  if (opts.encode !== false) {
    progress.phase = "encoding";
    report();
    const rawVideo = path.join(takeDir, "raw.mp4");
    result.encodeMs = await encodeMaster(
      takeDir,
      { frames: frames.map((f) => ({ ...f, ts: f.t })), t0: 0, endTs: durationMs },
      rawVideo,
      { fps: opts.fps },
    );
    result.rawVideo = rawVideo;
    takeMeta.encodeMs = result.encodeMs;
    takeMeta.status = "ok";
    if (!opts.keepFrames) {
      // raw.mp4 (CRF 16, capture resolution) is the master; frames are ~2.6 MB/s.
      fs.rmSync(path.join(takeDir, "frames"), { recursive: true, force: true });
      takeMeta.frames = "pruned";
    }
    writeMeta();
  }
  progress.phase = "done";
  report();
  return result;
}
