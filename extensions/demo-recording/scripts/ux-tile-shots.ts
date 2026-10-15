/**
 * Screenshots of the UX0 style tile and mock screens (docs/ux/*.html) in both themes at
 * 1400 and 900 px, written to docs/images/ux/. The pages are static (file://), so no server.
 *
 *   node extensions/demo-recording/scripts/ux-tile-shots.ts            # everything
 *   node extensions/demo-recording/scripts/ux-tile-shots.ts voice map  # only these pages
 *   node extensions/demo-recording/scripts/ux-tile-shots.ts --out /tmp/ux   # elsewhere
 *   node extensions/demo-recording/scripts/ux-tile-shots.ts --sections     # tile sections too
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.join(import.meta.dirname, "..");
const UX = path.join(ROOT, "docs", "ux");

interface Shot {
  name: string;
  page: string;
  query?: string;
  widths?: number[];
  /** Click or act before the shot (a selector to click). */
  click?: string[];
  fullPage?: boolean;
  /** Only when named on the command line. */
  optional?: boolean;
}

/** The mock screens and the states worth reviewing. */
const SHOTS: Shot[] = [
  { name: "voice", page: "voice.html", fullPage: true },
  { name: "voice-activity", page: "voice.html", click: ["[data-act=drawer]"], widths: [1400] },
  { name: "render", page: "render.html", fullPage: true },
  { name: "map", page: "map.html" },
  { name: "map-approved-paths", page: "map.html", query: "view=approved", widths: [1400] },
  { name: "map-search-final", page: "map.html", query: "q=final&sel=r8", widths: [1400] },
  { name: "map-focus", page: "map.html", query: "focus=1&sel=vo2&open=g1", widths: [1400] },
  { name: "config", page: "config.html", fullPage: true },
  {
    name: "config-search",
    page: "config.html",
    query: "q=voice&open=voiceName",
    fullPage: true,
    widths: [1400],
  },
  {
    name: "config-edit",
    page: "config.html",
    query: "q=tts&edit=ttsChain&open=voiceName",
    fullPage: true,
    widths: [1400],
  },
  // large (1.5 MB each): only when asked for by name, e.g. `... ux-tile-shots.ts tile`
  { name: "tile", page: "tile.html", fullPage: true, widths: [1400], optional: true },
];

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT = outIdx >= 0 ? (args[outIdx + 1] as string) : path.join(ROOT, "docs", "images", "ux");
const only = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");
const withSections = args.includes("--sections");

const pw = await import("playwright");
const browser = await pw.chromium.launch();
fs.mkdirSync(OUT, { recursive: true });
const made: string[] = [];
try {
  for (const shot of SHOTS) {
    if (only.length && !only.includes(shot.name) && !only.includes(shot.page.replace(".html", "")))
      continue;
    if (!only.length && shot.optional) continue;
    for (const theme of ["macchiato", "latte"] as const) {
      for (const width of shot.widths ?? [1400, 900]) {
        const page = await browser.newPage({
          viewport: { width, height: width === 1400 ? 900 : 1000 },
          deviceScaleFactor: 1,
        });
        const query = new URLSearchParams(shot.query ?? "");
        query.set("theme", theme);
        await page.goto(`${pathToFileURL(path.join(UX, shot.page)).href}?${query}`);
        await page.evaluate("document.fonts.ready");
        for (const sel of shot.click ?? []) await page.locator(sel).first().click();
        await page.waitForTimeout(150);
        const file = path.join(
          OUT,
          `${shot.name}-${theme === "macchiato" ? "dark" : "light"}-${width}.png`,
        );
        if (shot.fullPage === true && shot.page !== "tile.html") {
          // a tall window, not Playwright's full-page mode: fixed bars (the status strip) stay at the bottom
          const h = (await page.evaluate("document.documentElement.scrollHeight")) as number;
          await page.setViewportSize({ width, height: Math.min(Math.max(h, 900), 2400) });
          await page.waitForTimeout(100);
          await page.screenshot({ path: file });
        } else {
          await page.screenshot({ path: file, fullPage: shot.fullPage === true });
        }
        made.push(file);
        await page.close();
      }
    }
  }
  if (withSections) {
    for (const theme of ["macchiato", "latte"] as const) {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.goto(`${pathToFileURL(path.join(UX, "tile.html")).href}?theme=${theme}`);
      await page.evaluate("document.fonts.ready");
      for (const el of await page.locator("[data-shot]").all()) {
        const name = (await el.getAttribute("data-shot")) as string;
        const file = path.join(OUT, `tile-${name}-${theme === "macchiato" ? "dark" : "light"}.png`);
        await el.screenshot({ path: file });
        made.push(file);
      }
      await page.close();
    }
  }
} finally {
  await browser.close();
}
for (const f of made) console.log(f);
