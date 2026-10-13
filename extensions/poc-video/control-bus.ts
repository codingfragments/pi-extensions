import type { AddressInfo } from "node:net";
/**
 * control-bus.ts — the run's event stream + command channel (localhost WS).
 *
 * v1 consumers: the agent (relaying events as chat narration and chat
 * decisions back as commands — agent-in-the-loop) and scripted test clients.
 * The v2 consumer is the web panel — same bus, additive.
 *
 * The runner is the SINGLE WRITER of storyboard.yaml/vo.yaml: every command
 * that mutates them is validated and persisted by the runner, then a
 * storyboard-state-changed event broadcasts the new state to every client.
 *
 * Wire protocol (JSON per WS message):
 *   events  out: run_started · run_status · scene_started · action ·
 *                 scene_finished · storyboard_state_changed · error · run_finished
 *   commands in: pause · resume · abort · retake{id} · skip{id} ·
 *                 set{id, field, value} · get_state
 */
import { WebSocket, WebSocketServer } from "ws";
import type { RunMode, SceneRecord } from "./scripts/record.ts";

export type BusEvent =
  | { type: "run_started"; mode: RunMode; sceneIds: string[]; storyboard: unknown }
  | { type: "run_status"; status: "recording" | "paused" | "finished" | "aborted" }
  | { type: "scene_started"; index: number; id: string; title: string; intent: string }
  | {
      type: "action";
      index: number;
      stepIndex: number;
      stepType: string;
      selector?: string;
    }
  | { type: "scene_finished"; record: SceneRecord }
  | { type: "storyboard_state_changed"; storyboard: unknown }
  | { type: "error"; message: string; command?: unknown }
  | { type: "run_finished"; scenes: SceneRecord[]; video: string | null };

export type BusCommand =
  | { type: "pause" }
  | { type: "resume" }
  | { type: "abort" }
  | { type: "retake"; id: string }
  | { type: "skip"; id: string; value?: boolean }
  | { type: "set"; id: string; field: string; value: string | number | boolean }
  | { type: "get_state" };

const KNOWN_COMMANDS = new Set(["pause", "resume", "abort", "retake", "skip", "set", "get_state"]);

const errText = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";

export class ControlBus {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private commandHandler: ((cmd: BusCommand) => void) | null = null;
  private connectHandler: (() => void) | null = null;
  port = 0;

  get clientCount(): number {
    return this.clients.size;
  }

  /** Start listening. port 0 = pick a free port; resolves to the real port. */
  async start(port = 0): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.wss = new WebSocketServer({ port });
      this.wss.once("listening", () => resolve());
      this.wss.once("error", reject);
    });
    const addr = this.wss?.address() as AddressInfo;
    this.port = addr.port;
    this.wss?.on("connection", (ws) => {
      this.clients.add(ws);
      ws.on("message", (data) => {
        try {
          const cmd = JSON.parse(String(data)) as BusCommand;
          if (!cmd || typeof cmd.type !== "string" || !KNOWN_COMMANDS.has(cmd.type)) {
            this.broadcast({
              type: "error",
              message: `unknown command: ${String(data).slice(0, 200)}`,
            });
            return;
          }
          this.commandHandler?.(cmd);
        } catch (e) {
          this.broadcast({ type: "error", message: `unparseable command: ${errText(e)}` });
        }
      });
      ws.on("close", () => this.clients.delete(ws));
      ws.on("error", () => this.clients.delete(ws));
      this.connectHandler?.();
    });
    return this.port;
  }

  /** The engine installs this — every command routes through the single writer. */
  onCommand(handler: (cmd: BusCommand) => void): void {
    this.commandHandler = handler;
  }

  /** Fired on every new client connection — the engine sends a state snapshot. */
  onConnect(handler: () => void): void {
    this.connectHandler = handler;
  }

  broadcast(event: BusEvent): void {
    const s = JSON.stringify(event);
    for (const c of this.clients) {
      if (c.readyState === WebSocket.OPEN) c.send(s);
    }
  }

  async stop(): Promise<void> {
    const wss = this.wss;
    this.wss = null;
    if (!wss) return;
    for (const c of this.clients) c.terminate();
    this.clients.clear();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
}
