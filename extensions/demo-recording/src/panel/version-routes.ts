/**
 * The panel's version actions (UX3, D118): the history of a stage, a free plan for an action, and the
 * action itself. The older `approve`, `select` and `unaccept` routes stay for the tools and older callers.
 *
 *   GET  /api/history?stage=vo     every version of the stage and where it stands (read-only)
 *   POST /api/version-plan         what an action would change, or why it can't be done (free)
 *   POST /api/version-act          do it, once, and only if the project is still as planned
 *
 * Who is told: Approve & use starts an agent turn (the Director continues from the approved version);
 * Approve only, Use for next steps and Withdraw approval leave a quiet note for the next turn.
 */

import type { ProjectHandle } from "../workdir/layout.ts";
import {
  PARENT,
  type Stage,
  formatLine,
  isStage,
  takeNumber,
  versionLabel,
} from "../workdir/stages.ts";
import { PHASES, readState, setPhase } from "../workdir/state.ts";
import { PANEL_PREFIX, approvalMessage } from "./bridge.ts";
import type { GetRoute, PostRoute } from "./server.ts";
import {
  INTENTS,
  type Intent,
  StalePlanError,
  applyVersionAction,
  planVersionAction,
  versionHistory,
} from "./version-actions.ts";

export interface VersionRouteDeps {
  activeProject: () => ProjectHandle | undefined;
  notifyAgent: (text: string) => void;
  tellAgent: (text: string) => void;
  publish: (type: string, data: Record<string, unknown>, project?: string) => void;
}

function stageOf(source: URLSearchParams | Record<string, unknown>): Stage {
  const raw = source instanceof URLSearchParams ? source.get("stage") : source.stage;
  if (!isStage(raw))
    throw new Error('"stage" must be one of: storyboard, recording, vo, annotations, render');
  return raw;
}

function versionOf(stage: Stage, body: Record<string, unknown>): number {
  const v = body.version;
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  if (stage === "recording" && typeof body.take === "string") {
    const n = takeNumber(body.take);
    if (n !== undefined) return n;
  }
  throw new Error('"version" must be a positive integer');
}

function intentOf(body: Record<string, unknown>): Intent {
  const i = body.intent;
  if (typeof i !== "string" || !(INTENTS as readonly string[]).includes(i))
    throw new Error(`"intent" must be one of: ${INTENTS.join(", ")}`);
  return i as Intent;
}

export function versionRoutes(deps: VersionRouteDeps): {
  get: Record<string, GetRoute>;
  post: Record<string, PostRoute>;
} {
  const requireProject = () => {
    const p = deps.activeProject();
    if (!p) throw new Error("no active project");
    return p;
  };
  return {
    get: {
      history: (q) => {
        const p = deps.activeProject();
        if (!p) return { project: null };
        const stage = stageOf(q);
        const state = readState(p.dir) ?? p.state;
        return {
          project: p.slug,
          stage,
          parent: PARENT[stage] ?? null,
          line: formatLine(state.line),
          rows: versionHistory(p.dir, state, stage),
        };
      },
    },
    post: {
      "version-plan": (body) => {
        const p = requireProject();
        const stage = stageOf(body);
        const state = readState(p.dir) ?? p.state;
        return planVersionAction(p.dir, state, {
          stage,
          version: versionOf(stage, body),
          intent: intentOf(body),
        });
      },
      "version-act": (body) => {
        const p = requireProject();
        const stage = stageOf(body);
        const version = versionOf(stage, body);
        const intent = intentOf(body);
        const token = typeof body.token === "string" ? body.token : "";
        let applied: ReturnType<typeof applyVersionAction>;
        try {
          applied = applyVersionAction(p.dir, { stage, version, intent, token });
        } catch (e) {
          if (e instanceof StalePlanError) {
            // not an error to show: the panel looks again and asks again with the fresh plan
            const state = readState(p.dir) ?? p.state;
            return {
              stale: true,
              plan: planVersionAction(p.dir, state, { stage, version, intent }),
            };
          }
          throw e;
        }
        const { plan, state, orphaned } = applied;
        const label = versionLabel(stage, version);
        const line = formatLine(state.line);
        const inLine = state.line[stage] === version;
        const base = {
          stage,
          version,
          by: "panel",
          intent,
          line: state.line,
          lineText: line,
        };
        if (intent === "approve-use" || intent === "approve-only") {
          deps.publish(
            stage === "recording" ? "take.accepted" : `${stage}.approved`,
            {
              ...base,
              onLine: inLine,
              message: `${label} approved${inLine ? " and in the production line" : " (production line unchanged)"}`,
            },
            p.slug,
          );
        } else if (intent === "use") {
          deps.publish("line.changed", { ...base, message: `production line: ${line}` }, p.slug);
        } else {
          deps.publish(
            "stage.unaccepted",
            {
              ...base,
              orphaned,
              message: `approval of ${label} withdrawn${orphaned.length ? ` — blocked by dependency: ${orphaned.map((o) => o.label).join(", ")}` : ""}`,
            },
            p.slug,
          );
        }
        if (intent === "approve-use") {
          if (inLine) {
            const next =
              stage === "storyboard"
                ? "recording"
                : stage === "recording"
                  ? "vo-review"
                  : stage === "vo"
                    ? "voice-edit"
                    : undefined;
            if (next && PHASES.indexOf(next) > PHASES.indexOf(state.phase)) setPhase(p.dir, next);
          }
          deps.notifyAgent(`${approvalMessage(p.slug, stage, version)}\nProduction line: ${line}.`);
        } else if (intent === "approve-only") {
          deps.tellAgent(
            `${PANEL_PREFIX} The user APPROVED ${label} in project "${p.slug}" as an alternative and left the production line unchanged: ${line}. Nothing to start; keep working on the production line.`,
          );
        } else if (intent === "use") {
          deps.tellAgent(
            `${PANEL_PREFIX} The user switched the production line of "${p.slug}" to: ${line}. Work on this line from now on (tools default to it).`,
          );
        } else {
          deps.tellAgent(
            `${PANEL_PREFIX} The user WITHDREW the approval of ${label} in project "${p.slug}"${orphaned.length ? `; built on it and now blocked by dependency (not usable until it is approved again): ${orphaned.map((o) => o.label).join(", ")}` : ""}. Production line: ${line}.`,
          );
        }
        return { done: true, intent, plan, line: state.line, lineText: line, orphaned };
      },
    },
  };
}
