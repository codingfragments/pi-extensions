/**
 * The Annotation designer as a SEPARATE model run (S5 part 12, D85–D90;
 * docs/ACTORS.md): instead of an agent turn on the session model, the engine
 * builds the input pack, makes ONE call on the configured model chain
 * (`roles.annotationDesigner.model`), and feeds the answer through the same
 * suggest engine the tool uses (it resolves, weighs, adds privacy hits).
 *
 *   system prompt  = the demo-annotations skill's rules (one source) + an output-format block
 *   user message   = the input pack (+ the user's instructions on a re-suggest)
 *   answer         = a JSON array of suggestions
 *   repair         = ONE extra round for invalid JSON, invalid items and items that can't be
 *                    placed ("fix these or leave them out"), judged with a dry run
 *   no answer      = DesignerFailed → the caller hands over to the agent turn
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Timeline } from "../edit/timeline.ts";
import { type ModelAccess, parseModelSpec } from "../recorder/improvise.ts";
import { annotationContext } from "./context.ts";
import { type DesignReport, type Suggestion, suggestAnnotations } from "./design.ts";
import { toSuggestion } from "./suggestion.ts";
import { ANNOTATION_TYPES } from "./types.ts";
import type { ZoomLimits } from "./zoom-limits.ts";

export const DESIGNER_TIMEOUT_MS = 180_000;
const MAX_TOKENS = 8000;

const SKILL = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "skills",
  "demo-annotations",
  "SKILL.md",
);

/** The skill sections that carry the designer's judgement (the workflow section is tool-specific and left out). */
export const PROMPT_SECTIONS = ["What to suggest", "Writing rules", "Privacy (Privacy officer)"];

/** `## Heading` → its body, from the skill file. */
export function skillSections(markdown: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = markdown.split(/^## +/m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf("\n");
    out.set((nl < 0 ? part : part.slice(0, nl)).trim(), (nl < 0 ? "" : part.slice(nl + 1)).trim());
  }
  return out;
}

const OUTPUT_FORMAT = `## Output format

Reply with ONE JSON array and nothing else. Each element is one suggestion:

{
  "type": "zoom" | "highlight" | "spotlight" | "redact" | "callout" | "chapter",
  "scene": "<a scene id from the pack>",
  "anchor": { "mark": "<mark>" } | { "word": "<word of the narration>", "occurrence": 1 } | { "sceneStart": true },
      (optionally "offsetMs": a beat after the anchor, e.g. 800, inside the anchor object)
  "target": { "step": 1 } | { "text": "<visible text>", "role": "<role>" } | { "layout": "t13107#e24" } | { "box": { "x": 0, "y": 0, "w": 100, "h": 40 } },
  "alternatives": [ <other targets> ]            (zooms: 1–2),
  "text": "<callout/chapter text, ≤ 60 characters>",
  "durMs": <optional>, "factor": <zoom 1.1–1.8, optional>,
  "value": 1–5,
  "reason": "<one line: why>",
  "confidence": { "score": 1–2, "why": "<…>" }    (ONLY when you doubt the item)
}

Use the refs, marks, scene ids and words that appear in the pack — nothing else.
Suggest about twice as many as should be on. No prose, no explanations outside the array.`;

/** The system prompt: the role, the skill's rules (one source), the output format. */
export function designerSystemPrompt(skillFile = SKILL): string {
  const sections = skillSections(fs.readFileSync(skillFile, "utf8"));
  const rules = PROMPT_SECTIONS.map((h) => {
    const body = sections.get(h);
    if (!body) throw new Error(`demo-annotations skill: section "${h}" is missing`);
    return `## ${h}\n\n${body}`;
  });
  return [
    "You are the Annotation designer (and the Privacy officer) of an automated demo-video recorder.",
    "You decide what the viewer's eye should be pulled to, and when, in a video whose narration and edit already exist.",
    "You suggest; the engine places, weighs and pre-enables the best half; the user toggles, edits and accepts.",
    "You work from the input pack in the user message. You cannot look at the video or call tools: everything you need is in the pack.",
    "",
    ...rules,
    "",
    OUTPUT_FORMAT,
  ].join("\n");
}

export class DesignerFailed extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`the Annotation designer run failed (${errors.join("; ")})`);
    this.errors = errors;
  }
}

const TYPES: readonly string[] = ANNOTATION_TYPES;

export interface ParsedAnswer {
  suggestions: Suggestion[];
  /** Per-element problems (the element is left out). */
  problems: string[];
}

/** The model's text → suggestions. Throws when there is no JSON array at all. */
export function parseDesignerAnswer(text: string): ParsedAnswer {
  const candidates: string[] = [text.trim()];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const a = text.indexOf("[");
  const b = text.lastIndexOf("]");
  if (a >= 0 && b > a) candidates.push(text.slice(a, b + 1));
  let raw: unknown;
  let parsed = false;
  for (const c of candidates) {
    try {
      raw = JSON.parse(c);
      parsed = true;
      break;
    } catch {
      // try the next candidate
    }
  }
  if (!parsed) throw new Error("the answer is not valid JSON — reply with ONE JSON array");
  const list = Array.isArray(raw) ? raw : (raw as { suggestions?: unknown })?.suggestions;
  if (!Array.isArray(list)) throw new Error("the answer must be a JSON array of suggestions");
  const suggestions: Suggestion[] = [];
  const problems: string[] = [];
  list.forEach((el, i) => {
    const at = `suggestions[${i}]`;
    if (!el || typeof el !== "object" || Array.isArray(el))
      return void problems.push(`${at}: not an object`);
    const o = el as Record<string, unknown>;
    if (typeof o.type !== "string" || !TYPES.includes(o.type))
      return void problems.push(`${at}: "type" must be one of ${TYPES.join(", ")}`);
    if (typeof o.scene !== "string" || !o.scene)
      return void problems.push(`${at}: "scene" is required`);
    const anchor = o.anchor as Record<string, unknown> | undefined;
    if (
      !anchor ||
      typeof anchor !== "object" ||
      !("mark" in anchor || "word" in anchor || "sceneStart" in anchor)
    )
      return void problems.push(`${at}: "anchor" needs a mark, a word or sceneStart`);
    suggestions.push(toSuggestion(o));
  });
  return { suggestions, problems };
}

export interface DesignerRunOptions {
  projectDir: string;
  timeline: Timeline;
  timelineVersion: number;
  base?: number;
  instructions?: string;
  zoomLimits?: ZoomLimits;
  access: ModelAccess;
  models: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  /** "calling anthropic/…", "repairing …", "placing …" — for the progress line. */
  onStep?: (what: string) => void;
}

export interface DesignerRunResult {
  report: DesignReport;
  /** The model that produced the stored version. */
  model: string;
  /** A repair round was needed. */
  repaired: boolean;
  /** Everything that was tried, in order. */
  tried: string[];
  /** Suggestions in the final answer (before placing). */
  suggested: number;
}

async function ask(
  access: ModelAccess,
  spec: string,
  system: string,
  user: string,
  o: Pick<DesignerRunOptions, "signal" | "timeoutMs">,
): Promise<string> {
  const { provider, id } = parseModelSpec(spec);
  const model = access.find(provider, id);
  if (!model) throw new Error("not available in pi");
  const timeout = AbortSignal.timeout(o.timeoutMs ?? DESIGNER_TIMEOUT_MS);
  const res = await access.complete(
    model,
    {
      systemPrompt: system,
      messages: [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }],
    },
    { maxTokens: MAX_TOKENS, signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout },
  );
  if (res.stopReason === "error" || res.stopReason === "aborted")
    throw new Error(res.errorMessage ?? res.stopReason);
  const text = res.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
  if (!text.trim()) throw new Error("empty answer");
  return text;
}

const feedback = (pack: string, previous: string, issues: string[]) =>
  `${pack}\n\n---\nYour previous answer:\n${previous}\n\n---\nThe engine found these problems:\n${issues.map((x) => `- ${x}`).join("\n")}\n\nFix them or leave those items out, and reply with the complete corrected JSON array (all suggestions, not only the changed ones).`;

export async function runDesigner(o: DesignerRunOptions): Promise<DesignerRunResult> {
  const system = designerSystemPrompt();
  const pack = annotationContext({
    projectDir: o.projectDir,
    timeline: o.timeline,
    timelineVersion: o.timelineVersion,
    ...(o.base !== undefined ? { base: o.base } : {}),
    ...(o.instructions ? { instructions: o.instructions } : {}),
    ...(o.zoomLimits ? { zoomLimits: o.zoomLimits } : {}),
  });
  const user = `${pack}\n\nReply with the JSON array of suggestions.`;
  const place = (suggestions: Suggestion[], dryRun: boolean) =>
    suggestAnnotations({
      projectDir: o.projectDir,
      timeline: o.timeline,
      suggestions,
      ...(o.base !== undefined ? { base: o.base } : {}),
      ...(o.instructions ? { instructions: o.instructions } : {}),
      by: "annotation-designer (separate run)",
      dryRun,
      ...(o.zoomLimits ? { zoomLimits: o.zoomLimits } : {}),
    });
  const errors: string[] = [];
  const tried: string[] = [];
  for (const spec of o.models) {
    tried.push(spec);
    try {
      o.onStep?.(`calling ${spec}`);
      const first = await ask(o.access, spec, system, user, o);
      let answer: ParsedAnswer | undefined;
      let issues: string[];
      try {
        answer = parseDesignerAnswer(first);
        const dry = place(answer.suggestions, true);
        issues = [...answer.problems, ...dry.dropped.map((d) => `${d.id}: not placed — ${d.why}`)];
      } catch (err) {
        issues = [(err as Error).message];
      }
      let repaired = false;
      if (issues.length) {
        // One repair round (D88): invalid JSON or items, and items that can't be placed.
        o.onStep?.(`repairing ${issues.length} problem(s) with ${spec}`);
        const second = await ask(o.access, spec, system, feedback(pack, first, issues), o);
        repaired = true;
        try {
          const a2 = parseDesignerAnswer(second);
          if (!answer || a2.suggestions.length) answer = a2;
        } catch (err) {
          if (!answer) throw err;
        }
      }
      if (!answer || !answer.suggestions.length) throw new Error("no usable suggestions");
      o.onStep?.("placing the suggestions");
      const report = place(answer.suggestions, false);
      if (!report.added) throw new Error("none of the suggestions could be placed");
      return { report, model: spec, repaired, tried, suggested: answer.suggestions.length };
    } catch (err) {
      errors.push(`${spec}: ${(err as Error).message}`);
      if (o.signal?.aborted) break;
    }
  }
  throw new DesignerFailed(errors);
}
