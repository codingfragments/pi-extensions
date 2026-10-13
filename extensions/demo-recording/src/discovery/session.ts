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
  type AreaState,
  type DiscoveryProgress,
  discoveryProgress,
  formatDiscoveryProgress,
} from "./progress.ts";

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
  /** Max characters of aria digest returned per look. */
  digestChars?: number;
  now?: () => Date;
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

export class DiscoverySession {
  readonly id: string;
  readonly dir: string;
  readonly appSlug: string;
  readonly baseUrl: string;
  private readonly opts: DiscoveryOptions;
  private readonly policy: Policy;
  private readonly session: BrowserSession;
  private readonly cursor: Cursor;
  private readonly startedAt: number;
  private screens = 0;
  private actions = 0;
  readonly seen = new Set<string>();
  readonly verified = new Map<string, Target>();
  private readonly sitemap = new Map<string, { title: string; firstScreen: string }>();
  private closed = false;

  private constructor(opts: DiscoveryOptions, session: BrowserSession, id: string) {
    this.opts = opts;
    this.session = session;
    this.id = id;
    this.appSlug = opts.app.slug;
    this.baseUrl = opts.baseUrl ?? opts.app.baseUrl;
    this.dir = path.join(appDir(opts.root, opts.app.slug), "discovery", id);
    this.policy = loadPolicy(appDir(opts.root, opts.app.slug));
    this.cursor = new Cursor(session.page, createRng(Date.now() >>> 0), {
      x: Math.round(opts.viewport.width / 2),
      y: Math.round(opts.viewport.height / 2),
    });
    this.startedAt = Date.now();
    for (const sub of ["screens", "dom"])
      fs.mkdirSync(path.join(this.dir, sub), { recursive: true });
  }

  static async open(opts: DiscoveryOptions): Promise<DiscoverySession> {
    const session = await openSession({
      viewport: { ...opts.viewport, dpr: 1 },
      ...(opts.headed ? { headed: true } : {}),
      ...(opts.storageState ? { storageState: opts.storageState } : {}),
    });
    let id = stamp((opts.now ?? (() => new Date()))());
    // Two sessions in the same second get distinct ids.
    while (fs.existsSync(path.join(appDir(opts.root, opts.app.slug), "discovery", id)))
      id = `${id.slice(0, 15)}${String(Number(id.slice(13)) + 1).padStart(2, "0")}`;
    const ds = new DiscoverySession(opts, session, id);
    try {
      await session.page.goto(ds.baseUrl, { waitUntil: "load" });
      await ds.settle();
      await ds.cursor.place(ds.cursor.pos);
    } catch (err) {
      await session.close();
      throw err;
    }
    ds.emit("discovery.opened", { session: id, url: session.page.url(), headed: !!opts.headed });
    return ds;
  }

  get page(): Page {
    return this.session.page;
  }

  private emit(type: string, data: Record<string, unknown>): void {
    this.opts.bus?.publish(type, { app: this.appSlug, ...data }, this.opts.project);
  }

  private append(file: string, record: Record<string, unknown>): void {
    fs.appendFileSync(
      path.join(this.dir, file),
      `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`,
    );
  }

  // ---- exploration plan + progress estimate (S3) ----
  private areas: AreaState[] = [];
  private storyboardWritten = false;

  /** Declare (or replace) the areas the director intends to explore. Done areas are kept. */
  setPlan(names: string[]): void {
    const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))].slice(0, 20);
    if (!clean.length) throw new Error("plan needs at least one area name");
    const done = new Map(this.areas.filter((a) => a.doneAt !== undefined).map((a) => [a.name, a]));
    this.areas = clean.map((name) => done.get(name) ?? { name });
    this.startCurrent();
    this.append("actions.jsonl", { kind: "plan", areas: clean });
    this.emitProgress();
  }

  /** Mark an area explored; the next open area becomes current. */
  markDone(name: string): void {
    const area = this.areas.find((a) => a.name.toLowerCase() === name.trim().toLowerCase());
    if (!area)
      throw new Error(
        `unknown area "${name}" — declared areas: ${this.areas.map((a) => a.name).join(", ") || "none"}`,
      );
    area.startedAt ??= Date.now();
    area.doneAt = Date.now();
    this.startCurrent();
    this.append("actions.jsonl", { kind: "area-done", area: area.name });
    this.emitProgress();
  }

  /** Called when the storyboard is written: the last progress segment completes. */
  markStoryboardWritten(): void {
    this.storyboardWritten = true;
    this.emitProgress();
  }

  private startCurrent(): void {
    const current = this.areas.find((a) => a.doneAt === undefined);
    if (current && current.startedAt === undefined) current.startedAt = Date.now();
  }

  progress(): DiscoveryProgress {
    const b = this.opts.budgets;
    const minutes = (Date.now() - this.startedAt) / 60000;
    return discoveryProgress({
      startedAt: this.startedAt,
      now: Date.now(),
      areas: this.areas,
      budgetUsed: {
        screens: this.screens / b.discoveryScreens,
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

  budget(): Budget {
    const b = this.opts.budgets;
    const minutes = (Date.now() - this.startedAt) / 60000;
    return {
      screens: `${this.screens}/${b.discoveryScreens}`,
      actions: `${this.actions}/${b.discoveryActions}`,
      minutes: `${minutes.toFixed(1)}/${b.discoveryMinutes}`,
      exhausted:
        this.screens >= b.discoveryScreens ||
        this.actions >= b.discoveryActions ||
        minutes >= b.discoveryMinutes,
    };
  }

  private requireBudget(kind: "screens" | "actions"): void {
    const b = this.opts.budgets;
    const minutes = (Date.now() - this.startedAt) / 60000;
    const over =
      (kind === "screens" && this.screens >= b.discoveryScreens) ||
      (kind === "actions" && this.actions >= b.discoveryActions) ||
      minutes >= b.discoveryMinutes;
    if (over) {
      const bud = this.budget();
      throw new BudgetExhaustedError(
        `discovery budget exhausted (screens ${bud.screens}, actions ${bud.actions}, minutes ${bud.minutes}) — write the storyboard with what you have, or ask the user to raise budgets.discovery* in the config`,
      );
    }
  }

  /** Let the SPA finish: load state, then DOM quiet (results, streamed answers). */
  private async settle(): Promise<void> {
    await this.page.waitForLoadState("domcontentloaded").catch(() => {});
    await this.page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {});
    const q = await waitForDomQuiet(this.page, 400, 4000);
    // A navigation during the wait resets the context; wait once more on the new page.
    if (!q.quiet && q.ms === 0) await waitForDomQuiet(this.page, 400, 4000);
  }

  async look(opts: { fullPage?: boolean } = {}): Promise<LookResult> {
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
    const limit = this.opts.digestChars ?? 6000;
    const truncated = raw.length > limit;
    const digest = truncated
      ? `${raw.slice(0, limit)}\n… (truncated ${raw.length - limit} chars — scroll or look at a narrower region)`
      : raw;
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
    });
    this.emitProgress();
    return { screen, url, title, jpeg, digest, truncated, budget: this.budget() };
  }

  private writeSitemap(): void {
    const pages = [...this.sitemap.entries()].map(([url, v]) => ({ url, ...v }));
    fs.writeFileSync(path.join(this.dir, "sitemap.json"), `${JSON.stringify(pages, null, 2)}\n`);
  }

  private async describe(target?: Target): Promise<ElementInfo | null> {
    if (target) {
      const locator = locate(this.page, target);
      await locator.waitFor({ state: "attached", timeout: 8000 }).catch(() => {});
      return (await locator
        .evaluate(describeElement as unknown as Parameters<typeof locator.evaluate>[0])
        .catch(() => null)) as ElementInfo | null;
    }
    return (await this.page
      .evaluate(`(${describeElement.toString()})(document.activeElement)`)
      .catch(() => null)) as ElementInfo | null;
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
      this.emit(verdict.level === "blocked" ? "safety.blocked" : "safety.mutation", record);
    if (verdict.level === "blocked") {
      throw new BlockedActionError(
        `BLOCKED by the safety net: ${verdict.reason}. Don't work around it; if this action is genuinely safe in this tenant, ` +
          `ask the user to allow it in apps/${this.appSlug}/policy.json ({"allow": ["${ctx.name ?? ""}"]}).`,
      );
    }
    return verdict;
  }

  async act(p: ActParams): Promise<ActResult> {
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
        const info = await this.describe(target);
        if (!info && p.action === "click" && "css" in target) {
          throw new BlockedActionError(
            `BLOCKED by the safety net: could not inspect ${describeTarget(target)} before clicking. Use a {role, name} target so the action can be checked.`,
          );
        }
        verdict = this.gate(this.contextFor(p.action, target, info), {
          target: describeTarget(target),
        });
        const { box } = await resolveBox(this.page, target, 8000);
        await this.cursor.moveTo(aimPoint(box, createRng(this.actions)), box.w);
        if (p.action === "click") await this.cursor.click();
        verifiedTarget = target;
        break;
      }
      case "type": {
        if (!p.text) throw new Error("act type needs text");
        if (p.target) {
          const { box } = await resolveBox(this.page, p.target, 8000);
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
          const bb = await locate(this.page, p.target).boundingBox();
          if (bb) dy = Math.round(bb.y + bb.height / 2 - this.opts.viewport.height * 0.45);
          verifiedTarget = p.target;
        }
        if (!dy) dy = Math.round(this.opts.viewport.height * 0.7);
        verdict = this.gate({ action: "scroll" }, { dy });
        await this.cursor.scrollBy(dy);
        note = `scrolled ${dy}px`;
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
    this.emit("discovery.act", {
      action: p.action,
      ...(p.target ? { target: describeTarget(p.target) } : {}),
      level: verdict.level,
      url,
    });
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
    this.writeSitemap();
    await this.session.close();
    this.emit("discovery.closed", {
      session: this.id,
      screens: this.screens,
      actions: this.actions,
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
