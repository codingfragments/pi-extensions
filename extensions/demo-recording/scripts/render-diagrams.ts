/**
 * Render docs/diagrams/*.mmd (Mermaid) to docs/images/architecture/<name>.png and .svg.
 *
 *   node extensions/demo-recording/scripts/render-diagrams.ts [name …]
 *
 * Mermaid is downloaded once (jsdelivr) into ~/.cache/demo-recording/ and run in
 * Playwright's Chromium, so nothing is added to package.json. The sources are the
 * truth; the images are what the docs show (they render everywhere, also in editors
 * without a Mermaid plugin). Colours follow the legend in docs/ARCHITECTURE.md:
 * human = orange, model = purple, engine = blue, script/tool = green.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const docs = path.join(here, "..", "docs");
const src = path.join(docs, "diagrams");
const out = path.join(docs, "images", "architecture");
const MERMAID_URL = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";

async function mermaidFile(): Promise<string> {
  const dir = path.join(os.homedir(), ".cache", "demo-recording");
  const file = path.join(dir, "mermaid-11.min.js");
  if (fs.existsSync(file) && fs.statSync(file).size > 1_000_000) return file;
  fs.mkdirSync(dir, { recursive: true });
  const res = await fetch(MERMAID_URL);
  if (!res.ok) throw new Error(`could not download mermaid (${res.status})`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

const { chromium } = await import("playwright");
const wanted = new Set(process.argv.slice(2));
const names = fs
  .readdirSync(src)
  .filter((f) => f.endsWith(".mmd"))
  .map((f) => f.slice(0, -4))
  .filter((n) => !wanted.size || wanted.has(n));
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    deviceScaleFactor: 2,
    viewport: { width: 1800, height: 1200 },
  });
  await page.setContent(
    '<html><body style="margin:0;background:#fff"><div id="host" style="display:inline-block;padding:24px;background:#fff"></div></body></html>',
  );
  await page.addScriptTag({ path: await mermaidFile() });
  await page.evaluate(`mermaid.initialize({
    startOnLoad: false,
    theme: "base",
    securityLevel: "loose",
    flowchart: { curve: "basis", htmlLabels: true, useMaxWidth: false, nodeSpacing: 36, rankSpacing: 48 },
    sequence: { useMaxWidth: false, mirrorActors: false, actorMargin: 60, messageMargin: 34 },
    themeVariables: { fontFamily: "Helvetica, Arial, sans-serif", fontSize: "15px", primaryColor: "#f4f4f6", primaryBorderColor: "#8a8a99", lineColor: "#6b6b7b", tertiaryColor: "#fafafa", noteBkgColor: "#fff8dc", noteBorderColor: "#d4b84a" }
  })`);
  for (const name of names) {
    const text = fs.readFileSync(path.join(src, `${name}.mmd`), "utf8");
    const svg = (await page.evaluate(
      `mermaid.render("d-${name.replace(/[^a-z0-9]/gi, "")}", ${JSON.stringify(text)}).then((r) => r.svg)`,
    )) as string;
    await page.evaluate(`document.getElementById("host").innerHTML = ${JSON.stringify(svg)}`);
    await page.locator("#host").screenshot({ path: path.join(out, `${name}.png`) });
    fs.writeFileSync(path.join(out, `${name}.svg`), svg);
    console.log(`rendered ${name}`);
  }
} finally {
  await browser.close();
}
