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
import { MARKER_FLAG, killMarker } from "./processes.ts";

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
  /** Marks every process of this browser (see processes.ts), so a frozen one can be found and killed. */
  marker?: string;
  /** Cap for one page's JavaScript heap in MB (0 or unset = Chromium's own). */
  memoryMb?: number;
  /** More Chromium switches (the deep log's). */
  extraArgs?: string[];
}

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

export function launchArgs(
  dpr: number,
  o: { marker?: string; memoryMb?: number; extraArgs?: string[] } = {},
): string[] {
  return [
    `--force-device-scale-factor=${dpr}`,
    "--hide-scrollbars",
    "--disable-features=Translate,MediaRouter",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    ...(o.memoryMb && o.memoryMb > 0 ? [`--js-flags=--max-old-space-size=${o.memoryMb}`] : []),
    ...(o.marker ? [`${MARKER_FLAG}${o.marker}`] : []),
    ...(o.extraArgs ?? []),
  ];
}

export async function openSession(opts: SessionOptions): Promise<BrowserSession> {
  const { chromium } = await import("playwright");
  const { width, height, dpr } = opts.viewport;
  const browser = await chromium.launch({
    headless: !opts.headed,
    args: launchArgs(dpr, {
      ...(opts.marker ? { marker: opts.marker } : {}),
      ...(opts.memoryMb ? { memoryMb: opts.memoryMb } : {}),
      ...(opts.extraArgs ? { extraArgs: opts.extraArgs } : {}),
    }),
  });
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
        // a frozen browser never answers its own close: give it 5 s, then kill what is ours
        await Promise.race([
          browser.close().catch(() => {}),
          new Promise<void>((r) => setTimeout(r, 5000)),
        ]);
        if (opts.marker) killMarker(opts.marker);
      },
    };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}
