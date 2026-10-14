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
import { editVoSection, readVo, voVersions } from "../vo/store.ts";
import { recordInput } from "../workdir/inputs.ts";
import type { ProjectHandle } from "../workdir/layout.ts";
import { type ApprovalReset, versionLabel } from "../workdir/stages.ts";
import {
  type GatedArtifact,
  type SceneReviewStatus,
  acceptedTakeId,
  approveStage,
  getReview,
  readState,
  reviewText,
  setPhase,
  setReviewNote,
  setSceneReview,
  submitReview,
} from "../workdir/state.ts";
import { approvalMessage, reviewMessage, voReviewMessage } from "./bridge.ts";
import type { GetRoute, PostRoute } from "./server.ts";

export interface RouteDeps {
  /** Per-section audio files for a VO version (filled in once TTS exists). */
  audio?: (version: number) => unknown;
  /** Real-voice fit per scene for a VO version (after TTS). */
  fit?: (version: number) => unknown;
  bus: EventBus;
  activeProject: () => ProjectHandle | undefined;
  /** Current discovery session dir + id, if one is open. */
  discovery: () => { id: string; dir: string; budget: unknown } | undefined;
  notifyAgent: (text: string) => void;
}

const STATUSES: readonly SceneReviewStatus[] = ["approved", "changes", "rerun"];

function artifactField(body: Record<string, unknown>): GatedArtifact {
  const a = body.artifact ?? "storyboard";
  if (a !== "storyboard" && a !== "vo") throw new Error('"artifact" must be "storyboard" or "vo"');
  return a;
}

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
      vo: (q) => {
        const p = deps.activeProject();
        if (!p) return { project: null };
        const versions = voVersions(p.dir);
        const requested = q.get("version") ? Number(q.get("version")) : undefined;
        const state = readState(p.dir) ?? p.state;
        let current: ReturnType<typeof readVo>;
        try {
          current = readVo(p.dir, requested);
        } catch (err) {
          return {
            project: p.slug,
            versions,
            vo: null,
            error: (err as Error).message,
            approved: state.approved.vo ?? null,
          };
        }
        if (!current)
          return {
            project: p.slug,
            versions,
            vo: null,
            approved: state.approved.vo ?? null,
            acceptedTake: acceptedTakeId(state) ?? null,
          };
        const v = current.validated;
        return {
          project: p.slug,
          versions,
          version: current.version,
          take: v.script.take,
          sections: v.resolved.map((s, i) => ({
            key: s.key,
            kind: s.kind,
            scene: s.scene ?? null,
            written: v.script.sections[i]?.body ?? "",
            spoken: s.body,
            segments: s.segments,
          })),
          timing: v.timing,
          issues: v.issues,
          approved: state.approved.vo ?? null,
          review: getReview(state, current.version, "vo"),
          audio: deps.audio?.(current.version) ?? null,
          fit: deps.fit?.(current.version) ?? null,
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
        const artifact = artifactField(body);
        const scene = body.scene;
        if (typeof scene !== "string" || !scene) throw new Error('"scene" is required');
        const status = body.status === null ? null : (body.status as SceneReviewStatus);
        if (status !== null && !STATUSES.includes(status))
          throw new Error(`"status" must be one of ${STATUSES.join(", ")} or null`);
        if (artifact === "storyboard") {
          const sb = readStoryboard(p.dir, version);
          if (!sb) throw new Error(`storyboard v${version} does not exist`);
          if (!sb.storyboard.scenes.some((s) => s.id === scene))
            throw new Error(`scene "${scene}" is not in v${version}`);
        } else {
          const vo = readVo(p.dir, version);
          if (!vo) throw new Error(`voice-over v${version} does not exist`);
          if (!vo.validated.script.sections.some((s) => s.key === scene))
            throw new Error(`section "${scene}" is not in v${version}`);
        }
        const state = setSceneReview(
          p.dir,
          version,
          scene,
          status,
          typeof body.note === "string" ? body.note : undefined,
          artifact,
        );
        deps.bus.publish("review.updated", { artifact, version, scene, status }, p.slug);
        return { review: getReview(state, version, artifact) };
      },
      "review-note": (body) => {
        const p = requireProject(deps);
        const version = intField(body, "version");
        const artifact = artifactField(body);
        const state = setReviewNote(
          p.dir,
          version,
          typeof body.note === "string" ? body.note : "",
          artifact,
        );
        return { review: getReview(state, version, artifact) };
      },
      "review-submit": (body) => {
        const p = requireProject(deps);
        const version = intField(body, "version");
        const artifact = artifactField(body);
        if (artifact === "storyboard") {
          const sb = readStoryboard(p.dir, version);
          if (!sb) throw new Error(`storyboard v${version} does not exist`);
          const { review } = submitReview(p.dir, version);
          recordInput(p.dir, {
            stage: "storyboard",
            version,
            source: "panel",
            kind: "review",
            text: reviewText(review),
          });
          deps.bus.publish(
            "review.submitted",
            { artifact, version, message: `storyboard v${version} review sent to the agent` },
            p.slug,
          );
          deps.notifyAgent(reviewMessage(p.slug, sb.storyboard, review));
          return { review };
        }
        const vo = readVo(p.dir, version);
        if (!vo) throw new Error(`voice-over v${version} does not exist`);
        const { review } = submitReview(p.dir, version, "vo");
        recordInput(p.dir, {
          stage: "vo",
          version,
          source: "panel",
          kind: "review",
          text: reviewText(review),
        });
        deps.bus.publish(
          "review.submitted",
          { artifact, version, message: `voice-over v${version} review sent to the agent` },
          p.slug,
        );
        deps.notifyAgent(
          voReviewMessage(
            p.slug,
            vo.version,
            vo.validated.script.sections.map((s) => s.key),
            review,
          ),
        );
        return { review };
      },
      "vo-edit": (body) => {
        const p = requireProject(deps);
        const version = intField(body, "version");
        const section = body.section;
        if (typeof section !== "string" || !section) throw new Error('"section" is required');
        if (typeof body.text !== "string") throw new Error('"text" is required');
        const stored = editVoSection(p.dir, version, section, body.text);
        recordInput(p.dir, {
          stage: "vo",
          version: stored.version,
          source: "panel",
          kind: "review",
          text: `edited ${section} inline (v${version} → v${stored.version}): ${body.text.length > 300 ? `${body.text.slice(0, 300)}…` : body.text}`,
          refs: [`vo/script.v${stored.version}.md`],
        });
        deps.bus.publish(
          "vo.written",
          {
            version: stored.version,
            message: `voice-over v${stored.version} (edited ${section} in the panel)`,
            by: "user",
          },
          p.slug,
        );
        return { version: stored.version };
      },
      approve: (body) => {
        const p = requireProject(deps);
        if (body.artifact === "recording") {
          // Accept a take (Recording tab): chain-checked like every approval.
          const version = intField(body, "version");
          const { resets } = approveStage(p.dir, "recording", version);
          const st = readState(p.dir);
          if (st?.phase === "recording") setPhase(p.dir, "vo-review");
          const label = versionLabel("recording", version);
          const resetText = resets.length
            ? ` — reset: ${resets.map((r) => `${versionLabel(r.stage, r.version)} (${r.reason})`).join("; ")}`
            : "";
          deps.bus.publish(
            "take.accepted",
            {
              take: label.replace("recording ", ""),
              version,
              resets,
              message: `${label} accepted${resetText}`,
            },
            p.slug,
          );
          deps.notifyAgent(
            `${approvalMessage(p.slug, "recording", version)}${resets.length ? `\nCascade reset (stage chain): ${resets.map((r) => `${versionLabel(r.stage, r.version)} is no longer approved — ${r.reason}`).join("; ")}.` : ""}`,
          );
          return { approved: version, resets };
        }
        const version = intField(body, "version");
        const artifact = artifactField(body);
        let resets: ApprovalReset[] = [];
        if (artifact === "storyboard") {
          if (!readStoryboard(p.dir, version))
            throw new Error(`storyboard v${version} does not exist`);
          resets = approveStage(p.dir, "storyboard", version).resets;
          setPhase(p.dir, "recording");
        } else {
          const vo = readVo(p.dir, version);
          if (!vo) throw new Error(`voice-over v${version} does not exist`);
          if (vo.validated.issues.some((i) => i.level === "error"))
            throw new Error(`voice-over v${version} has errors — fix them first`);
          resets = approveStage(p.dir, "vo", version).resets;
          setPhase(p.dir, "voice-edit");
        }
        const resetText = resets.length
          ? ` — reset: ${resets.map((r) => `${versionLabel(r.stage, r.version)} (${r.reason})`).join("; ")}`
          : "";
        deps.bus.publish(
          `${artifact}.approved`,
          {
            version,
            message: `${artifact === "vo" ? "voice-over" : "storyboard"} v${version} approved${resetText}`,
            resets,
          },
          p.slug,
        );
        deps.notifyAgent(
          `${approvalMessage(p.slug, artifact, version)}${resets.length ? `\nCascade reset (stage chain): ${resets.map((r) => `${versionLabel(r.stage, r.version)} is no longer approved — ${r.reason}`).join("; ")}.` : ""}`,
        );
        return { approved: version, resets };
      },
    },
  };
}
