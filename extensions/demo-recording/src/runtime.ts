/**
 * Per-extension-instance runtime: config, event bus, panel, active project,
 * discovery session, and the panel → agent bridge.
 *
 * Nothing long-lived starts in the extension factory (repo AGENTS.md): the
 * panel and discovery browser start lazily on first use and are torn down
 * idempotently on `session_shutdown`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventBus } from "./bus.ts";
import { layerFiles } from "./config-edit.ts";
import { type DemoRecConfig, resolveConfig } from "./config.ts";
import { DirectorTracker } from "./director/state.ts";
import type { DiscoverySession } from "./discovery/session.ts";
import { voiceFit } from "./edit/pipeline.ts";
import { type EnvOverride, envOverrides } from "./env-overrides.ts";
import { GrantStore } from "./grants.ts";
import { Jobs } from "./jobs.ts";
import type { RegistryLike } from "./models.ts";
import { annotationRoutes } from "./panel/annotation-routes.ts";
import { brandRoutes } from "./panel/brand-routes.ts";
import { configRoutes } from "./panel/config-routes.ts";
import { costRoutes } from "./panel/cost.ts";
import { draftRoutes } from "./panel/draft-routes.ts";
import { fixRoutes } from "./panel/fix-routes.ts";
import { grantRoutes } from "./panel/grant-routes.ts";
import { graphRoutes } from "./panel/graph-routes.ts";
import { jobRoutes } from "./panel/job-routes.ts";
import { projectRoutes } from "./panel/project-routes.ts";
import { renderRoutes } from "./panel/render-routes.ts";
import { panelRoutes } from "./panel/routes.ts";
import { type GetRoute, type PanelHandle, type PostRoute, startPanel } from "./panel/server.ts";
import { stageRoutes } from "./panel/stage-routes.ts";
import { versionRoutes } from "./panel/version-routes.ts";
import { voiceListRoutes } from "./panel/voice-list-routes.ts";
import { voiceRoutes } from "./panel/voice-routes.ts";
import { type ModelAccess, modelAccessFrom } from "./recorder/improvise.ts";
import { startDesigner } from "./tools/designer.ts";
import { readManifest } from "./tts/synthesize.ts";
import { MAX_EVENT_TEXT, capText, firstLine } from "./util/events.ts";
import { projectContext } from "./workdir/context.ts";
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

/**
 * What was sent to the agent (log cleanup): the log line is the first line;
 * the event keeps the text (≤ 4 KB) and how it was delivered.
 *   report — a background job's result, starts a turn
 *   action — a panel action as a user message, starts a turn
 *   note   — for the next turn, starts none
 */
function agentEvent(text: string, kind: "report" | "action" | "note"): Record<string, unknown> {
  return {
    message: firstLine(text),
    kind,
    startsTurn: kind !== "note",
    text: capText(text),
    ...(text.length > MAX_EVENT_TEXT ? { truncated: text.length } : {}),
  };
}

function failedEvent(err: unknown, text: string): Record<string, unknown> {
  return {
    message: `couldn't reach the agent: ${(err as Error).message}`,
    error: (err as Error).stack ?? String(err),
    about: capText(firstLine(text), 300),
  };
}

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
  /** What the user has allowed the Director to spend (P1a). */
  readonly grants = new GrantStore();
  /** What the Director is doing right now, from pi's events (P1a A2). */
  readonly director = new DirectorTracker((type, data, slug = this.activeSlug) =>
    this.bus.publish(type, data, slug),
  );
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
  /** The `DEMO_REC_*` variables that are overriding the files right now (F12). */
  envOverrides(): EnvOverride[] {
    return envOverrides(
      layerFiles(process.env, os.homedir(), this.activeProject()?.dir),
      process.env,
      os.homedir(),
    );
  }

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
    if (slug)
      this.bus.publish(
        "project.active",
        { message: `active project: ${slug}`, project: slug },
        slug,
      );
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

  /** pi's model access (for separate role runs, S5 part 12), remembered from the session. */
  modelAccess: ModelAccess | undefined;

  /** pi's registry itself (for credential checks in cost estimates and the doctor). */
  registry: RegistryLike | undefined;
  /** The session model ("provider/id") the Director runs on — shown in the panel's cost hints. */
  sessionModel: string | undefined;

  bindModels(registry: unknown): void {
    if (registry && typeof (registry as { complete?: unknown }).complete === "function") {
      this.modelAccess = modelAccessFrom(registry as Parameters<typeof modelAccessFrom>[0]);
      this.registry = registry as RegistryLike;
    }
  }

  bindSessionModel(model: unknown): void {
    const m = model as { provider?: string; id?: string } | undefined;
    if (m?.provider && m.id) this.sessionModel = `${m.provider}/${m.id}`;
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
    this.bus.publish("agent.notified", agentEvent(content, "report"), this.activeSlug);
    try {
      if (this.agent?.sendMessage) {
        this.agent.sendMessage(
          { customType: "demo-recording", content, display: true, ...(details ? { details } : {}) },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      } else this.agent?.sendUserMessage(content, { deliverAs: "followUp" });
    } catch (err) {
      this.bus.publish("agent.notify-failed", failedEvent(err, content), this.activeSlug);
    }
  }

  /** Deliver a panel action to the director as a user message. */
  /**
   * Put the active project's memory (brief, lineage, active inputs; D42) into
   * the agent's next turn without starting one — on /demo open and session
   * restore, so the agent works from the same memory the panel shows.
   */
  primeContext(): void {
    const p = this.activeProject();
    if (!p || !this.agent?.sendMessage) return;
    try {
      this.agent.sendMessage(
        {
          customType: "demo-recording-context",
          content: `[demo-recording] ${projectContext(p.dir, p.slug)}`,
          display: false,
        },
        { triggerTurn: false, deliverAs: "nextTurn" },
      );
    } catch (err) {
      this.bus.publish("agent.notify-failed", failedEvent(err, "project context"), this.activeSlug);
    }
  }

  /** A note for the agent's next turn that does not start a turn (e.g. working-line changes). */
  tellAgent(text: string): void {
    this.bus.publish("agent.notified", agentEvent(text, "note"), this.activeSlug);
    if (!this.agent?.sendMessage) return;
    try {
      this.agent.sendMessage(
        { customType: "demo-recording-note", content: text, display: true },
        { triggerTurn: false, deliverAs: "nextTurn" },
      );
    } catch (err) {
      this.bus.publish("agent.notify-failed", failedEvent(err, text), this.activeSlug);
    }
  }

  notifyAgent(text: string): void {
    this.bus.publish("agent.notified", agentEvent(text, "action"), this.activeSlug);
    if (!this.agent) return;
    try {
      this.agent.sendUserMessage(text, { deliverAs: "followUp" });
    } catch (err) {
      this.bus.publish("agent.notify-failed", failedEvent(err, text), this.activeSlug);
    }
  }

  /** Payload for the panel's GET /api/state. */
  snapshot(): Record<string, unknown> {
    const cfg = this.getConfig();
    const p = this.activeProject();
    return {
      root: cfg.root,
      // Where history ends: the panel treats events at or below this as old news (UX2).
      busSeq: this.bus.lastSeq,
      models: {
        session: this.sessionModel ?? null,
        operator: cfg.improvise.models,
        designer: cfg.roles.annotationDesigner?.model ?? null,
      },
      config: {
        viewport: cfg.viewport,
        fps: cfg.fps,
        output: cfg.output,
        ttsChain: cfg.ttsChain,
        sources: cfg.sources,
      },
      envOverrides: this.envOverrides(),
      director: this.director.snapshot(),
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

  /** Every route the panel serves (also used by the cost-class test and the estimate route). */
  routeTables(): { get: Record<string, GetRoute>; post: Record<string, PostRoute> } {
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
      fit: (version) => {
        const p = this.activeProject();
        try {
          return p ? (voiceFit(p.dir, version, this.getConfig()) ?? null) : null;
        } catch {
          return null;
        }
      },
    });
    const brand = brandRoutes(this);
    const stages = stageRoutes({
      grant: (kind, project, target) => {
        this.grants.issue(kind, project, target, "panel");
      },
      activeProject: () => this.activeProject(),
      notifyAgent: (text) => this.notifyAgent(text),
      tellAgent: (text) => this.tellAgent(text),
      publish: (type, data, project) => this.bus.publish(type, data, project),
    });
    const project = projectRoutes({
      activeProject: () => this.activeProject(),
      publish: (type, data, slug) => this.bus.publish(type, data, slug),
      tellAgent: (text) => this.tellAgent(text),
      notifyAgent: (text) => this.notifyAgent(text),
    });
    const annotations = annotationRoutes({
      activeProject: () => this.activeProject(),
      getConfig: () => this.getConfig(),
      notifyAgent: (text) => this.notifyAgent(text),
      publish: (type, data, slug) => this.bus.publish(type, data, slug),
      designer: (o) => !!startDesigner(this, { ...o, trigger: "panel" }).job,
    });
    const renders = renderRoutes(this);
    const voice = voiceRoutes(this);
    // DEMO_REC_NO_VOICE_LIST keeps tests, screenshots and audits from ever listing a real account's voices
    const voiceList = voiceListRoutes({
      apiKey: () =>
        process.env.DEMO_REC_NO_VOICE_LIST ? undefined : process.env.ELEVENLABS_API_KEY,
    });
    const config = configRoutes({
      activeProject: () => this.activeProject(),
      reloadConfig: () => this.getConfig(true),
      publish: (type, data, slug) => this.bus.publish(type, data, slug),
    });
    const cost = costRoutes(this);
    const grants = grantRoutes(this);
    const fixes = fixRoutes(this);
    const jobs = jobRoutes(this);
    const graph = graphRoutes(this);
    const drafts = draftRoutes({
      activeProject: () => this.activeProject(),
      publish: (type, data, project) => this.bus.publish(type, data, project),
    });
    const versions = versionRoutes({
      activeProject: () => this.activeProject(),
      notifyAgent: (text) => this.notifyAgent(text),
      tellAgent: (text) => this.tellAgent(text),
      publish: (type, data, project) => this.bus.publish(type, data, project),
    });
    return {
      get: {
        ...routes.get,
        ...jobs.get,
        ...graph.get,
        ...grants.get,
        ...fixes.get,
        ...drafts.get,
        ...versions.get,
        ...brand.get,
        ...stages.get,
        ...project.get,
        ...config.get,
        ...annotations.get,
        ...renders.get,
        ...voiceList.get,
      },
      post: {
        ...routes.post,
        ...brand.post,
        ...stages.post,
        ...project.post,
        ...config.post,
        ...annotations.post,
        ...renders.post,
        ...voice.post,
        ...versions.post,
        ...drafts.post,
        ...cost.post,
        ...grants.post,
        ...fixes.post,
      },
    };
  }

  async ensurePanel(): Promise<PanelHandle> {
    if (this.panel) return this.panel;
    if (!this.panelStarting) {
      const tables = this.routeTables();
      this.panelStarting = startPanel({
        bus: this.bus,
        port: this.getConfig().panelPort,
        getState: () => this.snapshot(),
        get: tables.get,
        post: tables.post,
        media: () => {
          const root = this.getConfig().root;
          const p = this.activeProject();
          const previews = { previews: path.join(root, ".cache", "brand-previews") };
          return p ? { app: appDir(root, p.app.slug), project: p.dir, ...previews } : previews;
        },
      }).then((handle) => {
        this.panel = handle;
        // The URL without its token (the token never goes into events).
        this.bus.publish("panel.started", {
          port: handle.port,
          url: `http://127.0.0.1:${handle.port}/`,
          message: `panel on http://127.0.0.1:${handle.port}/`,
        });
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
