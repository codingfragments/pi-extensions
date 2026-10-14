/**
 * S5 follow-ups: title-card text, panel brand routes (two-phase writes, no
 * real config touched), media byte ranges (video seeking), brand from a .zip,
 * brand font + backdrop image actually rendered.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { renderBrandAssets } from "../src/brand/assets.ts";
import { resolveBrand } from "../src/brand/brand.ts";
import { createBrand, materializeSource } from "../src/brand/manage.ts";
import { EventBus } from "../src/bus.ts";
import { resolveConfig } from "../src/config.ts";
import { titleInfoFor } from "../src/edit/pipeline.ts";
import { hasBinary } from "../src/media/ffmpeg.ts";
import { startPanel } from "../src/panel/server.ts";
import { Runtime } from "../src/runtime.ts";
import { parseStoryboard } from "../src/storyboard/parse.ts";
import { writeStoryboard } from "../src/storyboard/store.ts";
import { ensureProject } from "../src/workdir/layout.ts";
import { approve } from "../src/workdir/state.ts";

async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}
const noRender =
  !((await chromiumAvailable()) && hasBinary("ffmpeg")) && "needs Playwright Chromium + ffmpeg";
const noZip = !(hasBinary("zip") && hasBinary("unzip")) && "needs zip + unzip";

let root: string;
const savedCfg = process.env.DEMO_REC_CONFIG;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-s5f-"));
  // Never touch the real ~/.config/demo-recording/config.json.
  process.env.DEMO_REC_CONFIG = path.join(root, "global-config.json");
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (savedCfg === undefined) Reflect.deleteProperty(process.env, "DEMO_REC_CONFIG");
  else process.env.DEMO_REC_CONFIG = savedCfg;
});

const STORYBOARD = (title?: string) => `version: 1
${title ? `title: ${title}\n` : ""}start_url: /
scenes:
  - id: 01-a
    title: First
    steps:
      - do: press
        key: Enter
`;

function project(brief: Record<string, string>) {
  const p = ensureProject(root, {
    project: "key-craft",
    appName: "KeyCraft",
    appUrl: "https://k.test",
  });
  const lines = Object.entries(brief).map(([k, v]) => `- **${k}:** ${v}`);
  fs.writeFileSync(
    path.join(p.dir, "brief.md"),
    `# Demo brief: key-craft\n\n- **App:** KeyCraft\n${lines.join("\n")}\n`,
  );
  return p;
}

test("title card: brief Title → storyboard title → short goal → project name; no app/title duplicate", () => {
  const cfg = { ...resolveConfig({ env: {}, readFile: () => undefined }), root };
  // Placeholders are ignored; the project name equals the app name → one line.
  let p = project({ Title: "_TODO_", "Goal / key message": "_To be sharpened during discovery_" });
  assert.deepEqual(
    { ...titleInfoFor(p.dir, cfg), date: "" },
    { app: "", title: "KeyCraft", date: "" },
  );

  // Short goal is used.
  p = project({ "Goal / key message": "Search that feels instant" });
  assert.equal(titleInfoFor(p.dir, cfg).title, "Search that feels instant");
  assert.equal(titleInfoFor(p.dir, cfg).app, "KeyCraft");

  // Long goal is not a title.
  p = project({ "Goal / key message": "x".repeat(80) });
  assert.equal(titleInfoFor(p.dir, cfg).title, "KeyCraft");

  // The approved storyboard's title wins over the goal …
  p = project({ "Goal / key message": "Search that feels instant" });
  writeStoryboard(p.dir, STORYBOARD("What KeyCraft gets right"));
  writeStoryboard(
    p.dir,
    STORYBOARD("A later, unapproved title").replace("version: 1", "version: 2"),
  );
  approve(p.dir, "storyboard", 1);
  assert.equal(titleInfoFor(p.dir, cfg).title, "What KeyCraft gets right");

  // … and the brief's Title wins over everything.
  fs.appendFileSync(path.join(p.dir, "brief.md"), "- **Title:** Honest keyboards\n");
  assert.equal(titleInfoFor(p.dir, cfg).title, "Honest keyboards");

  assert.throws(() => parseStoryboard(STORYBOARD("t".repeat(61)), { version: 1 }), /title.*60/);
});

test("panel brand routes: list, read-only built-in, duplicate, two-phase save and use", async () => {
  const globalFile = process.env.DEMO_REC_CONFIG as string;
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: globalFile } }),
    root,
    panelPort: 0,
  }));
  const panel = await rt.ensurePanel();
  const base = `http://127.0.0.1:${panel.port}`;
  const auth = { authorization: `Bearer ${panel.token}` };
  const post = async (name: string, body: unknown) => {
    const r = await fetch(`${base}/api/${name}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
  try {
    const list = (await (await fetch(`${base}/api/brands`, { headers: auth })).json()) as {
      default: string;
      brands: { name: string; builtin: boolean }[];
      project: string | null;
    };
    assert.equal(list.default, "neutral");
    assert.ok(list.brands.some((b) => b.name === "neutral" && b.builtin));
    assert.equal(list.project, null);

    const ro = await post("brand-save", { name: "neutral", patch: { frame: { radius: 4 } } });
    assert.equal(ro.status, 400);
    assert.match(String(ro.json.error), /built in/);

    assert.equal((await post("brand-duplicate", { name: "neutral", to: "mine" })).status, 200);
    const brandFile = path.join(root, "brands", "mine", "brand.json");
    const before = fs.readFileSync(brandFile, "utf8");
    const planned = await post("brand-save", { name: "mine", patch: { frame: { radius: 4 } } });
    assert.equal(planned.json.planned, true);
    assert.match(String(planned.json.diff), /\+.*"radius": 4/);
    assert.equal(fs.readFileSync(brandFile, "utf8"), before, "planning writes nothing");
    assert.equal(
      (await post("brand-save", { name: "mine", patch: { frame: { radius: 4 } }, confirm: true }))
        .json.saved,
      true,
    );
    assert.equal(JSON.parse(fs.readFileSync(brandFile, "utf8")).frame.radius, 4);
    assert.equal(
      (await post("brand-save", { name: "mine", patch: { colors: { accent: "nope" } } })).status,
      400,
    );

    const use = await post("brand-use", { name: "mine" });
    assert.equal(use.json.planned, true);
    assert.ok(!fs.existsSync(globalFile), "planning writes nothing");
    await post("brand-use", { name: "mine", confirm: true });
    assert.equal(JSON.parse(fs.readFileSync(globalFile, "utf8")).brand, "mine");
    assert.equal(rt.getConfig().brand, "mine");
    assert.equal((await post("brand-use", { name: "missing" })).status, 400);
    assert.equal(
      (await post("brand-use", { name: "mine", scope: "project" })).status,
      400,
      "no active project",
    );

    const render = await post("export-render", { brand: "mine" });
    assert.equal(render.status, 400);
    assert.match(String(render.json.error), /no active (demo )?project/);
  } finally {
    await rt.shutdown();
  }
});

test("media: byte ranges for video seeking", async () => {
  const dir = path.join(root, "media");
  fs.mkdirSync(dir);
  const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
  fs.writeFileSync(path.join(dir, "v.mp4"), bytes);
  const panel = await startPanel({
    bus: new EventBus(),
    port: 0,
    token: "t".repeat(64),
    getState: () => ({}),
    media: () => ({ project: dir }),
  });
  const url = `http://127.0.0.1:${panel.port}/media/project/v.mp4?token=${"t".repeat(64)}`;
  try {
    const full = await fetch(url);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("accept-ranges"), "bytes");
    assert.equal(full.headers.get("content-length"), "1000");
    assert.equal(full.headers.get("content-type"), "video/mp4");
    await full.arrayBuffer();

    const part = await fetch(url, { headers: { range: "bytes=100-199" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), "bytes 100-199/1000");
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(100, 200));

    const open = await fetch(url, { headers: { range: "bytes=990-" } });
    assert.equal(open.headers.get("content-range"), "bytes 990-999/1000");
    assert.equal((await open.arrayBuffer()).byteLength, 10);

    const suffix = await fetch(url, { headers: { range: "bytes=-5" } });
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(995));

    const past = await fetch(url, { headers: { range: "bytes=5000-" } });
    assert.equal(past.status, 416);
    assert.equal(past.headers.get("content-range"), "bytes */1000");
    await past.arrayBuffer();
  } finally {
    await panel.close();
  }
});

const LOGO =
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="50"><rect width="200" height="50" rx="10" fill="#ffffff"/></svg>';

test("brand from a .zip (incl. a nested folder and __MACOSX junk)", { skip: noZip }, () => {
  const src = path.join(root, "material");
  fs.mkdirSync(path.join(src, "Acme Brand", "logos"), { recursive: true });
  fs.writeFileSync(path.join(src, "Acme Brand", "logos", "logo-white.svg"), LOGO);
  fs.mkdirSync(path.join(src, "__MACOSX"));
  fs.writeFileSync(path.join(src, "__MACOSX", "._logo-white.svg"), "junk");
  const zip = path.join(root, "acme brand.zip");
  execFileSync("zip", ["-qr", zip, "."], { cwd: src });

  const dir = materializeSource(zip);
  assert.ok(fs.existsSync(path.join(dir, "Acme Brand", "logos", "logo-white.svg")));
  const b = createBrand(root, {
    name: "acme",
    source: zip,
    logoLight: "Acme Brand/logos/logo-white.svg",
    settings: { colors: { accent: "#ff8800" } },
  });
  assert.equal(b.brand.logo.light, "logo-light.svg");
  assert.ok(fs.existsSync(path.join(root, "brands", "acme", "logo-light.svg")));
  assert.throws(() => materializeSource(path.join(root, "nope.zip")), /not found/);
  fs.writeFileSync(path.join(root, "x.rar"), "x");
  assert.throws(() => materializeSource(path.join(root, "x.rar")), /folder or a \.zip/);
});

function fontFile(): string | undefined {
  const candidates = [
    "/System/Library/Fonts/Supplemental/Courier New.ttf",
    "/System/Library/Fonts/Supplemental/Comic Sans MS.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
  ];
  return candidates.find((f) => fs.existsSync(f));
}

function pixel(png: string, x: number, y: number): number[] {
  const out = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", png, "-vf", `crop=1:1:${x}:${y},format=rgb24`, "-f", "rawvideo", "-"],
    { maxBuffer: 1 << 20 },
  );
  return [...out.stdout];
}

test(
  "brand font file and backdrop image are really rendered",
  { skip: noRender || (!fontFile() && "no system font to test with") },
  async () => {
    const src = path.join(root, "material");
    fs.mkdirSync(src);
    fs.copyFileSync(fontFile() as string, path.join(src, "brand.ttf"));
    // Solid red 1920×1080 backdrop image.
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=1920x1080",
      "-frames:v",
      "1",
      path.join(src, "bg.png"),
    ]);
    const title = { app: "Acme", title: "Fonts are applied", date: "May 2026" };
    const size = { width: 1920, height: 1080 };
    const cacheDir = path.join(root, "cache");

    createBrand(root, { name: "plain", settings: { font: { family: "serif", weight: 600 } } });
    createBrand(root, {
      name: "fonted",
      source: src,
      font: "brand.ttf",
      backdropImage: "bg.png",
      settings: { font: { family: "serif", weight: 600 } },
    });
    const plain = await renderBrandAssets(resolveBrand(root, "plain"), size, { cacheDir, title });
    const fonted = await renderBrandAssets(resolveBrand(root, "fonted"), size, { cacheDir, title });
    assert.ok(plain.title && fonted.title && fonted.backdrop);

    // Backdrop image: corners of the backdrop are red, not the slate gradient.
    const [r, g, b] = pixel(fonted.backdrop as string, 10, 10);
    assert.ok(
      (r as number) > 200 && (g as number) < 50 && (b as number) < 50,
      `backdrop pixel ${r},${g},${b}`,
    );
    // Font: the title text renders differently from the same card without the font file.
    const textRow = (png: string) =>
      spawnSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-i",
          png,
          "-vf",
          "crop=900:120:150:470,format=gray",
          "-f",
          "rawvideo",
          "-",
        ],
        { maxBuffer: 1 << 22 },
      ).stdout;
    const a = textRow(plain.title as string);
    const c = textRow(fonted.title as string);
    let diff = 0;
    for (let i = 0; i < a.length; i++)
      if (Math.abs((a[i] as number) - (c[i] as number)) > 60) diff++;
    assert.ok(
      diff / a.length > 0.02,
      `title glyphs differ with the brand font (${((diff / a.length) * 100).toFixed(1)}% of pixels)`,
    );
  },
);
