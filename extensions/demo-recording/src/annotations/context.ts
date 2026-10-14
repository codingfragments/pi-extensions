/**
 * The Annotation designer's input pack (S5 part 8, D52): everything the agent
 * needs to suggest annotations, as compact text — per scene its duration, the
 * marks with their output times, the narration at each anchor, the director's
 * emphasis hints, the steps and their targets, and the elements on screen at
 * each mark (with refs the agent can use as targets). Plus privacy hits, the
 * caps and the noise table, and the user's kept items for a re-suggest.
 */

import fs from "node:fs";
import path from "node:path";
import type { Timeline } from "../edit/timeline.ts";
import type { TakeEvent } from "../recorder/events.ts";
import {
  type LayoutElement,
  type LayoutSnapshot,
  layoutAt,
  readLayout,
} from "../recorder/layout.ts";
import { readStoryboard } from "../storyboard/store.ts";
import { parseVo } from "../vo/script.ts";
import { readVo } from "../vo/store.ts";
import { readTakeStoryboardVersion } from "./design.ts";
import { readAnnotations } from "./file.ts";
import { scanPrivacy } from "./privacy.ts";
import { takeToSceneMs } from "./resolve.ts";
import { MAX_TEXT, MAX_ZOOMS, MAX_ZOOM_FACTOR, userTouched } from "./types.ts";
import { BASE_NOISE } from "./weights.ts";

const PRIORITY: Record<string, number> = {
  heading: 0,
  button: 1,
  textbox: 1,
  searchbox: 1,
  cell: 1,
  text: 1,
  row: 2,
  columnheader: 3,
  link: 3,
};
const MAX_ELEMENTS = 40;
/** Numbers are what narrations talk about: rank them first. */
const rank = (e: LayoutElement) => (PRIORITY[e.role] ?? 2) - (/\d/.test(e.text ?? "") ? 2 : 0);

const sec = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
const boxStr = (b: LayoutElement["box"]) =>
  `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}×${Math.round(b.h)}`;

/** The most useful elements of a snapshot: short texts, meaningful roles, no duplicates. */
export function pickElements(s: LayoutSnapshot, max = MAX_ELEMENTS): LayoutElement[] {
  const seen = new Set<string>();
  return s.els
    .filter((e) => {
      const t = (e.text ?? e.name ?? "").trim();
      return t.length > 0 && t.length <= 80 && e.box.w >= 4 && e.box.h >= 4;
    })
    .sort((a, b) => rank(a) - rank(b) || a.box.w * a.box.h - b.box.w * b.box.h)
    .filter((e) => {
      const k = (e.text ?? e.name ?? "").trim().toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, max)
    .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
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

export function annotationContext(o: {
  projectDir: string;
  timeline: Timeline;
  timelineVersion: number;
  /** Re-suggest base: the user's kept items are listed. */
  base?: number;
  instructions?: string;
}): string {
  const t = o.timeline;
  const takeDir = path.join(o.projectDir, "takes", t.take);
  const snaps = readLayout(takeDir);
  const events = readEvents(takeDir);
  const sb = readStoryboard(
    o.projectDir,
    readTakeStoryboardVersion(o.projectDir, t.take),
  )?.storyboard;
  const vo = readVo(o.projectDir, t.voVersion);
  const sections = vo ? parseVo(vo.text).sections : [];
  const L: string[] = [];
  L.push(`Annotation input pack — edit v${o.timelineVersion} (${t.take}, VO v${t.voVersion}).`);
  L.push(
    `Caps: ≤ ${MAX_ZOOMS} zooms per demo (1.1–${MAX_ZOOM_FACTOR}×, default 1.5), callout/chapter text ≤ ${MAX_TEXT} chars, one callout at a time, no two annotations on the same region at the same time.`,
  );
  L.push(
    `Noise per type: callout ${BASE_NOISE.callout}, highlight ${BASE_NOISE.highlight}, zoom ${BASE_NOISE.zoom}, spotlight ${BASE_NOISE.spotlight}; chapter and redact 0 (outside the budget, off by default). Spotlight is only enabled at value 5.`,
  );
  L.push(
    "Suggest about 2× as many as should be on; the engine enables the best half (value per noise). Coordinates are CSS px; targets: { step: n }, { text, role? }, { layout: ref }, { box }.",
  );
  if (!snaps.length)
    L.push(
      "⚠ This take has no layout snapshots (recorded before S5 part 6): use { step } or { box } targets only.",
    );
  for (const sc of t.scenes) {
    const story = sb?.scenes.find((s) => s.id === sc.id);
    L.push("", `## ${sc.id} — ${sc.title} (${sec(sc.durationMs)})`);
    if (story?.emphasis) L.push(`emphasis (scene): ${story.emphasis}`);
    // steps
    const stepEvents = events.filter(
      (e) => e.scene === sc.id && e.step !== undefined && e.type !== "target-settled",
    );
    if (story?.steps.length) {
      L.push("steps:");
      story.steps.forEach((st, i) => {
        const ev =
          stepEvents.find((e) => e.step === i && e.box) ?? stepEvents.find((e) => e.step === i);
        const settled = events.find(
          (e) => e.scene === sc.id && e.step === i && e.type === "target-settled",
        );
        const box = settled?.box ?? ev?.box;
        const when = ev ? ` at ${sec(takeToSceneMs(sc, ev.t))}` : "";
        const tgt = "target" in st && st.target ? ` ${JSON.stringify(st.target)}` : "";
        L.push(
          `  ${i} ${st.do}${tgt}${st.mark ? ` @${st.mark}` : ""}${when}${box ? ` box ${boxStr(box)}` : " (no element)"}${st.emphasis ? ` ✦ ${st.emphasis}` : ""}`,
        );
      });
    }
    // narration
    const vsec = sections.find((s) => s.kind === "scene" && s.scene === sc.id);
    if (vsec) {
      L.push("narration:");
      for (const seg of vsec.segments) {
        const a = seg.anchor ? sc.anchors.find((x) => x.mark === seg.anchor) : undefined;
        L.push(
          `  [${seg.anchor ? `@${seg.anchor} ${a ? sec(a.out) : "?"}` : "start 0.00 s"}] ${seg.text.replace(/\s+/g, " ").trim()}`,
        );
      }
    }
    // marks + on-screen elements
    const marks = events.filter((e) => e.scene === sc.id && e.mark && e.type !== "target-settled");
    const moments: { label: string; t: number }[] = marks.map((m) => ({
      label: `@${m.mark}`,
      t: m.t,
    }));
    const firstSnap = snaps.find((s) => s.scene === sc.id);
    if (firstSnap && !moments.some((m) => m.t <= firstSnap.t + 300))
      moments.unshift({ label: "scene start", t: firstSnap.t });
    let lastKey = "";
    let lastLabel = "";
    for (const m of moments) {
      const snap =
        snaps.find(
          (s) => s.scene === sc.id && s.reason === "mark" && s.mark === m.label.slice(1),
        ) ??
        layoutAt(
          snaps.filter((s) => s.scene === sc.id),
          m.t + 50,
        );
      if (!snap) continue;
      const els = pickElements(snap);
      const key = `${snap.url}|${els.map((e) => `${e.text}@${Math.round(e.box.x)},${Math.round(e.box.y)}`).join("|")}`;
      if (key === lastKey) {
        L.push(
          `on screen at ${m.label} (${sec(takeToSceneMs(sc, m.t))}): same screen as ${lastLabel} (refs t${snap.t}#… also valid)`,
        );
        continue;
      }
      lastKey = key;
      lastLabel = m.label;
      L.push(
        `on screen at ${m.label} (${sec(takeToSceneMs(sc, m.t))}, snapshot t${snap.t}, ${snap.els.length} elements, ${els.length} shown):`,
      );
      for (const e of els)
        L.push(
          `  t${snap.t}#${e.id} ${e.role} "${(e.text ?? e.name ?? "").trim()}" ${boxStr(e.box)}`,
        );
    }
  }
  const hits = scanPrivacy(snaps);
  L.push(
    "",
    hits.length
      ? "Privacy scan (the engine adds these as disabled redactions — add names it can't see):"
      : "Privacy scan: nothing found by pattern (emails, phones, keys, IBAN/cards, long IDs). Judge person/company names yourself; suggest redactions disabled.",
  );
  for (const h of hits) L.push(`  ${h.scene} ${h.ref} ${h.kind}: ${h.masked}`);
  if (o.base !== undefined) {
    const base = readAnnotations(o.projectDir, o.base);
    const kept = (base?.items ?? []).filter(userTouched);
    L.push(
      "",
      `Re-suggest based on v${o.base}: the user's ${kept.length} changed item(s) are kept as they are — don't suggest them again:`,
    );
    for (const k of kept)
      L.push(
        `  ${k.id} ${k.type} ${k.scene} ${JSON.stringify(k.anchor)}${k.text ? ` "${k.text}"` : ""} ${k.enabled ? "on" : "off"}`,
      );
  }
  if (o.instructions) L.push("", `Instructions from the user: ${o.instructions}`);
  return L.join("\n");
}
