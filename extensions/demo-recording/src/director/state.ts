/**
 * The Director's state, from what pi tells us (P1a A2, docs/DIRECTOR_STATE.md, pinned by test/p1a-director-events.test.ts).
 *
 *   working  from `before_agent_start` to `agent_settled`, NEVER to `agent_end` (pi retries after it, seconds later)
 *   task     what started the run, in words
 *   step     the tool in flight (the latest one when several run), or none: "thinking"
 *
 * A small state machine over pi's events; it publishes `director.started`, `director.step` and `director.settled` on the bus so the
 * log, the Activity list, the panel and a reload all see the same thing. Handlers must be cheap and must never throw.
 */

import { type Speaker, roleOfTool } from "../roles.ts";
import { stepLabel, taskLabel } from "./labels.ts";

export interface DirectorStep {
  tool: string;
  label: string;
  /** The role the Director plays while it runs this tool (docs/ACTORS.md): "Voice writer", "Cutter", … */
  role: Speaker;
  stage?: string;
  since: number;
}

export interface DirectorSnapshot {
  working: boolean;
  task?: string;
  by?: "you" | "panel" | "report";
  since?: number;
  step?: DirectorStep;
  /** The last time pi told us anything about the run (ms): "no news for N min" is judged from it. */
  lastAt?: number;
  /** How the last run ended, when idle. */
  last?: { task: string; aborted: boolean; ms: number; at: number };
}

type Publish = (type: string, data: Record<string, unknown>, slug?: string) => void;

export class DirectorTracker {
  private publish: Publish;
  private now: () => number;
  private state: DirectorSnapshot = { working: false };
  /** Tool calls in flight, newest last (several can run at once). */
  private inFlight: { id: string; step: DirectorStep }[] = [];
  /** The text of the latest input, before a skill is expanded: it names the task better than the expanded prompt. */
  private lastInput: { text: string; at: number } | undefined;
  private steered = 0;

  constructor(publish: Publish, now: () => number = Date.now) {
    this.publish = publish;
    this.now = now;
  }

  snapshot(): DirectorSnapshot {
    return structuredClone(this.state);
  }

  private touch(): void {
    this.state.lastAt = this.now();
  }

  /** pi: `input`. Remember what was sent; a message typed while the Director works joins the run. */
  onInput(e: { text?: string; streamingBehavior?: string }): void {
    const t = this.now();
    this.lastInput = { text: String(e.text ?? ""), at: t };
    if (this.state.working && e.streamingBehavior === "steer") {
      this.steered++;
      this.touch();
    }
  }

  /** pi: `before_agent_start`: a run begins. */
  onRunStart(e: {
    messageType?: string;
    prompt?: string;
    message?: { content?: unknown };
  }): void {
    const t = this.now();
    if (this.state.working) {
      this.touch(); // a message taken into the run that is going: nothing new to say
      return;
    }
    const input = this.lastInput && t - this.lastInput.at < 2000 ? this.lastInput.text : undefined;
    const custom =
      e.messageType === "custom"
        ? typeof e.message?.content === "string"
          ? e.message.content
          : ""
        : undefined;
    const { label, by } = taskLabel({
      ...(input !== undefined ? { input } : {}),
      ...(e.prompt !== undefined ? { prompt: e.prompt } : {}),
      ...(custom !== undefined ? { custom } : {}),
    });
    this.inFlight = [];
    this.steered = 0;
    this.state = { working: true, task: label, by, since: t, lastAt: t };
    this.publish("director.started", {
      task: label,
      by,
      since: t,
      message: `Director: ${label}`,
    });
  }

  /** pi: `tool_execution_start`. */
  onToolStart(e: { toolCallId?: string; toolName: string; args?: unknown }): void {
    if (!this.state.working) return;
    const t = this.now();
    const { label, stage } = stepLabel(e.toolName, e.args);
    const role = roleOfTool(e.toolName, (e.args ?? {}) as Record<string, unknown>);
    const step: DirectorStep = {
      tool: e.toolName,
      label,
      role,
      ...(stage ? { stage } : {}),
      since: t,
    };
    this.inFlight.push({ id: e.toolCallId ?? `${e.toolName}@${t}`, step });
    this.state.step = step;
    this.touch();
    this.publish("director.step", {
      tool: e.toolName,
      label,
      role,
      ...(stage ? { stage } : {}),
      since: t,
      message: `${role}: ${label}`,
    });
  }

  /** pi: `tool_execution_end`. */
  onToolEnd(e: { toolCallId?: string; toolName: string }): void {
    if (!this.state.working) return;
    this.inFlight = this.inFlight.filter((f) =>
      e.toolCallId ? f.id !== e.toolCallId : f.step.tool !== e.toolName,
    );
    const next = this.inFlight.at(-1)?.step;
    if (next) this.state.step = next;
    else Reflect.deleteProperty(this.state, "step");
    this.touch();
    this.publish("director.step", {
      tool: next?.tool ?? null,
      label: next?.label ?? "Thinking",
      ...(next?.role ? { role: next.role } : {}),
      ...(next?.stage ? { stage: next.stage } : {}),
      since: next?.since ?? this.now(),
      message: `${next?.role ?? "Director"}: ${next?.label ?? "thinking"}`,
    });
  }

  /** pi: `agent_settled`: pi will not continue by itself. The only end of a run. */
  onSettled(e: { aborted?: boolean } = {}): void {
    if (!this.state.working) return;
    const t = this.now();
    const task = this.state.task ?? "";
    const ms = t - (this.state.since ?? t);
    const aborted = e.aborted === true;
    this.inFlight = [];
    this.state = { working: false, last: { task, aborted, ms, at: t } };
    this.publish("director.settled", {
      task,
      aborted,
      ms,
      message: aborted ? `Director stopped: ${task}` : `Director finished: ${task}`,
    });
  }

  /** The session is closing: whatever was going is over. */
  onShutdown(): void {
    if (this.state.working) this.onSettled({ aborted: true });
  }
}
