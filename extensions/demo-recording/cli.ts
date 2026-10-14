#!/usr/bin/env node
/**
 * demo-recording engine CLI — every engine operation is runnable without a
 * model (IMPLEMENTATION_PLAN §1 principle 3). Used by tests and for manual
 * debugging.
 *
 *   node extensions/demo-recording/cli.ts <command> [options]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { takeGeometry } from "./src/annotations/apply.ts";
import { readAnnotations, writeAnnotations } from "./src/annotations/file.ts";
import { previewAnnotation } from "./src/annotations/preview.ts";
import { resolveAnnotations } from "./src/annotations/resolve.ts";
import { EventBus } from "./src/bus.ts";
import { resolveConfig } from "./src/config.ts";
import { formatDoctor, runDoctor } from "./src/doctor.ts";
import { prepareBrand, renderVariant } from "./src/edit/pipeline.ts";
import type { Timeline } from "./src/edit/timeline.ts";
import { serveFixture } from "./src/fixture/server.ts";
import { startPanel } from "./src/panel/server.ts";
import { runFixtureDemo } from "./src/pipeline/fixture-demo.ts";
import { runS1 } from "./src/pipeline/s1.ts";
import { createImproviser, modelAccessFrom } from "./src/recorder/improvise.ts";
import { formatProgress } from "./src/recorder/progress.ts";
import { recordTake } from "./src/recorder/runner.ts";
import { runCaptureSpike, spikeTable } from "./src/spike/capture.ts";
import { parseStoryboard } from "./src/storyboard/parse.ts";
import { editSummary } from "./src/tools/edit.ts";
import { takeSummary } from "./src/tools/record.ts";
import { voiceSummary } from "./src/tools/tts.ts";
import { listElevenLabsVoices, sortVoices } from "./src/tts/engines.ts";
import { ensureProject, listProjects, openProject } from "./src/workdir/layout.ts";
import { listVersions } from "./src/workdir/versioning.ts";

const HELP = `demo-recording engine CLI

Commands:
  doctor                                   check prerequisites
  fixture serve [--port N]                 serve the Acme Pulse fixture SPA
  project new --name N --url U [--app A]   create (or open) a demo project
  project list                             list projects under the root
  panel [--port N] [--project P] [--ticker]  run the side panel standalone;
                                           --ticker publishes a test event every 2s
  run-s1 [--fixture | --url U --app A] [--storyboard F] [--project P] [--headed] [--seed N]
                                           S1 walking skeleton: record a take, narrate with
                                           macOS say, naive-mux to out/<take>-naive.mp4
  spike capture [--storyboard F]           S1 capture spike: compare capture configs
  voices                                   list your ElevenLabs voices (needs ELEVENLABS_API_KEY)
  fixture-demo [--voice NAME] [--project P]  S4: full narrated demo of the fixture with your configured
                                           voice chain (ELEVENLABS_API_KEY + voice name → your voice)
  record [--fixture | --url U] [--storyboard F] [--project P] [--headed] [--seed N] [--no-model]
                                           S3 take: human motion/typing, improvise via pi's
                                           configured models (~/.pi/agent auth), resume, progress
  annotate add --project P --file F        store a hand-written annotation file as the next
                                           annotations/vN.json (validated)
  annotate check --project P [--version N] [--edit N]
                                           resolve annotations against the edit: times, boxes, warnings
  annotate preview --project P --id ID [--version N] [--edit N] [--brand B]
                                           render a preview clip + still of one annotation
  render --project P [--edit N] [--brand B] [--annotations N]
                                           re-render an edit (scenes + full), optionally with
                                           annotations burned in → out/edit-vN/<brand>+aN/

Environment: DEMO_REC_ROOT, DEMO_REC_CONFIG, DEMO_REC_PANEL_PORT (see README)`;

const HERE = path.dirname(fileURLToPath(import.meta.url));

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

async function main(argv: string[]): Promise<number> {
  const [command, sub, ...rest] = argv;
  const cfg = resolveConfig();

  if (!command || command === "help" || command === "--help") {
    console.log(HELP);
    return 0;
  }

  if (command === "doctor") {
    // pi's own credentials (~/.pi/agent) decide which improvise models are usable.
    const registry = await (async () => {
      try {
        const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
        const rt = await ModelRuntime.create();
        return {
          find: (p: string, id: string) => rt.getModel(p, id),
          hasConfiguredAuth: (m: never) =>
            rt.hasConfiguredAuth((m as { provider: string }).provider),
        };
      } catch {
        return undefined;
      }
    })();
    const results = await runDoctor(cfg, registry ? { registry } : {});
    console.log(formatDoctor(results));
    return results.some((r) => r.status === "fail") ? 1 : 0;
  }

  if (command === "fixture" && sub === "serve") {
    const { values } = parseArgs({
      args: rest,
      options: { port: { type: "string", default: "0" } },
    });
    const fixture = await serveFixture(Number(values.port));
    console.log(`Acme Pulse fixture: ${fixture.url}  (flags: ?slow=1, ?flaky=1 — Ctrl-C to stop)`);
    await waitForSignal();
    await fixture.close();
    return 0;
  }

  if (command === "project" && sub === "new") {
    const { values } = parseArgs({
      args: rest,
      options: { name: { type: "string" }, url: { type: "string" }, app: { type: "string" } },
    });
    if (!values.name || !values.url) {
      console.error("project new requires --name and --url");
      return 2;
    }
    const handle = ensureProject(cfg.root, {
      project: values.name,
      appUrl: values.url,
      appName: values.app ?? new URL(values.url).hostname,
    });
    console.log(`${handle.created ? "created" : "exists"}: ${handle.dir}`);
    return 0;
  }

  if (command === "project" && sub === "list") {
    for (const p of listProjects(cfg.root)) console.log(p);
    return 0;
  }

  if (command === "panel") {
    const args = sub ? [sub, ...rest] : rest;
    const { values } = parseArgs({
      args,
      options: {
        port: { type: "string" },
        project: { type: "string" },
        ticker: { type: "boolean", default: false },
      },
    });
    const bus = new EventBus();
    const project = values.project ? openProject(cfg.root, values.project) : undefined;
    const panel = await startPanel({
      bus,
      port: values.port ? Number(values.port) : cfg.panelPort,
      getState: () => ({
        root: cfg.root,
        config: {
          viewport: cfg.viewport,
          fps: cfg.fps,
          output: cfg.output,
          ttsChain: cfg.ttsChain,
          sources: cfg.sources,
        },
        project: project ? { ...openProject(cfg.root, project.slug) } : null,
      }),
    });
    bus.publish("panel.started", { message: "standalone panel (cli)" });
    let n = 0;
    const timer = values.ticker
      ? setInterval(() => bus.publish("test.tick", { n: ++n, message: `tick ${n}` }), 2000)
      : undefined;
    console.log(`demo panel: ${panel.url}  (Ctrl-C to stop)`);
    await waitForSignal();
    if (timer) clearInterval(timer);
    await panel.close();
    return 0;
  }

  if (command === "run-s1") {
    const args = sub ? [sub, ...rest] : rest;
    const { values } = parseArgs({
      args,
      options: {
        fixture: { type: "boolean", default: false },
        url: { type: "string" },
        app: { type: "string" },
        storyboard: {
          type: "string",
          default: path.join(HERE, "fixtures", "storyboards", "s1-search.yaml"),
        },
        project: { type: "string", default: "s1-walking-skeleton" },
        headed: { type: "boolean", default: false },
        seed: { type: "string" },
        voice: { type: "string" },
      },
    });
    if (!values.fixture && !values.url) {
      console.error("run-s1 needs --fixture or --url <base-url> [--app <name>]");
      return 2;
    }
    const fixture = values.fixture ? await serveFixture(0) : undefined;
    try {
      const baseUrl = fixture?.url ?? (values.url as string);
      const result = await runS1({
        config: cfg,
        project: values.project,
        appName: values.app ?? (fixture ? "Acme Pulse" : new URL(baseUrl).hostname),
        baseUrl,
        storyboardFile: path.resolve(values.storyboard),
        ...(values.headed ? { headed: true } : {}),
        ...(values.seed ? { seed: Number(values.seed) } : {}),
        ...(values.voice ? { sayVoice: values.voice } : {}),
        log: (m) => console.log(m),
      });
      console.log(`\n✔ ${result.output}`);
    } finally {
      await fixture?.close();
    }
    return 0;
  }

  if (command === "voices") {
    const all = sortVoices(
      await listElevenLabsVoices({
        ...(process.env.ELEVENLABS_API_KEY?.trim()
          ? { apiKey: process.env.ELEVENLABS_API_KEY.trim() }
          : {}),
      }),
    );
    for (const v of all)
      console.log(
        `${v.name === cfg.voiceName ? "▶" : " "} ${v.name}  (${v.category ?? "?"}, id ${v.voice_id})`,
      );
    console.log(
      `\n${all.length} voices · configured voiceName: ${cfg.voiceName ? `"${cfg.voiceName}"` : "(none)"}`,
    );
    return 0;
  }

  if (command === "fixture-demo") {
    const args = sub ? [sub, ...rest] : rest;
    const { values } = parseArgs({
      args,
      options: { voice: { type: "string" }, project: { type: "string", default: "fixture-demo" } },
    });
    const r = await runFixtureDemo(cfg, {
      project: values.project,
      ...(values.voice ? { voiceName: values.voice } : {}),
      log: (m) => console.log(m),
    });
    console.log(`\n${voiceSummary(r.voice)}\n\n${editSummary(r.edit)}`);
    return 0;
  }

  if (command === "annotate" || command === "render") {
    const args = command === "render" && sub ? [sub, ...rest] : rest;
    const { values } = parseArgs({
      args,
      options: {
        project: { type: "string" },
        file: { type: "string" },
        version: { type: "string" },
        edit: { type: "string" },
        brand: { type: "string" },
        id: { type: "string" },
        annotations: { type: "string" },
      },
    });
    if (!values.project) throw new Error("--project is required");
    const project = openProject(cfg.root, values.project);
    const editV = values.edit
      ? Number(values.edit)
      : listVersions(path.join(project.dir, "edit"), "timeline.v", ".json").at(-1);
    const timelineFor = () => {
      if (editV === undefined)
        throw new Error("this project has no edit yet — run the sync edit first");
      return JSON.parse(
        fs.readFileSync(path.join(project.dir, "edit", `timeline.v${editV}.json`), "utf8"),
      ) as Timeline;
    };
    if (command === "render") {
      if (editV === undefined) throw new Error("this project has no edit yet");
      const r = await renderVariant({
        projectDir: project.dir,
        config: cfg,
        timelineVersion: editV,
        variant: {
          ...(values.brand ? { brand: values.brand } : {}),
          ...(values.annotations ? { annotations: Number(values.annotations) } : {}),
        },
        onProgress: (p) => console.log(`[${p.done}/${p.total}] ${p.label}`),
      });
      console.log(editSummary(r));
      if (r.annotations) {
        console.log(`annotations v${r.annotations.version}: ${r.annotations.applied} applied`);
        for (const w of r.annotations.warnings) console.log(`  ! ${w}`);
      }
      return 0;
    }
    if (sub === "add") {
      if (!values.file) throw new Error("--file is required");
      const raw = JSON.parse(fs.readFileSync(values.file, "utf8"));
      const stored = writeAnnotations(project.dir, raw);
      console.log(
        `stored annotations v${stored.version} (${stored.items.length} items, ${stored.items.filter((x) => x.enabled).length} enabled)`,
      );
      return 0;
    }
    const file = readAnnotations(project.dir, values.version ? Number(values.version) : undefined);
    if (!file)
      throw new Error("no annotation file — add one with: annotate add --project P --file F");
    if (sub === "check") {
      const timeline = timelineFor();
      const r = resolveAnnotations(file, {
        timeline,
        takeDir: path.join(project.dir, "takes", timeline.take),
        ...takeGeometry(project.dir, timeline.take),
      });
      console.log(`annotations v${file.version} on edit v${editV} (${timeline.take}):`);
      for (const it of r.items)
        console.log(
          `  ${it.id.padEnd(16)} ${it.type.padEnd(9)} ${it.scene}  ${(it.startMs / 1000).toFixed(2)}–${(it.endMs / 1000).toFixed(2)} s${it.box ? `  box ${it.box.x},${it.box.y} ${it.box.w}×${it.box.h} px` : ""}${it.text ? `  "${it.text}"` : ""}`,
        );
      for (const w of r.warnings) console.log(`  ! ${w}`);
      return 0;
    }
    if (sub === "preview") {
      if (!values.id) throw new Error("--id is required");
      const timeline = timelineFor();
      const b = await prepareBrand(project.dir, cfg, timeline.take, values.brand ?? cfg.brand);
      const p = await previewAnnotation({
        projectDir: project.dir,
        timeline,
        file,
        id: values.id,
        brand: b.loaded,
        frame: b.frame,
        fps: cfg.fps,
        output: b.size,
        cacheDir: path.join(cfg.root, ".cache", "annotation-assets"),
        outDir: path.join(project.dir, "previews", "annotations"),
      });
      console.log(`clip:  ${p.clip}\nstill: ${p.still} (at ${(p.peakMs / 1000).toFixed(2)} s)`);
      for (const w of p.warnings) console.log(`  ! ${w}`);
      return 0;
    }
    throw new Error(`unknown: annotate ${sub ?? ""} — use add, check or preview`);
  }

  if (command === "record") {
    const args = sub ? [sub, ...rest] : rest;
    const { values } = parseArgs({
      args,
      options: {
        fixture: { type: "boolean", default: false },
        url: { type: "string" },
        storyboard: {
          type: "string",
          default: path.join(HERE, "fixtures", "storyboards", "s3-human.yaml"),
        },
        project: { type: "string", default: "s3-human" },
        headed: { type: "boolean", default: false },
        seed: { type: "string" },
        "no-model": { type: "boolean", default: false },
      },
    });
    if (!values.fixture && !values.url) {
      console.error("record needs --fixture or --url <base-url>");
      return 2;
    }
    const fixture = values.fixture ? await serveFixture(0) : undefined;
    try {
      const baseUrl = fixture?.url ?? (values.url as string);
      const project = ensureProject(cfg.root, {
        project: values.project,
        appName: fixture ? "Acme Pulse" : new URL(baseUrl).hostname,
        appUrl: baseUrl,
      });
      const storyboard = parseStoryboard(fs.readFileSync(path.resolve(values.storyboard), "utf8"), {
        version: 1,
      });
      let improviser: ReturnType<typeof createImproviser> | undefined;
      if (!values["no-model"]) {
        const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
        const runtime = await ModelRuntime.create();
        improviser = createImproviser(
          modelAccessFrom(runtime as never),
          cfg.improvise.models,
          cfg.improvise.timeoutMs,
        );
      }
      let last = "";
      const take = await recordTake({
        projectDir: project.dir,
        storyboard,
        storyboardVersion: 1,
        baseUrl,
        viewport: cfg.viewport,
        fps: cfg.fps,
        capture: cfg.capture,
        maxRetriesPerScene: cfg.recording.maxRetriesPerScene,
        typoRate: cfg.recording.typoRate,
        keepFrames: cfg.recording.keepFrames,
        hesitateMs: cfg.improvise.hesitateMs,
        ...(improviser ? { improviser } : {}),
        ...(values.headed ? { headed: true } : {}),
        ...(values.seed ? { seed: Number(values.seed) } : {}),
        onProgress: (p) => {
          const line = formatProgress(p);
          if (line !== last && process.stdout.isTTY) process.stdout.write(`\r\x1b[2K${line}`);
          last = line;
        },
      });
      if (process.stdout.isTTY) process.stdout.write("\n");
      console.log(takeSummary(take, 1));
    } finally {
      await fixture?.close();
    }
    return 0;
  }

  if (command === "spike" && sub === "capture") {
    const { values } = parseArgs({
      args: rest,
      options: {
        storyboard: {
          type: "string",
          default: path.join(HERE, "fixtures", "storyboards", "s1-search.yaml"),
        },
      },
    });
    const rows = await runCaptureSpike(path.resolve(values.storyboard));
    console.log(`\n${spikeTable(rows)}`);
    return 0;
  }

  console.error(`unknown command: ${argv.join(" ")}\n\n${HELP}`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`demo-recording: ${(err as Error).message}`);
    process.exit(1);
  },
);
