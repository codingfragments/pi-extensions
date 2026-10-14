/**
 * Panel routes for the Annotations tab (S5 part 8, D53–D58): the version or
 * draft with resolved timing and the budget, draft edits, save/discard,
 * re-suggest with instructions (→ the agent), card previews (still eager,
 * clip on click) and a low-res scene draft.
 */

import path from "node:path";
import { resolveContext } from "../annotations/apply.ts";
import {
  type DraftOp,
  discardDraft,
  editDraft,
  readDraft,
  saveDraft,
} from "../annotations/draft.ts";
import { annotationVersions, readAnnotations } from "../annotations/file.ts";
import { previewAnnotation, previewScene } from "../annotations/preview.ts";
import { resolveAnnotations } from "../annotations/resolve.ts";
import type { AnnotationFile } from "../annotations/types.ts";
import { budgetOf } from "../annotations/weights.ts";
import type { DemoRecConfig } from "../config.ts";
import { prepareBrand } from "../edit/pipeline.ts";
import type { Timeline } from "../edit/timeline.ts";
import { logInstructions, timelineFor } from "../tools/annotations.ts";
import { recordInput } from "../workdir/inputs.ts";
import type { ProjectHandle } from "../workdir/layout.ts";
import { isAccepted } from "../workdir/stages.ts";
import { readState } from "../workdir/state.ts";
import { PANEL_PREFIX } from "./bridge.ts";
import type { GetRoute, PostRoute } from "./server.ts";

export interface AnnotationRouteDeps {
  activeProject: () => ProjectHandle | undefined;
  getConfig: () => DemoRecConfig;
  notifyAgent: (text: string) => void;
  publish: (type: string, data: Record<string, unknown>, project?: string) => void;
}

/** Card stills at 960×540 (sharp enough for a card), clips and scene drafts at 640×360 (D55). */
export const STILL_SIZE = { width: 960, height: 540 };
export const CLIP_SIZE = { width: 640, height: 360 };

/** Project-relative path; the panel turns it into a media URL with its token. */
const media = (projectDir: string, file: string) =>
  path.relative(projectDir, file).split(path.sep).join("/");

function safeTimeline(
  projectDir: string,
  vo: number,
): { version: number; timeline: Timeline } | undefined {
  try {
    return timelineFor(projectDir, vo);
  } catch {
    return undefined;
  }
}

/** The tab's view of a version (or of the draft on top of it). */
export function annotationsView(p: ProjectHandle, cfg: DemoRecConfig, requested?: number) {
  const versions = annotationVersions(p.dir);
  const draft = readDraft(p.dir);
  const state = readState(p.dir) ?? p.state;
  const lineTimeline = safeTimeline(p.dir, state.line.vo as number);
  const base = {
    project: p.slug,
    versions,
    autoSuggest: cfg.annotations.autoSuggest,
    canSuggest: state.line.vo !== undefined && !!lineTimeline,
    lineVo: state.line.vo ?? null,
  };
  const v = requested ?? state.line.annotations ?? draft?.base ?? versions.at(-1);
  if (v === undefined || !versions.includes(v))
    return { ...base, version: null, file: null, draft: null };
  const useDraft = !!draft && draft.base === v;
  const file = (useDraft ? draft?.file : readAnnotations(p.dir, v)) as AnnotationFile;
  const t = safeTimeline(p.dir, file.basedOn.vo);
  const scenes = (t?.timeline.scenes ?? []).map((s) => ({
    id: s.id,
    title: s.title,
    durationMs: s.durationMs,
  }));
  const resolved: Record<
    string,
    { startMs: number; endMs: number; atMs: number } | { problem: string }
  > = {};
  if (t) {
    const rc = resolveContext(p.dir, t.timeline);
    for (const it of file.items) {
      const r = resolveAnnotations({ ...file, items: [{ ...it, enabled: true }] }, rc);
      const x = r.items[0];
      resolved[it.id] = x
        ? { startMs: Math.round(x.startMs), endMs: Math.round(x.endMs), atMs: Math.round(x.atMs) }
        : {
            problem: (r.warnings[0] ?? "not placeable")
              .replace(/^[^:]+: /, "")
              .replace(/ — skipped$/, ""),
          };
    }
  }
  return {
    ...base,
    version: v,
    accepted: isAccepted(state.accepted, "annotations", v),
    draft:
      useDraft && draft
        ? { base: draft.base, changes: draft.changes, updatedAt: draft.updatedAt }
        : null,
    otherDraft: draft && !useDraft ? draft.base : null,
    file,
    resolved,
    scenes,
    timelineVersion: t?.version ?? null,
    budget: budgetOf(file.items, file.budget?.optimumNoise ?? 0),
    stale: !t ? `the edit for VO v${file.basedOn.vo} is missing` : null,
  };
}

/** One preview render at a time (they share Chromium and ffmpeg). */
function serial() {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
}

export function annotationRoutes(deps: AnnotationRouteDeps): {
  get: Record<string, GetRoute>;
  post: Record<string, PostRoute>;
} {
  const requireProject = () => {
    const p = deps.activeProject();
    if (!p) throw new Error("no active project");
    return p;
  };
  const queue = serial();
  const fileFor = (p: ProjectHandle, body: Record<string, unknown>): AnnotationFile => {
    const v = Number(body.version);
    const d = readDraft(p.dir);
    if (d && d.base === v) return d.file;
    const f = readAnnotations(p.dir, v);
    if (!f) throw new Error(`annotations v${v} do not exist`);
    return f;
  };
  const versionOf = (body: Record<string, unknown>) => {
    const v = Number(body.version);
    if (!Number.isInteger(v) || v < 1) throw new Error('"version" is required');
    return v;
  };
  const changed = (p: ProjectHandle, message: string, version?: number) =>
    deps.publish("annotations.updated", { ...(version ? { version } : {}), message }, p.slug);

  return {
    get: {
      annotations: (q) => {
        const p = deps.activeProject();
        if (!p) return { project: null };
        const v = q.get("version");
        return annotationsView(p, deps.getConfig(), v ? Number(v) : undefined);
      },
    },
    post: {
      /** A draft edit: { version, op: toggle|text|nudge|target, id, … } */
      "annotations-edit": (body) => {
        const p = requireProject();
        const version = versionOf(body);
        const op = { ...(body as Record<string, unknown>) } as unknown as DraftOp & {
          version?: number;
        };
        Reflect.deleteProperty(op, "version");
        const d = editDraft(p.dir, version, op);
        changed(p, `annotations draft on v${version}: ${d.changes} unsaved change(s)`);
        return annotationsView(p, deps.getConfig(), version);
      },
      "annotations-save": () => {
        const p = requireProject();
        const d = readDraft(p.dir);
        const stored = saveDraft(p.dir);
        recordInput(p.dir, {
          stage: "annotations",
          version: stored.version,
          source: "panel",
          kind: "review",
          text: `annotation edits on v${d?.base}: ${d?.changes ?? 0} change(s) saved as v${stored.version}`,
        });
        changed(p, `annotations v${stored.version} saved from the panel`, stored.version);
        return annotationsView(p, deps.getConfig(), stored.version);
      },
      "annotations-discard": () => {
        const p = requireProject();
        const d = readDraft(p.dir);
        discardDraft(p.dir);
        changed(p, "annotation draft discarded");
        return annotationsView(p, deps.getConfig(), d?.base);
      },
      /** Ask the agent to (re-)suggest, with the user's instructions (D53, D56). */
      "annotations-resuggest": (body) => {
        const p = requireProject();
        const state = readState(p.dir) ?? p.state;
        if (state.line.vo === undefined)
          throw new Error("accept a voice-over first — annotations follow the narration");
        if (!safeTimeline(p.dir, state.line.vo))
          throw new Error(`run the sync edit for VO v${state.line.vo} first`);
        const instructions =
          typeof body.instructions === "string" ? body.instructions.trim().slice(0, 2000) : "";
        const base =
          body.version !== undefined && body.version !== null ? versionOf(body) : undefined;
        const draft = readDraft(p.dir);
        if (draft && base !== undefined && draft.base === base)
          throw new Error(
            "save or discard the unsaved changes first — re-suggest keeps saved changes only",
          );
        if (instructions) logInstructions(p.dir, base, instructions);
        deps.notifyAgent(
          base === undefined
            ? `${PANEL_PREFIX} Suggest annotations for project "${p.slug}" (VO v${state.line.vo})${instructions ? ` — the user's instructions: "${instructions}"` : ""}. Use the demo-annotations skill: demo_rec_annotations action=context${instructions ? " with these instructions" : ""}, then action=suggest.`
            : `${PANEL_PREFIX} Re-suggest annotations for project "${p.slug}" on top of v${base}${instructions ? ` — the user's instructions: "${instructions}"` : ""}. Use the demo-annotations skill: demo_rec_annotations action=context base=${base}${instructions ? " with these instructions" : ""}, then action=suggest base=${base}${instructions ? " instructions=…" : ""}. The user's changed items are kept automatically.`,
        );
        deps.publish(
          "annotations.requested",
          {
            message:
              base === undefined
                ? "annotation suggestions requested"
                : `re-suggest on v${base} requested`,
          },
          p.slug,
        );
        return { requested: true, base: base ?? null };
      },
      /** { version, id, kind: still|clip } → media URL (draft-aware, cached). */
      "annotation-preview": (body) => {
        const p = requireProject();
        const file = fileFor(p, body);
        const id = String(body.id ?? "");
        const kind = body.kind === "clip" ? "clip" : "still";
        return queue(async () => {
          const cfg = deps.getConfig();
          const { timeline } = timelineFor(p.dir, file.basedOn.vo);
          const size = kind === "clip" ? CLIP_SIZE : STILL_SIZE;
          const b = await prepareBrand(p.dir, { ...cfg, output: size }, timeline.take, cfg.brand);
          const pv = await previewAnnotation({
            projectDir: p.dir,
            timeline,
            file,
            id,
            brand: b.loaded,
            frame: b.frame,
            fps: cfg.fps,
            output: size,
            cacheDir: path.join(cfg.root, ".cache", "annotation-assets"),
            outDir: path.join(
              p.dir,
              "previews",
              "annotations",
              kind === "clip" ? "clips" : "stills",
            ),
            kind,
          });
          return {
            id,
            kind,
            still: media(p.dir, pv.still),
            ...(pv.clip ? { clip: media(p.dir, pv.clip) } : {}),
            warnings: pv.warnings,
          };
        });
      },
      /** { version, scene } → a low-res draft of the scene with all enabled annotations. */
      "annotations-scene-draft": (body) => {
        const p = requireProject();
        const file = fileFor(p, body);
        const scene = String(body.scene ?? "");
        return queue(async () => {
          const cfg = deps.getConfig();
          const { timeline } = timelineFor(p.dir, file.basedOn.vo);
          const b = await prepareBrand(
            p.dir,
            { ...cfg, output: CLIP_SIZE },
            timeline.take,
            cfg.brand,
          );
          const r = await previewScene({
            projectDir: p.dir,
            timeline,
            file,
            scene,
            brand: b.loaded,
            frame: b.frame,
            fps: cfg.fps,
            output: CLIP_SIZE,
            cacheDir: path.join(cfg.root, ".cache", "annotation-assets"),
            outDir: path.join(p.dir, "previews", "annotations", "scenes"),
          });
          return { scene, file: media(p.dir, r.file), warnings: r.warnings };
        });
      },
    },
  };
}
