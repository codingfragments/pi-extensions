/**
 * demo_rec_annotations — the Annotations stage for the agent (S5 part 8, D52–D57).
 *
 *   context   the designer's input pack for the working line's edit
 *   suggest   submit suggestions → next version (engine resolves, weighs, adds
 *             privacy redactions, pre-enables the recommended set, keeps the
 *             user's changes when `base` is given)
 *   get       a version (or the panel draft) with weights and the budget
 *   write     a full revision (agent edits on request)
 *   import    carry what still matches from an older version (no model)
 *   preview   a clip + still of one annotation
 *
 * There is deliberately NO approve: the user accepts annotations in the panel.
 */

import fs from "node:fs";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { annotationContext } from "../annotations/context.ts";
import {
  type DesignReport,
  type Suggestion,
  formatDesignReport,
  formatImportReport,
  importAnnotations,
  suggestAnnotations,
} from "../annotations/design.ts";
import { readDraft } from "../annotations/draft.ts";
import { annotationVersions, readAnnotations, writeAnnotations } from "../annotations/file.ts";
import { previewAnnotation } from "../annotations/preview.ts";
import { toSuggestion } from "../annotations/suggestion.ts";
import {
  ANNOTATION_TYPES,
  type AnnotationFile,
  type AnnotationItem,
  type AnnotationTarget,
} from "../annotations/types.ts";
import { budgetOf, formatBudget } from "../annotations/weights.ts";
import { prepareBrand } from "../edit/pipeline.ts";
import type { Timeline } from "../edit/timeline.ts";
import type { Runtime } from "../runtime.ts";
import { recordInput } from "../workdir/inputs.ts";
import { readState } from "../workdir/state.ts";
import { listVersions } from "../workdir/versioning.ts";
import { result } from "./common.ts";

/** The latest edit timeline of a voice-over version (or of the working line's VO). */
export function timelineFor(
  projectDir: string,
  voVersion?: number,
): { version: number; timeline: Timeline } {
  const state = readState(projectDir);
  const vo = voVersion ?? state?.line.vo;
  const dir = path.join(projectDir, "edit");
  const versions = listVersions(dir, "timeline.v", ".json").reverse();
  for (const v of versions) {
    const t = JSON.parse(
      fs.readFileSync(path.join(dir, `timeline.v${v}.json`), "utf8"),
    ) as Timeline;
    if (vo === undefined || t.voVersion === vo) return { version: v, timeline: t };
  }
  throw new Error(
    vo === undefined
      ? "no edit yet — run the sync edit (demo_rec_edit) first"
      : `no edit for VO v${vo} yet — run demo_rec_edit first`,
  );
}

/** Compact listing of a version for the agent. */
export function formatAnnotations(f: AnnotationFile, title = `Annotations v${f.version}`): string {
  const b = budgetOf(f.items, f.budget?.optimumNoise ?? 0);
  const lines = [
    `${title} (take ${f.take}, VO v${f.basedOn.vo}${f.by ? `, by ${f.by}` : ""}) — ${formatBudget(b)}`,
  ];
  for (const it of f.items) {
    const a = it.anchor;
    const when =
      "mark" in a
        ? `@${a.mark}`
        : "word" in a
          ? `"${a.word}"${a.occurrence ? `#${a.occurrence}` : ""}`
          : "scene start";
    const off = a.offsetMs ? `${a.offsetMs > 0 ? "+" : ""}${a.offsetMs}ms` : "";
    lines.push(
      `- [${it.enabled ? "x" : " "}] ${it.id} ${it.type} ${it.scene} ${when}${off}${it.target ? ` → ${JSON.stringify(it.target)}` : ""}${it.text ? ` "${it.text}"` : ""}` +
        `${it.weight ? ` (value ${it.weight.value}, noise ${it.weight.noise})` : ""}${it.origin && it.origin !== "suggested" ? ` [${it.origin}]` : ""}${it.edits?.length ? ` [${it.edits.length} user edit(s)]` : ""}${it.reason ? ` — ${it.reason}` : ""}`,
    );
  }
  return lines.join("\n");
}

const AnchorSchema = Type.Object(
  {
    mark: Type.Optional(Type.String({ description: "storyboard mark of the scene" })),
    sceneStart: Type.Optional(Type.Boolean()),
    word: Type.Optional(
      Type.String({ description: "a word or short phrase of the scene's narration" }),
    ),
    occurrence: Type.Optional(
      Type.Number({ description: "n-th occurrence of the word (default 1)" }),
    ),
    offsetMs: Type.Optional(
      Type.Number({ description: "shift (ms), e.g. 1200 = a beat after the mark" }),
    ),
  },
  { description: "When: exactly one of mark / sceneStart / word" },
);
const TargetSchema = Type.Object(
  {
    step: Type.Optional(
      Type.Number({ description: "index of the scene step whose element to use" }),
    ),
    text: Type.Optional(
      Type.String({ description: "visible text of the element (smallest match wins)" }),
    ),
    role: Type.Optional(
      Type.String({ description: "narrows a text target: row, cell, button, heading, …" }),
    ),
    layout: Type.Optional(
      Type.String({ description: 'element ref from the input pack, e.g. "t13107#e24"' }),
    ),
    box: Type.Optional(
      Type.Object(
        { x: Type.Number(), y: Type.Number(), w: Type.Number(), h: Type.Number() },
        { description: "CSS px" },
      ),
    ),
  },
  {
    description:
      "Where (zoom/highlight/spotlight/redact): exactly one of step / text(+role) / layout / box",
  },
);
const SuggestionSchema = Type.Object({
  id: Type.Optional(Type.String()),
  type: StringEnum(ANNOTATION_TYPES),
  scene: Type.String(),
  anchor: AnchorSchema,
  target: Type.Optional(TargetSchema),
  alternatives: Type.Optional(
    Type.Array(TargetSchema, { description: "other plausible targets, offered to the user" }),
  ),
  text: Type.Optional(
    Type.String({
      description:
        "callout/chapter text, ≤ 60 chars; names WHAT to look at, never repeats the narration",
    }),
  ),
  durMs: Type.Optional(Type.Number()),
  factor: Type.Optional(Type.Number({ description: "zoom 1.1–1.8 (default 1.5)" })),
  value: Type.Number({ description: "1–5: how much it helps the viewer" }),
  reason: Type.String({ description: "one line: why" }),
  confidence: Type.Optional(
    Type.Object(
      { score: Type.Number({ description: "1–5" }), why: Type.Optional(Type.String()) },
      {
        description:
          "only when you doubt this item (wrong element? wording?): 1–2 = needs the user's eyes",
      },
    ),
  ),
});

export { toSuggestion };

/** The `annotations.updated` event of a suggestion run (tool, or the separate designer). */
export function publishSuggested(
  rt: Runtime,
  slug: string,
  r: DesignReport,
  o: { base?: number; instructions?: string },
  by: string,
  extra: Record<string, unknown> = {},
): void {
  rt.bus.publish(
    "annotations.updated",
    {
      version: r.version,
      by,
      message: `annotations v${r.version} suggested · ${r.added} placed, ${r.enabled} on${r.kept.length ? `, ${r.kept.length} kept` : ""}${r.dropped.length ? `, ${r.dropped.length} not placed` : ""}`,
      placed: r.added,
      enabled: r.enabled,
      kept: r.kept,
      dropped: r.dropped,
      privacy: r.privacy,
      budget: r.budget,
      ...(o.base !== undefined ? { base: o.base } : {}),
      ...(o.instructions ? { instructions: o.instructions } : {}),
      ...(r.warnings.length ? { warnings: r.warnings } : {}),
      ...extra,
    },
    slug,
  );
}

/** Suggestion run (used by the tool and the panel's tests). */
export function runSuggest(
  rt: Runtime,
  o: { suggestions: Suggestion[]; base?: number; instructions?: string },
): string {
  const p = rt.requireProject();
  const { timeline } = timelineFor(p.dir);
  const r = suggestAnnotations({
    projectDir: p.dir,
    timeline,
    suggestions: o.suggestions,
    ...(o.base !== undefined ? { base: o.base } : {}),
    ...(o.instructions ? { instructions: o.instructions } : {}),
  });
  publishSuggested(rt, p.slug, r, o, "agent");
  return formatDesignReport(r);
}

export function registerAnnotationsTool(pi: ExtensionAPI, rt: Runtime): void {
  pi.registerTool({
    name: "demo_rec_annotations",
    label: "Demo annotations",
    description:
      "Annotations stage (see the demo-annotations skill). context: the input pack for the working line's edit (scenes, marks, narration, emphasis, " +
      "on-screen elements with refs, privacy hits, caps) — read it before suggesting. suggest: submit ~2× as many suggestions as should be on " +
      "(type, scene, anchor, target, text, value 1–5, reason); the engine resolves them, adds privacy redactions, weighs, pre-enables the best half " +
      "and writes the next version; unplaceable ones come back with reasons — fix and resubmit. With base=N (re-suggest) the user's changed items " +
      "are kept. get: a version (or draft=true for the panel's unsaved edits). write: a full revision as JSON (only when the user asks for specific " +
      "changes). import: carry what still matches from an older version. preview: a clip + still of one annotation. The user accepts annotations in the panel; you cannot.",
    parameters: Type.Object({
      action: StringEnum(["context", "suggest", "get", "write", "import", "preview"] as const),
      suggestions: Type.Optional(Type.Array(SuggestionSchema)),
      base: Type.Optional(
        Type.Number({
          description: "suggest: re-suggest on top of this version (keeps the user's changes)",
        }),
      ),
      instructions: Type.Optional(
        Type.String({ description: "context/suggest: the user's extra instructions, verbatim" }),
      ),
      version: Type.Optional(Type.Number({ description: "get/preview: version (default latest)" })),
      draft: Type.Optional(Type.Boolean({ description: "get: the panel's unsaved draft" })),
      json: Type.Optional(
        Type.String({
          description: "write: the complete annotation file as JSON (items with ids)",
        }),
      ),
      from: Type.Optional(Type.Number({ description: "import: source version" })),
      id: Type.Optional(Type.String({ description: "preview: annotation id" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      rt.bindUi(ctx?.ui);
      const p = rt.requireProject();
      switch (params.action) {
        case "context": {
          const { version, timeline } = timelineFor(p.dir);
          return result(
            annotationContext({
              projectDir: p.dir,
              timeline,
              timelineVersion: version,
              ...(params.base !== undefined ? { base: params.base } : {}),
              ...(params.instructions ? { instructions: params.instructions } : {}),
            }),
          );
        }
        case "suggest": {
          if (!params.suggestions?.length)
            throw new Error("suggest needs suggestions — read action=context first");
          const text = runSuggest(rt, {
            suggestions: params.suggestions.map((s) => toSuggestion(s as Record<string, unknown>)),
            ...(params.base !== undefined ? { base: params.base } : {}),
            ...(params.instructions ? { instructions: params.instructions } : {}),
          });
          return result(
            `${text}\nThe user reviews them in the panel's Annotations tab (toggles, text, nudges) and accepts there.`,
          );
        }
        case "get": {
          if (params.draft) {
            const d = readDraft(p.dir);
            return result(
              d
                ? formatAnnotations(d.file, `Unsaved draft on v${d.base} (${d.changes} change(s))`)
                : "no unsaved draft",
            );
          }
          const f = readAnnotations(p.dir, params.version);
          return result(
            f ? formatAnnotations(f) : "no annotations yet — read action=context and suggest",
          );
        }
        case "write": {
          if (!params.json) throw new Error("write needs json (the complete file)");
          const raw = JSON.parse(params.json) as Omit<AnnotationFile, "version">;
          const stored = writeAnnotations(p.dir, { ...raw, by: raw.by ?? "agent" });
          rt.bus.publish(
            "annotations.updated",
            {
              version: stored.version,
              by: "agent",
              message: `annotations v${stored.version} written by the agent · ${stored.items.length} item(s), ${stored.items.filter((x) => x.enabled).length} on`,
              items: stored.items.map(
                (x) => `${x.enabled ? "[x]" : "[ ]"} ${x.id} ${x.type} ${x.scene}`,
              ),
            },
            p.slug,
          );
          return result(formatAnnotations(stored));
        }
        case "import": {
          if (params.from === undefined)
            throw new Error(
              `import needs from (versions: ${annotationVersions(p.dir).join(", ") || "none"})`,
            );
          const { timeline } = timelineFor(p.dir);
          const r = importAnnotations({ projectDir: p.dir, timeline, from: params.from });
          rt.bus.publish(
            "annotations.updated",
            {
              version: r.version,
              by: "agent",
              message: `annotations v${r.version} imported from v${params.from} · ${r.carried.length} carried${r.notCarried.length ? `, ${r.notCarried.length} not` : ""}`,
              from: params.from,
              carried: r.carried,
              notCarried: r.notCarried,
            },
            p.slug,
          );
          return result(formatImportReport(r));
        }
        case "preview": {
          if (!params.id) throw new Error("preview needs id");
          const file = readAnnotations(p.dir, params.version);
          if (!file) throw new Error("no annotations yet");
          const { timeline } = timelineFor(p.dir, file.basedOn.vo);
          const cfg = rt.getConfig();
          const b = await prepareBrand(p.dir, cfg, timeline.take, cfg.brand);
          const pv = await previewAnnotation({
            projectDir: p.dir,
            timeline,
            file,
            id: params.id,
            brand: b.loaded,
            frame: b.frame,
            fps: cfg.fps,
            output: b.size,
            cacheDir: path.join(cfg.root, ".cache", "annotation-assets"),
            outDir: path.join(p.dir, "previews", "annotations"),
          });
          const img = fs.readFileSync(pv.still).toString("base64");
          return result(
            [
              { type: "image", data: img, mimeType: "image/png" },
              {
                type: "text",
                text: `clip: ${pv.clip}\nstill: ${pv.still}${pv.warnings.length ? `\n! ${pv.warnings.join("\n! ")}` : ""}`,
              },
            ],
            { clip: pv.clip, still: pv.still },
          );
        }
      }
    },
  });
}

/** Log the user's re-suggest instructions as a project input (D42). */
export function logInstructions(projectDir: string, base: number | undefined, text: string): void {
  recordInput(projectDir, {
    stage: "annotations",
    ...(base !== undefined ? { version: base } : {}),
    source: "panel",
    kind: "direction",
    text,
  });
}
