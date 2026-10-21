/**
 * Reusing a manual login (S7, D5, D147). You log in by hand (a password, OAuth, an e-mail link, a one-time code) in a headed browser the engine opens; the engine saves
 * the browser's state (`storageState` with `indexedDB: true`: cookies, localStorage, IndexedDB; never sessionStorage, which a saved state cannot keep) as
 * `apps/<app>/auth/state.json` (`0600`, in a `0700` folder, never in a project's zip) and **checks it in a fresh headless browser** before it counts as saved.
 * The same check, the PROBE, tells later whether the session is still good: the plain rule (a login-looking address or a visible password field) and an optional
 * rule per app. The engine never reads the state's content for anything else, and nothing here is ever sent to a model.
 */

import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { type AppInfo, type LoginRule, appDir } from "../workdir/layout.ts";

export const authDir = (root: string, app: string) => path.join(appDir(root, app), "auth");
export const statePath = (root: string, app: string) => path.join(authDir(root, app), "state.json");
const metaFile = (root: string, app: string) => path.join(authDir(root, app), "meta.json");

export const hasState = (root: string, app: string) => fs.existsSync(statePath(root, app));

export type SessionState = "none" | "valid" | "expired" | "unknown";

/** What the panel and the chat may know about a login: when it was saved and checked and the result. Never the content of the state. */
export interface SessionMeta {
  savedAt?: string;
  checkedAt?: string;
  state: SessionState;
  reason?: string;
  /** The address the probe ended on. */
  url?: string;
}

export function readMeta(root: string, app: string): SessionMeta {
  if (!hasState(root, app)) return { state: "none" };
  try {
    return JSON.parse(fs.readFileSync(metaFile(root, app), "utf8")) as SessionMeta;
  } catch {
    return { state: "unknown", reason: "never checked" };
  }
}

function writeMeta(root: string, app: string, meta: SessionMeta): void {
  fs.mkdirSync(authDir(root, app), { recursive: true, mode: 0o700 });
  fs.writeFileSync(metaFile(root, app), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
}

/** What a page shows: enough to tell a login from the app, without knowing the app. */
export interface PageFacts {
  url: string;
  hasPassword: boolean;
}

const LOGIN_PATH =
  /(^|\/)(log[-_]?in|sign[-_]?(in|on)|sso|auth|oauth2?|authorize|session\/new|accounts?\/login|saml|adfs)(\/|$|\?|#)/i;

/** The plain rule: a login-looking address, or a visible password field. Pure. */
export function looksLoggedOut(f: PageFacts): { out: boolean; reason: string } {
  let where = f.url;
  try {
    const u = new URL(f.url);
    where = `${u.pathname}${u.search}${u.hash}`;
  } catch {
    // a relative or odd address: look at it as it is
  }
  if (LOGIN_PATH.test(where))
    return { out: true, reason: `it ended on a login address (${where.slice(0, 80)})` };
  if (f.hasPassword) return { out: true, reason: "the page has a password field" };
  return { out: false, reason: "no login address, no password field" };
}

export interface ProbeResult {
  state: Exclude<SessionState, "none"> | "none";
  reason: string;
  url?: string;
}

/** Where the probe goes: the app's own rule, else its start page. */
export const probeUrl = (app: AppInfo): string => {
  const rule = app.login?.url;
  if (!rule) return app.baseUrl;
  try {
    return new URL(rule, app.baseUrl).toString();
  } catch {
    return app.baseUrl;
  }
};

export async function factsOf(page: Page): Promise<PageFacts> {
  const hasPassword =
    (await page
      .locator("input[type=password]:visible")
      .count()
      .catch(() => 0)) > 0;
  return { url: page.url(), hasPassword };
}

/** The app's own proof of being logged in (a text or a selector on the page); undefined when the app has no rule. */
async function ruleHolds(page: Page, rule: LoginRule | undefined): Promise<boolean | undefined> {
  if (!rule?.expectText && !rule?.expectSelector) return undefined;
  const loc = rule.expectSelector
    ? page.locator(rule.expectSelector).first()
    : page.getByText(rule.expectText as string).first();
  return loc.waitFor({ state: "visible", timeout: 5000 }).then(
    () => true,
    () => false,
  );
}

export interface ProbeOptions {
  root: string;
  app: AppInfo;
  /** The state file to try (default: the app's saved one). */
  file?: string;
  viewport?: { width: number; height: number };
  /** Record the result next to the state (default true). */
  record?: boolean;
}

/** Open the app with the saved state in a fresh headless browser and say whether you are still logged in. Never throws: a failure is "unknown" with the reason. */
export async function probeSession(o: ProbeOptions): Promise<ProbeResult> {
  const file = o.file ?? statePath(o.root, o.app.slug);
  if (!fs.existsSync(file)) return { state: "none", reason: "no saved login" };
  let result: ProbeResult;
  let browser: import("playwright").Browser | undefined;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      storageState: file,
      viewport: o.viewport ?? { width: 1280, height: 800 },
      locale: "en-US",
    });
    const page = await context.newPage();
    await page.goto(probeUrl(o.app), { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined); // an SPA redirects after its script runs
    await page.waitForTimeout(300);
    const facts = await factsOf(page);
    const rule = await ruleHolds(page, o.app.login);
    if (rule !== undefined)
      result = rule
        ? { state: "valid", reason: "the app's own check passed", url: facts.url }
        : {
            state: "expired",
            reason: `the app's own check did not find ${o.app.login?.expectSelector ?? `“${o.app.login?.expectText}”`}`,
            url: facts.url,
          };
    else {
      const v = looksLoggedOut(facts);
      result = v.out
        ? { state: "expired", reason: v.reason, url: facts.url }
        : { state: "valid", reason: v.reason, url: facts.url };
    }
  } catch (err) {
    result = {
      state: "unknown",
      reason: `the app could not be reached: ${(err as Error).message.split("\n")[0]}`,
    };
  } finally {
    await browser?.close().catch(() => undefined);
  }
  if (o.record !== false && !o.file)
    writeMeta(o.root, o.app.slug, {
      ...readMeta(o.root, o.app.slug),
      state: result.state,
      reason: result.reason,
      checkedAt: new Date().toISOString(),
      ...(result.url ? { url: result.url } : {}),
    });
  return result;
}

export interface LoginOptions {
  root: string;
  app: AppInfo;
  /** A visible window (default true); tests use a headless one. */
  headed?: boolean;
  viewport?: { width: number; height: number };
  /** Resolves when you say you are logged in (the chat's confirmation, the panel's button). Rejects or never resolves when you give up. */
  waitForDone: Promise<void>;
  /** Called with the page once the app is open (tests act as the user here). */
  afterOpen?: (page: Page) => Promise<void>;
  /** Called when the window is open, so the caller can tell you to go and log in. */
  onOpened?: () => void;
}

export interface LoginResult {
  saved: boolean;
  /** The check of the saved state in a fresh browser. */
  probe: ProbeResult;
  file: string;
  /** Why it was not saved. */
  problem?: string;
}

/**
 * Open a headed browser on the app; you log in by hand and say so; the state is saved owner-only and checked in a fresh headless browser. A state that does not hold
 * (the app keeps its login where a saved state cannot) is NOT kept and the previous one stays.
 */
export async function loginSession(o: LoginOptions): Promise<LoginResult> {
  const dir = authDir(o.root, o.app.slug);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = statePath(o.root, o.app.slug);
  const tmp = path.join(dir, `state.${process.pid}.new.json`);
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: o.headed === false });
  try {
    const context = await browser.newContext({
      viewport: o.viewport ?? { width: 1280, height: 800 },
      locale: "en-US",
    });
    const page = await context.newPage();
    await page
      .goto(probeUrl(o.app), { waitUntil: "domcontentloaded", timeout: 30_000 })
      .catch(() => undefined); // an unreachable page is still a window you can use
    await o.afterOpen?.(page);
    o.onOpened?.();
    const closed = new Promise<never>((_, reject) =>
      browser.on("disconnected", () =>
        reject(new Error("the browser window was closed before you said you were logged in")),
      ),
    );
    await Promise.race([o.waitForDone, closed]);
    await context.storageState({ path: tmp, indexedDB: true });
    fs.chmodSync(tmp, 0o600);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    return {
      saved: false,
      probe: { state: "unknown", reason: (err as Error).message },
      file,
      problem: (err as Error).message,
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
  // a fresh browser must be logged in with it, or it is no good
  const probe = await probeSession({
    root: o.root,
    app: o.app,
    file: tmp,
    ...(o.viewport ? { viewport: o.viewport } : {}),
  });
  if (probe.state === "expired") {
    fs.rmSync(tmp, { force: true });
    return {
      saved: false,
      probe,
      file,
      problem: `a fresh browser with the saved login is logged out (${probe.reason}). Either the login did not finish, or the app keeps it where a saved state cannot (sessionStorage): nothing was saved`,
    };
  }
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  const now = new Date().toISOString();
  writeMeta(o.root, o.app.slug, {
    savedAt: now,
    checkedAt: now,
    state: probe.state,
    reason: probe.reason,
    ...(probe.url ? { url: probe.url } : {}),
  });
  return { saved: true, probe, file };
}

/** Forget the saved login of an app (its state and its record). */
export function forgetSession(root: string, app: string): boolean {
  const had = hasState(root, app);
  fs.rmSync(statePath(root, app), { force: true });
  fs.rmSync(metaFile(root, app), { force: true });
  return had;
}

/** Set (or clear, with undefined) the app's own rule for "I am logged in" in its `app.json`. */
export function setLoginRule(root: string, appSlug: string, rule: LoginRule | undefined): AppInfo {
  const file = path.join(appDir(root, appSlug), "app.json");
  const info = JSON.parse(fs.readFileSync(file, "utf8")) as AppInfo;
  const clean: LoginRule = {};
  if (rule?.url?.trim()) clean.url = rule.url.trim();
  if (rule?.expectText?.trim()) clean.expectText = rule.expectText.trim();
  if (rule?.expectSelector?.trim()) clean.expectSelector = rule.expectSelector.trim();
  if (Object.keys(clean).length) info.login = clean;
  else Reflect.deleteProperty(info, "login");
  fs.writeFileSync(file, `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

/**
 * Before discovery or a recording: a saved login that has expired stops the start, with what to do. No saved login passes (a public app needs none; a take that
 * lands on a login page stops by itself, 7c). An app that cannot be reached passes with a note: the start will say it better.
 */
export async function checkBeforeStart(
  o: ProbeOptions,
): Promise<{ ok: true; note?: string } | { ok: false; message: string }> {
  if (!hasState(o.root, o.app.slug)) return { ok: true };
  const r = await probeSession(o);
  if (r.state === "expired")
    return {
      ok: false,
      message: `the saved login for ${o.app.name} has expired (${r.reason}): log in again with /demo login (or on the Project page), then start again`,
    };
  return r.state === "unknown"
    ? { ok: true, note: `could not check the login for ${o.app.name}: ${r.reason}` }
    : { ok: true };
}
