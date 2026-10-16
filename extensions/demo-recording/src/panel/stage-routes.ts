/**
 * Panel routes for the control room (S5 part 4, D39): stage lineage for every
 * tab header, the Recording tab (takes per storyboard version), approval dry
 * runs (cascade warning before approving), re-record requests, and the live
 * frame of a running take for the Activity drawer's preview.
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
  acceptedVersions,
  formatLine,
  isAccepted,
  isStage,
  isUsable,
  nextStep,
  orphanReason,
  orphansIfUnaccepted,
  parentOf,
  stageStatus,
  takeNumber,
  versionLabel,
} from "../workdir/stages.ts";
import { readState, selectStage, unacceptStage } from "../workdir/state.ts";
import { PANEL_PREFIX } from "./bridge.ts";
import type { GetRoute, PostRoute } from "./server.ts";

export interface StageRouteDeps {
  activeProject: () => ProjectHandle | undefined;
  notifyAgent: (text: string) => void;
  /** Note for the agent's next turn without starting one. */
  tellAgent: (text: string) => void;
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

/** Lineage label of an accepted version: "take-006 · storyboard v2". */
function lineageLabel(projectDir: string, stage: Stage, v: number): string {
  const parts = [versionLabel(stage, v).replace(/^recording /, "")];
  let s: Stage = stage;
  let n: number | undefined = v;
  while (PARENT[s] && n !== undefined) {
    const parent = PARENT[s] as Stage;
    n = parentOf(projectDir, s, n);
    if (n === undefined) break;
    parts.push(versionLabel(parent, n).replace(/^recording /, ""));
    s = parent;
  }
  return parts.join(" · ");
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
      /** Every stage: versions, accepted (with orphan flags), working line, inputs to pick from, next step. */
      stages: () => {
        const p = deps.activeProject();
        if (!p) return { project: null };
        const state = readState(p.dir) ?? p.state;
        return {
          project: p.slug,
          phase: state.phase,
          line: state.line,
          lineText: formatLine(state.line),
          stages: stageStatus(p.dir, state.accepted, state.line).map((s) => {
            const parent = PARENT[s.stage];
            return {
              ...s,
              label: STAGE_LABEL[s.stage],
              parent: parent ?? null,
              // Inputs for this stage's picker: accepted, usable versions of the parent stage.
              inputs: parent
                ? acceptedVersions(state.accepted, parent)
                    .filter((v) => isUsable(p.dir, state.accepted, parent, v))
                    .map((v) => ({
                      version: v,
                      label: lineageLabel(p.dir, parent, v),
                      at: state.accepted[parent]?.[String(v)] ?? null,
                    }))
                    .sort((a, b) => ((b.at ?? "") < (a.at ?? "") ? -1 : 1))
                : [],
            };
          }),
          next: nextStep(p.dir, state.accepted, state.line, { rendered: hasRender(p.dir) }),
        };
      },
      /** Recording tab: the takes of one storyboard version (?storyboard=N, default the working line's). */
      recordings: (q) => {
        const p = deps.activeProject();
        if (!p) return { project: null };
        const state = readState(p.dir) ?? p.state;
        const sb = q.get("storyboard") ? Number(q.get("storyboard")) : state.line.storyboard;
        const takes = listTakes(p.dir)
          .filter((t) => sb === undefined || t.storyboardVersion === sb)
          .reverse()
          .map((t) => {
            const n = takeNumber(t.id) as number;
            const dir = path.join(p.dir, "takes", t.id);
            const analysis = readAnalysis(dir);
            const orphaned = orphanReason(p.dir, state.accepted, "recording", n);
            return {
              id: t.id,
              version: n,
              status: t.status,
              storyboardVersion: t.storyboardVersion,
              durationMs: t.durationMs ?? null,
              startedAt: t.startedAt ?? null,
              analyzed: !!analysis,
              layoutSnapshots: (() => {
                try {
                  return (
                    (
                      JSON.parse(fs.readFileSync(path.join(dir, "take.json"), "utf8")) as {
                        layout?: { snapshots?: number };
                      }
                    ).layout?.snapshots ?? null
                  );
                } catch {
                  return null;
                }
              })(),
              accepted: isAccepted(state.accepted, "recording", n),
              acceptedAt: state.accepted.recording?.[String(n)] ?? null,
              orphaned: orphaned ?? null,
              onLine: state.line.recording === n,
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
          storyboard: sb ?? null,
          storyboardUsable: sb !== undefined && isUsable(p.dir, state.accepted, "storyboard", sb),
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
      /** What un-accepting would orphan (D45) — shown in the confirmation. */
      "unaccept-preview": (body) => {
        const p = requireProject();
        const stage = stageField(body);
        const version = versionField(stage, body);
        const state = readState(p.dir) ?? p.state;
        if (!isAccepted(state.accepted, stage, version))
          throw new Error(`${versionLabel(stage, version)} is not accepted`);
        return { orphans: orphansIfUnaccepted(p.dir, state.accepted, stage, version) };
      },
      unaccept: (body) => {
        const p = requireProject();
        const stage = stageField(body);
        const version = versionField(stage, body);
        const { state, orphaned } = unacceptStage(p.dir, stage, version);
        const label = versionLabel(stage, version);
        deps.publish(
          "stage.unaccepted",
          {
            stage,
            version,
            by: "panel",
            orphaned,
            line: state.line,
            message: `${label} un-accepted${orphaned.length ? ` — orphaned: ${orphaned.map((o) => o.label).join(", ")}` : ""}`,
          },
          p.slug,
        );
        deps.tellAgent(
          `${PANEL_PREFIX} The user UN-ACCEPTED ${label} in project "${p.slug}"${orphaned.length ? `; built on it and now orphaned (not usable until it is accepted again): ${orphaned.map((o) => o.label).join(", ")}` : ""}. Working line: ${formatLine(state.line)}.`,
        );
        return { orphaned, line: state.line };
      },
      /** Put a version on the working line (ancestors follow, descendants re-pick) — D46. */
      select: (body) => {
        const p = requireProject();
        const stage = stageField(body);
        const version = versionField(stage, body);
        const state = selectStage(p.dir, stage, version);
        deps.publish(
          "line.changed",
          { stage, version, line: state.line, message: `working line: ${formatLine(state.line)}` },
          p.slug,
        );
        deps.tellAgent(
          `${PANEL_PREFIX} The user switched the working line of "${p.slug}" to: ${formatLine(state.line)}. Work on this line from now on (tools default to it).`,
        );
        return { line: state.line, lineText: formatLine(state.line) };
      },
      /** Ask the agent for a new take of a storyboard (default: the working line's). Recording needs the improvise model, so it is an agent job. */
      rerecord: (body) => {
        const p = requireProject();
        const state = readState(p.dir) ?? p.state;
        const sb = typeof body.storyboard === "number" ? body.storyboard : state.line.storyboard;
        if (sb === undefined || !isUsable(p.dir, state.accepted, "storyboard", sb))
          throw new Error(
            "approve a storyboard first — a take is always recorded from an approved storyboard",
          );
        const note = typeof body.note === "string" ? body.note.trim() : "";
        recordInput(p.dir, {
          stage: "recording",
          version: sb,
          source: "panel",
          kind: "direction",
          text: `re-record requested for storyboard v${sb}${note ? `: ${note}` : ""}`,
        });
        deps.notifyAgent(
          `${PANEL_PREFIX} The user asks for a new take of storyboard v${sb} for project "${p.slug}"${note ? ` — notes: "${note}"` : ""}. Record it with demo_rec_record storyboard=${sb} (then analyze it; the user accepts takes in the Recording tab).`,
        );
        deps.publish(
          "recording.requested",
          {
            storyboard: sb,
            ...(note ? { note } : {}),
            message: `new take of storyboard v${sb} requested${note ? " (with notes)" : ""}`,
          },
          p.slug,
        );
        return { requested: true, storyboard: sb };
      },
    },
  };
}
