/**
 * S4 end-to-end (opt-in: DEMO_REC_E2E=1; needs Chromium, ffmpeg, uv, macOS say):
 * take → analysis → anchored voice-over → approval → offline voice (say +
 * Whisper alignment) → audio-led edit → scenes + full.mp4. Sync is measured
 * INDEPENDENTLY of the timeline: on screen (frame difference in the result
 * box) and in the final audio (Whisper on the rendered mix).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { dropSilentWords, envelope, refineOnsets } from "../src/align/onset.ts";
import { analyzeTake } from "../src/analysis/take.ts";
import { insetBox, renderBrandAssets } from "../src/brand/assets.ts";
import { resolveBrand } from "../src/brand/brand.ts";
import { createBrand } from "../src/brand/manage.ts";
import { resolveConfig } from "../src/config.ts";
import { fullAnchorTimes, renderVariant, runEdit, titleInfoFor } from "../src/edit/pipeline.ts";
import { serveFixture } from "../src/fixture/server.ts";
import { ffprobe, hasBinary, run } from "../src/media/ffmpeg.ts";
import { recordTake } from "../src/recorder/runner.ts";
import { parseStoryboard } from "../src/storyboard/parse.ts";
import { say } from "../src/tts/engines.ts";
import { sayAvailable } from "../src/tts/say.ts";
import { renderVoice, whisperWords } from "../src/tts/synthesize.ts";
import { writeVo } from "../src/vo/store.ts";
import { ensureProject } from "../src/workdir/layout.ts";
import { acceptTake, approve } from "../src/workdir/state.ts";

const enabled = process.env.DEMO_REC_E2E === "1";
const skip = !enabled
  ? "set DEMO_REC_E2E=1"
  : !(sayAvailable() && hasBinary("uv") && hasBinary("ffmpeg"))
    ? "needs macOS say + uv + ffmpeg"
    : false;

const STORYBOARD = `start_url: /?slow=1
scenes:
  - id: 01-dashboard
    title: Where churn hides
    steps:
      - { do: hover, target: { css: '[data-kpi="churn"]' }, mark: churn-kpi, dwell: 1.2s }
      - { do: hover, target: { css: 'g[data-region="EMEA"] rect' }, mark: emea-bar, dwell: 1.2s }
  - id: 02-search
    title: Ask in plain language
    deep_link: /search
    steps:
      - { do: click, target: { role: link, name: Search } }
      - { do: type, target: { role: searchbox, name: Search }, text: churn by region, mark: type-start }
      - { do: press, key: Enter }
      - { do: wait, for: { css: table.regions }, timeout: 15s, mark: results-visible, dwell: 1.5s }
`;

const VO = `---
take: take-001
---
## _intro
Churn looks fine on this dashboard. Split it by region and it is not.

## 01-dashboard
Headline churn is three point one percent. [@emea-bar] Then the chart: EMEA is far above everyone else.

## 02-search
Plain language search. [@type-start] Churn by region, nothing more. [@results-visible] Results arrive, and EMEA leads at {{dom:results-visible|EMEA\\s+([\\d.]+%)}}.

## _outro
Two steps, and the regional problem is obvious.
`;

type Box = { x: number; y: number; w: number; h: number };
/** Crop a viewport-space box out of a rendered frame (footage inset at `off` with `scale`). */
async function crop(
  video: string,
  sec: number,
  box: Box,
  scale: number,
  off = { x: 0, y: 0 },
): Promise<Buffer> {
  const out = path.join(os.tmpdir(), `demo-rec-e2e4-${process.pid}-${sec}.gray`);
  const c = `crop=${Math.round(box.w * scale)}:${Math.round(box.h * scale)}:${Math.round(off.x + box.x * scale)}:${Math.round(off.y + box.y * scale)}`;
  await run("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-ss",
    sec.toFixed(3),
    "-i",
    video,
    "-frames:v",
    "1",
    "-vf",
    `${c},scale=64:32,format=gray`,
    "-f",
    "rawvideo",
    out,
  ]);
  const b = fs.readFileSync(out);
  fs.rmSync(out);
  return b;
}
const diff = (a: Buffer, b: Buffer) =>
  a.reduce((n, v, i) => n + Math.abs(v - (b[i] ?? 0)), 0) / a.length;

test(
  "S4: anchored, audio-led edit — narration and screen events land within ±150 ms, dead time removed",
  { skip, timeout: 900_000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-e2e4-"));
    const fixture = await serveFixture(0);
    try {
      const config = { ...resolveConfig({ env: {}, readFile: () => undefined }), root };
      const project = ensureProject(root, {
        project: "e2e4",
        appName: "Acme Pulse",
        appUrl: fixture.url,
      });
      const take = await recordTake({
        projectDir: project.dir,
        storyboard: parseStoryboard(STORYBOARD, { version: 1 }),
        storyboardVersion: 1,
        baseUrl: fixture.url,
        viewport: config.viewport,
        fps: 30,
        seed: 4,
      });
      const analysis = await analyzeTake(take.takeDir);
      acceptTake(project.dir, take.takeId);
      const vo = writeVo(project.dir, VO);
      assert.match(
        vo.validated.resolved.find((s) => s.key === "02-search")?.body ?? "",
        /EMEA leads at 14\.2%/,
      );
      approve(project.dir, "vo", vo.version);

      const manifest = await renderVoice({
        projectDir: project.dir,
        voVersion: vo.version,
        take: take.takeId,
        sections: vo.validated.resolved,
        engines: [say({})],
      });
      assert.equal(manifest.engine, "say");
      const edit = await runEdit({ projectDir: project.dir, config });

      // ---- format
      const probe = await ffprobe(edit.full.file);
      const v = probe.streams.find((s) => s.codec_type === "video");
      assert.equal(`${v?.width}x${v?.height}`, "1920x1080");
      assert.equal(v?.r_frame_rate, "30/1");
      assert.ok(probe.streams.some((s) => s.codec_type === "audio"));
      assert.ok(
        Math.abs(probe.duration - edit.timeline.totals.fullMs / 1000) < 0.15,
        `full ${probe.duration}s vs timeline ${edit.timeline.totals.fullMs / 1000}s`,
      );
      assert.equal(edit.scenes.length, 2);
      for (const s of edit.scenes) assert.ok(fs.statSync(s.file).size > 20_000);

      // ---- dead time removed: the 4 s spinner is gone from the search scene
      const search = analysis.scenes.find((s) => s.id === "02-search");
      const searchEdit = edit.timeline.scenes.find((s) => s.id === "02-search");
      assert.ok(search && searchEdit);
      assert.ok(
        searchEdit.stats.cutMs >= 3000,
        `≥ 3 s of dead time cut (${searchEdit.stats.cutMs} ms)`,
      );

      // ---- sync, measured on screen: results box empty before the anchor, filled after
      // Default brand (neutral): title card over the intro, footage inset on the backdrop.
      const brand = resolveBrand(root, config.brand).brand;
      const titleMs = brand.title.enabled ? brand.title.durationMs + brand.title.dissolveMs : 0;
      const inset = insetBox(brand, config.output);
      assert.equal(edit.brand, "neutral");
      const anchors = fullAnchorTimes(edit.timeline, { titleMs });
      const results = anchors.find((a) => a.mark === "results-visible");
      const box = search.marks.find((m) => m.mark === "results-visible")?.box;
      assert.ok(results && box);
      const scale = inset.w / config.viewport.width;
      const before = await crop(edit.full.file, (results.out - 150) / 1000, box, scale, inset);
      const after = await crop(edit.full.file, (results.out + 150) / 1000, box, scale, inset);
      assert.ok(
        diff(before, after) > 8,
        `results appear within ±150 ms of the anchor on screen (diff ${diff(before, after).toFixed(1)})`,
      );

      // ---- sync, measured in the audio: Whisper on the final mix finds each anchored phrase at its anchor
      const wav = path.join(root, "final.wav");
      await run("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-i",
        edit.full.file,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        wav,
      ]);
      const env = await envelope(wav);
      const words = refineOnsets(
        dropSilentWords(
          await whisperWords(
            wav,
            VO.replace(/\[@[^\]]+\]|\{\{[^}]+\}\}|^---[\s\S]*?---|##.*$/gm, ""),
          ),
          env,
        ),
        env,
      );
      const firstWord: Record<string, string> = {
        "emea-bar": "then",
        "type-start": "churn",
        "results-visible": "results",
      };
      const errors: string[] = [];
      for (const a of anchors) {
        const w = firstWord[a.mark];
        if (!w) continue;
        const hit = words
          .filter((x) =>
            x.w
              .toLowerCase()
              .replace(/[^a-z]/g, "")
              .startsWith(w),
          )
          .sort((x, y) => Math.abs(x.s * 1000 - a.audioAt) - Math.abs(y.s * 1000 - a.audioAt))[0];
        const near = words
          .filter((x) => Math.abs(x.s * 1000 - a.audioAt) < 2500)
          .map((x) => `${x.w}@${x.s}`)
          .join(" ");
        assert.ok(hit, `"${w}" heard in the final audio (near the anchor: ${near})`);
        const err = Math.abs(hit.s * 1000 - a.audioAt);
        errors.push(`${a.mark}: ${err.toFixed(0)} ms`);
        assert.ok(
          err <= 150,
          `@${a.mark}: narration heard ${err.toFixed(0)} ms from its anchor at ${a.audioAt} ms (near: ${near})`,
        );
        assert.ok(
          Math.abs(a.audioAt - a.out) <= 150,
          `@${a.mark}: anchor drift ${a.audioAt - a.out} ms`,
        );
      }
      console.log(
        `S4 E2E sync: ${errors.join(", ")}; full ${probe.duration.toFixed(1)} s; cut ${edit.timeline.totals.cutMs} ms`,
      );

      // Brand switch (D27): re-render the same timeline with another brand —
      // no new timeline, no TTS; same length, logo bug in the corner.
      const src = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-e2e4-brand-"));
      fs.writeFileSync(
        path.join(src, "logo.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" rx="8" fill="#ffffff"/></svg>',
      );
      createBrand(root, {
        name: "acme",
        source: src,
        logoLight: "logo.svg",
        settings: { colors: { accent: "#ff8800" }, logoBug: { enabled: true, opacity: 1 } },
      });
      const timelines = () =>
        fs.readdirSync(path.join(project.dir, "edit")).filter((f) => f.startsWith("timeline.v"));
      const timelinesBefore = timelines();
      const variant = await renderVariant({
        projectDir: project.dir,
        config,
        timelineVersion: edit.version,
        variant: { brand: "acme" },
      });
      assert.deepEqual(timelines(), timelinesBefore, "no new timeline");
      assert.equal(variant.outDir, path.join(project.dir, "out", `edit-v${edit.version}`, "acme"));
      assert.ok(
        Math.abs(variant.full.durationSec - probe.duration) < 0.1,
        `same length (${variant.full.durationSec} vs ${probe.duration})`,
      );
      assert.ok(fs.existsSync(edit.full.file), "the neutral variant stays");
      const assets = await renderBrandAssets(resolveBrand(root, "acme"), config.output, {
        cacheDir: path.join(root, ".cache", "brand-assets"),
        title: titleInfoFor(project.dir, config),
      });
      const bug = assets.logoBug;
      assert.ok(bug, "acme has a logo bug");
      const region = async (file: string) => {
        const out = path.join(os.tmpdir(), `demo-rec-e2e4-${process.pid}-bug.gray`);
        await run("ffmpeg", [
          "-v",
          "error",
          "-y",
          "-ss",
          "8",
          "-i",
          file,
          "-frames:v",
          "1",
          "-vf",
          `crop=${bug.w}:${bug.h}:${bug.x}:${bug.y},format=gray`,
          "-f",
          "rawvideo",
          out,
        ]);
        const b = fs.readFileSync(out);
        fs.rmSync(out, { force: true });
        return b;
      };
      const [plain, bugged] = [await region(edit.full.file), await region(variant.full.file)];
      // The white logo replaces whatever was there (backdrop or footage edge) on most pixels.
      const changed =
        plain.reduce((n, v, k) => n + (Math.abs(v - (bugged[k] as number)) > 40 ? 1 : 0), 0) /
        plain.length;
      assert.ok(
        changed > 0.3,
        `logo bug visible at ${bug.x},${bug.y} (${(changed * 100).toFixed(0)}% of its box changed)`,
      );
    } finally {
      await fixture.close();
      if (process.env.DEMO_REC_KEEP) console.log(`kept: ${root}`);
      else fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
