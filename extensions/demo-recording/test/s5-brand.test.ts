/**
 * S5 part 2 — brand packages: validation, inset geometry, creation from brand
 * material, diff-first updates, filter graph with brand layers, and the
 * title-card hold in the full video.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  insetBox,
  logoBugHeight,
  logoBugPosition,
  renderBrandAssets,
  titleLogoCss,
} from "../src/brand/assets.ts";
import { contrast, listBrands, parseBrand, resolveBrand } from "../src/brand/brand.ts";
import {
  createBrand,
  duplicateBrand,
  extractColors,
  inspectSource,
  mergePatch,
  patchedBrand,
  planBrandUpdate,
  updateBrand,
} from "../src/brand/manage.ts";
import { fullAnchorTimes } from "../src/edit/pipeline.ts";
import { filterGraph, fullJob, imageInputs } from "../src/edit/render.ts";
import type { Timeline } from "../src/edit/timeline.ts";
import { hasBinary } from "../src/media/ffmpeg.ts";

async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}
// Rendering logo previews/assets needs Chromium (and ffprobe); CI has neither.
const skip =
  !((await chromiumAvailable()) && hasBinary("ffmpeg")) && "needs Playwright Chromium + ffmpeg";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const SIZE = { width: 1920, height: 1080 };

const LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60" viewBox="0 0 240 60"><rect x="0" y="0" width="60" height="60" rx="12" fill="#ffffff"/><text x="74" y="42" font-size="36" fill="#ffffff" font-family="sans-serif">Acme</text></svg>';

function brandMaterial(): string {
  const dir = tmp("demo-rec-brandsrc-");
  fs.mkdirSync(path.join(dir, "logos"));
  fs.writeFileSync(path.join(dir, "logos", "acme-logo-white.svg"), LOGO_SVG);
  fs.writeFileSync(
    path.join(dir, "logos", "acme-logo-black.svg"),
    LOGO_SVG.replaceAll("#ffffff", "#111111"),
  );
  fs.writeFileSync(
    path.join(dir, "colors.css"),
    ":root{--primary:#632CA6;--bg:#1b1430;--text:#f5f3fa;--primary-2:#632ca6;--x:#fff}",
  );
  return dir;
}

test("neutral brand ships built in and validates cleanly", () => {
  const root = tmp("demo-rec-brand-");
  const brands = listBrands(root);
  assert.ok(brands.some((b) => b.name === "neutral" && b.builtin && !b.error));
  const n = resolveBrand(root, "neutral");
  assert.equal(n.brand.frame.mode, "inset");
  assert.equal(n.brand.logoBug.enabled, false);
  assert.deepEqual(n.warnings, []);
  assert.ok(contrast(n.brand.colors.text, n.brand.colors.backdrop) >= 4.5);
});

test("parseBrand rejects bad values and warns on low contrast", () => {
  assert.throws(() => parseBrand({ colors: { accent: "purple" } }, "x", "/tmp"), /colors\.accent/);
  assert.throws(() => parseBrand({ frame: { inset: 0.3 } }, "x", "/tmp"), /frame\.inset/);
  const low = parseBrand(
    { colors: { backdrop: "#202020", backdropTo: "#202020", text: "#303030" } },
    "x",
    "/tmp",
  );
  assert.ok(
    low.warnings.some((w) => /contrast/i.test(w)),
    low.warnings.join("; "),
  );
});

test("title.logoPosition: validated, defaults to inline, drives the title-card CSS", () => {
  assert.equal(parseBrand({}, "x", "/tmp").brand.title.logoPosition, "inline");
  assert.equal(
    parseBrand({ title: { logoPosition: "top-left" } }, "x", "/tmp").brand.title.logoPosition,
    "top-left",
  );
  assert.throws(
    () => parseBrand({ title: { logoPosition: "middle" } }, "x", "/tmp"),
    /title\.logoPosition/,
  );
  assert.match(titleLogoCss("inline", 1), /margin-bottom/);
  assert.doesNotMatch(titleLogoCss("inline", 1), /position:absolute/);
  assert.match(titleLogoCss("top-left", 1), /position:absolute;left:150px;top:96px/);
  assert.match(titleLogoCss("bottom-right", 1), /right:150px;bottom:96px/);
});

test("insetBox centers the footage and keeps the aspect ratio", () => {
  const n = resolveBrand(tmp("demo-rec-brand-"), "neutral").brand;
  const b = insetBox(n, SIZE);
  assert.equal(b.w % 2, 0);
  assert.equal(b.h % 2, 0);
  assert.ok(Math.abs(b.w / b.h - 16 / 9) < 0.01);
  assert.ok(Math.abs(b.x - (SIZE.width - b.w) / 2) <= 1);
  assert.ok(Math.abs(b.w - 0.92 * SIZE.width) <= 2);
  const full = insetBox({ ...n, frame: { ...n.frame, mode: "fullbleed" } }, SIZE);
  assert.deepEqual(full, { x: 0, y: 0, w: 1920, h: 1080 });
});

test("extractColors normalizes and ranks hex codes", () => {
  const c = extractColors([":root{--a:#632CA6;--b:#632ca6;--c:#fff}", "#FFF"]);
  assert.deepEqual(c.slice(0, 2), [
    { hex: "#632ca6", count: 2 },
    { hex: "#ffffff", count: 2 },
  ]);
});

test("brand from material: inspect, create, diff-first update, duplicate", { skip }, async () => {
  const root = tmp("demo-rec-brandroot-");
  const src = brandMaterial();
  const inv = await inspectSource(src, path.join(root, "inspect"));
  const light = inv.files.find((f) => f.rel.endsWith("white.svg"));
  const dark = inv.files.find((f) => f.rel.endsWith("black.svg"));
  assert.equal(light?.kind, "logo-candidate");
  assert.ok((light?.luminance ?? 0) > 0.8, "white mark is light");
  assert.ok((dark?.luminance ?? 1) < 0.2, "black mark is dark");
  assert.ok(
    inv.colors.some((c) => c.hex === "#632ca6" && c.count === 2),
    JSON.stringify(inv.colors),
  );
  assert.equal(inv.previews.length, 2);

  const created = createBrand(root, {
    name: "acme",
    source: src,
    displayName: "Acme",
    logoLight: "logos/acme-logo-white.svg",
    logoDark: "logos/acme-logo-black.svg",
    settings: {
      colors: { accent: "#9a6fe0", backdrop: "#1b1430", backdropTo: "#2a2047" },
      logoBug: { enabled: true },
    },
  });
  assert.equal(created.builtin, false);
  assert.ok(fs.existsSync(path.join(root, "brands", "acme", "logo-light.svg")));
  assert.ok(listBrands(root).some((b) => b.name === "acme"));
  assert.throws(() => createBrand(root, { name: "acme" }), /already exists/);
  assert.throws(() => createBrand(root, { name: "Bad Name" }), /lowercase/);
  assert.throws(
    () => createBrand(root, { name: "x", source: src, logoLight: "../../etc/passwd" }),
    /not found/,
  );

  // Diff-first update; nothing written by the plan.
  const before = fs.readFileSync(path.join(created.dir, "brand.json"), "utf8");
  const plan = planBrandUpdate(root, "acme", { colors: { accent: "#ff8800" } });
  assert.match(plan.diff, /\+.*#ff8800/);
  assert.equal(fs.readFileSync(path.join(created.dir, "brand.json"), "utf8"), before);
  assert.throws(() => planBrandUpdate(root, "acme", { colors: { accent: "nope" } }), /accent/);
  const updated = updateBrand(root, "acme", { colors: { accent: "#ff8800" } });
  assert.equal(updated.brand.colors.accent, "#ff8800");
  assert.equal(updated.brand.colors.backdrop, "#1b1430", "untouched fields kept");

  // Built-ins are read-only; duplicate first.
  assert.throws(() => updateBrand(root, "neutral", { frame: { radius: 4 } }), /built in/);
  const copy = duplicateBrand(root, "neutral", "neutral-custom");
  assert.equal(copy.builtin, false);
  assert.equal(updateBrand(root, "neutral-custom", { frame: { radius: 4 } }).brand.frame.radius, 4);
  // In-memory patch for previews leaves the file alone.
  assert.equal(
    patchedBrand(root, "neutral-custom", { frame: { radius: 30 } }).brand.frame.radius,
    30,
  );
  assert.equal(resolveBrand(root, "neutral-custom").brand.frame.radius, 4);
  assert.deepEqual(mergePatch({ a: { b: 1, c: 2 } }, { a: { c: 3 } }), { a: { b: 1, c: 3 } });

  // Assets: backdrop, mask, title, logo bug (cached on the second call).
  const cacheDir = path.join(root, "cache");
  const title = { app: "Acme Pulse", title: "Churn", date: "May 2026" };
  const a = await renderBrandAssets(resolveBrand(root, "acme"), SIZE, {
    cacheDir,
    title,
    withLogoBug: true,
  });
  for (const f of [a.backdrop, a.mask, a.title, a.logoBug?.file])
    assert.ok(f && fs.existsSync(f), `asset ${f}`);
  const t0 = Date.now();
  const again = await renderBrandAssets(resolveBrand(root, "acme"), SIZE, {
    cacheDir,
    title,
    withLogoBug: true,
  });
  assert.equal(again.title, a.title);
  assert.ok(Date.now() - t0 < 500, "second call hits the cache");
  const dims = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", a.title as string],
    { encoding: "utf8" },
  ).trim();
  assert.equal(dims, "1920,1080");
});

test("filterGraph: inset + mask + title + logo bug, inputs after audio", () => {
  const job = {
    video: [{ src: [0, 2000] as [number, number], speed: 1, durMs: 2000 }],
    audio: [{ file: "/a.wav", src: [0, 1000] as [number, number], at: 0 }],
    durationMs: 2000,
  };
  const brand = {
    inset: { x: 76, y: 43, w: 1766, h: 994 },
    backdrop: "/bg.png",
    mask: "/mask.png",
    title: { file: "/title.png", durationMs: 2500, dissolveMs: 800 },
    logoBug: { file: "/bug.png", x: 1800, y: 1000, opacity: 0.7, fromMs: 3300 },
  };
  const g = filterGraph(job, { fps: 30, width: 1920, height: 1080, brand }, ["/a.wav"]);
  assert.deepEqual(
    imageInputs(brand).map((i) => i.key),
    ["backdrop", "mask", "title", "bug"],
  );
  assert.match(g, /scale=1766:994/);
  assert.match(g, /\[3:v\]format=gray/, "mask is input 3 (video, audio, backdrop, mask)");
  assert.match(g, /alphamerge/);
  assert.match(g, /overlay=76:43/);
  assert.match(g, /fade=t=out:st=2\.500:d=0\.800:alpha=1/);
  assert.match(g, /colorchannelmixer=aa=0\.70/);
  assert.match(g, /\[vout\]/);
  // No brand → unchanged full-frame graph.
  const plain = filterGraph(job, { fps: 30, width: 1920, height: 1080 }, ["/a.wav"]);
  assert.match(plain, /scale=1920:1080/);
  assert.doesNotMatch(plain, /alphamerge|overlay/);
});

test("fullJob holds the opening frame long enough for the title card", () => {
  const t = {
    take: "take-001",
    scenes: [
      {
        id: "01-a",
        durationMs: 4000,
        pieces: [{ src: [1000, 5000], speed: 1 }],
        audio: [],
        anchors: [{ mark: "m", out: 1000, audioAt: 1000, drift: 0 }],
      },
    ],
    full: [{ type: "scene", id: "01-a" }],
  } as unknown as Timeline;
  const plain = fullJob(t, "/p");
  const titled = fullJob(t, "/p", { titleMs: 3300 });
  assert.equal(titled.durationMs, plain.durationMs + 3300);
  assert.deepEqual(titled.video[0], { hold: 1000, durMs: 3300 });
  assert.equal(fullAnchorTimes(t, { titleMs: 3300 })[0]?.out, 4300);
  // An intro card longer than the title needs no extra hold.
  const withIntro = {
    ...t,
    full: [{ type: "card", kind: "intro", durationMs: 5000, holdAt: 1000 }, ...t.full],
  } as unknown as Timeline;
  assert.equal(
    fullJob(withIntro, "/p", { titleMs: 3300 }).durationMs,
    fullJob(withIntro, "/p").durationMs,
  );
});

test("logo bug sits in the margin or inside the footage, never on its edge", () => {
  const n = resolveBrand(tmp("demo-rec-brand-"), "neutral").brand;
  const box = insetBox(n, SIZE); // ~43 px vertical margin
  const small = logoBugPosition("bottom-right", { w: 100, h: 28 }, box, SIZE);
  assert.ok(small.y >= box.y + box.h, "fits in the bottom margin");
  assert.equal(small.x + 100, box.x + box.w, "aligned with the footage's right edge");
  const tall = logoBugPosition("bottom-right", { w: 100, h: 40 }, box, SIZE);
  assert.ok(
    tall.y + 40 <= box.y + box.h - 10 && tall.x + 100 <= box.x + box.w - 10,
    "inside the footage with padding",
  );
  const top = logoBugPosition("top-left", { w: 100, h: 28 }, box, SIZE);
  assert.ok(top.y + 28 <= box.y && top.x === box.x);
  // Inset: the bug shrinks to fit the margin (its light logo is made for the backdrop).
  const h = logoBugHeight(n, box, SIZE);
  assert.ok(h <= SIZE.height - box.y - box.h - 12 && h >= 20, `bug height ${h}`);
  assert.ok(logoBugPosition("bottom-right", { w: 100, h }, box, SIZE).y >= box.y + box.h);
  assert.equal(
    logoBugHeight({ ...n, frame: { ...n.frame, mode: "fullbleed" } }, box, SIZE),
    n.logoBug.heightPx,
  );
  const fb = logoBugPosition(
    "bottom-left",
    { w: 100, h: 28 },
    { x: 0, y: 0, ...{ w: 1920, h: 1080 } },
    SIZE,
  );
  assert.ok(fb.x > 0 && fb.y + 28 < 1080, "full-bleed: inside with padding");
});
