#!/usr/bin/env node
/**
 * demo-recording engine CLI — every engine operation is runnable without a
 * model (IMPLEMENTATION_PLAN §1 principle 3). Used by tests and for manual
 * debugging.
 *
 *   node extensions/demo-recording/cli.ts <command> [options]
 */

import { parseArgs } from "node:util";
import { EventBus } from "./src/bus.ts";
import { resolveConfig } from "./src/config.ts";
import { formatDoctor, runDoctor } from "./src/doctor.ts";
import { serveFixture } from "./src/fixture/server.ts";
import { startPanel } from "./src/panel/server.ts";
import { ensureProject, listProjects, openProject } from "./src/workdir/layout.ts";

const HELP = `demo-recording engine CLI

Commands:
  doctor                                   check prerequisites
  fixture serve [--port N]                 serve the Acme Pulse fixture SPA
  project new --name N --url U [--app A]   create (or open) a demo project
  project list                             list projects under the root
  panel [--port N] [--project P] [--ticker]  run the side panel standalone;
                                           --ticker publishes a test event every 2s

Environment: DEMO_REC_ROOT, DEMO_REC_CONFIG, DEMO_REC_PANEL_PORT (see README)`;

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
    const results = await runDoctor(cfg);
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
