/**
 * Storyboard scene confidence (D78):
 *   low    a target never seen in discovery · a css target · failed/retried in a take ·
 *          an improvise step without a fallback
 *   medium new/changed since the previous version · an improvise step · no deep_link
 *          (an unsafe resume) · no screen thumbnail
 *   high   none of these (+ "unchanged since vN, where you approved it", D79)
 *
 * "Never seen in discovery" is measured when the storyboard is written (the
 * discovery session is live then) and stored next to the version:
 * storyboard/vN.checks.json.
 */

import fs from "node:fs";
import path from "node:path";
import { unsafeResumeScenes } from "../recorder/replay-guard.ts";
import { describeTarget } from "../recorder/targets.ts";
import { readStoryboard, storyboardDir, storyboardVersions } from "../storyboard/store.ts";
import type { Scene, Target } from "../storyboard/types.ts";
import { readState } from "../workdir/state.ts";
import { type ConfidenceSummary, type Reason, judge, summarize } from "./level.ts";

export interface StoryboardChecks {
  /** Was a discovery session open when the version was written (targets checked)? */
  discovery: boolean;
  unknownTargets: { scene: string; step: number; target: Target }[];
}

const checksFile = (projectDir: string, v: number) =>
  path.join(storyboardDir(projectDir), `v${v}.checks.json`);

export function writeStoryboardChecks(
  projectDir: string,
  v: number,
  checks: StoryboardChecks,
): void {
  fs.writeFileSync(checksFile(projectDir, v), `${JSON.stringify(checks, null, 2)}\n`);
}

export function readStoryboardChecks(projectDir: string, v: number): StoryboardChecks | undefined {
  const f = checksFile(projectDir, v);
  return fs.existsSync(f)
    ? (JSON.parse(fs.readFileSync(f, "utf8")) as StoryboardChecks)
    : undefined;
}

/** Scene content without the agent's own view (a changed score is not a changed scene). */
export const sceneKey = (s: Scene) => {
  const { confidence: _c, ...rest } = s;
  return JSON.stringify(rest);
};

/** Failed attempts per scene in takes recorded from these storyboard versions. */
function failedAttempts(
  projectDir: string,
  versions: Set<number>,
): Map<string, { take: string; version: number; error: string }[]> {
  const out = new Map<string, { take: string; version: number; error: string }[]>();
  const dir = path.join(projectDir, "takes");
  if (!fs.existsSync(dir)) return out;
  for (const id of fs
    .readdirSync(dir)
    .filter((d) => /^take-\d+$/.test(d))
    .sort()) {
    const tj = path.join(dir, id, "take.json");
    const af = path.join(dir, id, "attempts.jsonl");
    if (!fs.existsSync(tj) || !fs.existsSync(af)) continue;
    const meta = JSON.parse(fs.readFileSync(tj, "utf8")) as { storyboardVersion?: number };
    if (meta.storyboardVersion === undefined || !versions.has(meta.storyboardVersion)) continue;
    for (const line of fs.readFileSync(af, "utf8").split("\n").filter(Boolean)) {
      try {
        const a = JSON.parse(line) as { scene: string; error?: string };
        out.set(a.scene, [
          ...(out.get(a.scene) ?? []),
          {
            take: id,
            version: meta.storyboardVersion,
            error: (a.error ?? "").split("\n")[0] ?? "",
          },
        ]);
      } catch {
        // a torn line — ignore
      }
    }
  }
  return out;
}

export function storyboardConfidence(
  projectDir: string,
  version: number,
): ConfidenceSummary | undefined {
  const cur = readStoryboard(projectDir, version)?.storyboard;
  if (!cur) return undefined;
  const earlier = storyboardVersions(projectDir).filter((v) => v < version);
  const prevV = earlier.at(-1);
  const prev = prevV !== undefined ? readStoryboard(projectDir, prevV)?.storyboard : undefined;
  const state = readState(projectDir);
  const checks = readStoryboardChecks(projectDir, version);
  const unsafe = new Set(unsafeResumeScenes(cur.scenes).map((u) => u.scene));
  // Takes of this version, and of earlier versions for scenes that didn't change since.
  const older = new Map<number, Map<string, string>>();
  for (const v of earlier) {
    const sb = readStoryboard(projectDir, v)?.storyboard;
    if (sb) older.set(v, new Map(sb.scenes.map((s) => [s.id, sceneKey(s)])));
  }
  const failed = failedAttempts(projectDir, new Set([...earlier, version]));
  const items = cur.scenes.map((scene) => {
    const r: Reason[] = [];
    const key = sceneKey(scene);
    for (const u of checks?.unknownTargets.filter((x) => x.scene === scene.id) ?? [])
      r.push({
        level: "low",
        text: `step ${u.step}: ${describeTarget(u.target)} was never seen in discovery`,
      });
    scene.steps.forEach((st, i) => {
      const t =
        "target" in st ? st.target : st.do === "wait" && !("ms" in st.for) ? st.for : undefined;
      if (t && "css" in t)
        r.push({ level: "low", text: `step ${i}: a css target (${t.css}) breaks easily` });
      if (st.do === "improvise")
        r.push(
          st.fallback
            ? { level: "medium", text: `step ${i}: improvised input (the model writes it live)` }
            : { level: "low", text: `step ${i}: improvised input without a fallback` },
        );
    });
    // An earlier version's failure counts while the scene is unchanged since.
    const fails = (failed.get(scene.id) ?? []).filter(
      (f) => f.version === version || older.get(f.version)?.get(scene.id) === key,
    );
    if (fails.length)
      r.push({
        level: "low",
        text: `failed ${fails.length}× while recording (${fails[0]?.take}: ${fails[0]?.error.slice(0, 100)})`,
      });
    if (prev) {
      const before = prev.scenes.find((s) => s.id === scene.id);
      if (!before) r.push({ level: "medium", text: `new since v${prevV}` });
      else if (sceneKey(before) !== key)
        r.push({ level: "medium", text: `changed since v${prevV}` });
    }
    if (unsafe.has(scene.id))
      r.push({ level: "medium", text: "no deep_link — a failure here can't be re-shot safely" });
    if (!scene.screen) r.push({ level: "medium", text: "no screen thumbnail to review against" });
    // D79: the latest earlier version where the user approved exactly this scene.
    const approvedIn = [...earlier]
      .reverse()
      .find(
        (v) =>
          state?.reviews?.[String(v)]?.scenes[scene.id]?.status === "approved" &&
          older.get(v)?.get(scene.id) === key,
      );
    return judge(scene.id, r, scene.confidence, approvedIn);
  });
  return summarize(items);
}
