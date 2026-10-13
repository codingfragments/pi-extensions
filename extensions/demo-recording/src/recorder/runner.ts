/**
 * Storyboard runner (S1): records one continuous take (D8) of a storyboard.
 *
 *   takes/take-NNN/
 *     frames/ 000001.jpg … frames.ffconcat
 *     frames.jsonl   events.jsonl   take.json   raw.mp4
 *
 * Every step logs its key moment on the screencast clock; `mark`s become VO
 * anchors later. S3 adds human typing/scroll models, improvise, observers and
 * resume; the take layout and event contract stay the same.
 */

import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import {
  type CaptureResult,
  Screencast,
  type ScreencastOptions,
  encodeMaster,
} from "../browser/capture/screencast.ts";
import { Cursor, aimPoint } from "../browser/cursor/motion.ts";
import { openSession } from "../browser/session.ts";
import type { Step, Storyboard } from "../storyboard/types.ts";
import { sleep } from "../util/duration.ts";
import { type Rng, createRng, randomSeed } from "../util/rng.ts";
import { createNextNumberedDir } from "../workdir/versioning.ts";
import { EventLog, type TakeEvent } from "./events.ts";
import { describeTarget, locate, resolveBox } from "./targets.ts";

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
}

export interface SceneSpan {
  id: string;
  title: string;
  start: number;
  end: number;
}

export interface TakeResult {
  takeId: string;
  takeDir: string;
  events: TakeEvent[];
  scenes: SceneSpan[];
  capture: CaptureResult["stats"];
  rawVideo?: string;
  encodeMs?: number;
  durationMs: number;
}

const DEFAULT_DWELL: Record<Step["do"], number> = {
  goto: 500,
  move: 150,
  hover: 900,
  click: 350,
  type: 400,
  press: 250,
  wait: 600,
  pause: 0,
};

const LEAD_IN_MS = 700;
const TAIL_MS = 900;

class StepRunner {
  private readonly page: Page;
  private readonly cursor: Cursor;
  private readonly rng: Rng;
  private readonly log: EventLog;
  private readonly baseUrl: string;

  constructor(page: Page, cursor: Cursor, rng: Rng, log: EventLog, baseUrl: string) {
    this.page = page;
    this.cursor = cursor;
    this.rng = rng;
    this.log = log;
    this.baseUrl = baseUrl;
  }

  async run(step: Step, scene: string, index: number): Promise<void> {
    const at = { scene, step: index };
    const mark = step.mark ? { mark: step.mark } : {};
    switch (step.do) {
      case "goto": {
        await this.page.goto(new URL(step.url, this.baseUrl).toString(), { waitUntil: "load" });
        this.log.log("navigate", { ...at, ...mark, data: { url: this.page.url() } });
        break;
      }
      case "move":
      case "hover": {
        const { box } = await resolveBox(this.page, step.target);
        await this.cursor.moveTo(aimPoint(box, this.rng), box.w);
        this.log.log(step.do, {
          ...at,
          ...mark,
          box,
          data: { target: describeTarget(step.target) },
        });
        break;
      }
      case "click": {
        const { box } = await resolveBox(this.page, step.target);
        await this.cursor.moveTo(aimPoint(box, this.rng), box.w);
        this.log.log("click", {
          ...at,
          ...mark,
          box,
          data: { target: describeTarget(step.target) },
        });
        await this.cursor.click();
        break;
      }
      case "type": {
        let box: TakeEvent["box"];
        if (step.target) {
          ({ box } = await resolveBox(this.page, step.target));
          await this.cursor.moveTo(aimPoint(box, this.rng), box.w);
          this.log.log("click", {
            ...at,
            box,
            data: { target: describeTarget(step.target), for: "focus" },
          });
          await this.cursor.click();
          await sleep(this.rng.range(180, 320));
        }
        if (step.clear) {
          await this.page.keyboard.press("ControlOrMeta+A");
          await this.page.keyboard.press("Backspace");
        }
        this.log.log("type-start", {
          ...at,
          ...mark,
          ...(box ? { box } : {}),
          data: { text: step.text },
        });
        for (const ch of step.text) {
          await this.page.keyboard.type(ch);
          await sleep(this.rng.range(55, 150) + (ch === " " ? this.rng.range(40, 120) : 0));
        }
        this.log.log("type-end", { ...at });
        break;
      }
      case "press": {
        this.log.log("press", { ...at, ...mark, data: { key: step.key } });
        await this.page.keyboard.press(step.key);
        break;
      }
      case "wait": {
        if ("ms" in step.for) {
          await sleep(step.for.ms);
          this.log.log("wait-satisfied", { ...at, ...mark });
          break;
        }
        const locator = locate(this.page, step.for);
        try {
          await locator.waitFor({ state: "visible", timeout: step.timeout });
        } catch {
          throw new Error(
            `wait timed out after ${step.timeout} ms for ${describeTarget(step.for)}`,
          );
        }
        const bb = await locator.boundingBox();
        this.log.log("wait-satisfied", {
          ...at,
          ...mark,
          ...(bb
            ? {
                box: {
                  x: Math.round(bb.x),
                  y: Math.round(bb.y),
                  w: Math.round(bb.width),
                  h: Math.round(bb.height),
                },
              }
            : {}),
          data: { for: describeTarget(step.for) },
        });
        break;
      }
      case "pause":
        await sleep(step.ms);
        break;
    }
    const dwell = step.dwell ?? DEFAULT_DWELL[step.do];
    if (dwell > 0) await sleep(dwell * this.rng.range(0.9, 1.1));
  }
}

function sceneSpans(events: TakeEvent[], storyboard: Storyboard): SceneSpan[] {
  return storyboard.scenes.flatMap((s) => {
    const start = events.find((e) => e.type === "scene-start" && e.scene === s.id);
    const end = events.find((e) => e.type === "scene-end" && e.scene === s.id);
    return start && end ? [{ id: s.id, title: s.title, start: start.t, end: end.t }] : [];
  });
}

export async function recordTake(opts: RecordOptions): Promise<TakeResult> {
  const { file: takeDir } = createNextNumberedDir(path.join(opts.projectDir, "takes"), "take-");
  const takeId = path.basename(takeDir);
  const seed = opts.seed ?? randomSeed();
  const rng = createRng(seed);
  const log = new EventLog(path.join(takeDir, "events.jsonl"), opts.onEvent);
  const takeMeta: Record<string, unknown> = {
    schema: 1,
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

  const session = await openSession({
    viewport: opts.viewport,
    ...(opts.headed ? { headed: true } : {}),
    ...(opts.storageState ? { storageState: opts.storageState } : {}),
  });
  let capture: CaptureResult | undefined;
  let screencast: Screencast | undefined;
  try {
    const { page } = session;
    // Off-camera setup: load the start page and let it settle.
    await page.goto(new URL(opts.storyboard.start_url, opts.baseUrl).toString(), {
      waitUntil: "load",
    });
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    const cursor = new Cursor(page, rng, {
      x: Math.round(opts.viewport.width * 0.62),
      y: Math.round(opts.viewport.height * 0.58),
    });
    await cursor.place(cursor.pos);
    await sleep(300);

    const cdp = await session.context.newCDPSession(page);
    screencast = new Screencast(cdp, path.join(takeDir, "frames"), opts.capture);
    const t0 = await screencast.start();
    log.setOrigin(t0);
    takeMeta.t0 = t0;
    log.log("take-start", { data: { url: page.url() } });
    await sleep(LEAD_IN_MS);

    const runner = new StepRunner(page, cursor, rng, log, opts.baseUrl);
    for (const scene of opts.storyboard.scenes) {
      log.log("scene-start", { scene: scene.id, data: { title: scene.title } });
      for (const [i, step] of scene.steps.entries()) {
        try {
          await runner.run(step, scene.id, i);
        } catch (err) {
          log.log("error", { scene: scene.id, step: i, data: { message: (err as Error).message } });
          throw new Error(`scene ${scene.id}, step ${i} (${step.do}): ${(err as Error).message}`);
        }
      }
      log.log("scene-end", { scene: scene.id });
    }
    await sleep(TAIL_MS);
    log.log("take-end");
    capture = await screencast.stop();
    screencast = undefined;
  } catch (err) {
    if (screencast) capture = await screencast.stop().catch(() => undefined);
    takeMeta.status = "failed";
    takeMeta.error = (err as Error).message;
    if (capture) takeMeta.captureStats = capture.stats;
    writeMeta();
    throw err;
  } finally {
    await session.close();
  }

  const scenes = sceneSpans(log.events, opts.storyboard);
  fs.writeFileSync(path.join(takeDir, "scenes.json"), `${JSON.stringify(scenes, null, 2)}\n`);
  takeMeta.durationMs = capture.endTs - capture.t0;
  takeMeta.captureStats = capture.stats;
  takeMeta.status = "captured";
  writeMeta();

  const result: TakeResult = {
    takeId,
    takeDir,
    events: log.events,
    scenes,
    capture: capture.stats,
    durationMs: capture.endTs - capture.t0,
  };
  if (opts.encode !== false) {
    const rawVideo = path.join(takeDir, "raw.mp4");
    result.encodeMs = await encodeMaster(takeDir, capture, rawVideo, { fps: opts.fps });
    result.rawVideo = rawVideo;
    takeMeta.encodeMs = result.encodeMs;
    takeMeta.status = "ok";
    writeMeta();
  }
  return result;
}
