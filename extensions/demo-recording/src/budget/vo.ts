/**
 * The voice-over against the length budget (item 22 PR 2, D-R3-25-14). The final video follows the narration: a scene is as long as its footage (after the dead time is
 * cut) or its speech, whichever is longer (the edit stretches the footage to the voice); the intro, the bridges and the outro add their speech; the title card its length.
 * Within the window the edit just stretches; a script that would pass the ceiling asks the user: raise the ceiling, or cut.
 */

import fs from "node:fs";
import path from "node:path";
import type { ValidatedVo } from "../vo/script.ts";
import { speechSeconds } from "../vo/script.ts";
import { setBriefFacts } from "../workdir/brief.ts";
import { recordInput } from "../workdir/inputs.ts";
import { writeNextVersion } from "../workdir/versioning.ts";
import { type LengthBudget, againstBudget, clock, lengthVerdict } from "./length.ts";

export interface VoLength {
  finalSec: number;
  verdict: "short" | "fits" | "long";
  words: string;
  /** The scenes where the speech is longer than the footage, most first: where to cut. */
  overruns: { section: string; overSec: number }[];
  /** A ceiling that would hold this script, rounded up to the next half minute. */
  raiseToSec: number;
}

export function voLength(
  v: ValidatedVo,
  b: LengthBudget,
  o: { titleMs: number; wordsPerSecond?: number },
): VoLength {
  let sec = o.titleMs / 1000;
  for (const t of v.timing) sec += Math.max(t.usableSec, t.speechSec);
  for (const s of v.resolved)
    if (s.kind !== "scene") sec += speechSeconds(s.body, o.wordsPerSecond);
  const finalSec = Math.round(sec);
  const overruns = v.timing
    .map((t) => ({ section: t.section, overSec: +(t.speechSec - t.usableSec).toFixed(1) }))
    .filter((x) => x.overSec > 0.5)
    .sort((a, c) => c.overSec - a.overSec);
  return {
    finalSec,
    verdict: lengthVerdict(finalSec, b),
    words: againstBudget(finalSec, b, "with this voice-over the final is about"),
    overruns,
    raiseToSec: Math.ceil(finalSec / 30) * 30,
  };
}

/** Write a brief field as a new brief version, as the panel's facts form does (a user's answer, recorded as an input). */
export function writeBriefField(
  projectDir: string,
  patch: Record<string, string>,
  why: string,
): number | undefined {
  const file = path.join(projectDir, "brief.md");
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "# Demo brief\n";
  const after = setBriefFacts(before, patch);
  if (after === before) return undefined;
  const v = writeNextVersion(path.join(projectDir, "brief"), "v", ".md", after);
  fs.writeFileSync(file, after);
  recordInput(projectDir, {
    stage: "brief",
    version: v.version,
    source: "panel",
    kind: "brief",
    text: `${why} → brief v${v.version}`,
    refs: [`brief/v${v.version}.md`],
  });
  return v.version;
}

export const clockText = clock;
