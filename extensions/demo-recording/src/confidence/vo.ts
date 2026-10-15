/**
 * Voice-over section confidence (D78):
 *   low    a validation error · a number the page never shows in that scene ·
 *          speech/footage > 1.15 or < 0.5
 *   medium a warning · new/changed vs the base version · ratio 1.0–1.15 ·
 *          a name not on the page · a scene section without any [@mark]
 *   high   none of these (+ "unchanged since vN, where you approved it", D79)
 *
 * The base is the version a direction was drafted from (vo/script.vN.meta.json,
 * D83), else the previous version for the same take.
 */

import path from "node:path";
import { readAnalysis } from "../analysis/take.ts";
import { pageHas, spokenValues } from "../qa/numbers.ts";
import { readLayout } from "../recorder/layout.ts";
import { readVo, readVoMeta, voVersions } from "../vo/store.ts";
import { readState } from "../workdir/state.ts";
import { type ConfidenceSummary, type Reason, judge, summarize } from "./level.ts";

/** Whitespace-insensitive text (a comment line the agent adds is not a change). */
export const normText = (t: string) => t.replace(/\s+/g, " ").trim();

/** The version a VO version is compared with: its stored base, else the previous one of the same take. */
export function voBase(projectDir: string, version: number): number | undefined {
  const meta = readVoMeta(projectDir, version);
  if (meta?.base !== undefined) return meta.base;
  const take = safeTake(projectDir, version);
  return voVersions(projectDir)
    .filter((v) => v < version && safeTake(projectDir, v) === take)
    .at(-1);
}

function safeTake(projectDir: string, v: number): string | undefined {
  try {
    return readVo(projectDir, v)?.validated.script.take;
  } catch {
    return undefined;
  }
}

function safeBodies(projectDir: string, v: number): Map<string, string> | undefined {
  try {
    const vo = readVo(projectDir, v);
    return vo
      ? new Map(vo.validated.script.sections.map((s) => [s.key, normText(s.body)]))
      : undefined;
  } catch {
    return undefined;
  }
}

export function voConfidence(projectDir: string, version: number): ConfidenceSummary | undefined {
  const vo = readVo(projectDir, version);
  if (!vo) return undefined;
  const v = vo.validated;
  const takeDir = path.join(projectDir, "takes", v.script.take);
  const analysis = readAnalysis(takeDir);
  const snaps = readLayout(takeDir);
  const base = voBase(projectDir, version);
  const cache = new Map<number, Map<string, string> | undefined>();
  const bodies = (x: number) => {
    if (!cache.has(x)) cache.set(x, safeBodies(projectDir, x));
    return cache.get(x);
  };
  const baseBodies = base !== undefined ? bodies(base) : undefined;
  const state = readState(projectDir);
  const earlier = voVersions(projectDir).filter((x) => x < version);
  const items = v.script.sections.map((sec, i) => {
    const r: Reason[] = [];
    // The speech-vs-footage warning is covered by the ratio rule below.
    for (const is of v.issues.filter(
      (x) => x.section === sec.key && !/of speech for ~/.test(x.message),
    ))
      r.push({ level: is.level === "error" ? "low" : "medium", text: is.message });
    const t = v.timing.find((x) => x.section === sec.key);
    if (t && sec.kind === "scene") {
      if (t.ratio > 1.15)
        r.push({
          level: "low",
          text: `${t.speechSec.toFixed(0)} s of speech for ${t.usableSec.toFixed(0)} s of footage — the edit has to freeze`,
        });
      else if (t.ratio < 0.5)
        r.push({
          level: "low",
          text: `only ${t.speechSec.toFixed(0)} s of speech for ${t.usableSec.toFixed(0)} s of footage — long silence`,
        });
      else if (t.ratio > 1)
        r.push({
          level: "medium",
          text: `speech is a bit longer than the footage (${Math.round(t.ratio * 100)} %)`,
        });
    }
    if (sec.kind === "scene") {
      if (!sec.segments.some((g) => g.anchor))
        r.push({ level: "medium", text: "no [@mark] — nothing ties the words to the screen" });
      // Values said vs the scene's page text (marks + layout snapshots), like QA's value check (D71).
      const sc = analysis?.scenes.find((x) => x.id === sec.scene);
      if (sc) {
        const page = [
          ...sc.marks.map((m) => m.dom ?? ""),
          ...snaps
            .filter((s) => s.scene === sc.id)
            .map((s) =>
              s.els.map((e) => [e.text, e.name, e.value].filter(Boolean).join(" ")).join("\n"),
            ),
        ].join("\n");
        const spoken = v.resolved[i]?.segments.map((g) => g.text).join(" ") ?? "";
        const seen = new Set<string>();
        for (const val of spokenValues(spoken.split(/\s+/).filter(Boolean))) {
          if (seen.has(`${val.kind}:${val.value}`) || pageHas(page, val)) continue;
          seen.add(`${val.kind}:${val.value}`);
          r.push(
            val.kind === "number"
              ? { level: "low", text: `says “${val.said}” — not on the page in ${sc.id}` }
              : { level: "medium", text: `the name “${val.said}” isn't on the page in ${sc.id}` },
          );
        }
      }
    }
    if (baseBodies) {
      const before = baseBodies.get(sec.key);
      if (before === undefined) r.push({ level: "medium", text: `new since v${base}` });
      else if (before !== normText(sec.body))
        r.push({ level: "medium", text: `changed since v${base}` });
    }
    const approvedIn = [...earlier]
      .reverse()
      .find(
        (x) =>
          state?.voReviews?.[String(x)]?.scenes[sec.key]?.status === "approved" &&
          bodies(x)?.get(sec.key) === normText(sec.body),
      );
    return judge(sec.key, r, sec.confidence, approvedIn);
  });
  return summarize(items);
}
