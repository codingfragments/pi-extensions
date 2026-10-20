/**
 * Panel routes for the Annotations tab (S5 part 8, D53–D58): the version or
 * draft with resolved timing and the budget, draft edits, save/discard,
 * re-suggest with instructions (→ the agent), card previews (still eager,
 * clip on click) and a low-res scene draft.
 */

import path from "node:path";
import { resolveContext } from "../annotations/apply.ts";
import { type DraftOp, canReset } from "../annotations/draft.ts";
import { annotationVersions, readAnnotations } from "../annotations/file.ts";
import { previewAnnotation, previewScene } from "../annotations/preview.ts";
import { resolveAnnotations } from "../annotations/resolve.ts";
import type { AnnotationFile } from "../annotations/types.ts";
import { budgetOf } from "../annotations/weights.ts";
import { zoomLimitsOf, zoomUse } from "../annotations/zoom-limits.ts";
import { annotationBase, annotationConfidence } from "../confidence/annotations.ts";
import type { DemoRecConfig } from "../config.ts";
import {
  type AnnotationWorkingDraft,
  annotationDraftFlags,
  discardAnnotationDraft,
  editAnnotationDraft,
  listAnnotationDrafts,
  preferredAnnotationDraft,
  readAnnotationDraft,
  saveAnnotationDraftAsVersion,
} from "../drafts/annotations.ts";
import { DraftConflict } from "../drafts/store.ts";
import { prepareBrand } from "../edit/pipeline.ts";
import type { Timeline } from "../edit/timeline.ts";
import { PANEL_PREFIX } from "../roles.ts";
import { logInstructions, timelineFor, zoomGuardFor } from "../tools/annotations.ts";
import { recordInput } from "../workdir/inputs.ts";
import type { ProjectHandle } from "../workdir/layout.ts";
import { isAccepted } from "../workdir/stages.ts";
import { readState } from "../workdir/state.ts";
import type { GetRoute, PostRoute } from "./server.ts";

export interface AnnotationRouteDeps {
  activeProject: () => ProjectHandle | undefined;
  getConfig: () => DemoRecConfig;
  notifyAgent: (text: string) => void;
  publish: (type: string, data: Record<string, unknown>, project?: string) => void;
  /**
   * Run the Annotation designer as a separate model call (S5 part 12), when its role has a model.
   * Returns true when the run started; `onFallback` hands over to the agent when it can't deliver.
   */
  designer?: (o: {
    base?: number;
    instructions?: string;
    onFallback: (errors: string[]) => void;
  }) => boolean;
}

/** Stills and clips at 960×540 (cards and the large preview popup); scene drafts at 640×360 (inline). */
export const STILL_SIZE = { width: 960, height: 540 };
export const CLIP_SIZE = { width: 960, height: 540 };
export const SCENE_DRAFT_SIZE = { width: 640, height: 360 };

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

/** The ids of the annotations in a draft that differ from its base version. */
function draftChangedIds(projectDir: string, d: AnnotationWorkingDraft): string[] {
  const base = readAnnotations(projectDir, d.base);
  const was = new Map((base?.items ?? []).map((x) => [x.id, JSON.stringify(x)]));
  return d.file.items.filter((x) => was.get(x.id) !== JSON.stringify(x)).map((x) => x.id);
}

/** The tab's view of a version (or of the draft on top of it). */
export function annotationsView(p: ProjectHandle, cfg: DemoRecConfig, requested?: number) {
  const versions = annotationVersions(p.dir);
  const state = readState(p.dir) ?? p.state;
  const drafts = listAnnotationDrafts(p.dir);
  const lineTimeline = safeTimeline(p.dir, state.line.vo as number);
  const base = {
    project: p.slug,
    versions,
    autoSuggest: cfg.annotations.autoSuggest,
    canSuggest: state.line.vo !== undefined && !!lineTimeline,
    lineVo: state.line.vo ?? null,
  };
  const v =
    requested ??
    state.line.annotations ??
    preferredAnnotationDraft(p.dir, undefined)?.base ??
    versions.at(-1);
  if (v === undefined || !versions.includes(v))
    return { ...base, version: null, file: null, draft: null, otherDrafts: [] };
  const draft: AnnotationWorkingDraft | undefined = drafts.find((d) => d.base === v);
  const file = (draft ? draft.file : readAnnotations(p.dir, v)) as AnnotationFile;
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
    draft: draft
      ? {
          base: draft.base,
          changes: draft.changes,
          updatedAt: draft.updatedAt,
          revision: draft.revision,
          author: draft.author,
          flags: annotationDraftFlags(p.dir, draft),
          /** The annotations that differ from the base version: what a discard would lose. */
          changedIds: draftChangedIds(p.dir, draft),
        }
      : null,
    /** Drafts on other versions: they are kept, and never replaced by editing this one. */
    otherDrafts: drafts
      .filter((d) => d.base !== v)
      .map((d) => ({ base: d.base, changes: d.changes })),
    /** Which items can go back to how the designer suggested them. */
    resettable: file.items.filter(canReset).map((x) => x.id),
    file,
    resolved,
    scenes,
    timelineVersion: t?.version ?? null,
    budget: budgetOf(file.items, file.budget?.optimumNoise ?? 0),
    /** How many zooms are on, against the limit for this demo (annotations.zoomsPerMinute / zoomsPerScene). */
    zooms: zoomUse(file.items, zoomLimitsOf(cfg), t?.timeline.totals.fullMs),
    confidence: annotationConfidence(file, resolved, baseOf(p.dir, file, versions)),
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
    const d = readAnnotationDraft(p.dir, v);
    if (d?.changes) return d.file;
    const f = readAnnotations(p.dir, v);
    if (!f) throw new Error(`annotations v${v} do not exist`);
    return f;
  };
  const versionOf = (body: Record<string, unknown>) => {
    const v = Number(body.version);
    if (!Number.isInteger(v) || v < 1) throw new Error('"version" is required');
    return v;
  };
  const changed = (
    p: ProjectHandle,
    message: string,
    version?: number,
    extra: Record<string, unknown> = {},
  ) =>
    deps.publish(
      "annotations.updated",
      { ...(version ? { version } : {}), by: "user", message, ...extra },
      p.slug,
    );
  /** "toggle co-kpi → on", "text co-kpi edited", "nudge zoom-emea start +0.5 s": never the text itself (D121). */
  const describeOp = (op: DraftOp, after?: { enabled?: boolean }) =>
    op.op === "toggle"
      ? `toggle ${op.id} → ${after?.enabled ? "on" : "off"}`
      : op.op === "text"
        ? `text ${op.id} edited`
        : op.op === "nudge"
          ? `nudge ${op.id} ${op.field} ${op.deltaMs > 0 ? "+" : ""}${(op.deltaMs / 1000).toFixed(1)} s`
          : op.op === "reset"
            ? `reset ${op.id} to suggested`
            : `target ${op.id} → alternative ${op.alternative + 1}`;
  /** The revision the caller last saw: required (null = "I have no draft"), so nothing is overwritten silently. */
  const revisionOf = (body: Record<string, unknown>): number | null => {
    if (!("revision" in body))
      throw new Error('"revision" is required: the draft revision you last saw, or null for none');
    const r = body.revision;
    if (r === null || r === 0) return null;
    if (typeof r !== "number" || !Number.isInteger(r) || r < 1)
      throw new Error('"revision" must be the revision you last saw, or null for none');
    return r;
  };
  const authorOf = (body: Record<string, unknown>) =>
    typeof body.author === "string" && body.author ? body.author.slice(0, 80) : "panel";
  /** A rejected write is data, not an error: the view as the server has it, and why. */
  const conflicted = (
    p: ProjectHandle,
    version: number,
    err: DraftConflict<AnnotationWorkingDraft>,
  ) => ({
    ...annotationsView(p, deps.getConfig(), version),
    saved: false,
    conflict: true,
    message: err.message,
  });

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
      /**
       * A draft edit: { version, revision, author?, op: toggle|text|nudge|target|reset, id, … }.
       * Answers with the view; `saved: false, conflict: true` when the revision is stale (nothing written).
       */
      "annotations-edit": (body) => {
        const p = requireProject();
        const version = versionOf(body);
        const expected = revisionOf(body);
        const author = authorOf(body);
        const op = { ...(body as Record<string, unknown>) } as unknown as DraftOp & {
          version?: number;
          revision?: number | null;
          author?: string;
        };
        for (const k of ["version", "revision", "author"]) Reflect.deleteProperty(op, k);
        try {
          const vo = readAnnotations(p.dir, version)?.basedOn.vo;
          const guard = vo === undefined ? undefined : zoomGuardFor(deps.getConfig(), p.dir, vo);
          const d = editAnnotationDraft(
            p.dir,
            version,
            op,
            { expected, author },
            new Date(),
            guard,
          );
          if (d) {
            const item = d.file.items.find((x) => x.id === op.id);
            const what = describeOp(op, item);
            changed(p, `draft on v${version}: ${what} (${d.changes} unsaved)`, undefined, {
              draftOf: version,
              revision: d.revision,
              change: what,
              unsaved: d.changes,
              author,
              ...(item
                ? {
                    item: {
                      id: item.id,
                      type: item.type,
                      scene: item.scene,
                      enabled: item.enabled,
                    },
                  }
                : {}),
            });
          }
          return { ...annotationsView(p, deps.getConfig(), version), saved: true };
        } catch (err) {
          if (err instanceof DraftConflict) return conflicted(p, version, err);
          throw err;
        }
      },
      /** Save new version: { version (the base), revision } → exactly one version, once per revision. */
      "annotations-save": (body) => {
        const p = requireProject();
        const base = versionOf(body);
        try {
          const r = saveAnnotationDraftAsVersion(p.dir, base, revisionOf(body));
          if (!r.repeated) {
            recordInput(p.dir, {
              stage: "annotations",
              version: r.version,
              source: "panel",
              kind: "review",
              text: `annotation edits on v${base}: ${r.changes} change(s) saved as v${r.version}`,
            });
            changed(
              p,
              `annotations v${r.version} saved from the panel (${r.changes} change(s) on v${base})`,
              r.version,
              { editedFrom: base, changes: r.changes, edited: r.edited },
            );
          }
          return {
            ...annotationsView(p, deps.getConfig(), r.version),
            saved: true,
            repeated: r.repeated,
          };
        } catch (err) {
          if (err instanceof DraftConflict) return conflicted(p, base, err);
          throw err;
        }
      },
      /** { version (the base), revision } → drops that draft and says what was lost. */
      "annotations-discard": (body) => {
        const p = requireProject();
        const base = versionOf(body);
        try {
          const gone = discardAnnotationDraft(p.dir, base, revisionOf(body));
          if (gone)
            changed(
              p,
              `annotation draft on v${base} discarded (${gone.changes} change(s))`,
              undefined,
              { draftOf: base, changes: gone.changes },
            );
          return { ...annotationsView(p, deps.getConfig(), base), discarded: gone };
        } catch (err) {
          if (err instanceof DraftConflict) return { ...conflicted(p, base, err), discarded: null };
          throw err;
        }
      },
      /** Ask the agent to (re-)suggest, with the user's instructions (D53, D56). */
      "annotations-resuggest": (body) => {
        const p = requireProject();
        const state = readState(p.dir) ?? p.state;
        if (state.line.vo === undefined)
          throw new Error("approve a voice-over first — annotations follow the narration");
        if (!safeTimeline(p.dir, state.line.vo))
          throw new Error(`run the sync edit for VO v${state.line.vo} first`);
        const instructions =
          typeof body.instructions === "string" ? body.instructions.trim().slice(0, 2000) : "";
        const base =
          body.version !== undefined && body.version !== null ? versionOf(body) : undefined;
        const draft = base !== undefined ? readAnnotationDraft(p.dir, base) : undefined;
        if (draft?.changes)
          throw new Error(
            "save or discard the unsaved changes first — re-suggest keeps saved changes only",
          );
        if (instructions) logInstructions(p.dir, base, instructions);
        const ask =
          base === undefined
            ? `${PANEL_PREFIX} Suggest annotations for project "${p.slug}" (VO v${state.line.vo})${instructions ? ` — the user's instructions: "${instructions}"` : ""}. Use the demo-annotations skill: demo_rec_annotations action=context${instructions ? " with these instructions" : ""}, then action=suggest.`
            : `${PANEL_PREFIX} Re-suggest annotations for project "${p.slug}" on top of v${base}${instructions ? ` — the user's instructions: "${instructions}"` : ""}. Use the demo-annotations skill: demo_rec_annotations action=context base=${base}${instructions ? " with these instructions" : ""}, then action=suggest base=${base}${instructions ? " instructions=…" : ""}. The user's changed items are kept automatically.`;
        // D85–D90: the separate Annotation designer when its role has a model; the agent otherwise (or when it fails).
        const separate = deps.designer?.({
          ...(base !== undefined ? { base } : {}),
          ...(instructions ? { instructions } : {}),
          onFallback: (errors) =>
            deps.notifyAgent(
              `(The separate Annotation designer couldn't do it: ${errors.join("; ")}.) ${ask}`,
            ),
        });
        if (!separate) deps.notifyAgent(ask);
        deps.publish(
          "annotations.requested",
          {
            message:
              base === undefined
                ? `annotation suggestions requested${instructions ? " (with instructions)" : ""}`
                : `re-suggest on v${base} requested${instructions ? " (with instructions)" : ""}`,
            ...(base !== undefined ? { base } : {}),
            voVersion: state.line.vo,
            by: separate ? "separate designer run" : "agent",
            ...(instructions ? { instructions } : {}),
          },
          p.slug,
        );
        return { requested: true, base: base ?? null, separate: !!separate };
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
            { ...cfg, output: SCENE_DRAFT_SIZE },
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
            output: SCENE_DRAFT_SIZE,
            cacheDir: path.join(cfg.root, ".cache", "annotation-assets"),
            outDir: path.join(p.dir, "previews", "annotations", "scenes"),
          });
          return { scene, file: media(p.dir, r.file), warnings: r.warnings };
        });
      },
    },
  };
}

/** D78 "new vs base": the edit/re-suggest/import base, else the previous version for the same VO. */
function baseOf(dir: string, file: AnnotationFile, versions: number[]) {
  const b = annotationBase(file, versions);
  if (b === undefined) return undefined;
  try {
    const bf = readAnnotations(dir, b);
    if (!bf) return undefined;
    const related = file.editedFrom ?? file.resuggestedFrom ?? file.importedFrom;
    if (related === undefined && bf.basedOn.vo !== file.basedOn.vo) return undefined;
    return { version: b, ids: bf.items.map((x) => x.id) };
  } catch {
    return undefined;
  }
}
