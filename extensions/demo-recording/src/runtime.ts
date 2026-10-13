/**
 * Per-extension-instance runtime: config, event bus, panel, active project,
 * discovery session, and the panel → agent bridge.
 *
 * Nothing long-lived starts in the extension factory (repo AGENTS.md): the
 * panel and discovery browser start lazily on first use and are torn down
 * idempotently on `session_shutdown`.
 */

import { EventBus } from "./bus.ts";
import { type DemoRecConfig, resolveConfig } from "./config.ts";
import type { DiscoverySession } from "./discovery/session.ts";
import { panelRoutes } from "./panel/routes.ts";
import { type PanelHandle, startPanel } from "./panel/server.ts";
import { type ProjectHandle, appDir, openProject } from "./workdir/layout.ts";

/** The subset of ExtensionAPI the runtime needs (keeps tests and the CLI simple). */
export interface AgentBridge {
  sendUserMessage: (text: string, options?: { deliverAs?: "steer" | "followUp" }) => void;
}

export class Runtime {
  readonly bus = new EventBus();
  private config: DemoRecConfig | undefined;
  private panel: PanelHandle | undefined;
  private panelStarting: Promise<PanelHandle> | undefined;
  private activeSlug: string | undefined;
  private readonly resolve: () => DemoRecConfig;
  private readonly agent: AgentBridge | undefined;
  discovery: DiscoverySession | undefined;

  constructor(resolve: () => DemoRecConfig = () => resolveConfig(), agent?: AgentBridge) {
    this.resolve = resolve;
    this.agent = agent;
  }

  /** Resolved config; `reload` re-reads file/env (e.g. after the user edits config). */
  getConfig(reload = false): DemoRecConfig {
    if (!this.config || reload) this.config = this.resolve();
    return this.config;
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
          ? { session: this.discovery.id, budget: this.discovery.budget() }
          : null,
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
    await this.closeDiscovery().catch(() => {});
    const panel = this.panel ?? (await this.panelStarting?.catch(() => undefined));
    this.panel = undefined;
    this.panelStarting = undefined;
    await panel?.close();
  }
}
