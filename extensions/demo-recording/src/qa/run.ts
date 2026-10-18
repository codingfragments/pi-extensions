/**
 * Deterministic QA of a final render (S5 part 10, D69–D75) — the QA reviewer.
 *
 *   values       numbers/names the narration says vs. the page text at that moment (D71)
 *   footage      error toasts and console/page errors inside the used footage
 *   drift        Whisper on the rendered audio vs. each anchor's event (D72, D75)
 *   media        frozen picture, silence, black frames (ffmpeg detect filters)
 *   annotations  unplaceable items, redaction gaps, unredacted privacy hits
 *
 * Writes render/vN.qa.json + render/vN/qa-report.md; returns the summary for
 * the record. Blocking items gate "accept" until fixed or confirmed (D70, D73).
 */

import fs from "node:fs";
import path from "node:path";
import { norm } from "../align/align.ts";
import {
  dropSilentWords,
  envelope,
  onsetNear,
  refineOnsets,
  snapToOnset,
  speechOnsets,
} from "../align/onset.ts";
import { readAnalysis } from "../analysis/take.ts";
import { resolveContext } from "../annotations/apply.ts";
import { readVoText } from "../annotations/design.ts";
import { readAnnotations } from "../annotations/file.ts";
import { scanPrivacy } from "../annotations/privacy.ts";
import { resolveAnnotations, sceneMsToTake, takeToSceneMs } from "../annotations/resolve.ts";
import { resolveBrand } from "../brand/brand.ts";
import type { DemoRecConfig } from "../config.ts";
import { fullJob } from "../edit/render.ts";
import type { SceneTimeline, Timeline } from "../edit/timeline.ts";
import { ffmpeg, run } from "../media/ffmpeg.ts";
import type { TakeEvent } from "../recorder/events.ts";
import { type LayoutSnapshot, layoutAt, readLayout } from "../recorder/layout.ts";
import type { RenderRequest } from "../render/run.ts";
import type { RenderRecord, RenderVariantRec } from "../render/store.ts";
import { readManifest, whisperWords } from "../tts/synthesize.ts";
import { parseVo } from "../vo/script.ts";
import { placeFindings, sameFinding } from "./identity.ts";
import { applyIgnores } from "./ignores.ts";
import { checkIntegrity } from "./integrity.ts";
import { pageHas, spokenValues } from "./numbers.ts";
import { type RenderOverrides, applyShifts } from "./overrides.ts";
import { legacyLevels, summarize } from "./summary.ts";
import type {
  AnchorDiag,
  FindingIdentity,
  QaDiagnostics,
  QaFix,
  QaItem,
  QaReport,
  QaSummary,
} from "./types.ts";

/** A narration this far off its moment needs your eyes first (it is a warning, never a stop). */
export const DRIFT_HIGH_MS = 300;
export const DRIFT_WARN_MS = 150;
/** Measured vs the edit's plan: a bigger gap than this means the measurement or the render is off (D-QA-6). */
export const DRIFT_DISAGREE_MS = 300;

export const qaFile = (projectDir: string, v: number) =>
  path.join(projectDir, "render", `v${v}.qa.json`);

export function readQa(projectDir: string, v: number): QaReport | undefined {
  const f = qaFile(projectDir, v);
  return fs.existsSync(f)
    ? legacyLevels(JSON.parse(fs.readFileSync(f, "utf8")) as QaReport)
    : undefined;
}

/** The timeline a render used: the edit's, with that render's overrides applied. */
export function effectiveTimeline(projectDir: string, rec: RenderRecord): Timeline {
  const t = JSON.parse(
    fs.readFileSync(path.join(projectDir, "edit", `timeline.v${rec.timeline}.json`), "utf8"),
  ) as Timeline;
  const of = path.join(projectDir, "render", `v${rec.version}.overrides.json`);
  if (!fs.existsSync(of)) return t;
  const ov = JSON.parse(fs.readFileSync(of, "utf8")) as RenderOverrides;
  return applyShifts(projectDir, t, ov.shifts).timeline;
}

function timingOf(projectDir: string, t: Timeline, v: RenderVariantRec, root: string) {
  if (v.timing) return v.timing;
  const b = resolveBrand(root, v.brand).brand;
  const titleMs = b.title.enabled ? b.title.durationMs + b.title.dissolveMs : 0;
  const fj = fullJob(t, projectDir, { titleMs });
  return { titleMs, sceneStart: fj.sceneStart ?? {}, itemStart: fj.itemStart ?? [] };
}

function readEvents(takeDir: string): TakeEvent[] {
  const f = path.join(takeDir, "events.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as TakeEvent);
}

const pieceDur = (p: SceneTimeline["pieces"][number]) =>
  "src" in p ? (p.src[1] - p.src[0]) / p.speed : p.freeze.dur;
const secStr = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}.${String(Math.floor((ms % 1000) / 100))}`;

/** Section-audio ms → scene output ms (undefined when that audio was cut). */
function audioOut(sc: SceneTimeline, ms: number): number | undefined {
  const p = sc.audio.find((a) => ms >= a.src[0] - 1 && ms <= a.src[1] + 1);
  return p ? p.at + (ms - p.src[0]) : undefined;
}

export interface Ctx {
  projectDir: string;
  config: DemoRecConfig;
  rec: RenderRecord;
  t: Timeline;
  takeDir: string;
  snaps: LayoutSnapshot[];
  events: TakeEvent[];
  timing: { titleMs: number; sceneStart: Record<string, number>; itemStart: number[] };
  full: string;
  signal?: AbortSignal;
  /** Words with times from audio (default: Whisper). Tests and the calibration inject their own. */
  transcribe?: typeof whisperWords;
}

// --- values (D71) ---------------------------------------------------------------------

function domText(takeDir: string, mark: string): string {
  const f = path.join(takeDir, "dom", `${mark}.yaml`);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
}
const snapText = (s: LayoutSnapshot | undefined) =>
  s ? s.els.map((e) => [e.text, e.name, e.value].filter(Boolean).join(" ")).join("\n") : "";

export function checkValues(c: Ctx): QaItem[] {
  const items: QaItem[] = [];
  const m = readManifest(c.projectDir, c.t.voVersion);
  const vo = readVoText(c.projectDir, c.t.voVersion);
  if (!m || !vo) return items;
  const sections = parseVo(vo).sections;
  for (const sc of c.t.scenes) {
    const sec = m.sections[sc.id];
    const vsec = sections.find((s) => s.kind === "scene" && s.scene === sc.id);
    if (!sec || !vsec) continue;
    const start = c.timing.sceneStart[sc.id] ?? 0;
    const sceneSnaps = c.snaps.filter((s) => s.scene === sc.id);
    const sceneMarks = c.events
      .filter((e) => e.scene === sc.id && e.mark)
      .map((e) => e.mark as string);
    const sceneText = [
      ...sceneSnaps.map(snapText),
      ...sceneMarks.map((mk) => domText(c.takeDir, mk)),
    ].join("\n");
    vsec.segments.forEach((seg, k) => {
      const words = sec.alignment.words.filter((w) => w.seg === k);
      if (!words.length) return;
      for (const v of spokenValues(words.map((w) => w.w))) {
        const w = words[v.wordIndex];
        if (!w) continue;
        const said = audioOut(sc, w.s * 1000);
        if (said === undefined) continue;
        const saidTake = sceneMsToTake(sc, said);
        const atText = [
          snapText(layoutAt(sceneSnaps, saidTake)),
          seg.anchor ? domText(c.takeDir, seg.anchor) : "",
        ].join("\n");
        if (pageHas(atText, v)) continue;
        const identity: FindingIdentity = {
          ...(seg.anchor ? { anchor: seg.anchor } : {}),
          phrase: words.slice(0, 3).map((x) => norm(x.w)),
          value: v.kind === "number" ? v.value : v.said.toLowerCase(),
        };
        const label =
          v.kind === "number"
            ? `“${v.said}”${v.said.replace(/[^\d.]/g, "") !== v.value ? ` (${v.value})` : ""}`
            : `the name “${v.said}”`;
        if (pageHas(sceneText, v)) {
          const shownSnap = sceneSnaps.find((s) => pageHas(snapText(s), v));
          const shown = shownSnap ? takeToSceneMs(sc, shownSnap.t) : undefined;
          const later = shown !== undefined && shown > said + 200;
          items.push({
            id: "",
            check: "values",
            level: "warning",
            identity,
            scene: sc.id,
            atMs: start + said,
            message: `${label} is said at ${secStr(start + said)} but shown ${shown !== undefined ? `at ${secStr(start + shown)}` : "at another moment"} in ${sc.id}`,
          });
        } else
          items.push({
            id: "",
            check: "values",
            level: "warning",
            identity,
            ...(v.kind === "number" ? { high: true as const } : {}),
            scene: sc.id,
            atMs: start + said,
            message:
              v.kind === "number"
                ? `the narration says ${label} — it isn't on screen anywhere in ${sc.id}. Fix the number in the voice-over, or leave it if it is meant (e.g. a forecast)`
                : `${label} isn't on screen in ${sc.id} (names are checked loosely — a warning only)`,
          });
      }
    });
  }
  return items;
}

// --- footage ----------------------------------------------------------------------------

export function checkFootage(c: Ctx): QaItem[] {
  const items: QaItem[] = [];
  const analysis = readAnalysis(c.takeDir);
  const used = (scene: string, t: number) => {
    const sc = c.t.scenes.find((s) => s.id === scene);
    return (
      !!sc &&
      sc.pieces.some((p) =>
        "src" in p ? t >= p.src[0] && t <= p.src[1] : Math.abs(t - p.freeze.at) < 120,
      )
    );
  };
  for (const sc of c.t.scenes) {
    const start = c.timing.sceneStart[sc.id] ?? 0;
    const as = analysis?.scenes.find((s) => s.id === sc.id)?.alerts ?? [];
    for (const a of as) {
      if (!used(sc.id, a.t)) continue;
      const err = /err|danger|fail|crit/i.test(a.level);
      items.push({
        id: "",
        check: "footage",
        level: "warning",
        identity: { text: norm(a.text).slice(0, 80) },
        ...(err ? { high: true as const } : {}),
        scene: sc.id,
        atMs: start + takeToSceneMs(sc, a.t),
        message: `${err ? "an error" : `a ${a.level}`} message is on screen: “${a.text.slice(0, 120)}”${err ? " — re-record the scene, or leave it if it is part of the story" : ""}`,
      });
    }
    for (const e of c.events.filter(
      (x) => x.scene === sc.id && (x.type === "console-error" || x.type === "page-error"),
    )) {
      if (!used(sc.id, e.t)) continue;
      items.push({
        id: "",
        check: "footage",
        level: "warning",
        identity: {
          text: norm(String((e.data as { text?: string } | undefined)?.text ?? "")).slice(0, 80),
        },
        high: true,
        scene: sc.id,
        atMs: start + takeToSceneMs(sc, e.t),
        message: `the app logged ${e.type === "page-error" ? "an uncaught error" : "a console error"} during this part of the video: “${String((e.data as { text?: string } | undefined)?.text ?? "").slice(0, 120)}” — not visible, but the app may be in a broken state`,
      });
    }
  }
  return items;
}

// --- drift (D72, D75) --------------------------------------------------------------------

export async function checkDrift(
  c: Ctx,
): Promise<{ items: QaItem[]; whisper: boolean; diagnostics?: QaDiagnostics }> {
  const m = readManifest(c.projectDir, c.t.voVersion);
  const vo = readVoText(c.projectDir, c.t.voVersion);
  if (!m || !vo) return { items: [], whisper: false };
  const wav = path.join(
    path.dirname(qaFile(c.projectDir, c.rec.version)),
    `v${c.rec.version}.qa-audio.wav`,
  );
  const sections = parseVo(vo).sections;
  const said = Object.values(m.sections).flatMap((s) => s.alignment.words.map((w) => w.w));
  let heard: { w: string; s: number }[];
  let env: number[] = [];
  try {
    await ffmpeg(["-i", c.full, "-vn", "-ac", "1", "-ar", "16000", "-y", wav]);
    // Whisper's word starts are loose (±0.3 s after pauses): refine them on the audio
    // envelope, as the voice pipeline does, and snap each anchored word to its onset.
    env = await envelope(wav);
    const raw = await (c.transcribe ?? whisperWords)(wav, said.join(" "), c.config.align.model);
    heard = refineOnsets(dropSilentWords(raw, env), env).map((w) => ({ w: w.w, s: w.s }));
  } catch (err) {
    return {
      items: [
        {
          id: "",
          check: "drift",
          level: "warning",
          message: `sync not checked: Whisper isn't available (${(err as Error).message.split("\n")[0]}) — install uv + Python for full QA`,
        },
      ],
      whisper: false,
    };
  } finally {
    fs.rmSync(wav, { force: true });
  }
  const H = heard.map((h) => ({ n: norm(h.w), s: h.s * 1000 }));
  const onsets = speechOnsets(env);
  // The edit's own plan, before any render override moved the narration (P1a Q0).
  const original = readOriginalTimeline(c.projectDir, c.rec);
  const items: QaItem[] = [];
  const anchors: AnchorDiag[] = [];
  for (const sc of c.t.scenes) {
    const start = c.timing.sceneStart[sc.id] ?? 0;
    const sec = m.sections[sc.id];
    const vsec = sections.find((s) => s.kind === "scene" && s.scene === sc.id);
    if (!sec || !vsec) continue;
    for (const a of sc.anchors) {
      const k = vsec.segments.findIndex((s) => s.anchor === a.mark);
      const first = sec.alignment.words
        .filter((w) => w.seg === k)
        .slice(0, 2)
        .map((w) => norm(w.w));
      if (!first.length) continue;
      const expect = start + a.out;
      const diag: AnchorDiag = {
        scene: sc.id,
        mark: a.mark,
        eventMs: Math.round(expect),
        plannedAudioMs: Math.round(start + a.audioAt),
        plannedDriftMs: Math.round(a.audioAt - a.out - (a.hint ?? 0)),
        hintMs: a.hint ?? 0,
        editDriftMs: Math.round(
          original?.scenes.find((x) => x.id === sc.id)?.anchors.find((x) => x.mark === a.mark)
            ?.drift ?? a.audioAt - a.out,
        ),
        words: first,
        matches: 0,
        heard: [],
      };
      anchors.push(diag);
      const atPlan = onsetNear(onsets, diag.plannedAudioMs, 150);
      if (atPlan !== undefined) diag.onsetAtPlanMs = atPlan;
      let best: number | undefined;
      let bestAt = -1;
      let secondAt: number | undefined;
      for (let i = 0; i + first.length <= H.length; i++) {
        if (!first.every((f, j) => H[i + j]?.n === f)) continue;
        const ts = (H[i] as { s: number }).s;
        if (Math.abs(ts - expect) > 3000) continue;
        diag.matches++;
        if (best === undefined || Math.abs(ts - expect) < Math.abs(best - expect)) {
          best = ts;
          bestAt = i;
          secondAt = first.length > 1 ? H[i + 1]?.s : undefined;
        }
      }
      if (best === undefined) continue;
      diag.rawMeasuredMs = Math.round(best);
      diag.transcriptOnOnset = onsetNear(onsets, best, 100) !== undefined;
      diag.heard = H.slice(Math.max(0, bestAt - 2), bestAt + first.length + 3).map(
        (h) => [h.n, Math.round(h.s)] as [string, number],
      );
      // Whisper stretches a word that follows a pause back over the pause (the word starts early) and the
      // onset refinement then hands the onset to the NEXT word. The anchored narration starts at the first
      // speech onset around the first two words, so look for that; else snap the word start as before.
      const rawBest: number = best;
      const hi = Math.max(secondAt ?? rawBest, rawBest) + 150;
      const around = onsets.find((o) => o >= rawBest - 120 && o <= hi);
      best = around ?? snapToOnset(rawBest / 1000, env) * 1000;
      // measured against where the narration was MEANT to start: the event plus the timing hint (Q6)
      const drift = Math.round(best - expect - (a.hint ?? 0));
      diag.measuredMs = Math.round(best);
      diag.supported = around !== undefined || diag.transcriptOnOnset === true;
      diag.measuredDriftMs = drift;
      diag.gapMs = Math.round(best - diag.plannedAudioMs);
      const abs = Math.abs(drift);
      const disagree = Math.abs(diag.gapMs) > DRIFT_DISAGREE_MS;
      const identity: FindingIdentity = {
        anchor: a.mark,
        phrase: sec.alignment.words
          .filter((w) => w.seg === k)
          .slice(0, 3)
          .map((w) => norm(w.w)),
      };
      const planned = `the edit planned ${diag.plannedDriftMs >= 0 ? "+" : "−"}${Math.abs(diag.plannedDriftMs)} ms`;
      const moment = a.hint
        ? `where you set it (its moment ${a.hint > 0 ? "+" : "−"}${Math.abs(a.hint)} ms)`
        : "its moment";
      if (abs <= DRIFT_WARN_MS) {
        if (disagree)
          items.push({
            id: "",
            check: "drift",
            level: "info",
            identity,
            scene: sc.id,
            atMs: expect,
            message: `@${a.mark}: the measured narration is ${Math.abs(diag.gapMs)} ms ${diag.gapMs > 0 ? "after" : "before"} where the edit put it, though it lands on its moment: the measurement and the render disagree (see the diagnostics in the QA report)`,
          });
        continue;
      }
      items.push({
        id: "",
        check: "drift",
        level: "warning",
        identity,
        ...(abs > DRIFT_HIGH_MS ? { high: true as const } : {}),
        scene: sc.id,
        atMs: expect,
        message: `the narration for @${a.mark} starts ${abs} ms ${drift > 0 ? "after" : "before"} ${moment} (measured; ${planned})${disagree ? `: the two disagree by ${Math.abs(diag.gapMs)} ms${sidesWith(diag)}` : ""}${diag.supported ? "" : " — the measurement is not on a speech onset: it may be wrong"}`,
      });
    }
  }
  // How much was measured: the anchors the transcript did not contain are said, not skipped silently.
  const unmeasured = anchors.filter((a) => a.measuredDriftMs === undefined);
  if (unmeasured.length)
    items.push({
      id: "",
      check: "drift",
      level: "info",
      atMs: unmeasured[0]?.eventMs as number,
      moments: unmeasured.map((a) => a.eventMs),
      message: `the narration was measured at ${anchors.length - unmeasured.length} of ${anchors.length} anchors; at ${unmeasured.map((a) => `@${a.mark}`).join(", ")} the transcript did not contain the words, so sync is not checked there`,
    });
  return {
    items,
    whisper: true,
    diagnostics: {
      anchors,
      sceneStart: { ...c.timing.sceneStart },
      titleMs: c.timing.titleMs,
      heard: H.map((h) => [h.n, Math.round(h.s)] as [string, number]),
    },
  };
}

/** Who the audio onset agrees with when the transcript and the plan disagree: the way to tell which of the two is wrong. */
export function sidesWith(d: Pick<AnchorDiag, "transcriptOnOnset" | "onsetAtPlanMs">): string {
  if (d.transcriptOnOnset)
    return ": the transcript's word start is on a speech onset, so the measurement is probably right and the plan is off";
  if (d.onsetAtPlanMs !== undefined)
    return ": the audio has speech starting where the plan put it and the transcript's word start is not on an onset, so the measurement is probably off";
  return ", so the measurement or the render is off";
}

/** The edit's timeline as the edit wrote it (no render overrides). */
function readOriginalTimeline(projectDir: string, rec: RenderRecord): Timeline | undefined {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(projectDir, "edit", `timeline.v${rec.timeline}.json`), "utf8"),
    ) as Timeline;
  } catch {
    return undefined;
  }
}

// --- media ------------------------------------------------------------------------------

/** Windows (full ms) where the edit holds a frame on purpose: freezes, cards, the title hold. */
function heldWindows(c: Ctx): [number, number][] {
  const w: [number, number][] = [];
  c.t.full.forEach((item, i) => {
    const at = c.timing.itemStart[i] ?? 0;
    if (item.type === "card") w.push([at, at + item.durationMs]);
    else {
      const sc = c.t.scenes.find((s) => s.id === item.id);
      let out = at;
      for (const p of sc?.pieces ?? []) {
        const d = pieceDur(p);
        if (!("src" in p) || p.kind === "static" || p.kind === "dead") w.push([out, out + d]);
        out += d;
      }
    }
  });
  if (c.timing.titleMs) w.push([0, c.timing.titleMs]);
  return w;
}

export async function checkMedia(c: Ctx): Promise<QaItem[]> {
  const items: QaItem[] = [];
  const r = await run("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i",
    c.full,
    "-vf",
    "freezedetect=n=0.002:d=3,blackdetect=d=0.5:pix_th=0.08",
    "-af",
    "silencedetect=noise=-45dB:d=2.5",
    "-f",
    "null",
    "-",
  ]);
  const log = `${r.stdout}\n${r.stderr}`;
  const num = (re: RegExp) => [...log.matchAll(re)].map((m) => Number(m[1]) * 1000);
  const fs0 = num(/freeze_start: ([\d.]+)/g);
  const fe = num(/freeze_end: ([\d.]+)/g);
  const held = heldWindows(c);
  const overlapShare = (a: number, b: number) =>
    held.reduce((n, [x, y]) => n + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0) /
    Math.max(1, b - a);
  const heldFrames: { at: number; ms: number }[] = [];
  fs0.forEach((s, i) => {
    const e = fe[i] ?? (c.rec.variants[0]?.durationSec ?? 0) * 1000;
    const expected = overlapShare(s, e) >= 0.6;
    if (expected || e - s < 6000) {
      heldFrames.push({ at: s, ms: e - s });
      return;
    }
    items.push({
      id: "",
      check: "media",
      level: "warning",
      identity: { kind: "still" },
      atMs: s,
      message: `the picture stands still for ${((e - s) / 1000).toFixed(1)} s — a loading screen or a frozen page?`,
    });
  });
  // Held frames the edit made on purpose are noise one by one: one line, with where each is.
  if (heldFrames.length)
    items.push({
      id: "",
      check: "media",
      level: "info",
      identity: { kind: "held" },
      atMs: heldFrames[0]?.at as number,
      moments: heldFrames.map((h) => h.at),
      message: `${heldFrames.length} held frame${heldFrames.length === 1 ? "" : "s"} where the picture stands still (${(heldFrames.reduce((n, h) => n + h.ms, 0) / 1000).toFixed(1)} s in all, the longest ${(Math.max(...heldFrames.map((h) => h.ms)) / 1000).toFixed(1)} s): the edit holds a frame on purpose, or the picture is short`,
    });
  const ss = num(/silence_start: ([\d.]+)/g);
  const se = num(/silence_end: ([\d.]+)/g);
  const pauses: { at: number; ms: number }[] = [];
  ss.forEach((s, i) => {
    const e = se[i] ?? s;
    if (e - s >= 4000) {
      items.push({
        id: "",
        check: "media",
        level: "warning",
        identity: { kind: "pause" },
        atMs: s,
        message: `no narration for ${((e - s) / 1000).toFixed(1)} s — a long pause`,
      });
    } else pauses.push({ at: s, ms: e - s });
  });
  if (pauses.length)
    items.push({
      id: "",
      check: "media",
      level: "info",
      identity: { kind: "short-pauses" },
      atMs: pauses[0]?.at as number,
      moments: pauses.map((p) => p.at),
      message: `${pauses.length} short pause${pauses.length === 1 ? "" : "s"} in the narration (the longest ${(Math.max(...pauses.map((p) => p.ms)) / 1000).toFixed(1)} s)`,
    });
  for (const m of log.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)) {
    const s = Number(m[1]) * 1000;
    const e = Number(m[2]) * 1000;
    items.push({
      id: "",
      check: "media",
      level: "warning",
      identity: { kind: "black" },
      atMs: s,
      message: `a black picture for ${((e - s) / 1000).toFixed(1)} s`,
    });
  }
  return items;
}

// --- annotations ----------------------------------------------------------------------------

export function checkAnnotations(c: Ctx): QaItem[] {
  const items: QaItem[] = [];
  const v = c.rec.basedOn.annotations;
  const file = v !== undefined ? readAnnotations(c.projectDir, v) : undefined;
  const types = c.rec.options.annotationTypes;
  const included = (file?.items ?? []).filter(
    (it) => it.enabled && (types === "all" || types.includes(it.type)),
  );
  if (file && included.length) {
    const rc = { ...resolveContext(c.projectDir, c.t), timeline: c.t };
    const r = resolveAnnotations({ ...file, items: included }, rc);
    for (const w of r.warnings)
      items.push({
        id: "",
        check: "annotations",
        level: "warning",
        identity: { text: norm(w).slice(0, 100) },
        message: w,
      });
    // Redaction gaps: the redacted element's later positions must stay inside the redaction.
    for (const res of r.items.filter((x) => x.type === "redact" && x.box)) {
      const it = included.find((x) => x.id === res.id);
      const sc = c.t.scenes.find((s) => s.id === res.scene);
      if (!it?.target || !sc || !res.box) continue;
      let text: string | undefined;
      if ("text" in it.target) text = it.target.text;
      else if ("layout" in it.target) {
        const [, ms, id] = /^t(\d+)#(e\d+)$/.exec(it.target.layout) ?? [];
        const el = c.snaps.find((s) => s.t === Number(ms))?.els.find((e) => e.id === id);
        text = el?.text ?? el?.name;
      }
      if (!text) continue;
      const sx = rc.source.w / rc.viewport.width;
      const sy = rc.source.h / rc.viewport.height;
      const t0 = sceneMsToTake(sc, res.startMs);
      const t1 = sceneMsToTake(sc, res.endMs);
      for (const s of c.snaps.filter((x) => x.scene === res.scene && x.t >= t0 && x.t <= t1)) {
        for (const el of s.els.filter((e) => (e.text ?? e.name) === text)) {
          const b = { x: el.box.x * sx, y: el.box.y * sy, w: el.box.w * sx, h: el.box.h * sy };
          const inside =
            b.x >= res.box.x - 8 &&
            b.y >= res.box.y - 8 &&
            b.x + b.w <= res.box.x + res.box.w + 8 &&
            b.y + b.h <= res.box.y + res.box.h + 8;
          if (!inside) {
            items.push({
              id: "",
              check: "annotations",
              level: "blocking",
              hard: "redaction",
              identity: { ref: res.id },
              scene: res.scene,
              atMs: (c.timing.sceneStart[res.scene] ?? 0) + takeToSceneMs(sc, s.t),
              message: `redaction ${res.id} doesn't cover its element here — it moved; add a redaction for its new position`,
            });
            break;
          }
        }
      }
    }
  }
  // Privacy hits that this render shows unredacted.
  const redacts = included.filter((x) => x.type === "redact");
  for (const h of scanPrivacy(c.snaps)) {
    const sc = c.t.scenes.find((s) => s.id === h.scene);
    if (!sc) continue;
    const covered = redacts.some(
      (r) => r.scene === h.scene && r.target && "layout" in r.target && r.target.layout === h.ref,
    );
    if (covered) continue;
    items.push({
      id: "",
      check: "annotations",
      level: "warning",
      identity: { ref: h.ref },
      scene: h.scene,
      atMs: (c.timing.sceneStart[h.scene] ?? 0) + takeToSceneMs(sc, h.t),
      message: `possibly private data on screen, not redacted: ${h.reason} (${h.masked})`,
    });
  }
  return items;
}

// --- run ------------------------------------------------------------------------------------

export async function runQa(o: {
  projectDir: string;
  config: DemoRecConfig;
  rec: RenderRecord;
  signal?: AbortSignal;
}): Promise<QaSummary> {
  const v = o.rec.variants[0];
  if (!v) throw new Error(`render v${o.rec.version} has no variants`);
  const full = path.join(o.projectDir, v.dir, v.files.full);
  if (!fs.existsSync(full)) throw new Error(`render v${o.rec.version} has no video files any more`);
  const t = effectiveTimeline(o.projectDir, o.rec);
  const takeDir = path.join(o.projectDir, "takes", t.take);
  const c: Ctx = {
    projectDir: o.projectDir,
    config: o.config,
    rec: o.rec,
    t,
    takeDir,
    snaps: readLayout(takeDir),
    events: readEvents(takeDir),
    timing: timingOf(o.projectDir, t, v, o.config.root),
    full,
    ...(o.signal ? { signal: o.signal } : {}),
  };
  const previous = readQa(o.projectDir, o.rec.version);
  const drift = await checkDrift(c);
  const items = [
    ...checkValues(c),
    ...checkFootage(c),
    ...drift.items,
    ...(await checkMedia(c)),
    ...(await checkIntegrity({
      projectDir: o.projectDir,
      rec: o.rec,
      full,
      expectedMs: t.totals.fullMs,
      expectsAudio:
        t.scenes.some((s) => s.audio.length > 0) || t.full.some((i) => i.type === "card"),
    })),
    ...checkAnnotations(c),
  ];
  const order = { blocking: 0, warning: 1, info: 2 } as const;
  items.sort((a, b) => order[a.level] - order[b.level] || (a.atMs ?? 0) - (b.atMs ?? 0));
  placeFindings(items, c.timing.sceneStart);
  items.forEach((it, i) => {
    it.id = `${it.check}-${i + 1}`;
    // Keep confirmations across re-runs when the same issue is found again (by what it is, not its numbers).
    const same = previous?.items.find(
      (p) =>
        p.confirmed &&
        !p.confirmed.reason.startsWith("ignored (") &&
        (sameFinding(p, it) || (p.check === it.check && p.message === it.message)),
    );
    if (same?.confirmed) it.confirmed = same.confirmed;
  });
  // What you decided to leave alone covers its findings again, and ends when its content changed (Q2)
  applyIgnores(o.projectDir, o.rec, items);
  const report: QaReport = {
    render: o.rec.version,
    variant: v.key,
    createdAt: new Date().toISOString(),
    whisper: drift.whisper,
    items,
    ...(drift.diagnostics ? { diagnostics: drift.diagnostics } : {}),
    stage: "render",
    version: o.rec.version,
    ...(drift.diagnostics
      ? {
          coverage: {
            anchors: {
              measured: drift.diagnostics.anchors.filter((a) => a.measuredDriftMs !== undefined)
                .length,
              total: drift.diagnostics.anchors.length,
            },
          },
        }
      : {}),
  };
  for (const it of report.items) {
    it.stage = "render";
    it.version = o.rec.version;
  }
  fs.writeFileSync(qaFile(o.projectDir, o.rec.version), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(
    path.join(o.projectDir, "render", `v${o.rec.version}`, "qa-report.md"),
    formatQaMarkdown(report),
  );
  return summarize(items, report.createdAt);
}

/** Never throws: a failing QA becomes status "error" on the record. */
export async function runQaSafe(o: {
  projectDir: string;
  config: DemoRecConfig;
  rec: RenderRecord;
  signal?: AbortSignal;
}): Promise<QaSummary> {
  try {
    return await runQa(o);
  } catch (err) {
    return {
      status: "error",
      blocking: 0,
      confirmed: 0,
      warnings: 0,
      info: 0,
      ranAt: new Date().toISOString(),
      error: (err as Error).message,
    };
  }
}

/** Confirm a blocking item ("export anyway", D73). */
export function confirmItem(
  projectDir: string,
  version: number,
  id: string,
  reason: string,
  now = new Date(),
): { report: QaReport; summary: QaSummary } {
  const report = readQa(projectDir, version);
  if (!report) throw new Error(`render v${version} has no QA report — run QA first`);
  const it = report.items.find((x) => x.id === id);
  if (!it) throw new Error(`QA item ${id} is not in the report of render v${version}`);
  if (it.level !== "blocking")
    throw new Error(`${id} is a ${it.level}, not a hard stop — it does not need a confirmation`);
  if (it.hard === "integrity")
    throw new Error(
      `${id} is a broken file, not a judgement call — it cannot be confirmed: render again`,
    );
  if (reason.trim().length < 3)
    throw new Error("a reason is required — why is it fine to export anyway?");
  it.confirmed = { at: now.toISOString(), reason: reason.trim().slice(0, 500) };
  fs.writeFileSync(qaFile(projectDir, version), `${JSON.stringify(report, null, 2)}\n`);
  return { report, summary: summarize(report.items, report.createdAt) };
}

/** Why a final can't be accepted yet (undefined = it can, D70). */
export function qaBlocker(rec: RenderRecord): string | undefined {
  if (rec.kind !== "final") return undefined;
  if (!rec.qa) return "QA has not run on this final — Re-run QA first";
  if (rec.qa.status === "error") return `QA failed to run (${rec.qa.error}) — Re-run QA`;
  if (rec.qa.status === "blocked")
    return `QA found ${rec.qa.blocking - rec.qa.confirmed} hard stop(s): a broken file needs a new render, a redaction that leaks needs a fix`;
  return undefined;
}

export function formatQa(report: QaReport, summary: QaSummary): string {
  const head = `QA of render v${report.render} (${report.variant}): ${summary.status} — ${summary.blocking} hard stop(s)${summary.confirmed ? ` (${summary.confirmed} confirmed)` : ""}, ${summary.high ?? 0} need your eyes, ${summary.warnings} warning(s) in all, ${summary.info} info${summary.ignored ? `, ${summary.ignored} ignored by you` : ""}${report.whisper ? "" : " · sync not checked (no Whisper)"}`;
  const lines = [head];
  for (const it of report.items.filter((i) => i.level !== "info"))
    lines.push(
      `- [${it.level === "blocking" ? "HARD STOP" : it.high ? "needs your eyes" : it.level}${it.confirmed ? ", confirmed" : ""}${it.ignored ? `, ignored: ${it.ignored.reason}` : ""}] ${it.atMs !== undefined ? `${secStr(it.atMs)} ` : ""}${it.message}`,
    );
  return lines.join("\n");
}

export function formatQaMarkdown(report: QaReport): string {
  const s = summarize(report.items, report.createdAt);
  const lines = [
    `# QA — render v${report.render}`,
    "",
    `Status: **${s.status}** · ${s.blocking} blocking (${s.confirmed} confirmed) · ${s.warnings} warnings · ${s.info} info · checked ${report.createdAt}`,
    "",
  ];
  for (const level of ["blocking", "warning", "info"] as const) {
    const xs = report.items.filter((i) => i.level === level);
    if (!xs.length) continue;
    lines.push(`## ${level}`, "");
    for (const it of xs)
      lines.push(
        `- ${it.atMs !== undefined ? `\`${secStr(it.atMs)}\` ` : ""}${it.scene ? `(${it.scene}) ` : ""}${it.message}${it.confirmed ? ` — **confirmed**: ${it.confirmed.reason}` : ""}${it.ignored ? ` — **ignored** (${it.ignored.scope}, since render v${it.ignored.since}): ${it.ignored.reason}` : ""}`,
      );
    lines.push("");
  }
  const d = report.diagnostics;
  if (d?.anchors.length) {
    const ms = (n: number | undefined) => (n === undefined ? "n/a" : `${n > 0 ? "+" : ""}${n}`);
    lines.push(
      "## Sync diagnostics",
      "",
      "Per anchor, in ms of the full video. *measured* is what the transcript of the rendered audio says; *planned* is what the edit planned;",
      "*edit* is the edit's own plan before any render override. *gap* = measured audio start − planned audio start: it should be near zero.",
      "*transcript on an onset* and *onset at plan* are a second look at the rendered audio: does the transcript's word start sit on a speech onset (a rise out of at least 150 ms of quiet), and is there an onset where the plan put the narration? A word start in the middle of a pause is a transcript that stretched the word: not to be trusted.",
      "",
      "| scene | anchor | event | measured drift | planned drift | edit drift | gap | matches | transcript on an onset | onset at plan |",
      "|---|---|---:|---:|---:|---:|---:|---:|:---:|---:|",
      ...d.anchors.map(
        (a) =>
          `| ${a.scene} | @${a.mark} | ${a.eventMs} | ${ms(a.measuredDriftMs)} | ${ms(a.plannedDriftMs)} | ${ms(a.editDriftMs)} | ${ms(a.gapMs)} | ${a.matches} | ${a.transcriptOnOnset === undefined ? "n/a" : a.transcriptOnOnset ? "yes" : "no"} | ${a.onsetAtPlanMs === undefined ? "no" : "yes"} |`,
      ),
      "",
    );
  }
  return lines.join("\n");
}

function readRenderRecord(projectDir: string, v: number): RenderRecord {
  const f = path.join(projectDir, "render", `v${v}.json`);
  if (!fs.existsSync(f)) throw new Error(`render v${v} does not exist`);
  return JSON.parse(fs.readFileSync(f, "utf8")) as RenderRecord;
}

/** A render version for bus events (log cleanup): one line + the facts the popup shows. */
export function renderEvent(projectDir: string, rec: RenderRecord): Record<string, unknown> {
  const bytes = rec.variants.reduce((n, v) => n + v.bytes, 0);
  const q = rec.qa ? readQa(projectDir, rec.version) : undefined;
  const qa = rec.qa
    ? {
        ...rec.qa,
        firstBlocking: (q?.items ?? [])
          .filter((i) => i.level === "blocking" && !i.confirmed)
          .slice(0, 3)
          .map((i) => i.message),
      }
    : null;
  const qaText =
    rec.kind !== "final"
      ? ""
      : !rec.qa
        ? " · QA not run"
        : rec.qa.status === "blocked"
          ? ` · QA: ${rec.qa.blocking - rec.qa.confirmed} blocking`
          : rec.qa.status === "error"
            ? " · QA error"
            : " · QA ✓";
  return {
    message: `${rec.kind} render v${rec.version} ${rec.status === "done" ? "ready" : rec.status} · ${rec.variants.length} flavor(s) · ${(bytes / 1e6).toFixed(1)} MB${qaText}`,
    version: rec.version,
    kind: rec.kind,
    status: rec.status,
    basedOn: rec.basedOn,
    timeline: rec.timeline,
    options: rec.options,
    brands: rec.brands,
    size: rec.size,
    lengthSec: rec.variants[0]?.durationSec ?? null,
    bytes,
    flavors: rec.variants.map((v) => ({
      key: v.key,
      dir: v.dir,
      files: v.files,
      bytes: v.bytes,
      ...(v.reusedFrom ? { reusedFrom: v.reusedFrom } : {}),
    })),
    ...(qa ? { qa } : {}),
    ...(rec.overrides ? { overrides: rec.overrides } : {}),
    ...(rec.error ? { error: rec.error } : {}),
  };
}

export { summarize };
