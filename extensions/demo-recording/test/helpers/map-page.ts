/** The map open in a browser on the seeded project: shared by the mouse and trackpad tests. */
import fs from "node:fs";
import path from "node:path";
import { resolveConfig } from "../../src/config.ts";
import { Runtime } from "../../src/runtime.ts";
import { seedPanelProject } from "./panel-seed.ts";

export async function chromium() {
  try {
    const pw = await import("playwright");
    return fs.existsSync(pw.chromium.executablePath()) ? pw.chromium : undefined;
  } catch {
    return undefined;
  }
}

export async function openMap() {
  const browserType = await chromium();
  process.env.DEMO_REC_NO_OPEN = "1";
  const seed = seedPanelProject();
  const cfg = path.join(seed.root, "c.json");
  fs.writeFileSync(cfg, "{}");
  process.env.DEMO_REC_CONFIG = cfg;
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
    root: seed.root,
    panelPort: 0,
  }));
  rt.tellAgent = () => undefined;
  rt.setActiveProject(seed.slug);
  const panel = await rt.ensurePanel();
  const browser = await (browserType as NonNullable<typeof browserType>).launch();
  const page = await (
    await browser.newContext({ viewport: { width: 1400, height: 800 } })
  ).newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${panel.url}#/map`);
  await page.waitForSelector(".ds-map .ds-node");
  const level = async () => Number.parseInt(await page.innerText("[data-zoom]"));
  const canvas = () =>
    page.evaluate(
      "(() => { const c = document.querySelector('.ds-map-canvas'); const r = c.getBoundingClientRect(); return { left: c.scrollLeft, top: c.scrollTop, x: r.left, y: r.top, w: c.clientWidth, h: c.clientHeight, panning: c.dataset.panning ?? null, cursor: getComputedStyle(c).cursor }; })()",
    ) as Promise<{
      left: number;
      top: number;
      x: number;
      y: number;
      w: number;
      h: number;
      panning: string | null;
      cursor: string;
    }>;
  /** The graph point (in its own units) under a pointer position. */
  const under = (px: number, py: number) =>
    page.evaluate(
      `(() => { const c = document.querySelector('.ds-map-canvas'); const r = c.getBoundingClientRect(); const z = Number.parseInt(document.querySelector('[data-zoom]').textContent) / 100; return { x: (c.scrollLeft + ${px} - r.left) / z, y: (c.scrollTop + ${py} - r.top) / z }; })()`,
    ) as Promise<{ x: number; y: number }>;
  const close = async () => {
    await browser.close();
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  };
  return { page, level, canvas, under, errors, close };
}
