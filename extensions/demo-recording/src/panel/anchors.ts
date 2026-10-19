/**
 * What the picture shows at each anchor of a voice-over section (UX19b, D132): for every `[@mark]` in the narration,
 * the moment in the take and the keyframe the analysis took there, so the words can be checked against the picture.
 * Read-only; nothing is rendered here (the keyframes exist if the take was analysed).
 */

import fs from "node:fs";
import path from "node:path";
import { readAnalysis } from "../analysis/take.ts";
import type { SectionKind, VoSegment } from "../vo/script.ts";
import { localize } from "./stage-routes.ts";

export interface SectionAnchor {
  mark: string;
  /** Milliseconds into the take. */
  atMs: number;
  /** A line of what the page said at that moment (the analysis's snapshot), when it recorded one. */
  dom: string | null;
  /** Project-relative path of the keyframe, when there is one on disk. */
  image: string | null;
}

/** The anchors used by a section's narration, in the order they are spoken, once each. */
export function sectionAnchors(
  projectDir: string,
  take: string,
  scene: string | undefined,
  segments: VoSegment[],
): SectionAnchor[] {
  if (!scene) return [];
  const used: string[] = [];
  for (const s of segments) if (s.anchor && !used.includes(s.anchor)) used.push(s.anchor);
  if (!used.length) return [];
  let analysis: ReturnType<typeof readAnalysis>;
  try {
    analysis = readAnalysis(path.join(projectDir, "takes", take));
  } catch {
    return [];
  }
  const marks = analysis?.scenes.find((s) => s.id === scene)?.marks ?? [];
  const out: SectionAnchor[] = [];
  for (const mark of used) {
    const m = marks.find((x) => x.mark === mark);
    if (!m) continue;
    let image: string | null = null;
    const file = m.keyframe
      ? path.isAbsolute(m.keyframe)
        ? m.keyframe
        : path.join(projectDir, m.keyframe)
      : null;
    if (file && fs.existsSync(file)) {
      const rel = path.relative(projectDir, file);
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) image = rel.split(path.sep).join("/");
    }
    const dom = m.dom ? m.dom.replace(/\s+/g, " ").trim().slice(0, 160) : null;
    out.push({ mark, atMs: m.t, dom: dom || null, image });
  }
  return out;
}

export interface SectionFrame {
  /** The mark name, "start", "end", or the notable moment's type (e.g. "alert"). */
  label: string;
  kind: "start" | "mark" | "event" | "end";
  /** Milliseconds into the take. */
  t: number;
  /** Project-relative path of the still, when it is on disk. */
  image: string | null;
  /** A mark the narration anchors to. Always false for the other kinds. */
  used: boolean;
  /** The first words the narration speaks at a used mark. */
  pins?: string;
  /** The scene the frame belongs to (for an intro or an outro: the scene it shows). */
  scene: string;
}

const PIN_WORDS = 9;

/** The first words of what is spoken at an anchor, without markers. */
function pinsOf(segments: VoSegment[], mark: string): string | undefined {
  const seg = segments.find((x) => x.anchor === mark);
  const words = (seg?.text ?? "")
    .replace(/\[@[^\]]*\]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return undefined;
  return `${words.slice(0, PIN_WORDS).join(" ")}${words.length > PIN_WORDS ? "…" : ""}`;
}

/**
 * Every moment of the section's scene in time order (F16): the start, each mark (used by the narration or not), notable
 * moments such as a toast, the end. An intro shows how the first scene opens and an outro how the last one closes; a bridge
 * shows nothing. Read-only, nothing is rendered.
 */
export function sectionFrames(
  projectDir: string,
  take: string,
  section: { kind: SectionKind; scene?: string },
  segments: VoSegment[],
): SectionFrame[] {
  let analysis: ReturnType<typeof readAnalysis>;
  try {
    analysis = readAnalysis(path.join(projectDir, "takes", take));
  } catch {
    return [];
  }
  const scenes = analysis?.scenes ?? [];
  const scene =
    section.kind === "scene"
      ? scenes.find((s) => s.id === section.scene)
      : section.kind === "intro"
        ? scenes[0]
        : section.kind === "outro"
          ? scenes.at(-1)
          : undefined;
  if (!scene) return [];
  const marks = new Set((scene.marks ?? []).map((m) => m.mark));
  const used = new Set(segments.map((x) => x.anchor).filter(Boolean) as string[]);
  const frames = (scene.keyframes ?? [])
    .map((k): SectionFrame => {
      const kind: SectionFrame["kind"] =
        k.label === "start"
          ? "start"
          : k.label === "end"
            ? "end"
            : marks.has(k.label)
              ? "mark"
              : "event";
      const file = localize(projectDir, k.file);
      const isUsed = kind === "mark" && used.has(k.label);
      const pins = isUsed ? pinsOf(segments, k.label) : undefined;
      return {
        label: k.label,
        kind,
        t: k.t,
        image: file ? path.relative(projectDir, file).split(path.sep).join("/") : null,
        used: isUsed,
        ...(pins ? { pins } : {}),
        scene: scene.id,
      };
    })
    .sort((a, b) => a.t - b.t);
  if (section.kind === "intro") return frames.filter((f) => f.kind === "start");
  if (section.kind === "outro") return frames.filter((f) => f.kind === "end");
  return frames;
}
