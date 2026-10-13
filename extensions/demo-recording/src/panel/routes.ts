/**
 * Panel API routes for S2 (REVIEW + LIVE discovery). Thin glue over the
 * workdir/state modules; every state change goes through state.json first and
 * is then announced on the bus and (for submissions/approvals) to the agent.
 */

import fs from "node:fs";
import path from "node:path";
import type { EventBus } from "../bus.ts";
import { diffStoryboards } from "../storyboard/diff.ts";
import { readStoryboard, storyboardVersions } from "../storyboard/store.ts";
import type { ProjectHandle } from "../workdir/layout.ts";
import {
  type SceneReviewStatus,
  approve,
  getReview,
  readState,
  setPhase,
  setReviewNote,
  setSceneReview,
  submitReview,
} from "../workdir/state.ts";
import { approvalMessage, reviewMessage } from "./bridge.ts";
import type { GetRoute, PostRoute } from "./server.ts";

export interface RouteDeps {
  bus: EventBus;
  activeProject: () => ProjectHandle | undefined;
  /** Current discovery session dir + id, if one is open. */
  discovery: () => { id: string; dir: string; budget: unknown } | undefined;
  notifyAgent: (text: string) => void;
}

const STATUSES: readonly SceneReviewStatus[] = ["approved", "changes", "rerun"];

function requireProject(deps: RouteDeps): ProjectHandle {
  const p = deps.activeProject();
  if (!p) throw new Error("no active project");
  return p;
}

function intField(body: Record<string, unknown>, key: string): number {
  const v = body[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1)
    throw new Error(`"${key}" must be a positive integer`);
  return v;
}

function readJsonl(file: string, limit: number): unknown[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .map((l) => JSON.parse(l));
}

export function panelRoutes(deps: RouteDeps): {
  get: Record<string, GetRoute>;
  post: Record<string, PostRoute>;
} {
  return {
    get: {
      storyboard: (q) => {
        const p = deps.activeProject();
        if (!p) return { project: null };
        const versions = storyboardVersions(p.dir);
        const requested = q.get("version") ? Number(q.get("version")) : undefined;
        const current = readStoryboard(p.dir, requested);
        const state = readState(p.dir) ?? p.state;
        if (!current)
          return {
            project: p.slug,
            versions,
            storyboard: null,
            approved: state.approved.storyboard ?? null,
          };
        const prevVersion = versions.filter((v) => v < current.version).at(-1);
        const prev = prevVersion !== undefined ? readStoryboard(p.dir, prevVersion) : undefined;
        return {
          project: p.slug,
          app: p.app.slug,
          versions,
          version: current.version,
          storyboard: current.storyboard,
          text: current.text,
          approved: state.approved.storyboard ?? null,
          review: getReview(state, current.version),
          diff: prev ? diffStoryboards(prev.storyboard, current.storyboard) : null,
        };
      },
      discovery: () => {
        const d = deps.discovery();
        if (!d) return { session: null };
        return {
          session: d.id,
          budget: d.budget,
          audit: readJsonl(path.join(d.dir, "audit.jsonl"), 50).filter(
            (r) => (r as { level?: string }).level !== "safe",
          ),
          sitemap: fs.existsSync(path.join(d.dir, "sitemap.json"))
            ? JSON.parse(fs.readFileSync(path.join(d.dir, "sitemap.json"), "utf8"))
            : [],
        };
      },
    },
    post: {
      review: (body) => {
        const p = requireProject(deps);
        const version = intField(body, "version");
        const scene = body.scene;
        if (typeof scene !== "string" || !scene) throw new Error('"scene" is required');
        const status = body.status === null ? null : (body.status as SceneReviewStatus);
        if (status !== null && !STATUSES.includes(status))
          throw new Error(`"status" must be one of ${STATUSES.join(", ")} or null`);
        const sb = readStoryboard(p.dir, version);
        if (!sb) throw new Error(`storyboard v${version} does not exist`);
        if (!sb.storyboard.scenes.some((s) => s.id === scene))
          throw new Error(`scene "${scene}" is not in v${version}`);
        const state = setSceneReview(
          p.dir,
          version,
          scene,
          status,
          typeof body.note === "string" ? body.note : undefined,
        );
        deps.bus.publish("review.updated", { version, scene, status }, p.slug);
        return { review: getReview(state, version) };
      },
      "review-note": (body) => {
        const p = requireProject(deps);
        const version = intField(body, "version");
        const state = setReviewNote(p.dir, version, typeof body.note === "string" ? body.note : "");
        return { review: getReview(state, version) };
      },
      "review-submit": (body) => {
        const p = requireProject(deps);
        const version = intField(body, "version");
        const sb = readStoryboard(p.dir, version);
        if (!sb) throw new Error(`storyboard v${version} does not exist`);
        const { review } = submitReview(p.dir, version);
        deps.bus.publish(
          "review.submitted",
          { version, message: `storyboard v${version} review sent to the agent` },
          p.slug,
        );
        deps.notifyAgent(reviewMessage(p.slug, sb.storyboard, review));
        return { review };
      },
      approve: (body) => {
        const p = requireProject(deps);
        const version = intField(body, "version");
        if (body.artifact !== "storyboard")
          throw new Error('only "storyboard" approval is available in this slice');
        if (!readStoryboard(p.dir, version))
          throw new Error(`storyboard v${version} does not exist`);
        approve(p.dir, "storyboard", version);
        setPhase(p.dir, "recording");
        deps.bus.publish(
          "storyboard.approved",
          { version, message: `storyboard v${version} approved` },
          p.slug,
        );
        deps.notifyAgent(approvalMessage(p.slug, "storyboard", version));
        return { approved: version };
      },
    },
  };
}
