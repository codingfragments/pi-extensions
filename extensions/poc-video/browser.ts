import fs from "node:fs";
import path from "node:path";
/**
 * poc-video browser state — the single place that owns the Chromium
 * lifecycle. Pass-1 exploration tools drive it; the pass-2 recording
 * runner (record.ts, pending) will reuse the same persistent-profile
 * conventions.
 *
 * Deliberately thin: if exploration ever moves to Playwright MCP, this
 * module is the only code that changes — the storyboard/validator/panel
 * layers are driver-agnostic.
 */
import { chromium } from "playwright";
import type { BrowserContext, Page } from "playwright";

export interface BrowserState {
  context: BrowserContext;
  page: Page;
  /** run directory (pocs/<target>) — screenshots/recordings land here */
  runDir: string;
  /** persistent profile dir — reused across retakes, never committed */
  profileDir: string;
}

let current: BrowserState | null = null;

/** The run dir of the open browser, or null. */
export function activeRunDir(): string | null {
  return current?.runDir ?? null;
}

/**
 * Launch a persistent headed Chromium and open `url`.
 *
 * The persistent profile means: the user logs in manually ONCE per working
 * session; retakes reuse the same profile without re-login. Credentials are
 * never captured by us — the profile belongs to the user's own browser
 * data dir under the run directory.
 *
 * If a browser is already open for the same run dir, it is reused (just
 * navigates). A different run dir is a hard error — close first.
 */
export async function openBrowser(opts: {
  runDir: string;
  url: string;
  headless?: boolean;
}): Promise<BrowserState> {
  const runDir = path.resolve(opts.runDir);
  if (current) {
    if (current.runDir === runDir) {
      await current.page.goto(opts.url, { waitUntil: "domcontentloaded" });
      return current;
    }
    throw new Error(
      `browser already open for run dir ${current.runDir} — call poc_video_close first to switch to ${runDir}`,
    );
  }
  const profileDir = path.join(runDir, ".profile");
  fs.mkdirSync(profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: opts.headless ?? false,
    viewport: { width: 1920, height: 1080 },
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(opts.url, { waitUntil: "domcontentloaded" });
  current = { context, page, runDir, profileDir };
  return current;
}

/** The page of the open browser — throws a helpful error when closed. */
export function requirePage(): Page {
  if (!current) {
    throw new Error("browser not open — call poc_video_open first (run dir + start URL)");
  }
  return current.page;
}

/** The run dir of the open browser — throws a helpful error when closed. */
export function requireRunDir(): string {
  if (!current) {
    throw new Error("browser not open — call poc_video_open first (run dir + start URL)");
  }
  return current.runDir;
}

/** Close the browser (idempotent). */
export async function closeBrowser(): Promise<void> {
  const state = current;
  current = null;
  if (state) {
    await state.context.close().catch(() => {});
  }
}

/** Session-shutdown cleanup — registered in index.ts, never throws. */
export async function shutdownBrowser(): Promise<void> {
  try {
    await closeBrowser();
  } catch {
    // best-effort: never block session teardown
  }
}
