/**
 * Working drafts (UX5a, D115, D121): the user's unsaved edits, kept in the project and private until
 * saved. Every route is cost class `none`: nothing here starts a model, TTS or render job, tells the
 * Director, or changes approval or the production line.
 *
 *   GET  /api/drafts?stage=vo                 drafts with changes, and what changed under each
 *   GET  /api/draft?stage=vo&base=N           one draft, its sections next to the base (and the newest version)
 *   POST /api/draft-save    { stage, base, revision, edits, author }   autosave; a stale revision is rejected
 *   POST /api/draft-discard { stage, base, revision }                  drop it, naming what is lost
 *   POST /api/draft-version { stage, base, revision }                  Save new version: exactly one version
 *
 * A rejected write is not an error: it answers `{ conflict: true, current }` with the draft as it is now.
 * Events carry the stage, base, revision and count of changes, never the text.
 */

import {
  DraftConflict,
  type DraftStage,
  type WorkingDraft,
  discardDraft,
  draftFlags,
  draftSections,
  isDraftStage,
  listDrafts,
  readDraft,
  saveDraft,
  saveDraftAsVersion,
  summarize,
} from "../drafts/store.ts";
import { capText } from "../util/events.ts";
import { recordInput } from "../workdir/inputs.ts";
import type { ProjectHandle } from "../workdir/layout.ts";
import type { GetRoute, PostRoute } from "./server.ts";

export interface DraftRouteDeps {
  activeProject: () => ProjectHandle | undefined;
  publish: (type: string, data: Record<string, unknown>, project?: string) => void;
}

function stageOf(source: URLSearchParams | Record<string, unknown>): DraftStage {
  const raw = source instanceof URLSearchParams ? source.get("stage") : source.stage;
  if (!isDraftStage(raw))
    throw new Error('"stage" must be "vo": only the voice-over is edited inline');
  return raw;
}

function baseOf(source: URLSearchParams | Record<string, unknown>): number {
  const raw = source instanceof URLSearchParams ? Number(source.get("base")) : source.base;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1)
    throw new Error('"base" must be a version number');
  return raw;
}

function revisionOf(body: Record<string, unknown>): number | null {
  const r = body.revision;
  if (r === null || r === undefined || r === 0) return null;
  if (typeof r !== "number" || !Number.isInteger(r) || r < 1)
    throw new Error('"revision" must be the revision you last saw, or null for none');
  return r;
}

function view(dir: string, d: WorkingDraft) {
  return {
    draft: summarize(d),
    edits: d.edits,
    flags: draftFlags(dir, d),
    sections: draftSections(dir, d),
  };
}

export function draftRoutes(deps: DraftRouteDeps): {
  get: Record<string, GetRoute>;
  post: Record<string, PostRoute>;
} {
  const project = () => {
    const p = deps.activeProject();
    if (!p) throw new Error("no active project");
    return p;
  };
  const conflict = (dir: string, err: DraftConflict) => ({
    conflict: true,
    message: err.message,
    current: err.current ? view(dir, err.current) : null,
  });
  return {
    get: {
      drafts: (q) => {
        const p = deps.activeProject();
        if (!p) return { project: null, drafts: [] };
        return { project: p.slug, drafts: listDrafts(p.dir, stageOf(q)) };
      },
      draft: (q) => {
        const p = project();
        const stage = stageOf(q);
        const d = readDraft(p.dir, stage, baseOf(q));
        return d && Object.keys(d.edits).length
          ? view(p.dir, d)
          : { draft: null, revision: d?.revision ?? null };
      },
    },
    post: {
      "draft-save": (body) => {
        const p = project();
        const stage = stageOf(body);
        const base = baseOf(body);
        const edits = body.edits;
        if (!edits || typeof edits !== "object" || Array.isArray(edits))
          throw new Error('"edits" must map a section to its new text (or null to drop the edit)');
        const author =
          typeof body.author === "string" && body.author ? body.author.slice(0, 80) : "panel";
        try {
          const d = saveDraft(p.dir, stage, base, {
            expected: revisionOf(body),
            edits: edits as Record<string, string | null>,
            author,
          });
          deps.publish(
            "draft.changed",
            {
              stage,
              base,
              revision: d.revision,
              changes: Object.keys(d.edits).length,
              author,
              message: `draft on ${stage} v${base}: ${Object.keys(d.edits).length} section(s) changed (revision ${d.revision})`,
            },
            p.slug,
          );
          return { saved: true, ...view(p.dir, d) };
        } catch (err) {
          if (err instanceof DraftConflict) return { saved: false, ...conflict(p.dir, err) };
          throw err;
        }
      },
      "draft-discard": (body) => {
        const p = project();
        const stage = stageOf(body);
        const base = baseOf(body);
        try {
          const gone = discardDraft(p.dir, stage, base, revisionOf(body));
          if (gone)
            deps.publish(
              "draft.changed",
              {
                stage,
                base,
                revision: gone.revision,
                changes: 0,
                discarded: true,
                message: `draft on ${stage} v${base} discarded (${gone.changes} section(s))`,
              },
              p.slug,
            );
          return { discarded: gone };
        } catch (err) {
          if (err instanceof DraftConflict) return { discarded: null, ...conflict(p.dir, err) };
          throw err;
        }
      },
      "draft-version": (body) => {
        const p = project();
        const stage = stageOf(body);
        const base = baseOf(body);
        const edits = readDraft(p.dir, stage, base)?.edits ?? {};
        try {
          const saved = saveDraftAsVersion(p.dir, stage, base, revisionOf(body));
          if (!saved.repeated) {
            const text = Object.entries(edits)
              .map(([k, v]) => `${k}: ${capText(v)}`)
              .join(" | ");
            recordInput(p.dir, {
              stage: "vo",
              version: saved.version,
              source: "panel",
              kind: "review",
              text: `edited ${saved.sections.join(", ")} (v${base} → v${saved.version}): ${text.length > 300 ? `${text.slice(0, 300)}…` : text}`,
              refs: [`vo/script.v${saved.version}.md`],
            });
            deps.publish(
              "vo.written",
              {
                version: saved.version,
                message: `voice-over v${saved.version} (saved from a draft on v${base}: ${saved.sections.join(", ")})`,
                by: "user",
                from: base,
              },
              p.slug,
            );
            deps.publish(
              "draft.changed",
              {
                stage,
                base,
                changes: 0,
                saved: saved.version,
                message: `draft on ${stage} v${base} saved as v${saved.version}`,
              },
              p.slug,
            );
          }
          return { saved: true, ...saved };
        } catch (err) {
          if (err instanceof DraftConflict) return { saved: false, ...conflict(p.dir, err) };
          throw err;
        }
      },
    },
  };
}
