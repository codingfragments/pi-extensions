/**
 * Panel API routes for S2 (REVIEW + LIVE discovery). Thin glue over the
 * workdir/state modules; every state change goes through state.json first and
 * is then announced on the bus and (for submissions/approvals) to the agent.
 */

import fs from "node:fs";
import path from "node:path";
import { readDraft } from "../annotations/draft.ts";
import { readAnnotations } from "../annotations/file.ts";
import type { EventBus } from "../bus.ts";
import { qaBlocker } from "../qa/run.ts";
import { readRender } from "../render/store.ts";
import { diffStoryboards } from "../storyboard/diff.ts";
import { readStoryboard, storyboardVersions } from "../storyboard/store.ts";
import { capText } from "../util/events.ts";
import { editVoSection, readVo, voVersions } from "../vo/store.ts";
import { recordInput } from "../workdir/inputs.ts";
import type { ProjectHandle } from "../workdir/layout.ts";
import { PARENT, acceptedVersions, formatLine, parentOf, versionLabel } from "../workdir/stages.ts";
import {
  type GatedArtifact,
  PHASES,
  type SceneReviewStatus,
  acceptStage,
  acceptedTakeId,
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
            accepted: acceptedVersions(state.accepted, "storyboard"),
            selected: state.line.storyboard ?? null,
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
          accepted: acceptedVersions(state.accepted, "storyboard"),
          selected: state.line.storyboard ?? null,
          review: getReview(state, current.version),
          diff: prev ? diffStoryboards(prev.storyboard, current.storyboard) : null,
        };
      },
      vo: (q) => {
        const p = deps.activeProject();
        if (!p) return { project: null };
        const state = readState(p.dir) ?? p.state;
        // Scoped to one take (the input): ?take=N, else the working line's take.
        const take = q.get("take") ? Number(q.get("take")) : state.line.recording;
        const all = voVersions(p.dir);
        const versions =
          take !== undefined ? all.filter((v) => parentOf(p.dir, "vo", v) === take) : all;
        const scope = {
          input: take ?? null,
          accepted: acceptedVersions(state.accepted, "vo"),
          selected: state.line.vo ?? null,
        };
        const asked = q.get("version") ? Number(q.get("version")) : undefined;
        const requested = asked ?? (take !== undefined ? (versions.at(-1) ?? -1) : undefined);
        let current: ReturnType<typeof readVo>;
        try {
          current = readVo(p.dir, requested);
        } catch (err) {
          return {
            project: p.slug,
            versions,
            vo: null,
            error: (err as Error).message,
            ...scope,
          };
        }
        if (!current)
          return {
            project: p.slug,
            versions,
            vo: null,
            ...scope,
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
          ...scope,
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
        deps.bus.publish(
          "review.updated",
          {
            artifact,
            version,
            scene,
            status,
            ...(typeof body.note === "string" && body.note ? { note: body.note } : {}),
            message: `${artifact === "vo" ? "voice-over" : "storyboard"} v${version} · ${scene} → ${status ?? "cleared"}`,
          },
          p.slug,
        );
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
            {
              artifact,
              version,
              review: capText(reviewText(review)),
              message: `storyboard v${version} review sent to the agent`,
            },
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
          {
            artifact,
            version,
            review: capText(reviewText(review)),
            message: `voice-over v${version} review sent to the agent`,
          },
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
            from: version,
            section,
            text: capText(body.text),
          },
          p.slug,
        );
        return { version: stored.version };
      },
      /** Accept a version (D44): several per stage; chain-checked; resets nothing. */
      approve: (body) => {
        const p = requireProject(deps);
        const version = intField(body, "version");
        const artifact = body.artifact ?? "storyboard";
        if (
          artifact !== "storyboard" &&
          artifact !== "vo" &&
          artifact !== "recording" &&
          artifact !== "annotations" &&
          artifact !== "render"
        )
          throw new Error(
            '"artifact" must be "storyboard", "recording", "vo", "annotations" or "render"',
          );
        if (artifact === "render") {
          const r = readRender(p.dir, version);
          if (!r) throw new Error(`render v${version} does not exist`);
          if (r.kind !== "final")
            throw new Error("only final renders can be accepted — drafts are for watching");
          if (r.status !== "done") throw new Error(`render v${version} is ${r.status}`);
          if (r.deleted || r.pruned)
            throw new Error(`render v${version} has no files any more — render it again`);
          const why = qaBlocker(r);
          if (why) throw new Error(why);
        }
        if (artifact === "annotations") {
          if (!readAnnotations(p.dir, version))
            throw new Error(`annotations v${version} do not exist`);
          if (readDraft(p.dir)?.base === version)
            throw new Error(
              `annotations v${version} have unsaved changes — save them (as a new version) or discard them first`,
            );
        }
        if (artifact === "storyboard" && !readStoryboard(p.dir, version))
          throw new Error(`storyboard v${version} does not exist`);
        if (artifact === "vo") {
          const vo = readVo(p.dir, version);
          if (!vo) throw new Error(`voice-over v${version} does not exist`);
          if (vo.validated.issues.some((i) => i.level === "error"))
            throw new Error(`voice-over v${version} has errors — fix them first`);
        }
        const state = acceptStage(p.dir, artifact, version);
        const onLine = state.line[artifact] === version;
        if (onLine) {
          const next =
            artifact === "storyboard"
              ? "recording"
              : artifact === "recording"
                ? "vo-review"
                : artifact === "vo"
                  ? "voice-edit"
                  : undefined;
          if (next && PHASES.indexOf(next) > PHASES.indexOf(state.phase)) setPhase(p.dir, next);
        }
        const label = versionLabel(artifact, version);
        deps.bus.publish(
          artifact === "recording" ? "take.accepted" : `${artifact}.approved`,
          {
            version,
            by: "panel",
            onLine,
            line: formatLine(state.line),
            ...(PARENT[artifact] ? { basedOn: parentOf(p.dir, artifact, version) ?? null } : {}),
            message: `${label} accepted${onLine ? " (working line)" : ""}`,
          },
          p.slug,
        );
        deps.notifyAgent(
          `${approvalMessage(p.slug, artifact, version)}${onLine ? "" : `\nIt is not on the working line (${formatLine(state.line)}); the user can switch to it in the panel.`}`,
        );
        return { accepted: version, onLine, line: state.line };
      },
    },
  };
}
