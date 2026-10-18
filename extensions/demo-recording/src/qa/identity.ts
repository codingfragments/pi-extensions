/**
 * What makes a finding "the same" in the next render (P1a Q2, D-QA-3): the check, the scene and what it is about
 * (an anchor, a value, a toast's text, an annotation), never its timing numbers, with reasonable flexibility:
 *  - an anchor that was renamed is found again by the first three words of its phrase;
 *  - a value matches by its normalised form (numbers by value, names case-insensitive);
 *  - a finding with no anchor (a pause, a still picture) matches by kind and by staying within 1.5 s of where it
 *    was in its scene.
 * And what an ignore was true for (`contentKey`): the scene's narration, or the take. A different one ends it.
 */

import { createHash } from "node:crypto";
import { readVoText } from "../annotations/design.ts";
import type { RenderRecord } from "../render/store.ts";
import { parseVo } from "../vo/script.ts";
import type { FindingIdentity, QaCheck, QaItem } from "./types.ts";

/** How far a finding without an anchor may move inside its scene and still be the same finding (ms). */
export const SAME_SPOT_MS = 1500;

/** The scene a full-video time falls in. */
export function sceneAt(sceneStart: Record<string, number>, atMs: number): string | undefined {
  let best: string | undefined;
  let at = -1;
  for (const [id, start] of Object.entries(sceneStart))
    if (start <= atMs && start > at) {
      best = id;
      at = start;
    }
  return best;
}

/** Media findings come from the whole video: give them the scene they fall in and their place inside it. */
export function placeFindings(items: QaItem[], sceneStart: Record<string, number>): void {
  for (const it of items) {
    if (it.check !== "media" || it.atMs === undefined || it.scene) continue;
    const scene = sceneAt(sceneStart, it.atMs);
    if (!scene) continue;
    it.scene = scene;
    it.identity = { ...it.identity, relMs: Math.round(it.atMs - (sceneStart[scene] ?? 0)) };
  }
}

const prefix3 = (p?: string[]) => (p && p.length >= 3 ? p.slice(0, 3).join(" ") : undefined);

/** Are two findings the same issue? Both name their check, scene and identity. */
export function sameFinding(
  a: { check: QaCheck; scene?: string | undefined; identity?: FindingIdentity | undefined },
  b: { check: QaCheck; scene?: string | undefined; identity?: FindingIdentity | undefined },
): boolean {
  if (a.check !== b.check || a.scene !== b.scene) return false;
  const x = a.identity ?? {};
  const y = b.identity ?? {};
  switch (a.check) {
    case "drift":
      return (
        (!!x.anchor && x.anchor === y.anchor) ||
        (!!prefix3(x.phrase) && prefix3(x.phrase) === prefix3(y.phrase))
      );
    case "values": {
      if (!x.value || x.value !== y.value) return false;
      // the same value said by another segment of the scene is another finding
      if (x.anchor && y.anchor)
        return (
          x.anchor === y.anchor || (!!prefix3(x.phrase) && prefix3(x.phrase) === prefix3(y.phrase))
        );
      return true;
    }
    case "footage":
      return !!x.text && x.text === y.text;
    case "annotations":
      return (!!x.ref && x.ref === y.ref) || (!!x.text && x.text === y.text);
    case "media":
      if (!x.kind || x.kind !== y.kind) return false;
      return x.relMs === undefined || y.relMs === undefined
        ? true
        : Math.abs(x.relMs - y.relMs) <= SAME_SPOT_MS;
    default:
      return false;
  }
}

const hash = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 10);

/** The narration of a scene in a voice-over version, as one hash. */
export function sceneNarrationHash(
  projectDir: string,
  voVersion: number,
  scene: string,
): string | undefined {
  const text = readVoText(projectDir, voVersion);
  if (!text) return undefined;
  const sec = parseVo(text).sections.find((s) => s.kind === "scene" && s.scene === scene);
  return sec ? hash(sec.segments.map((s) => s.text).join(" ")) : undefined;
}

/**
 * What an ignore is true for. Findings about the story (a value, the sync, the media, the annotations) are about
 * the scene's narration; a toast or console error in the footage is about the take.
 */
export function contentKey(
  projectDir: string,
  rec: Pick<RenderRecord, "voVersion" | "take">,
  check: QaCheck,
  scene: string | undefined,
): string {
  if (check === "footage") return `take:${rec.take}`;
  const h = scene ? sceneNarrationHash(projectDir, rec.voVersion, scene) : undefined;
  return `narration:${scene ?? "-"}:${h ?? "-"}`;
}
