/**
 * What a take leaves behind when a step did not finish, the take was interrupted, or a scene failed (`takes/take-N/diagnostics/<kind>-<n>/`). The aim is that the next
 * person (or the next version of the engine) can tell what was happening without having been there:
 *
 *   README.txt        what happened in words, the verdict (where it is stuck) and what each file is
 *   context.json      the action that did not finish (scene, step, its definition, expected and allowed time, how long it ran), the take's own state (time, attempt,
 *                     segments, retries, stalls, progress), the settings, the machine
 *   events-tail.jsonl the last 40 events of the take
 *   probes.json       which questions the browser still answered, and how fast (see browser/diagnosis.ts)
 *   page.jpg, aria.yaml  the page as far as it still answers; last-frame.jpg the last frame the capture got
 *   ps.txt, *.sample.txt  the browser's processes and their native stacks (a stall only; macOS `sample`)
 */

import fs from "node:fs";
import path from "node:path";
import {
  fmtProcesses,
  probeBrowser,
  runtimeFacts,
  sampleBrowser,
  verdictOf,
} from "../browser/diagnosis.ts";
import { processesOf } from "../browser/processes.ts";
import type { BrowserSession } from "../browser/session.ts";
import type { Step } from "../storyboard/types.ts";
import type { TakeEvent } from "./events.ts";
import type { ProgressSnapshot } from "./progress.ts";

export type DiagKind = "stalled" | "interrupted" | "failed";

export interface DiagInfo {
  kind: DiagKind;
  /** The n-th of its kind in this take. */
  n: number;
  takeDir: string;
  takeId: string;
  storyboardVersion: number;
  scene?: { id: string; title: string; index: number; total: number };
  step?: {
    index: number;
    total: number;
    definition: Step;
    expectedMs: number;
    allowedMs: number;
    ranMs: number;
  };
  attempt: number;
  stallsSoFar: number;
  retriesSoFar: number;
  takeTimeMs: number;
  /** The error message that ended the step, when there was one. */
  error?: string;
  session?: BrowserSession;
  marker?: string;
  lastFrame?: string;
  cursor?: { x: number; y: number };
  headed: boolean;
  settings: Record<string, unknown>;
  events: TakeEvent[];
  progress?: ProgressSnapshot;
  segments: { index: number; offset: number }[];
}

/** Collect everything, never throw, and finish in a few seconds even when the browser answers nothing. Returns the folder and its files (paths relative to the take). */
export async function collectDiagnostics(
  info: DiagInfo,
): Promise<{ dir: string; files: string[]; verdict: string }> {
  const name = `${info.kind}-${info.n}`;
  const dir = path.join(info.takeDir, "diagnostics", name);
  const rel = (f: string) => path.relative(info.takeDir, f);
  const files: string[] = [];
  let verdict = "no browser to ask";
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stall = info.kind === "stalled";
    const [probes, samples] = await Promise.all([
      info.session
        ? probeBrowser(info.session, { filesDir: dir })
        : Promise.resolve([] as Awaited<ReturnType<typeof probeBrowser>>),
      stall && info.marker
        ? sampleBrowser(info.marker, dir, "browser")
        : Promise.resolve([] as string[]),
    ]);
    if (probes.length) {
      verdict = verdictOf(probes);
      fs.writeFileSync(
        path.join(dir, "probes.json"),
        `${JSON.stringify({ verdict, probes }, null, 2)}\n`,
      );
      files.push(path.join(dir, "probes.json"));
      for (const f of ["page.jpg", "aria.yaml"])
        if (fs.existsSync(path.join(dir, f))) files.push(path.join(dir, f));
    }
    if (info.marker) {
      const rows = processesOf(info.marker);
      fs.writeFileSync(path.join(dir, "ps.txt"), `${fmtProcesses(rows)}\n`);
      files.push(path.join(dir, "ps.txt"));
    }
    files.push(...samples);
    fs.writeFileSync(
      path.join(dir, "events-tail.jsonl"),
      info.events
        .slice(-40)
        .map((e) => `${JSON.stringify(e)}\n`)
        .join(""),
    );
    files.push(path.join(dir, "events-tail.jsonl"));
    if (info.lastFrame) {
      const src = path.join(info.takeDir, "frames", info.lastFrame);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(dir, "last-frame.jpg"));
        files.push(path.join(dir, "last-frame.jpg"));
      }
    }
    const context = {
      kind: info.kind,
      at: new Date().toISOString(),
      verdict,
      take: info.takeId,
      storyboardVersion: info.storyboardVersion,
      takeTimeMs: info.takeTimeMs,
      scene: info.scene,
      step: info.step,
      attempt: info.attempt,
      stallsSoFar: info.stallsSoFar,
      retriesSoFar: info.retriesSoFar,
      error: info.error,
      cursor: info.cursor,
      headed: info.headed,
      segments: info.segments,
      progress: info.progress,
      settings: info.settings,
      machine: runtimeFacts(),
    };
    fs.writeFileSync(path.join(dir, "context.json"), `${JSON.stringify(context, null, 2)}\n`);
    files.push(path.join(dir, "context.json"));
    const s = info.step;
    const readme = [
      `${info.kind.toUpperCase()} in ${info.takeId}${info.scene ? `, scene ${info.scene.id} (${info.scene.index}/${info.scene.total}) “${info.scene.title}”` : ""}${s ? `, step ${s.index + 1}/${s.total} (${s.definition.do})` : ""}`,
      s
        ? `The step was expected to take ${(s.expectedMs / 1000).toFixed(1)} s, was allowed ${(s.allowedMs / 1000).toFixed(0)} s, and had run ${(s.ranMs / 1000).toFixed(1)} s when this was written.`
        : "",
      `Take time ${(info.takeTimeMs / 1000).toFixed(1)} s, attempt ${info.attempt}, ${info.stallsSoFar} stall(s) and ${info.retriesSoFar} retry(ies) so far.`,
      info.error ? `Error: ${info.error}` : "",
      `Verdict: ${verdict}`,
      "",
      "Files: context.json (the step, the take's state, settings, machine), events-tail.jsonl (the last 40 events), probes.json (what the browser still answered and how fast),",
      "page.jpg / aria.yaml (the page, if it still answers), last-frame.jpg (the last frame the capture received), ps.txt and browser.<pid>.sample.txt (processes and native stacks).",
    ]
      .filter((l) => l !== "")
      .join("\n");
    fs.writeFileSync(path.join(dir, "README.txt"), `${readme}\n`);
    files.unshift(path.join(dir, "README.txt"));
  } catch {
    // collecting must never be what breaks the take
  }
  return { dir: rel(dir), files: files.map(rel), verdict };
}
