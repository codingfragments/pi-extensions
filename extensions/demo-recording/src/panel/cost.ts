/**
 * Cost classes and the estimate route (S5 part 13, D91–D95).
 *
 * Every panel POST route has a cost class — what it may start:
 *   none      only state or a note
 *   local     a local job (ffmpeg, previews): no model, no money
 *   turn      an agent turn on the session model (cost: not estimable)
 *   tts       text-to-speech: bills characters / credits
 *   take      a recording: the improvise model per `improvise` step + minutes of recording
 *   designer  a separate Annotation designer run: one big input pack
 *
 * Blocking ("ask first") are tts, take and designer; a turn only gets a visible hint (D91).
 * A test fails for a route that isn't in the table (and for a table entry without a route).
 * `POST /api/estimate {action, …}` is a free dry run: what would run, with exact numbers
 * where they are known (D92). The routes themselves keep their API (D94).
 */

import { annotationContext } from "../annotations/context.ts";
import { improviseModelStatus, roleModelStatus } from "../models.ts";
import type { Runtime } from "../runtime.ts";
import { readStoryboard } from "../storyboard/store.ts";
import { timelineFor } from "../tools/annotations.ts";
import { designerAvailable } from "../tools/designer.ts";
import { listTakes } from "../tools/take.ts";
import { formatEstimate, voiceEstimate } from "../tts/estimate.ts";
import { readState } from "../workdir/state.ts";
import type { PostRoute } from "./server.ts";

export type CostClass = "none" | "local" | "turn" | "tts" | "take" | "designer";

export const ROUTE_COST: Record<string, CostClass[]> = {
  "annotation-preview": ["local"],
  "annotations-discard": ["none"],
  "annotations-edit": ["none"],
  "annotations-empty": ["none"],
  // a separate designer run when its role has a model, else an agent turn
  "annotations-resuggest": ["turn", "designer"],
  "annotations-save": ["none"],
  "annotations-scene-draft": ["local"],
  approve: ["turn"],
  "brand-duplicate": ["none"],
  "brand-preview": ["local"],
  "brand-save": ["none"],
  "brand-use": ["none"],
  "config-open": ["none"],
  "config-reload": ["none"],
  "config-set": ["none"],
  estimate: ["none"],
  "export-render": ["local"],
  // asks the Director to draft the brief with the user: an agent turn
  "brief-draft": ["turn"],
  "finding-mark": ["none"],
  "input-mark": ["none"],
  "project-facts": ["none"],
  render: ["local"],
  "render-cancel": ["none"],
  "render-delete": ["none"],
  "render-open": ["none"],
  "render-qa-confirm": ["none"],
  "render-qa-fix": ["local"],
  "render-qa-run": ["local"],
  "render-zip": ["local"],
  // the Director records it (an agent turn) and the improvise model types the live inputs
  rerecord: ["turn", "take"],
  review: ["none"],
  "review-approve-high": ["none"],
  "review-note": ["none"],
  "review-submit": ["turn"],
  select: ["none"],
  unaccept: ["none"],
  "unaccept-preview": ["none"],
  // working drafts (UX5a): saving or discarding a draft never starts a job or tells the Director
  "draft-discard": ["none"],
  "draft-save": ["none"],
  "draft-version": ["none"],
  // approve & use starts an agent turn; approve only, use and withdraw leave a quiet note
  "version-act": ["turn"],
  "version-plan": ["none"],
  "vo-direction": ["turn"],
  "vo-edit": ["none"],
  "vo-generate": ["tts"],
};

/** Classes that block with an "ask first" dialog (D91); a turn only gets a hint. */
export const BLOCKING: readonly CostClass[] = ["tts", "take", "designer"];
/** Blocking classes the user may switch off for the session (D95). TTS bills directly: never. */
export const SKIPPABLE: readonly CostClass[] = ["take", "designer"];

export interface CostEstimate {
  action: string;
  /** The classes in effect (a re-suggest is "designer" or "turn" depending on the config). */
  classes: CostClass[];
  blocking: boolean;
  skippable: boolean;
  title: string;
  confirmLabel: string;
  /** One line: what will run. */
  what: string;
  facts: [string, string][];
  warnings: string[];
}

const secs = (ms: number) => `${Math.round(ms / 1000)} s`;
const sessionName = (rt: Runtime) => rt.sessionModel ?? "the session model";

function base(
  action: string,
  classes: CostClass[],
  o: Partial<CostEstimate> & { what: string },
): CostEstimate {
  return {
    action,
    classes,
    blocking: classes.some((c) => BLOCKING.includes(c)),
    skippable:
      classes.some((c) => BLOCKING.includes(c)) &&
      classes.every((c) => !BLOCKING.includes(c) || SKIPPABLE.includes(c)),
    title: "Continue?",
    confirmLabel: "Continue",
    facts: [],
    warnings: [],
    ...o,
  };
}

const modelLine = (
  specs: string[],
  status: { spec: string; ok: boolean; reason: string }[] | undefined,
) =>
  specs
    .map((s) => {
      const st = status?.find((x) => x.spec === s);
      return st && !st.ok ? `${s} ✖` : s;
    })
    .join(" → ");

export async function estimate(
  rt: Runtime,
  action: string,
  body: Record<string, unknown>,
): Promise<CostEstimate> {
  const declared = ROUTE_COST[action];
  if (!declared) throw new Error(`unknown action "${action}"`);
  const cfg = rt.getConfig();

  if (action === "vo-generate") {
    const version = Number(body.version);
    if (!Number.isInteger(version) || version < 1) throw new Error('"version" is required');
    const { estimate: e } = await voiceEstimate(rt, version);
    return base(action, ["tts"], {
      title: `Generate voice & render · VO v${version}`,
      confirmLabel: e.price > 0 ? `Generate (≈ ${e.currency}${e.cost.toFixed(2)})` : "Generate",
      what: formatEstimate(e),
      facts: [
        ["Voice", `${e.engine} “${e.voice.name}”${e.model ? ` · ${e.model}` : ""}`],
        ["Sections", `${e.toSynthesize} to synthesize · ${e.cached} cached (free)`],
        ["Characters", e.chars.toLocaleString("en-US")],
        ...(e.credits !== null
          ? ([["Credits", `≈ ${e.credits.toLocaleString("en-US")}`]] as [string, string][])
          : []),
        [
          "Cost",
          e.price > 0
            ? `≈ ${e.currency}${e.cost.toFixed(2)} (at ${e.currency}${e.price} ${e.priceUnit})`
            : "free",
        ],
        ["Then", "the sync edit and a draft render run as engine jobs (no agent turn)"],
      ],
      warnings: e.skipped.map((s) => `${s.engine} skipped: ${s.reason}`),
    });
  }

  if (action === "rerecord") {
    const p = rt.requireProject();
    const state = readState(p.dir) ?? p.state;
    const sb = Number(body.storyboard ?? state.line.storyboard);
    const story = readStoryboard(p.dir, Number.isInteger(sb) ? sb : undefined);
    if (!story) throw new Error("no storyboard to record yet");
    const improvise = story.storyboard.scenes.reduce(
      (n, s) => n + s.steps.filter((st) => st.do === "improvise").length,
      0,
    );
    const status = rt.registry
      ? improviseModelStatus(cfg.improvise.models, rt.registry)
      : undefined;
    const last = listTakes(p.dir)
      .filter((t) => t.status === "ok" && t.storyboardVersion === story.version)
      .at(-1);
    const warnings = (status ?? [])
      .filter((s) => !s.ok)
      .map(
        (s) =>
          `${s.spec}: ${s.reason}${improvise ? " — its steps would use the next model, or type their fallback text" : ""}`,
      );
    return base(action, ["turn", "take"], {
      title: "Record a new take?",
      confirmLabel: "Record take",
      what: `A new take of storyboard v${story.version}`,
      facts: [
        ["Storyboard", `v${story.version} · ${story.storyboard.scenes.length} scene(s)`],
        [
          "Recording",
          last?.durationMs !== undefined
            ? `about ${secs(last.durationMs)} (like ${last.id}), headless`
            : "length unknown — no earlier take of this version",
        ],
        [
          "Improvised inputs",
          improvise
            ? `${improvise} step(s) on ${modelLine(cfg.improvise.models, status)}`
            : "none in this storyboard",
        ],
        ["The Director", `records and analyses it — an agent turn on ${sessionName(rt)}`],
      ],
      warnings,
    });
  }

  if (action === "annotations-resuggest") {
    const avail = designerAvailable(rt);
    if (!("models" in avail)) {
      return base(action, ["turn"], {
        what: `Starts the Director on ${sessionName(rt)}`,
        title: "Suggest annotations",
        confirmLabel: "Suggest",
      });
    }
    const p = rt.requireProject();
    const status = rt.registry ? roleModelStatus(avail.models, rt.registry) : undefined;
    let pack = "can't be built yet (no edit for this voice-over)";
    try {
      const { version, timeline } = timelineFor(p.dir);
      const base_ =
        body.version !== undefined && body.version !== null ? Number(body.version) : undefined;
      const text = annotationContext({
        projectDir: p.dir,
        timeline,
        timelineVersion: version,
        ...(base_ !== undefined ? { base: base_ } : {}),
        ...(typeof body.instructions === "string" && body.instructions.trim()
          ? { instructions: body.instructions }
          : {}),
      });
      pack = `≈ ${Math.round(text.length / 4).toLocaleString("en-US")} tokens in, one call (+ at most one repair call)`;
    } catch {
      // keep the note above
    }
    return base(action, ["designer"], {
      title: "Run the Annotation designer?",
      confirmLabel: "Suggest",
      what: "The Annotation designer, as one separate model call",
      facts: [
        ["Models", modelLine(avail.models, status)],
        ["Input", pack],
        ["No agent turn", "the Director only gets a quiet note"],
      ],
      warnings: (status ?? [])
        .filter((s) => !s.ok)
        .map((s) => `${s.spec}: ${s.reason} — the agent turn takes over if every model fails`),
    });
  }

  // everything else: a turn gets a hint, the rest nothing
  if (declared.includes("turn"))
    return base(action, ["turn"], { what: `Starts the Director on ${sessionName(rt)}` });
  return base(action, declared, { what: "" });
}

export function costRoutes(rt: Runtime): { post: Record<string, PostRoute> } {
  return {
    post: {
      /** A free dry run of what an action would start: `{ action, …the route's own body }`. */
      estimate: (body) => {
        if (typeof body.action !== "string") throw new Error('"action" is required');
        return estimate(rt, body.action, body);
      },
    },
  };
}
