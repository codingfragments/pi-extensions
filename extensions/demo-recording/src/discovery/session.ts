/**
 * Discovery browser (S2, Phase 1). The director explores the app through
 * `look` (screenshot = source of truth, D4, plus an aria digest for exact
 * values and targets) and `act` (virtual-cursor actions behind the safety net,
 * D6). Targets use the storyboard's own syntax, so anything that works here is
 * a valid storyboard target by construction.
 *
 *   apps/<app>/discovery/<yyyymmdd-hhmmss>/
 *     screens/sNNN.jpg   dom/sNNN.yaml   actions.jsonl   audit.jsonl   sitemap.json
 */

import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { Cursor, aimPoint } from "../browser/cursor/motion.ts";
import { killMarker, newMarker } from "../browser/processes.ts";
import { waitForDomQuiet } from "../browser/quiet.ts";
import {
  type ActionContext,
  type Policy,
  type SafetyVerdict,
  classify,
  loadPolicy,
} from "../browser/safety.ts";
import { type BrowserSession, openSession } from "../browser/session.ts";
import type { EventBus } from "../bus.ts";
import { describeTarget, locate, resolveBox } from "../recorder/targets.ts";
import type { Target } from "../storyboard/types.ts";
import { sleep } from "../util/duration.ts";
import { createRng } from "../util/rng.ts";
import { type AppInfo, appDir } from "../workdir/layout.ts";
import {
  attachPageLog,
  deepLogArgs,
  diagDir,
  diagnoseStall,
  startProcessSampler,
} from "./diagnostics.ts";
import { reduceDigest } from "./digest.ts";
import { type ExtensionState, NODE_CAP, allowedScroll, grew, measureExtent } from "./extent.ts";
import {
  type DirectorState,
  HEARTBEAT_DEFAULT_SEC,
  type HeartbeatFacts,
  heartbeatMessage,
  nextBeatDelay,
} from "./heartbeat.ts";
import { type LogRecord, type Measure, measureAreas, measuredProgress } from "./measure.ts";
import { type DiscoveryProgress, formatDiscoveryProgress } from "./progress.ts";
import { readSessionRecord, writeSessionRecord } from "./state.ts";
import { type SurveyPage, collectNavLinks, contactSheets, linkKey, outlineOf } from "./survey.ts";
import { CallStalledError, deadlineFor, withDeadline } from "./watchdog.ts";

export interface DiscoveryBudgets {
  discoveryScreens: number;
  discoveryActions: number;
  discoveryMinutes: number;
}

export interface DiscoveryOptions {
  root: string;
  app: AppInfo;
  /** Runtime base URL (defaults to app.baseUrl). */
  baseUrl?: string;
  viewport: { width: number; height: number };
  budgets: DiscoveryBudgets;
  headed?: boolean;
  storageState?: string;
  bus?: EventBus;
  project?: string;
  /** The Project-page request this session takes (item 10, D1): written to session.json. */
  request?: string;
  /** Max characters of aria digest returned per look. */
  digestChars?: number;
  now?: () => Date;
  /** Say that the session is alive when nothing else was said for this many seconds (default 30; 0 = never). */
  heartbeatSec?: number;
  /** One browser call may take this many seconds before the browser is judged frozen and restarted (default 25; 0 = no deadline). */
  callTimeoutSec?: number;
  /** Keep the deep browser log (diagnostics/). */
  browserLog?: boolean;
  /** Cap for a page's JavaScript heap in MB (0 = Chromium's own). */
  browserMemoryMb?: number;
  /** The longest an action waits for the page to settle, in ms (default 2500). */
  settleMaxMs?: number;
  /** Leave the (headed) browser window open when the session closes; it is closed when pi shuts down. */
  keepOpen?: boolean;
}

export interface Budget {
  screens: string;
  actions: string;
  minutes: string;
  exhausted: boolean;
}

export interface LookResult {
  screen: string;
  url: string;
  title: string;
  jpeg: Buffer;
  digest: string;
  truncated: boolean;
  budget: Budget;
}

export interface ActParams {
  action: "click" | "hover" | "type" | "press" | "scroll" | "goto" | "back" | "wait";
  target?: Target;
  text?: string;
  submit?: boolean;
  clear?: boolean;
  key?: string;
  dy?: number;
  url?: string;
  ms?: number;
}

export interface ActResult {
  action: string;
  verdict: SafetyVerdict;
  url: string;
  urlChanged: boolean;
  /** The storyboard target that worked (verified for storyboard use). */
  verifiedTarget?: Target;
  note?: string;
}

export class BlockedActionError extends Error {}
export class BudgetExhaustedError extends Error {}

/** Minimal structural DOM types (the Node test config has no DOM lib). */
interface DomEl {
  tagName: string;
  getAttribute(name: string): string | null;
  closest(selector: string): DomEl | null;
  querySelector(selector: string): unknown;
  labels?: ArrayLike<{ innerText: string }> | null;
  innerText?: string;
  value?: string;
  isContentEditable?: boolean;
}

/**
 * Runs IN THE PAGE (serialized by Playwright via toString) — must stay
 * self-contained: no references to module scope.
 *
 * Pass it to locator.evaluate as a FUNCTION. A string argument is evaluated
 * as an expression and never receives the element — that silently produced
 * empty names and let "Delete workspace" pass as read-only (caught by
 * test/s2-discovery.test.ts).
 */
function describeElement(el: DomEl | null): ElementInfo | null {
  if (!el) return null;
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute("type") || "").toLowerCase();
  const form = el.closest("form");
  const searchForm =
    !!form &&
    (form.getAttribute("role") === "search" ||
      !!form.querySelector("input[type=search], [role=searchbox]"));
  const labelText = el.labels?.[0] ? el.labels[0].innerText : "";
  const name =
    el.getAttribute("aria-label") ||
    labelText ||
    el.innerText ||
    el.value ||
    el.getAttribute("placeholder") ||
    el.getAttribute("title") ||
    "";
  let implicit = "";
  if (tag === "a") implicit = "link";
  else if (tag === "button") implicit = "button";
  else if (tag === "textarea") implicit = "textbox";
  else if (tag === "select") implicit = "combobox";
  else if (tag === "input") {
    if (type === "search") implicit = "searchbox";
    else if (type === "button" || type === "submit" || type === "reset") implicit = "button";
    else if (type === "checkbox" || type === "radio") implicit = type;
    else implicit = "textbox";
  }
  return {
    role: el.getAttribute("role") || implicit,
    name: String(name).trim().replace(/\s+/g, " ").slice(0, 120),
    inputType: type,
    inForm: !!form,
    searchForm,
    multiline: tag === "textarea" || !!el.isContentEditable,
  };
}

interface ElementInfo {
  role: string;
  name: string;
  inputType: string;
  inForm: boolean;
  searchForm: boolean;
  multiline: boolean;
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** `role|name` pairs mentioned in an aria snapshot (for storyboard linting). */
export function ariaTargets(snapshot: string): Set<string> {
  const out = new Set<string>();
  for (const m of snapshot.matchAll(/^\s*- ([a-z]+) "((?:[^"\\]|\\.)*)"/gm))
    out.add(`${m[1]}|${m[2]}`);
  return out;
}

export function targetKey(t: Target): string | undefined {
  return "role" in t && t.name ? `${t.role}|${t.name}` : undefined;
}

/** "/search?q=x" from a full URL (log messages); the URL itself stays in data. */
function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}${u.hash}` || "/";
  } catch {
    return url;
  }
}

export class DiscoverySession {
  readonly id: string;
  readonly dir: string;
  readonly appSlug: string;
  readonly baseUrl: string;
  private readonly opts: DiscoveryOptions;
  private readonly policy: Policy;
  private session: BrowserSession;
  private cursor: Cursor;
  /** Marks this session's browser processes, so a frozen one can be found and killed. */
  private marker: string;
  /** Browser calls run one at a time; what is running now (the heartbeat and the panel say it). */
  private chain: Promise<unknown> = Promise.resolve();
  private inFlight: { call: string; startedAt: number; deadlineMs: number } | undefined;
  private stalls = 0;
  /** The page chrome (navigation, header) of the last look, to leave out of the next digest while it is the same. */
  private lastChrome = new Map<string, string>();
  /** Pages that load more when scrolled (by address): what is known about each. */
  private readonly extension = new Map<string, ExtensionState>();
  private stopSampler: (() => void) | undefined;
  /** Set when the session closed but left its window open (keepOpen): closed for good by `closeKept`. */
  private kept: BrowserSession | undefined;
  private readonly startedAt: number;
  private screens = 0;
  /** Screens taken by the survey: they do not use the screen budget (the engine took them, not the model's steps). */
  private surveyed = 0;
  private actions = 0;
  readonly seen = new Set<string>();
  readonly verified = new Map<string, Target>();
  private readonly sitemap = new Map<string, { title: string; firstScreen: string }>();
  private closed = false;
  // the heartbeat: when anything was last said, when the last step was, what it was, and what the Director is doing
  private lastSaidAt = Date.now();
  private lastStepAt = Date.now();
  private lastStep = "";
  private director: DirectorState = "unknown";
  private beatTimer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribeBus: (() => void) | undefined;

  private constructor(opts: DiscoveryOptions, session: BrowserSession, id: string, marker: string) {
    this.opts = opts;
    this.session = session;
    this.marker = marker;
    this.id = id;
    this.appSlug = opts.app.slug;
    this.baseUrl = opts.baseUrl ?? opts.app.baseUrl;
    this.dir = path.join(appDir(opts.root, opts.app.slug), "discovery", id);
    this.policy = loadPolicy(appDir(opts.root, opts.app.slug));
    this.cursor = this.newCursor(session.page);
    this.startedAt = Date.now();
    for (const sub of ["screens", "dom"])
      fs.mkdirSync(path.join(this.dir, sub), { recursive: true });
  }

  /** The cursor of discovery: it does not need to look human (that is for recordings), so it moves at once. */
  private newCursor(page: Page): Cursor {
    const c = new Cursor(page, createRng(Date.now() >>> 0), {
      x: Math.round(this.opts.viewport.width / 2),
      y: Math.round(this.opts.viewport.height / 2),
    });
    c.fast = true;
    return c;
  }

  static async open(opts: DiscoveryOptions): Promise<DiscoverySession> {
    let id = stamp((opts.now ?? (() => new Date()))());
    // Two sessions in the same second get distinct ids.
    while (fs.existsSync(path.join(appDir(opts.root, opts.app.slug), "discovery", id)))
      id = `${id.slice(0, 15)}${String(Number(id.slice(13)) + 1).padStart(2, "0")}`;
    const sessionDir = path.join(appDir(opts.root, opts.app.slug), "discovery", id);
    const marker = newMarker();
    if (opts.browserLog) fs.mkdirSync(diagDir(sessionDir), { recursive: true });
    const launch = {
      viewport: { ...opts.viewport, dpr: 1 },
      marker,
      ...(opts.browserMemoryMb ? { memoryMb: opts.browserMemoryMb } : {}),
      ...(opts.browserLog ? { extraArgs: deepLogArgs(sessionDir) } : {}),
      ...(opts.headed ? { headed: true } : {}),
      ...(opts.storageState ? { storageState: opts.storageState } : {}),
    };
    const session = await openSession(launch);
    session.context.setDefaultTimeout(10_000);
    session.context.setDefaultNavigationTimeout(30_000);
    const ds = new DiscoverySession(opts, session, id, marker);
    try {
      await session.page.goto(ds.baseUrl, { waitUntil: "load" });
      await ds.settle();
      await ds.cursor.place(ds.cursor.pos);
      if (opts.headed) await session.page.bringToFront().catch(() => undefined);
    } catch (err) {
      await session.close();
      throw err;
    }
    ds.watchPage();
    if (opts.browserLog) ds.stopSampler = startProcessSampler(ds.dir, () => ds.marker);
    writeSessionRecord(appDir(opts.root, opts.app.slug), {
      id,
      startedAt: new Date().toISOString(),
      budgets: opts.budgets,
      ...(opts.request ? { request: opts.request } : {}),
    });
    ds.emit("discovery.opened", {
      session: id,
      url: session.page.url(),
      headed: !!opts.headed,
      budgets: opts.budgets,
      message: `discovery ${id} opened on ${pathOf(session.page.url())}${opts.headed ? " (headed)" : ""}`,
    });
    ds.startHeartbeat();
    return ds;
  }

  get page(): Page {
    return this.session.page;
  }

  /** Page events worth keeping (and saying): crashes and dialogs always, console errors in the deep log. */
  private watchPage(): void {
    attachPageLog(this.session.page, this.dir, !!this.opts.browserLog, (message) =>
      this.emit("discovery.page-event", { message }),
    );
  }

  /** What is running now, for the heartbeat and the panel. */
  currentCall(): { call: string; ms: number; deadlineMs: number } | undefined {
    const f = this.inFlight;
    return f ? { call: f.call, ms: Date.now() - f.startedAt, deadlineMs: f.deadlineMs } : undefined;
  }

  private callLog(rec: Record<string, unknown>): void {
    try {
      fs.appendFileSync(
        path.join(this.dir, "calls.jsonl"),
        `${JSON.stringify({ at: new Date().toISOString(), ...rec })}\n`,
      );
    } catch {
      // the call log must never break a call
    }
  }

  /**
   * One browser call, alone, with a deadline. A browser that does not answer is judged frozen: its processes are diagnosed (ps and macOS sample, into diagnostics/),
   * killed, and a new browser is opened on the same page with the saved login; the caller is told what happened and that the page was reloaded.
   */
  private guarded<T>(
    call: string,
    deadlineMs: number,
    fn: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const run = async (): Promise<T> => {
      this.ensureOpen();
      const startedAt = Date.now();
      this.inFlight = { call, startedAt, deadlineMs };
      try {
        const out = await withDeadline(call, deadlineMs, fn, signal);
        this.callLog({ call, ms: Date.now() - startedAt, ok: true });
        return out;
      } catch (err) {
        const ms = Date.now() - startedAt;
        if (err instanceof CallStalledError) {
          this.callLog({ call, ms, ok: false, stalled: true, aborted: err.aborted });
          this.inFlight = undefined;
          throw await this.recover(err);
        }
        this.callLog({ call, ms, ok: false, error: (err as Error).message.split("\n")[0] });
        throw err;
      } finally {
        this.inFlight = undefined;
      }
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Diagnose, kill and reopen the browser; returns the error the caller throws. */
  private async recover(stalled: CallStalledError): Promise<Error> {
    const n = ++this.stalls;
    const url = (() => {
      try {
        return this.session.page.url();
      } catch {
        return this.baseUrl;
      }
    })();
    this.emit("discovery.stalled", {
      call: stalled.call,
      afterMs: stalled.afterMs,
      message: `${stalled.message}: the browser looks frozen, diagnosing and restarting it`,
    });
    const files = await diagnoseStall(
      this.dir,
      this.marker,
      n,
      `${stalled.message} on ${url}`,
      this.session,
    );
    killMarker(this.marker);
    await Promise.race([this.session.close(), sleep(3000)]).catch(() => undefined);
    try {
      const sessionDir = this.dir;
      this.marker = newMarker();
      const session = await openSession({
        viewport: { ...this.opts.viewport, dpr: 1 },
        marker: this.marker,
        ...(this.opts.browserMemoryMb ? { memoryMb: this.opts.browserMemoryMb } : {}),
        ...(this.opts.browserLog ? { extraArgs: deepLogArgs(sessionDir) } : {}),
        ...(this.opts.headed ? { headed: true } : {}),
        ...(this.opts.storageState ? { storageState: this.opts.storageState } : {}),
      });
      session.context.setDefaultTimeout(10_000);
      session.context.setDefaultNavigationTimeout(30_000);
      this.session = session;
      this.cursor = this.newCursor(session.page);
      this.watchPage();
      await session.page
        .goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })
        .catch(() => undefined);
      await this.settle();
      this.emit("discovery.recovered", {
        call: stalled.call,
        diagnostics: files.map((f) => path.relative(this.dir, f)),
        message: `the browser was restarted on ${pathOf(url)} after ${stalled.call} stalled (diagnosis: ${files.length} file(s) in diagnostics/)`,
      });
      return new Error(
        `${stalled.message}, so the browser was frozen: it was restarted and the page ${pathOf(url)} was reloaded with the saved login (scroll position and any typed text are gone). ` +
          `${stalled.aborted ? "" : "Try the step again, or go on with another route. "}If it happens again on the same page, avoid that page and say so in your findings.`,
      );
    } catch (err) {
      this.closed = true;
      this.emit("discovery.recover-failed", {
        message: `the browser could not be restarted: ${(err as Error).message.split("\n")[0]}`,
      });
      return new Error(
        `${stalled.message}, and the browser could not be restarted (${(err as Error).message.split("\n")[0]}): the discovery session is closed. Open a new one with demo_rec_browser open.`,
      );
    }
  }

  private emit(type: string, data: Record<string, unknown>): void {
    this.lastSaidAt = Date.now();
    this.opts.bus?.publish(type, { app: this.appSlug, ...data }, this.opts.project);
  }

  // ---- the heartbeat: a quiet session says it is alive (every 30 s by default) ----
  private startHeartbeat(): void {
    const beatMs = (this.opts.heartbeatSec ?? HEARTBEAT_DEFAULT_SEC) * 1000;
    if (!(beatMs > 0)) return;
    // what the Director is doing comes from its own events on the bus
    this.unsubscribeBus = this.opts.bus?.subscribe((e) => {
      if (this.opts.project && e.project && e.project !== this.opts.project) return;
      if (e.type === "director.started" || e.type === "director.step") this.director = "working";
      else if (e.type === "director.settled") this.director = "settled";
    });
    // while a browser call is running and silent, say so more often (every 10 s at most): that is exactly when a session looks stuck
    const every = () => (this.inFlight ? Math.min(beatMs, 10_000) : beatMs);
    const schedule = () => {
      if (this.closed) return;
      this.beatTimer = setTimeout(
        () => {
          if (this.closed) return;
          if (Date.now() - this.lastSaidAt >= every() - 25) this.beat();
          schedule();
        },
        Math.min(nextBeatDelay(Date.now(), this.lastSaidAt, every()), 2000),
      );
      this.beatTimer.unref?.();
    };
    schedule();
  }

  private beat(): void {
    const b = this.budget();
    const area = this.progress().current;
    const facts: HeartbeatFacts = {
      sinceStepMs: Date.now() - this.lastStepAt,
      lastStep: this.lastStep,
      screens: b.screens,
      actions: b.actions,
      ...(area ? { area } : {}),
      ...(this.currentCall()
        ? {
            inFlight: this.currentCall() as NonNullable<
              ReturnType<DiscoverySession["currentCall"]>
            >,
          }
        : {}),
      director: this.director,
    };
    this.emit("discovery.heartbeat", {
      sinceStepMs: facts.sinceStepMs,
      director: facts.director,
      ...(facts.inFlight ? { inFlight: facts.inFlight } : {}),
      budget: b,
      message: heartbeatMessage(facts),
    });
  }

  /** The action log as it is on disk, kept in memory too: progress is measured from it (measure.ts). */
  private log: LogRecord[] = [];

  private append(file: string, record: Record<string, unknown>): void {
    const full = { at: new Date().toISOString(), ...record };
    fs.appendFileSync(path.join(this.dir, file), `${JSON.stringify(full)}\n`);
    if (file === "actions.jsonl") {
      this.log.push(full as LogRecord);
      this.lastStepAt = Date.now();
    }
  }

  // ---- exploration plan + measured progress (S3, D3) ----
  private storyboardWritten = false;

  /**
   * Declare (or replace) the areas the director intends to explore. `routes` may name the routes of each area (/search): looks and
   * actions on those pages count for it. Areas already done or dropped keep their state.
   */
  setPlan(names: string[], routes?: Record<string, string[]>): void {
    const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))].slice(0, 20);
    if (!clean.length) throw new Error("plan needs at least one area name");
    const hints: Record<string, string[]> = {};
    for (const [name, list] of Object.entries(routes ?? {})) {
      const area = clean.find((c) => c.toLowerCase() === name.trim().toLowerCase());
      if (!area)
        throw new Error(
          `routes for "${name}", which is not one of the declared areas: ${clean.join(", ")}`,
        );
      const rs = (Array.isArray(list) ? list : []).map((r) => String(r).trim()).filter(Boolean);
      const bad = rs.find((r) => !r.startsWith("/"));
      if (bad)
        throw new Error(
          `route "${bad}" of "${area}" must be a path starting with / (for example /search)`,
        );
      hints[area] = rs;
    }
    this.append("actions.jsonl", {
      kind: "plan",
      areas: clean,
      ...(Object.keys(hints).length ? { routes: hints } : {}),
    });
    this.emitProgress();
  }

  private declared(name: string) {
    const m = this.measure();
    const area = m.areas.find((a) => a.name.toLowerCase() === name.trim().toLowerCase());
    if (!area)
      throw new Error(
        `unknown area "${name}" — declared areas: ${m.areas.map((a) => a.name).join(", ") || "none"}`,
      );
    return area;
  }

  /** The director says an area is explored. Progress still counts only what was seen there. */
  markDone(name: string): void {
    const area = this.declared(name);
    this.append("actions.jsonl", { kind: "area-done", area: area.name });
    this.emitProgress();
  }

  /** The director leaves an area out on purpose, and says why: the storyboard check accepts that. */
  dropArea(name: string, why: string): void {
    const area = this.declared(name);
    if (!why.trim()) throw new Error(`say why "${area.name}" is dropped (a reason is required)`);
    this.append("actions.jsonl", {
      kind: "area-dropped",
      area: area.name,
      why: why.trim().slice(0, 240),
    });
    this.emitProgress();
  }

  /** Called when the storyboard is written: the last progress segment completes. */
  markStoryboardWritten(): void {
    this.storyboardWritten = true;
    this.emitProgress();
  }

  /** What the session has actually seen, per area. */
  measure(): Measure {
    return measureAreas(this.log);
  }

  progress(): DiscoveryProgress {
    const b = this.opts.budgets;
    const minutes = (Date.now() - this.startedAt) / 60000;
    return measuredProgress(this.measure(), {
      startedAt: this.startedAt,
      now: Date.now(),
      budgetUsed: {
        screens: this.screensUsed() / b.discoveryScreens,
        actions: this.actions / b.discoveryActions,
        minutes: minutes / b.discoveryMinutes,
      },
      budgetMinutes: b.discoveryMinutes,
      storyboardWritten: this.storyboardWritten,
    });
  }

  private emitProgress(): void {
    const p = this.progress();
    this.emit("discovery.progress", { progress: p, message: formatDiscoveryProgress(p) });
  }

  private screensUsed(): number {
    return this.screens - this.surveyed;
  }

  budget(): Budget {
    const b = this.opts.budgets;
    const minutes = (Date.now() - this.startedAt) / 60000;
    return {
      screens: `${this.screensUsed()}/${b.discoveryScreens}`,
      actions: `${this.actions}/${b.discoveryActions}`,
      minutes: `${minutes.toFixed(1)}/${b.discoveryMinutes}`,
      exhausted:
        this.screensUsed() >= b.discoveryScreens ||
        this.actions >= b.discoveryActions ||
        minutes >= b.discoveryMinutes,
    };
  }

  private requireBudget(kind: "screens" | "actions"): void {
    const b = this.opts.budgets;
    const minutes = (Date.now() - this.startedAt) / 60000;
    const over =
      (kind === "screens" && this.screensUsed() >= b.discoveryScreens) ||
      (kind === "actions" && this.actions >= b.discoveryActions) ||
      minutes >= b.discoveryMinutes;
    if (over) {
      const bud = this.budget();
      throw new BudgetExhaustedError(
        `discovery budget exhausted (screens ${bud.screens}, actions ${bud.actions}, minutes ${bud.minutes}) — write the storyboard with what you have, or ask the user to extend the budget (Project → Discovery → Extend the budget, or budgets.discovery* in the config)`,
      );
    }
  }

  /** Let the SPA finish: load state, then DOM quiet (results, streamed answers). */
  private async settle(): Promise<void> {
    await this.settlePage(this.page, this.opts.settleMaxMs ?? 2500);
  }

  /** Let a page finish: load state, then network idle, then the DOM quiet; the whole wait capped at `max` ms. */
  private async settlePage(page: Page, max: number): Promise<void> {
    // An app that never goes idle (polling, live data) would otherwise cost the longest wait on every single step.
    const t0 = Date.now();
    await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
    await page
      .waitForLoadState("networkidle", { timeout: Math.min(1500, Math.round(max * 0.6)) })
      .catch(() => {});
    const left = () => Math.max(400, max - (Date.now() - t0));
    const q = await waitForDomQuiet(page, 300, left());
    // A navigation during the wait resets the context; wait once more on the new page.
    if (!q.quiet && q.ms === 0) await waitForDomQuiet(page, 300, left());
  }

  /** A screenshot and the aria digest of the page now. Under a deadline: a frozen browser is restarted (see `guarded`). */
  look(
    opts: { fullPage?: boolean; fullDigest?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<LookResult> {
    return this.guarded("look", this.deadlineMs(), () => this.lookNow(opts), signal);
  }

  private deadlineMs(act?: { action: string; ms?: number; text?: string }): number {
    return deadlineFor((this.opts.callTimeoutSec ?? 25) * 1000, act);
  }

  private async lookNow(
    opts: { fullPage?: boolean; fullDigest?: boolean } = {},
  ): Promise<LookResult> {
    this.ensureOpen();
    this.requireBudget("screens");
    this.screens++;
    const screen = `${this.id}/s${String(this.screens).padStart(3, "0")}`;
    const file = screen.split("/")[1] as string;
    const jpeg = await this.page.screenshot({
      type: "jpeg",
      quality: 72,
      fullPage: !!opts.fullPage,
      scale: "css",
    });
    const raw = await this.page
      .locator("body")
      .ariaSnapshot({ timeout: 5000 })
      .catch(() => "(aria snapshot unavailable)");
    for (const key of ariaTargets(raw)) this.seen.add(key);
    // page chrome that has not changed since the last look is one line, so the limit is spent on the page's own content
    const reduced = reduceDigest(raw, this.lastChrome, opts.fullDigest);
    const shown = reduced.text;
    const limit = this.opts.digestChars ?? 6000;
    const truncated = shown.length > limit;
    const digest = truncated
      ? `${shown.slice(0, limit)}\n… (truncated ${shown.length - limit} chars — scroll or look at a narrower region)`
      : shown;
    fs.writeFileSync(path.join(this.dir, "screens", `${file}.jpg`), jpeg);
    fs.writeFileSync(path.join(this.dir, "dom", `${file}.yaml`), raw);
    const url = this.page.url();
    const title = await this.page.title();
    if (!this.sitemap.has(url)) {
      this.sitemap.set(url, { title, firstScreen: screen });
      this.writeSitemap();
    }
    this.append("actions.jsonl", { kind: "look", screen, url, title });
    this.emit("discovery.look", {
      screen,
      url,
      title,
      media: `discovery/${this.id}/screens/${file}.jpg`,
      budget: this.budget(),
      message: `look ${screen}${title ? ` “${title}”` : ""} · ${pathOf(url)}`,
    });
    this.lastStep = `look ${screen}${title ? ` “${title}”` : ""} · ${pathOf(url)}`;
    this.emitProgress();
    return { screen, url, title, jpeg, digest, truncated, budget: this.budget() };
  }

  private writeSitemap(): void {
    const pages = [...this.sitemap.entries()].map(([url, v]) => ({ url, ...v }));
    fs.writeFileSync(path.join(this.dir, "sitemap.json"), `${JSON.stringify(pages, null, 2)}\n`);
  }

  /**
   * The survey: visit the navigation of the app by itself (no model between the pages), up to `max` pages, a few tabs at a time, and return what each page is. The pages
   * are real screens (sNNN, in the log and the sitemap) but do not use the screen budget. A page that loads more when scrolled is extended once and marked.
   */
  survey(
    o: { paths?: string[]; max?: number } = {},
    signal?: AbortSignal,
  ): Promise<{ pages: SurveyPage[]; sheets: Buffer[]; ms: number }> {
    const base = (this.opts.callTimeoutSec ?? 25) * 1000;
    return this.guarded("survey", base > 0 ? base * 5 : 0, () => this.surveyNow(o), signal);
  }

  private async surveyNow(o: { paths?: string[]; max?: number }): Promise<{
    pages: SurveyPage[];
    sheets: Buffer[];
    ms: number;
  }> {
    this.ensureOpen();
    this.requireBudget("actions");
    this.actions++;
    const t0 = Date.now();
    const origin = new URL(this.baseUrl).origin;
    const max = Math.max(1, Math.min(60, Math.round(o.max ?? 24)));
    const here = this.page.url();
    // what to visit: the paths asked for, else the navigation of this page, then the navigation of what that reveals (two levels)
    const queue: { href: string; name: string; depth: number }[] = [];
    const queued = new Set<string>();
    const enqueue = (href: string, name: string, depth: number) => {
      let key: string;
      try {
        key = linkKey(href);
      } catch {
        return;
      }
      if (queued.has(key) || queue.length >= max) return;
      queued.add(key);
      queue.push({ href, name, depth });
    };
    queued.add(linkKey(here));
    if (o.paths?.length)
      for (const p of o.paths) enqueue(new URL(p, this.baseUrl).toString(), p, 1);
    else for (const l of await collectNavLinks(this.page, origin)) enqueue(l.href, l.name, 1);
    const pages: SurveyPage[] = [];
    const files: string[] = [];
    const concurrency = 3;
    const visit = async (
      item: { href: string; name: string; depth: number },
      index: number,
    ): Promise<SurveyPage> => {
      const pth = (() => {
        const u = new URL(item.href);
        return `${u.pathname}${u.search}`;
      })();
      const started = Date.now();
      let verdict: SafetyVerdict;
      try {
        verdict = this.gate(
          { action: "goto", sameOrigin: new URL(item.href).origin === origin },
          { url: item.href },
        );
      } catch (err) {
        return {
          screen: "",
          url: item.href,
          path: pth,
          title: "",
          status: "skipped",
          note: (err as Error).message.split("\n")[0] ?? "blocked",
        };
      }
      void verdict;
      const tab = await this.session.context.newPage();
      try {
        await tab.goto(item.href, { waitUntil: "domcontentloaded", timeout: 15_000 });
        await this.settlePage(tab, Math.min(1500, this.opts.settleMaxMs ?? 1500));
        const title = await tab.title().catch(() => "");
        const screenNo = ++this.screens;
        this.surveyed++;
        const screen = `${this.id}/s${String(screenNo).padStart(3, "0")}`;
        const file = screen.split("/")[1] as string;
        const jpeg = await tab.screenshot({ type: "jpeg", quality: 60, scale: "css" });
        const raw = await tab
          .locator("body")
          .ariaSnapshot({ timeout: 3000 })
          .catch(() => "");
        for (const key of ariaTargets(raw)) this.seen.add(key);
        fs.writeFileSync(path.join(this.dir, "screens", `${file}.jpg`), jpeg);
        fs.writeFileSync(path.join(this.dir, "dom", `${file}.yaml`), raw);
        files[index] = path.join(this.dir, "screens", `${file}.jpg`);
        const url = tab.url();
        // one scroll to the bottom: does the page load more? If so it is marked and the Director's own scrolls stay inside what loaded
        let extendsInfo: SurveyPage["extends"];
        const before = await measureExtent(tab);
        if (before && before.scrollH > before.clientH * 1.3) {
          await tab.mouse.move(
            Math.round(this.opts.viewport.width / 2),
            Math.round(this.opts.viewport.height / 2),
          );
          await tab.mouse.wheel(0, Math.round(before.clientH * 1.5));
          await tab.waitForTimeout(700);
          const after = await measureExtent(tab);
          if (after && grew(before, after)) {
            extendsInfo = { rows: after.rows - before.rows, px: after.scrollH - before.scrollH };
            this.extension.set(this.keyOf(url), {
              extends: true,
              grewRows: extendsInfo.rows,
              grewPx: extendsInfo.px,
              knownH: after.scrollH,
            });
          }
        }
        if (!this.sitemap.has(url)) this.sitemap.set(url, { title, firstScreen: screen });
        this.append("actions.jsonl", { kind: "look", screen, url, title, survey: true });
        this.emit("discovery.look", {
          screen,
          url,
          title,
          media: `discovery/${this.id}/screens/${file}.jpg`,
          budget: this.budget(),
          message: `survey ${screen}${title ? ` “${title}”` : ""} · ${pathOf(url)}`,
        });
        // the second level: the navigation this page reveals (a section's own menu)
        if (item.depth < 2 && !o.paths?.length)
          for (const l of await collectNavLinks(tab, origin))
            enqueue(l.href, l.name, item.depth + 1);
        return {
          screen,
          url,
          path: pth,
          title,
          outline: outlineOf(raw),
          ...(extendsInfo ? { extends: extendsInfo } : {}),
          status: "seen",
          ms: Date.now() - started,
        };
      } catch (err) {
        return {
          screen: "",
          url: item.href,
          path: pth,
          title: "",
          status: "failed",
          note: (err as Error).message.split("\n")[0] ?? "failed",
          ms: Date.now() - started,
        };
      } finally {
        await tab.close().catch(() => undefined);
      }
    };
    // breadth first, a few tabs at a time; the queue grows as the pages reveal their own menus
    let cursor = 0;
    while (cursor < queue.length) {
      const batch = queue.slice(cursor, cursor + concurrency);
      const start = cursor;
      cursor += batch.length;
      const done = await Promise.all(batch.map((item, k) => visit(item, start + k)));
      done.forEach((page, k) => {
        pages[start + k] = page;
      });
    }
    this.writeSitemap();
    this.lastStep = `survey of ${pages.filter((p) => p.status === "seen").length} pages`;
    this.emitProgress();
    const seenFiles = files.filter((f): f is string => !!f);
    const sheetFiles = await contactSheets(seenFiles, path.join(this.dir, "screens"), "survey");
    return {
      pages: pages.filter(Boolean),
      sheets: sheetFiles.slice(0, 2).map((f) => fs.readFileSync(f)),
      ms: Date.now() - t0,
    };
  }

  private async describe(target?: Target): Promise<ElementInfo | null> {
    if (target) {
      const locator = locate(this.page, target);
      // the target is waited for ONCE (the caller has done it); a short look is all that is left, never Playwright's 30 s default
      return (await locator
        .evaluate(describeElement as unknown as Parameters<typeof locator.evaluate>[0], undefined, {
          timeout: 3000,
        })
        .catch(() => null)) as ElementInfo | null;
    }
    return (await this.page
      .evaluate(`(${describeElement.toString()})(document.activeElement)`)
      .catch(() => null)) as ElementInfo | null;
  }

  /** The page's address without the part that does not change what it shows. */
  private pageKey(): string {
    return this.keyOf(this.page.url());
  }

  private keyOf(url: string): string {
    try {
      const u = new URL(url);
      return `${u.origin}${u.pathname}${u.search}`;
    } catch {
      return url;
    }
  }

  /** Wait once for a target to be there (up to 8 s); a missing one fails here, with the message the Director knows. */
  private async waitForTarget(target: Target, ms = 8000): Promise<void> {
    try {
      await locate(this.page, target).waitFor({ state: "visible", timeout: ms });
    } catch {
      throw new Error(`target not visible within ${ms} ms: ${describeTarget(target)}`);
    }
  }

  /**
   * Safety must not fail open: if the element can't be inspected, classify
   * using the target's own role/name/text instead of an anonymous element.
   */
  private contextFor(
    action: "click" | "hover",
    target: Target,
    info: ElementInfo | null,
  ): ActionContext {
    if (info) {
      return {
        action,
        role: info.role,
        name: info.name,
        inputType: info.inputType,
        inForm: info.inForm,
        searchForm: info.searchForm,
      };
    }
    if ("role" in target)
      return { action, role: target.role, ...(target.name ? { name: target.name } : {}) };
    if ("text" in target) return { action, name: target.text };
    if ("label" in target) return { action, name: target.label };
    return { action, name: "" };
  }

  private gate(ctx: ActionContext, detail: Record<string, unknown>): SafetyVerdict {
    const verdict = classify(ctx, this.policy);
    const record = {
      action: ctx.action,
      ...detail,
      name: ctx.name,
      role: ctx.role,
      level: verdict.level,
      reason: verdict.reason,
      page: this.page.url(),
    };
    this.append("audit.jsonl", record);
    if (verdict.level !== "safe")
      this.emit(verdict.level === "blocked" ? "safety.blocked" : "safety.mutation", {
        ...record,
        message: `${verdict.level === "blocked" ? "blocked" : "state change"}: ${ctx.action}${ctx.name ? ` “${ctx.name}”` : ""}${verdict.reason ? ` — ${verdict.reason}` : ""}`,
      });
    if (verdict.level === "blocked") {
      throw new BlockedActionError(
        `BLOCKED by the safety net: ${verdict.reason}. Don't work around it; if this action is genuinely safe in this tenant, ` +
          `ask the user to allow it in apps/${this.appSlug}/policy.json ({"allow": ["${ctx.name ?? ""}"]}).`,
      );
    }
    return verdict;
  }

  /** One action behind the safety net. Under a deadline: a frozen browser is restarted (see `guarded`). */
  act(p: ActParams, signal?: AbortSignal): Promise<ActResult> {
    return this.guarded(`act ${p.action}`, this.deadlineMs(p), () => this.actNow(p), signal);
  }

  private async actNow(p: ActParams): Promise<ActResult> {
    this.ensureOpen();
    this.requireBudget("actions");
    this.actions++;
    const before = this.page.url();
    let verdict: SafetyVerdict = { level: "safe", reason: "" };
    let verifiedTarget: Target | undefined;
    let note: string | undefined;
    const needTarget = () => {
      if (!p.target)
        throw new Error(`act ${p.action} needs a target ({role, name} | {text} | {label} | {css})`);
      return p.target;
    };

    switch (p.action) {
      case "click":
      case "hover": {
        const target = needTarget();
        await this.waitForTarget(target);
        const info = await this.describe(target);
        if (!info && p.action === "click" && "css" in target) {
          throw new BlockedActionError(
            `BLOCKED by the safety net: could not inspect ${describeTarget(target)} before clicking. Use a {role, name} target so the action can be checked.`,
          );
        }
        verdict = this.gate(this.contextFor(p.action, target, info), {
          target: describeTarget(target),
        });
        const { box } = await resolveBox(this.page, target, 3000);
        await this.cursor.moveTo(aimPoint(box, createRng(this.actions)), box.w);
        if (p.action === "click") await this.cursor.click();
        verifiedTarget = target;
        break;
      }
      case "type": {
        if (!p.text) throw new Error("act type needs text");
        if (p.target) {
          await this.waitForTarget(p.target);
          const { box } = await resolveBox(this.page, p.target, 3000);
          await this.cursor.moveTo(aimPoint(box, createRng(this.actions)), box.w);
          await this.cursor.click();
          verifiedTarget = p.target;
        }
        if (p.clear) {
          await this.page.keyboard.press("ControlOrMeta+A");
          await this.page.keyboard.press("Backspace");
        }
        const info = await this.describe();
        const ctx: ActionContext = {
          action: "type",
          submit: !!p.submit,
          ...(info
            ? {
                role: info.role,
                name: info.name,
                inputType: info.inputType,
                inForm: info.inForm,
                searchForm: info.searchForm,
                multiline: info.multiline,
              }
            : {}),
        };
        // Gate before typing so a blocked submit never leaves half-typed text behind.
        verdict = this.gate(ctx, {
          text: p.text,
          ...(p.target ? { target: describeTarget(p.target) } : {}),
        });
        await this.page.keyboard.type(p.text, { delay: 30 });
        if (p.submit) await this.page.keyboard.press("Enter");
        break;
      }
      case "press": {
        if (!p.key) throw new Error("act press needs a key");
        const info = await this.describe();
        verdict = this.gate(
          {
            action: "press",
            key: p.key,
            ...(info
              ? {
                  role: info.role,
                  name: info.name,
                  inputType: info.inputType,
                  inForm: info.inForm,
                  searchForm: info.searchForm,
                  multiline: info.multiline,
                }
              : {}),
          },
          { key: p.key },
        );
        await this.page.keyboard.press(p.key);
        break;
      }
      case "scroll": {
        let dy = p.dy ?? 0;
        if (p.target) {
          const bb = await locate(this.page, p.target)
            .boundingBox({ timeout: 3000 })
            .catch(() => null);
          if (bb) dy = Math.round(bb.y + bb.height / 2 - this.opts.viewport.height * 0.45);
          verifiedTarget = p.target;
        }
        if (!dy) dy = Math.round(this.opts.viewport.height * 0.7);
        verdict = this.gate({ action: "scroll" }, { dy });
        // a list that loads more as you scroll may extend ONCE (that is enough to understand the page); after that a scroll stays inside what is loaded
        const key = this.pageKey();
        const state = this.extension.get(key);
        const before = await measureExtent(this.page);
        let todo = dy;
        if (before && dy > 0) {
          todo = allowedScroll(
            state ?? { extends: false, grewRows: 0, grewPx: 0, knownH: 0 },
            before,
            dy,
          );
          if (todo <= 0) {
            note =
              before.nodes > NODE_CAP
                ? `NOT scrolled: this page already holds ${before.nodes} elements, scrolling further would only bloat it. Use what you have, or filter or search instead.`
                : `NOT scrolled: this page loads more rows as you scroll and it has already extended once (+${state?.grewRows ?? 0} rows), which is enough to understand it. Use what is loaded, or filter or search instead of scrolling on.`;
            break;
          }
        }
        await this.cursor.scrollBy(todo);
        note = `scrolled ${todo}px${todo !== dy ? ` (of ${dy}: the rest would load more rows)` : ""}`;
        if (before && dy > 0) {
          await this.settle();
          const after = await measureExtent(this.page);
          if (after && !state?.extends && grew(before, after)) {
            this.extension.set(key, {
              extends: true,
              grewRows: after.rows - before.rows,
              grewPx: after.scrollH - before.scrollH,
              knownH: after.scrollH,
            });
            note += ` — this page loads more as you scroll (+${after.rows - before.rows} rows, +${after.scrollH - before.scrollH} px): it extended once, which is enough to understand it; further scrolling down stays inside what is loaded`;
          } else if (state?.extends && after) state.knownH = Math.max(state.knownH, before.scrollH);
        }
        break;
      }
      case "goto": {
        if (!p.url) throw new Error("act goto needs a url (absolute or relative to the app)");
        const url = new URL(p.url, this.baseUrl);
        const origin = new URL(this.baseUrl).origin;
        const sameOrigin = url.origin === origin || this.policy.allowOrigins.includes(url.origin);
        verdict = this.gate({ action: "goto", sameOrigin }, { url: url.toString() });
        await this.page.goto(url.toString(), { waitUntil: "load" });
        break;
      }
      case "back": {
        verdict = this.gate({ action: "back" }, {});
        await this.page.goBack({ waitUntil: "load" }).catch(() => null);
        break;
      }
      case "wait": {
        if (p.target) {
          await locate(this.page, p.target).waitFor({
            state: "visible",
            timeout: Math.min(p.ms ?? 10000, 20000),
          });
          verifiedTarget = p.target;
        } else await sleep(Math.min(p.ms ?? 1000, 10000));
        break;
      }
    }

    await this.settle();
    const url = this.page.url();
    if (verifiedTarget) {
      const key = targetKey(verifiedTarget) ?? JSON.stringify(verifiedTarget);
      this.verified.set(key, verifiedTarget);
    }
    const result: ActResult = { action: p.action, verdict, url, urlChanged: url !== before };
    if (verifiedTarget) result.verifiedTarget = verifiedTarget;
    if (note) result.note = note;
    this.append("actions.jsonl", { kind: "act", ...p, level: verdict.level, url });
    const target = p.target ? describeTarget(p.target) : undefined;
    this.emit("discovery.act", {
      action: p.action,
      ...(target ? { target } : {}),
      level: verdict.level,
      url,
      ...(url !== before ? { from: before } : {}),
      ...(note ? { note } : {}),
      message: `${p.action}${target ? ` ${target}` : ""}${p.action === "goto" && p.url ? ` ${p.url}` : ""}${p.action === "press" && p.key ? ` ${p.key}` : ""} (${verdict.level})${url !== before ? ` → ${pathOf(url)}` : ""}`,
    });
    this.lastStep = `${p.action}${target ? ` ${target}` : ""} · ${pathOf(url)}`;
    this.emitProgress();
    return result;
  }

  /** Storyboard targets never seen in an aria digest nor verified by an act. */
  unknownTargets(targets: Target[]): Target[] {
    return targets.filter((t) => {
      const key = targetKey(t);
      if (key) return !this.seen.has(key) && !this.verified.has(key);
      return !this.verified.has(JSON.stringify(t));
    });
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("discovery session is closed — open a new one");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.beatTimer) clearTimeout(this.beatTimer);
    this.unsubscribeBus?.();
    this.stopSampler?.();
    this.writeSitemap();
    // keepOpen: a window you asked to see stays open (it is closed when pi shuts down, or with `closeKept`); everything else closes, a frozen one by force
    if (this.opts.keepOpen && this.opts.headed) this.kept = this.session;
    else await this.session.close();
    const bud = this.budget();
    const prior = readSessionRecord(appDir(this.opts.root, this.appSlug), this.id);
    writeSessionRecord(appDir(this.opts.root, this.appSlug), {
      id: this.id,
      startedAt: prior?.startedAt ?? new Date(this.startedAt).toISOString(),
      budgets: this.opts.budgets,
      ...(this.opts.request ? { request: this.opts.request } : {}),
      closedAt: new Date().toISOString(),
      usage: {
        screens: this.screens,
        actions: this.actions,
        minutes: +((Date.now() - this.startedAt) / 60000).toFixed(1),
      },
      exhausted: bud.exhausted,
    });
    this.emit("discovery.closed", {
      session: this.id,
      screens: this.screens,
      actions: this.actions,
      budget: this.budget(),
      message: `discovery ${this.id} closed · ${this.screens} screen(s), ${this.actions} action(s)`,
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** True when the session is closed but its window is still open (keepOpen). */
  get windowKept(): boolean {
    return !!this.kept;
  }

  /** Close the window that was kept open. */
  async closeKept(): Promise<void> {
    const k = this.kept;
    this.kept = undefined;
    await k?.close();
  }
}
