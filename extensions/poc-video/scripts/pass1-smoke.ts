/**
 * pass1-smoke — headless end-to-end exercise of the browser module
 * (open → navigate → screenshot → close). Manual recipe: just smoke-browser
 * (CI does not run this — it needs the Chromium binary and network).
 *
 * Run from extensions/poc-video/: node scripts/pass1-smoke.ts <tmpdir>
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeBrowser, openBrowser, requirePage, requireRunDir } from "../browser.ts";

async function main(): Promise<number> {
  // ALWAYS under the OS temp dir — a run dir contains a browser profile that
  // must never land inside the repo working tree.
  const tmp = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), "poc-video-smoke-"));
  const runDir = path.join(tmp, "smoke-target");
  fs.mkdirSync(runDir, { recursive: true });

  const state = await openBrowser({ runDir, url: "https://example.com", headless: true });
  const url1 = state.page.url();
  if (!url1.includes("example.com")) throw new Error(`unexpected start url: ${url1}`);

  const page = requirePage();
  await page.goto("https://example.com", { waitUntil: "domcontentloaded" });

  const scenesDir = path.join(requireRunDir(), "scenes");
  fs.mkdirSync(scenesDir, { recursive: true });
  const shot = path.join(scenesDir, "smoke-01.png");
  await page.screenshot({ path: shot });
  const stat = fs.statSync(shot);
  if (stat.size < 1000) throw new Error(`screenshot suspiciously small: ${stat.size} bytes`);

  await closeBrowser();
  console.log(
    `✔ smoke passed — ${path.relative(tmp, shot)} (${stat.size} bytes), profile under ${tmp}`,
  );
  return 0;
}

process.exit(await main());
