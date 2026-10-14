/**
 * Panel routes for the control room (S5 part 4, D39): stage lineage for every
 * tab header, the Recording tab (takes per storyboard version), approval dry
 * runs (cascade warning before approving), re-record requests, and the live
 * frame of a running take for the Live panel's preview.
 */

import fs from "node:fs";
import path from "node:path";
import { readAnalysis } from "../analysis/take.ts";
import { listTakes } from "../tools/take.ts";
import { recordInput } from "../workdir/inputs.ts";
import type { ProjectHandle } from "../workdir/layout.ts";
import {
  PARENT,
  STAGE_LABEL,
  type Stage,
  isStage,
  nextStep,
  previewApproval,
  stageStatus,
  takeNumber,
  versionLabel,
} from "../workdir/stages.ts";
import { readState } from "../workdir/state.ts";
import { PANEL_PREFIX } from "./bridge.ts";
import type { GetRoute, PostRoute } from "./server.ts";

export interface StageRouteDeps {
  activeProject: () => ProjectHandle | undefined;
  notifyAgent: (text: string) => void;
  publish: (type: string, data: Record<string, unknown>, project?: string) => void;
}

/** Project-relative path for media URLs (`/media/project/<rel>`). */
const rel = (projectDir: string, file: string) =>
  path.relative(projectDir, file).split(path.sep).join("/");

/**
 * Analysis files store absolute paths; if the project was moved or copied
 * they point at the old place. Re-anchor anything under `takes/` onto this
 * project. Undefined when the file can't be found.
 */
export function localize(projectDir: string, file: string): string | undefined {
  const inside = path.resolve(file).startsWith(path.resolve(projectDir) + path.sep);
  if (inside && fs.existsSync(file)) return file;
  const parts = file.split(/[\\/]/);
  const i = parts.lastIndexOf("takes");
  if (i < 0) return undefined;
  const moved = path.join(projectDir, ...parts.slice(i));
  return fs.existsSync(moved) ? moved : undefined;
}

function hasRender(projectDir: string): boolean {
  const out = path.join(projectDir, "out");
  if (!fs.existsSync(out)) return false;
  return fs.readdirSync(out).some((d) => {
    const dir = path.join(out, d);
    if (!/^edit-v\d+$|^render-v\d+$/.test(d) || !fs.statSync(dir).isDirectory()) return false;
    return (
      fs.existsSync(path.join(dir, "full.mp4")) ||
      fs.readdirSync(dir).some((v) => fs.existsSync(path.join(dir, v, "full.mp4")))
    );
  });
}

/** The newest frame of the most recent take still being recorded (frames/ exists only while capturing). */
export function liveFrame(
  projectDir: string,
  maxAgeMs = 15_000,
): { take: string; media: string } | null {
  const takes = path.join(projectDir, "takes");
  if (!fs.existsSync(takes)) return null;
  const ids = fs
    .readdirSync(takes)
    .filter((d) => /^take-\d{3,}$/.test(d))
    .sort()
    .reverse();
  for (const id of ids) {
    const frames = path.join(takes, id, "frames");
    if (!fs.existsSync(frames)) continue;
    const newest = fs
      .readdirSync(frames)
      .filter((f) => f.endsWith(".jpg"))
      .sort()
      .at(-1);
    if (!newest) continue;
    const file = path.join(frames, newest);
    if (Date.now() - fs.statSync(file).mtimeMs > maxAgeMs) return null;
    return { take: id, media: rel(projectDir, file) };
  }
  return null;
}

function stageField(body: Record<string, unknown>): Stage {
  const raw = body.artifact ?? body.stage;
  if (!isStage(raw))
    throw new Error('"artifact" must be a stage: storyboard, recording, vo, annotations, render');
  return raw;
}

function versionField(stage: Stage, body: Record<string, unknown>): number {
  const v = body.version;
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  if (stage === "recording" && typeof body.take === "string") {
    const n = takeNumber(body.take);
    if (n !== undefined) return n;
  }
  throw new Error('"version" must be a positive integer (or "take": "take-NNN")');
}

export function stageRoutes(deps: StageRouteDeps): {
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
      /** Lineage for every stage tab header + what the project waits for. */
      stages: () => {
        const p = deps.activeProject();
        if (!p) return { project: null };
        const state = readState(p.dir) ?? p.state;
        return {
          project: p.slug,
          phase: state.phase,
          stages: stageStatus(p.dir, state.approved).map((s) => ({
            ...s,
            label: STAGE_LABEL[s.stage],
            parent: PARENT[s.stage] ?? null,
            // Downstream approvals that a different approval here would put at risk.
            downstreamApproved: Object.entries(state.approved)
              .filter(
                ([k]) =>
                  isStage(k) &&
                  STAGE_LABEL[k as Stage] &&
                  k !== s.stage &&
                  isDownstream(s.stage, k as Stage),
              )
              .map(([k, v]) => versionLabel(k as Stage, v as number)),
          })),
          next: nextStep(p.dir, state.approved, { rendered: hasRender(p.dir) }),
        };
      },
      /** Recording tab: every take, newest first, with analysis state and keyframes. */
      recordings: () => {
        const p = deps.activeProject();
        if (!p) return { project: null };
        const state = readState(p.dir) ?? p.state;
        const takes = listTakes(p.dir)
          .reverse()
          .map((t) => {
            const n = takeNumber(t.id) as number;
            const dir = path.join(p.dir, "takes", t.id);
            const analysis = readAnalysis(dir);
            return {
              id: t.id,
              version: n,
              status: t.status,
              storyboardVersion: t.storyboardVersion,
              durationMs: t.durationMs ?? null,
              startedAt: t.startedAt ?? null,
              analyzed: !!analysis,
              accepted: state.approved.recording === n,
              onApprovedStoryboard: t.storyboardVersion === state.approved.storyboard,
              hasVideo: fs.existsSync(path.join(dir, "raw.mp4")),
              video: fs.existsSync(path.join(dir, "raw.mp4"))
                ? rel(p.dir, path.join(dir, "raw.mp4"))
                : null,
              scenes: (analysis?.scenes ?? []).map((s) => {
                const files = s.keyframes.map((x) => ({
                  label: x.label,
                  file: localize(p.dir, x.file),
                }));
                const k =
                  files.find((x) => x.label !== "start" && x.file) ?? files.find((x) => x.file);
                return {
                  id: s.id,
                  title: s.title ?? s.id,
                  durationMs: s.end - s.start,
                  keyframe: k?.file ? rel(p.dir, k.file) : null,
                };
              }),
            };
          });
        return {
          project: p.slug,
          approvedStoryboard: state.approved.storyboard ?? null,
          accepted: state.approved.recording ?? null,
          takes,
        };
      },
      /** Newest frame of a take being recorded right now (null when nothing is recording). */
      "live-frame": () => {
        const p = deps.activeProject();
        return { frame: p ? liveFrame(p.dir) : null };
      },
    },
    post: {
      /** Dry run: which approvals a new approval would reset (the cascade warning). */
      "approve-preview": (body) => {
        const p = requireProject();
        const stage = stageField(body);
        const version = versionField(stage, body);
        const state = readState(p.dir) ?? p.state;
        const resets = previewApproval(p.dir, state.approved, stage, version);
        return { resets: resets.map((r) => ({ ...r, label: versionLabel(r.stage, r.version) })) };
      },
      /** Ask the agent for a new take (recording is an agent job: it needs the improvise model). */
      rerecord: (body) => {
        const p = requireProject();
        const state = readState(p.dir) ?? p.state;
        const sb = state.approved.storyboard;
        if (!sb)
          throw new Error(
            "approve a storyboard first — a take is always based on the approved storyboard",
          );
        const note = typeof body.note === "string" ? body.note.trim() : "";
        recordInput(p.dir, {
          stage: "recording",
          version: sb,
          source: "panel",
          kind: "direction",
          text: `re-record requested${note ? `: ${note}` : ""}`,
        });
        deps.notifyAgent(
          `${PANEL_PREFIX} The user asks for a new take of storyboard v${sb} for project "${p.slug}"${note ? ` — notes: "${note}"` : ""}. Record it with demo_rec_record (then analyze it; the user accepts the take in the Recording tab).`,
        );
        deps.publish(
          "recording.requested",
          { storyboard: sb, message: `new take of storyboard v${sb} requested` },
          p.slug,
        );
        return { requested: true };
      },
    },
  };
}

function isDownstream(of: Stage, s: Stage): boolean {
  let cur: Stage | undefined = s;
  while (cur) {
    cur = PARENT[cur];
    if (cur === of) return true;
  }
  return false;
}
