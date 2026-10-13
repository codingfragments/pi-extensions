/**
 * Per-extension-instance runtime: config, event bus, panel, active project,
 * discovery session, and the panel → agent bridge.
 *
 * Nothing long-lived starts in the extension factory (repo AGENTS.md): the
 * panel and discovery browser start lazily on first use and are torn down
 * idempotently on `session_shutdown`.
 */

import fs from "node:fs";
import path from "node:path";
import { EventBus } from "./bus.ts";
import { type DemoRecConfig, resolveConfig } from "./config.ts";
import type { DiscoverySession } from "./discovery/session.ts";
import { Jobs } from "./jobs.ts";
import { panelRoutes } from "./panel/routes.ts";
import { type PanelHandle, startPanel } from "./panel/server.ts";
import { readManifest } from "./tts/synthesize.ts";
import { type ProjectHandle, appDir, openProject, projectDir } from "./workdir/layout.ts";

/** The subset of ExtensionAPI the runtime needs (keeps tests and the CLI simple). */
export interface AgentBridge {
  sendUserMessage: (text: string, options?: { deliverAs?: "steer" | "followUp" }) => void;
  /** Custom message into the session (job completions). */
  sendMessage?: (
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ) => void;
}

/** Footer status sink (ctx.ui), captured from the latest tool/command context. */
export interface StatusSink {
  setStatus: (key: string, text: string | undefined) => void;
}

export const STATUS_KEY = "demo-rec";

export class Runtime {
  readonly bus = new EventBus();
  private config: DemoRecConfig | undefined;
  private panel: PanelHandle | undefined;
  private panelStarting: Promise<PanelHandle> | undefined;
  private activeSlug: string | undefined;
  private readonly resolve: (projectConfigFile?: string) => DemoRecConfig;
  private configKey = "";
  private readonly agent: AgentBridge | undefined;
  discovery: DiscoverySession | undefined;
  readonly jobs = new Jobs();
  private ui: StatusSink | undefined;
  private lastStatus = 0;

  constructor(
    resolve: (projectConfigFile?: string) => DemoRecConfig = (f) =>
      resolveConfig(f ? { projectConfigFile: f } : {}),
    agent?: AgentBridge,
  ) {
    this.resolve = resolve;
    this.agent = agent;
    // Mirror progress into pi's footer status line.
    this.bus.subscribe((e) => {
      const message = typeof e.data?.message === "string" ? e.data.message : undefined;
      if (
        e.type === "discovery.progress" ||
        e.type === "take.progress" ||
        e.type === "tts.progress" ||
        e.type === "edit.progress"
      )
        this.setStatus(message);
      if (e.type === "discovery.closed" || e.type === "take.finished")
        this.setStatus(undefined, true);
    });
  }

  /** Resolved config; `reload` re-reads file/env (e.g. after the user edits config). */
  /** Effective config: defaults < global file < active project's config.json < env. */
  getConfig(reload = false): DemoRecConfig {
    const key = this.activeSlug ?? "";
    if (!this.config || reload || this.configKey !== key) {
      const base = this.resolve();
      const file = this.projectConfigPath(base.root);
      this.config = file && fs.existsSync(file) ? this.resolve(file) : base;
      this.configKey = key;
    }
    return this.config;
  }

  /** `projects/<p>/config.json` of the active project (whether or not it exists). */
  projectConfigPath(root = this.getConfig().root): string | undefined {
    return this.activeSlug
      ? path.join(projectDir(root, this.activeSlug), "config.json")
      : undefined;
  }

  setActiveProject(slug: string | undefined): void {
    this.activeSlug = slug;
    if (slug) this.bus.publish("project.active", { message: `active project: ${slug}` }, slug);
  }

  get activeProjectSlug(): string | undefined {
    return this.activeSlug;
  }

  /** Re-read the active project from disk (state.json is the source of truth). */
  activeProject(): ProjectHandle | undefined {
    if (!this.activeSlug) return undefined;
    try {
      return openProject(this.getConfig().root, this.activeSlug);
    } catch {
      return undefined;
    }
  }

  requireProject(): ProjectHandle {
    const p = this.activeProject();
    if (!p) throw new Error("no active demo project — run /demo new or /demo open first");
    return p;
  }

  /** Remember the latest UI context (for footer status from background jobs). */
  bindUi(ui: StatusSink | undefined): void {
    if (ui) this.ui = ui;
  }

  /** Footer status; throttled to ~2/s unless `force`. Undefined clears it. */
  setStatus(text: string | undefined, force = false): void {
    const now = Date.now();
    if (!force && text !== undefined && now - this.lastStatus < 500) return;
    this.lastStatus = now;
    try {
      this.ui?.setStatus(STATUS_KEY, text);
    } catch {
      // stale context after a session switch — ignore
    }
  }

  /** Report a finished background job into the session (triggers a turn when idle). */
  reportToAgent(content: string, details?: unknown): void {
    this.bus.publish("agent.notified", { message: content.split("\n")[0] ?? "" }, this.activeSlug);
    try {
      if (this.agent?.sendMessage) {
        this.agent.sendMessage(
          { customType: "demo-recording", content, display: true, ...(details ? { details } : {}) },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      } else this.agent?.sendUserMessage(content, { deliverAs: "followUp" });
    } catch (err) {
      this.bus.publish("agent.notify-failed", { message: (err as Error).message }, this.activeSlug);
    }
  }

  /** Deliver a panel action to the director as a user message. */
  notifyAgent(text: string): void {
    this.bus.publish("agent.notified", { message: text.split("\n")[0] ?? "" }, this.activeSlug);
    if (!this.agent) return;
    try {
      this.agent.sendUserMessage(text, { deliverAs: "followUp" });
    } catch (err) {
      this.bus.publish("agent.notify-failed", { message: (err as Error).message }, this.activeSlug);
    }
  }

  /** Payload for the panel's GET /api/state. */
  snapshot(): Record<string, unknown> {
    const cfg = this.getConfig();
    const p = this.activeProject();
    return {
      root: cfg.root,
      config: {
        viewport: cfg.viewport,
        fps: cfg.fps,
        output: cfg.output,
        ttsChain: cfg.ttsChain,
        sources: cfg.sources,
      },
      project: p ? { slug: p.slug, dir: p.dir, app: p.app, state: p.state } : null,
      discovery:
        this.discovery && !this.discovery.isClosed
          ? {
              session: this.discovery.id,
              budget: this.discovery.budget(),
              progress: this.discovery.progress(),
            }
          : null,
      job: (() => {
        const j = this.jobs.latest("record");
        return j
          ? { id: j.id, status: j.status, progress: j.progress ?? null, error: j.error ?? null }
          : null;
      })(),
    };
  }

  async ensurePanel(): Promise<PanelHandle> {
    if (this.panel) return this.panel;
    if (!this.panelStarting) {
      const routes = panelRoutes({
        bus: this.bus,
        activeProject: () => this.activeProject(),
        discovery: () =>
          this.discovery && !this.discovery.isClosed
            ? { id: this.discovery.id, dir: this.discovery.dir, budget: this.discovery.budget() }
            : undefined,
        notifyAgent: (text) => this.notifyAgent(text),
        audio: (version) => {
          const p = this.activeProject();
          const m = p ? readManifest(p.dir, version) : undefined;
          return m
            ? Object.fromEntries(Object.values(m.sections).map((sec) => [sec.key, sec.file]))
            : null;
        },
      });
      this.panelStarting = startPanel({
        bus: this.bus,
        port: this.getConfig().panelPort,
        getState: () => this.snapshot(),
        get: routes.get,
        post: routes.post,
        media: () => {
          const p = this.activeProject();
          return p ? { app: appDir(this.getConfig().root, p.app.slug), project: p.dir } : {};
        },
      }).then((handle) => {
        this.panel = handle;
        this.bus.publish("panel.started", { port: handle.port });
        return handle;
      });
      this.panelStarting.catch(() => {
        this.panelStarting = undefined;
      });
    }
    return this.panelStarting;
  }

  get panelUrl(): string | undefined {
    return this.panel?.url;
  }

  async closeDiscovery(): Promise<void> {
    const d = this.discovery;
    this.discovery = undefined;
    await d?.close();
  }

  async shutdown(): Promise<void> {
    await this.jobs.cancelAll().catch(() => {});
    this.setStatus(undefined, true);
    await this.closeDiscovery().catch(() => {});
    const panel = this.panel ?? (await this.panelStarting?.catch(() => undefined));
    this.panel = undefined;
    this.panelStarting = undefined;
    await panel?.close();
  }
}
