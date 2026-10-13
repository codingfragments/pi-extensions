/**
 * Browser session for discovery and recording.
 *
 * S1 finding (docs/spikes/S1-capture.md): in headless Chromium the CDP
 * screencast ignores the context's deviceScaleFactor and delivers CSS-pixel
 * frames (1600×900). Launching with `--force-device-scale-factor=<dpr>` in
 * addition to the context DPR yields true device-pixel frames (3200×1800) at
 * ~60 fps while the layout stays at the CSS viewport — so D15 holds headless.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Page } from "playwright";

const OVERLAY_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "cursor",
  "overlay.js",
);

export interface SessionOptions {
  viewport: { width: number; height: number; dpr: number };
  headed?: boolean;
  /** Path to a Playwright storageState file (D5). */
  storageState?: string;
  /** Inject the virtual cursor overlay (default true). */
  cursor?: boolean;
}

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

export function launchArgs(dpr: number): string[] {
  return [
    `--force-device-scale-factor=${dpr}`,
    "--hide-scrollbars",
    "--disable-features=Translate,MediaRouter",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
  ];
}

export async function openSession(opts: SessionOptions): Promise<BrowserSession> {
  const { chromium } = await import("playwright");
  const { width, height, dpr } = opts.viewport;
  const browser = await chromium.launch({ headless: !opts.headed, args: launchArgs(dpr) });
  try {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: dpr,
      colorScheme: "light",
      locale: "en-US",
      ...(opts.storageState ? { storageState: opts.storageState } : {}),
    });
    if (opts.cursor !== false)
      await context.addInitScript({ content: fs.readFileSync(OVERLAY_FILE, "utf8") });
    const page = await context.newPage();
    let closed = false;
    return {
      browser,
      context,
      page,
      close: async () => {
        if (closed) return;
        closed = true;
        await browser.close().catch(() => {});
      },
    };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}
