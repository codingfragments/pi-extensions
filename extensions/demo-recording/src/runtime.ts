/**
 * Per-extension-instance runtime: config, event bus, panel, active project.
 *
 * Nothing long-lived starts in the extension factory (repo AGENTS.md): the
 * panel starts lazily on first use and is torn down idempotently on
 * `session_shutdown`.
 */

import { EventBus } from "./bus.ts";
import { type DemoRecConfig, resolveConfig } from "./config.ts";
import { type PanelHandle, startPanel } from "./panel/server.ts";
import { type ProjectHandle, openProject } from "./workdir/layout.ts";

export class Runtime {
  readonly bus = new EventBus();
  private config: DemoRecConfig | undefined;
  private panel: PanelHandle | undefined;
  private panelStarting: Promise<PanelHandle> | undefined;
  private activeSlug: string | undefined;

  private readonly resolve: () => DemoRecConfig;

  constructor(resolve: () => DemoRecConfig = () => resolveConfig()) {
    this.resolve = resolve;
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
    };
  }

  async ensurePanel(): Promise<PanelHandle> {
    if (this.panel) return this.panel;
    if (!this.panelStarting) {
      this.panelStarting = startPanel({
        bus: this.bus,
        port: this.getConfig().panelPort,
        getState: () => this.snapshot(),
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

  async shutdown(): Promise<void> {
    const panel = this.panel ?? (await this.panelStarting?.catch(() => undefined));
    this.panel = undefined;
    this.panelStarting = undefined;
    await panel?.close();
  }
}
