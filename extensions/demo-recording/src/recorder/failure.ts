/**
 * Why a take failed, as data. The runner used to leave only an error string; the panel and the Director's note need the scene, the step, how many tries it took and
 * what ended it, and a way to say it in words.
 */

import fs from "node:fs";
import path from "node:path";
import type { Storyboard } from "../storyboard/types.ts";

export interface TakeFailure {
  /**
   * retries: a scene failed more often than `maxRetriesPerScene`; stalls: the browser froze more often than a take survives; no-resume: the scene cannot be shot
   * again without repeating state changes; setup: the take could not start; error: anything else.
   */
  kind: "retries" | "stalls" | "no-resume" | "setup" | "error";
  scene?: string;
  /** 0-based step of the scene, when known. */
  step?: number;
  /** Attempts the scene had (for `retries`). */
  attempts?: number;
  stalls: number;
  message: string;
}

const first = (s: string) => s.split("\n", 1)[0] ?? s;

/** The failure in a sentence a person reads: where, what, after how much. */
export function failureWords(f: TakeFailure, storyboard?: Storyboard): string {
  const scene = f.scene ? storyboard?.scenes.find((s) => s.id === f.scene) : undefined;
  const where = f.scene
    ? `scene ${f.scene}${scene?.title ? ` (${scene.title})` : ""}${f.step !== undefined ? `, step ${f.step + 1}${scene?.steps[f.step] ? ` (${scene.steps[f.step]?.do})` : ""}` : ""}`
    : "the take";
  // the message already starts with "scene X, step N (do): " for a step that failed: say only what went wrong
  const what =
    first(f.message).replace(/^scene \S+, step \d+ \([a-z]+\)( did not finish[^:]*)?:?\s*/i, "") ||
    first(f.message);
  switch (f.kind) {
    case "retries":
      return `${where} failed after ${f.attempts ?? "several"} attempt${f.attempts === 1 ? "" : "s"}: ${what}`;
    case "stalls":
      return `the browser froze ${f.stalls} times in ${where}, more than a take survives: ${what}`;
    case "no-resume":
      return `${where} failed and cannot be shot again without repeating state changes (it has no deep link): ${what}`;
    case "setup":
      return `the take could not start: ${what}`;
    default:
      return `${where} failed: ${what}`;
  }
}

export interface FailedTake {
  take: string;
  status: string;
  storyboardVersion: number;
  failure: TakeFailure;
  /** The failure in words. */
  words: string;
  /** Folders under the take with the diagnosis, newest last. */
  diagnostics: string[];
  /** The diagnosis's own verdict (where the browser was stuck), when there is one. */
  verdict?: string;
}

/** A take that did not complete, as the panel and the Director's note need it. Undefined for a take that is fine or does not exist. */
export function readFailedTake(
  projectDir: string,
  take: string,
  storyboard?: Storyboard,
): FailedTake | undefined {
  const dir = path.join(projectDir, "takes", take);
  let meta: {
    status?: string;
    storyboardVersion?: number;
    error?: string;
    failure?: TakeFailure;
    stalls?: number;
    diagnostics?: string[];
  };
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, "take.json"), "utf8"));
  } catch {
    return undefined;
  }
  if (meta.status !== "failed") return undefined;
  const failure: TakeFailure = meta.failure ?? {
    kind: "error",
    stalls: meta.stalls ?? 0,
    message: meta.error ?? "unknown error",
  };
  const diagnostics = meta.diagnostics ?? [];
  let verdict: string | undefined;
  for (const d of [...diagnostics].reverse()) {
    try {
      const m = /^Verdict: (.+)$/m.exec(fs.readFileSync(path.join(dir, d, "README.txt"), "utf8"));
      if (m?.[1]) {
        verdict = m[1];
        break;
      }
    } catch {
      // a diagnosis that was not written
    }
  }
  return {
    take,
    status: meta.status,
    storyboardVersion: meta.storyboardVersion ?? 0,
    failure,
    words: failureWords(failure, storyboard),
    diagnostics,
    ...(verdict ? { verdict } : {}),
  };
}

/** What the recommendation box starts with: the evidence, for you to complete. */
export function recommendationDraft(f: FailedTake): string {
  return `${f.words}.${f.verdict ? ` The diagnosis says: ${f.verdict}.` : ""}\n\nWhat I would change: `;
}
