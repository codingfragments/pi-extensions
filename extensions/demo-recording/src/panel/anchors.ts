/**
 * What the picture shows at each anchor of a voice-over section (UX19b, D132): for every `[@mark]` in the narration,
 * the moment in the take and the keyframe the analysis took there, so the words can be checked against the picture.
 * Read-only; nothing is rendered here (the keyframes exist if the take was analysed).
 */

import fs from "node:fs";
import path from "node:path";
import { readAnalysis } from "../analysis/take.ts";
import type { VoSegment } from "../vo/script.ts";

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
