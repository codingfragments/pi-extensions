/**
 * Voice-over script (IMPLEMENTATION_PLAN §3.4, S4).
 *
 *   ---
 *   take: take-003
 *   ---
 *   ## _intro
 *   Churn looks fine on Acme Pulse — until you split it by region.
 *
 *   ## 02-search
 *   Natural-language search, so I'll just ask. [@type-start] Churn by region…
 *   [@results-visible] and EMEA jumps out at {{dom:results-visible|EMEA\s+([\d.]+%)}}.
 *
 *   ## _bridge:03-assistant      (full video only, spoken before that scene)
 *   ## _outro
 *
 * - `[@mark]`: the text after the anchor starts at that event (the editor syncs it).
 * - `{{dom:<mark>|<regex>}}`: a value from the page text captured at <mark>;
 *   capture group 1 (or the whole match) is frozen into the text before TTS.
 * Validation is against the take's analysis: scenes, marks (order), bindings,
 * and speech time vs. usable scene time.
 */

import fs from "node:fs";
import path from "node:path";
import type { TakeAnalysis } from "../analysis/take.ts";
import type { AgentConfidence } from "../storyboard/types.ts";

export type SectionKind = "scene" | "intro" | "outro" | "bridge";

export interface VoSegment {
  /** Mark the segment is anchored to; undefined = starts with the scene. */
  anchor?: string;
  /** Text as written (bindings unresolved). */
  text: string;
}

export interface VoSection {
  key: string;
  kind: SectionKind;
  /** Scene id (scene sections and bridges). */
  scene?: string;
  /** Section body as written. */
  body: string;
  segments: VoSegment[];
  /** The agent's own view (D77): a `<!-- confidence: 2 — why -->` line in the section. */
  confidence?: AgentConfidence;
}

export interface VoScript {
  take: string;
  sections: VoSection[];
}

export interface VoIssue {
  level: "error" | "warning";
  section: string;
  message: string;
}

/** ~155 wpm (D18) → seconds of speech. */
export const WORDS_PER_SECOND = 155 / 60;

export const BANNED = [
  "seamless",
  "seamlessly",
  "powerful",
  "robust",
  "cutting-edge",
  "revolutionary",
  "game-changer",
  "game changer",
  "best-in-class",
  "world-class",
  "leverage",
  "synergy",
  "next-generation",
  "state-of-the-art",
  "unlock",
  "supercharge",
];

/** `<!-- confidence: 2 — the number may have changed -->` (score 1–5, optional reason after —, -, or :). */
const CONFIDENCE_RE = /<!--\s*confidence:\s*([1-5])\s*(?:[—–:-]\s*([\s\S]*?))?\s*-->/g;
const ANCHOR_RE = /\[@([a-z0-9][a-z0-9-]*)\]/g;
const BINDING_RE = /\{\{dom:([a-z0-9][a-z0-9-]*)\|(.+?)\}\}/g;

export function parseVo(text: string): VoScript {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) throw new Error("voice-over: missing front matter (---\\ntake: take-NNN\\n---)");
  const take = /^take:\s*(take-\d+)\s*$/m.exec(m[1] as string)?.[1];
  if (!take) throw new Error("voice-over: front matter needs `take: take-NNN`");
  // HTML comments are notes for the writer (e.g. from the template), never spoken —
  // except `<!-- confidence: N — why -->`, the agent's view of its section (D77).
  const rest = text
    .slice(m[0].length)
    .replace(
      CONFIDENCE_RE,
      (_w, n: string, why: string) =>
        `\uE000conf:${n}:${(why ?? "").trim().replace(/\s+/g, " ")}\uE000`,
    )
    .replace(/<!--[\s\S]*?-->/g, "");
  const sections: VoSection[] = [];
  const parts = rest.split(/^## +/m).slice(1);
  if (!parts.length)
    throw new Error("voice-over: no sections (use `## <scene-id>`, `## _intro`, `## _outro`)");
  for (const part of parts) {
    const nl = part.indexOf("\n");
    const heading = (nl < 0 ? part : part.slice(0, nl)).trim();
    let confidence: AgentConfidence | undefined;
    const body = (nl < 0 ? "" : part.slice(nl + 1))
      .replace(/\uE000conf:(\d):([^\uE000]*)\uE000/g, (_w, n: string, why: string) => {
        confidence = { score: Number(n), ...(why ? { why } : {}) };
        return "";
      })
      .trim();
    const key = heading.split(/\s+—\s+|\s+-\s+/)[0]?.trim() ?? "";
    let kind: SectionKind;
    let scene: string | undefined;
    if (key === "_intro") kind = "intro";
    else if (key === "_outro") kind = "outro";
    else if (key.startsWith("_bridge:")) {
      kind = "bridge";
      scene = key.slice(8);
    } else if (/^[a-z0-9][a-z0-9-]*$/.test(key)) {
      kind = "scene";
      scene = key;
    } else
      throw new Error(
        `voice-over: unknown section "## ${heading}" (scene id, _intro, _outro, or _bridge:<scene-id>)`,
      );
    if (sections.some((s) => s.key === key))
      throw new Error(`voice-over: duplicate section "${key}"`);
    sections.push({
      key,
      kind,
      ...(scene ? { scene } : {}),
      body,
      segments: splitSegments(body),
      ...(confidence ? { confidence } : {}),
    });
  }
  return { take, sections };
}

export function splitSegments(body: string): VoSegment[] {
  const segs: VoSegment[] = [];
  let last = 0;
  let anchor: string | undefined;
  for (const m of body.matchAll(ANCHOR_RE)) {
    const text = clean(body.slice(last, m.index));
    if (text || anchor) segs.push({ ...(anchor ? { anchor } : {}), text });
    anchor = m[1];
    last = (m.index as number) + m[0].length;
  }
  const tail = clean(body.slice(last));
  if (tail || anchor) segs.push({ ...(anchor ? { anchor } : {}), text: tail });
  return segs.filter((s) => s.text || s.anchor);
}

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function wordCount(text: string): number {
  return text
    .replace(BINDING_RE, "x")
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

export function speechSeconds(text: string): number {
  return +(wordCount(text) / WORDS_PER_SECOND).toFixed(1);
}

/** Resolve `{{dom:mark|regex}}` against page-text snapshots. */
export function resolveBindings(
  text: string,
  domFor: (mark: string) => string | undefined,
  onError: (msg: string) => void,
): string {
  return text.replace(BINDING_RE, (whole, mark: string, pattern: string) => {
    const dom = domFor(mark);
    if (dom === undefined) {
      onError(`binding ${whole}: no page text captured at @${mark}`);
      return whole;
    }
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (err) {
      onError(`binding ${whole}: invalid regex (${(err as Error).message})`);
      return whole;
    }
    const m = re.exec(dom);
    if (!m) {
      onError(`binding ${whole}: pattern not found in the page text at @${mark}`);
      return whole;
    }
    return (m[1] ?? m[0]).trim();
  });
}

export interface SceneTiming {
  section: string;
  speechSec: number;
  usableSec: number;
  /** speech / usable — > 1 needs freezes, < 0.5 leaves long silence. */
  ratio: number;
}

export interface ValidatedVo {
  script: VoScript;
  /** Sections with bindings frozen (what TTS speaks). */
  resolved: VoSection[];
  issues: VoIssue[];
  timing: SceneTiming[];
}

export function validateVo(script: VoScript, analysis: TakeAnalysis, domDir: string): ValidatedVo {
  const issues: VoIssue[] = [];
  const err = (section: string, message: string) =>
    issues.push({ level: "error", section, message });
  const warn = (section: string, message: string) =>
    issues.push({ level: "warning", section, message });
  if (script.take !== analysis.take)
    err("(front matter)", `script is for ${script.take}, analysis is ${analysis.take}`);

  const sceneById = new Map(analysis.scenes.map((s) => [s.id, s]));
  const domCache = new Map<string, string | undefined>();
  const domFor = (mark: string) => {
    if (!domCache.has(mark)) {
      const f = path.join(domDir, `${mark}.yaml`);
      domCache.set(mark, fs.existsSync(f) ? fs.readFileSync(f, "utf8") : undefined);
    }
    return domCache.get(mark);
  };

  const resolved: VoSection[] = [];
  const timing: SceneTiming[] = [];
  for (const section of script.sections) {
    if (section.scene && !sceneById.has(section.scene)) {
      err(
        section.key,
        `scene "${section.scene}" is not in ${analysis.take} (scenes: ${[...sceneById.keys()].join(", ")})`,
      );
    }
    const scene = section.scene ? sceneById.get(section.scene) : undefined;
    if (section.kind !== "scene" && section.segments.some((s) => s.anchor)) {
      err(section.key, "anchors are only allowed in scene sections");
    }
    if (section.kind === "scene" && scene) {
      const marks = new Map(scene.marks.map((m) => [m.mark, m.t]));
      let prevT = -1;
      for (const seg of section.segments) {
        if (!seg.anchor) continue;
        const t = marks.get(seg.anchor);
        if (t === undefined) {
          err(
            section.key,
            `[@${seg.anchor}] is not a mark of ${scene.id} (marks: ${[...marks.keys()].map((m) => `@${m}`).join(", ") || "none"})`,
          );
          continue;
        }
        if (t < prevT)
          err(
            section.key,
            `[@${seg.anchor}] is out of order (anchors must follow the take's timeline)`,
          );
        prevT = t;
      }
    }
    const segments = section.segments.map((seg) => ({
      ...seg,
      text: resolveBindings(seg.text, domFor, (m) => err(section.key, m)),
    }));
    const lower = section.body.toLowerCase();
    for (const word of BANNED) {
      if (new RegExp(`\\b${word.replace(/-/g, "[- ]")}\\b`, "i").test(lower))
        warn(section.key, `avoid "${word}" (marketing filler, D18)`);
    }
    const full = segments.map((s) => s.text).join(" ");
    if (!full.trim()) warn(section.key, "empty section");
    resolved.push({ ...section, body: full, segments });
    if (section.kind === "scene" && scene) {
      const dead = scene.idle.reduce((n, r) => n + (r.end - r.start), 0);
      const usableSec = +((scene.end - scene.start - dead) / 1000).toFixed(1);
      const speechSec = speechSeconds(full);
      const ratio = usableSec > 0 ? +(speechSec / usableSec).toFixed(2) : 99;
      timing.push({ section: section.key, speechSec, usableSec, ratio });
      if (ratio > 1.35)
        warn(
          section.key,
          `~${speechSec}s of speech for ~${usableSec}s of footage — the editor will freeze frames; consider trimming`,
        );
      if (ratio < 0.35 && usableSec > 6)
        warn(
          section.key,
          `only ~${speechSec}s of speech for ~${usableSec}s of footage — long silences`,
        );
    }
  }
  for (const scene of analysis.scenes) {
    if (!script.sections.some((s) => s.kind === "scene" && s.scene === scene.id))
      warn(scene.id, "no narration for this scene (it will be silent)");
  }
  return { script, resolved, issues, timing };
}

export function formatIssues(v: ValidatedVo): string {
  const lines: string[] = [];
  for (const t of v.timing)
    lines.push(`- ${t.section}: speech ~${t.speechSec}s / footage ~${t.usableSec}s (×${t.ratio})`);
  for (const i of v.issues) lines.push(`- ${i.level.toUpperCase()} ${i.section}: ${i.message}`);
  return lines.join("\n");
}
