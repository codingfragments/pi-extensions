/**
 * The deterministic half of the Annotation designer (S5 part 8, D52–D57).
 *
 *   suggest  the agent submits suggestions (type, scene, anchor, target, text,
 *            value 1–5, reason); the engine validates and resolves them, adds
 *            the privacy scan's redactions, weighs everything, pre-enables the
 *            recommended set, carries the user's changes from the base version
 *            (D56) and writes the next annotations/vN.json.
 *   import   carries what still matches from an older version (D57), no model.
 */

import fs from "node:fs";
import path from "node:path";
import type { Timeline } from "../edit/timeline.ts";
import { type LayoutSnapshot, readLayout } from "../recorder/layout.ts";
import { readStoryboard } from "../storyboard/store.ts";
import { parseVo } from "../vo/script.ts";
import { resolveContext } from "./apply.ts";
import { readAnnotations, validateAnnotations, writeAnnotations } from "./file.ts";
import { scanPrivacy } from "./privacy.ts";
import { type ResolvedAnnotation, resolveAnnotations, takeToSceneMs } from "./resolve.ts";
import {
  type AnnotationFile,
  type AnnotationItem,
  type AnnotationTarget,
  type AnnotationType,
  MAX_ZOOMS,
  userTouched,
} from "./types.ts";
import {
  type Emphasis,
  budgetOf,
  counted,
  formatBudget,
  noiseOf,
  recommend,
  valueBonus,
} from "./weights.ts";

/** What the agent submits per suggestion. */
export interface Suggestion {
  id?: string;
  type: AnnotationType;
  scene: string;
  anchor: AnnotationItem["anchor"];
  target?: AnnotationTarget;
  alternatives?: AnnotationTarget[];
  text?: string;
  durMs?: number;
  factor?: number;
  /** 1–5: how much this helps the viewer. */
  value: number;
  /** One line: why. */
  reason: string;
}

export interface DesignReport {
  version: number;
  added: number;
  enabled: number;
  kept: string[];
  dropped: { id: string; why: string }[];
  privacy: number;
  budget: string;
  warnings: string[];
}

const SHORT: Record<AnnotationType, string> = {
  zoom: "zoom",
  highlight: "hl",
  spotlight: "sp",
  redact: "rd",
  callout: "co",
  chapter: "ch",
};

/** Emphasis hints (storyboard) and narration anchors (VO), per scene. */
const addTo = <T>(m: Record<string, Set<T>>, k: string, v: T) => {
  const set = m[k] ?? new Set<T>();
  set.add(v);
  m[k] = set;
};

export function emphasisFor(projectDir: string, timeline: Timeline): Emphasis {
  const e: Emphasis = { stepMarks: {}, steps: {}, voMarks: {} };
  const sbVersion = readTakeStoryboardVersion(projectDir, timeline.take);
  const sb = readStoryboard(projectDir, sbVersion)?.storyboard;
  for (const sc of sb?.scenes ?? []) {
    sc.steps.forEach((st, i) => {
      if (!st.emphasis) return;
      addTo(e.steps, sc.id, i);
      if (st.mark) addTo(e.stepMarks, sc.id, st.mark);
    });
  }
  const vo = readVoText(projectDir, timeline.voVersion);
  if (vo) {
    for (const sec of parseVo(vo).sections)
      if (sec.scene && sec.kind === "scene")
        for (const seg of sec.segments) if (seg.anchor) addTo(e.voMarks, sec.scene, seg.anchor);
  }
  return e;
}

/** The VO script text (no validation — the take's analysis isn't needed here). */
export function readVoText(projectDir: string, version: number): string | undefined {
  const f = path.join(projectDir, "vo", `script.v${version}.md`);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : undefined;
}

export function readTakeStoryboardVersion(projectDir: string, take: string): number | undefined {
  const f = path.join(projectDir, "takes", take, "take.json");
  if (!fs.existsSync(f)) return undefined;
  const v = (JSON.parse(fs.readFileSync(f, "utf8")) as { storyboardVersion?: number })
    .storyboardVersion;
  return typeof v === "number" ? v : undefined;
}

const sameAnchor = (a: AnnotationItem["anchor"], b: AnnotationItem["anchor"]) =>
  JSON.stringify(a) === JSON.stringify(b);
const sameTarget = (a?: AnnotationTarget, b?: AnnotationTarget) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function uniqueId(base: string, taken: Set<string>): string {
  let n = 1;
  while (taken.has(`${base}-${n}`)) n++;
  const id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/**
 * Can each item be placed on this recording? Resolved one by one, so that
 * alternatives (two zoom candidates at the same moment) don't knock each
 * other out — only one of them will be enabled anyway.
 */
function placeEach(
  items: AnnotationItem[],
  timeline: Timeline,
  rc: ReturnType<typeof resolveContext>,
) {
  const out: ResolvedAnnotation[] = [];
  const why = new Map<string, string>();
  for (const it of items) {
    const r = resolveAnnotations(
      {
        version: 0,
        basedOn: { vo: timeline.voVersion },
        take: timeline.take,
        items: [{ ...it, enabled: true }],
      },
      rc,
    );
    const res = r.items[0];
    if (res) out.push(res);
    else
      why.set(
        it.id,
        (r.warnings[0] ?? `${it.id}: not placeable`)
          .slice(it.id.length + 2)
          .replace(/ — skipped$/, ""),
      );
  }
  return { items: out, why };
}

/** Privacy hits as disabled redact suggestions (D54), unless a redaction already covers the element. */
export function privacySuggestions(
  snaps: LayoutSnapshot[],
  timeline: Timeline,
  existing: AnnotationItem[],
  taken: Set<string>,
): AnnotationItem[] {
  const out: AnnotationItem[] = [];
  for (const hit of scanPrivacy(snaps)) {
    const sc = timeline.scenes.find((s) => s.id === hit.scene);
    if (!sc) continue;
    const covered = existing.some(
      (it) =>
        it.type === "redact" &&
        it.scene === hit.scene &&
        ((it.target && "layout" in it.target && it.target.layout === hit.ref) ||
          (it.target &&
            "box" in it.target &&
            it.target.box.x <= hit.box.x &&
            it.target.box.y <= hit.box.y &&
            it.target.box.x + it.target.box.w >= hit.box.x + hit.box.w &&
            it.target.box.y + it.target.box.h >= hit.box.y + hit.box.h)),
    );
    if (covered) continue;
    const at = takeToSceneMs(sc, hit.t);
    out.push({
      id: uniqueId(`rd-${hit.kind}`, taken),
      type: "redact",
      scene: hit.scene,
      anchor: at > 300 ? { sceneStart: true, offsetMs: Math.round(at) } : { sceneStart: true },
      target: { layout: hit.ref },
      enabled: false,
      origin: "suggested",
      reason: `privacy: ${hit.reason} (${hit.masked})`,
      weight: { value: 3, noise: 0 },
    });
  }
  return out;
}

/**
 * Turn the agent's suggestions into the next version. Never throws on a bad
 * suggestion: it is dropped and reported, so the agent can fix and resubmit.
 */
export function suggestAnnotations(o: {
  projectDir: string;
  timeline: Timeline;
  suggestions: Suggestion[];
  /** Re-suggest base (D56): its user-touched items are kept. */
  base?: number;
  instructions?: string;
  by?: string;
}): DesignReport {
  const warnings: string[] = [];
  const dropped: { id: string; why: string }[] = [];
  const baseFile = o.base !== undefined ? readAnnotations(o.projectDir, o.base) : undefined;
  if (o.base !== undefined && !baseFile) throw new Error(`annotations v${o.base} do not exist`);
  const kept = (baseFile?.items ?? []).filter(userTouched);
  const taken = new Set(kept.map((k) => k.id));
  const emphasis = emphasisFor(o.projectDir, o.timeline);
  const sceneIds = new Set(o.timeline.scenes.map((s) => s.id));

  const fresh: AnnotationItem[] = [];
  o.suggestions.forEach((sg, i) => {
    const label = sg.id ?? `suggestion ${i + 1}`;
    if (!sceneIds.has(sg.scene))
      return void dropped.push({ id: label, why: `scene "${sg.scene}" is not in the edit` });
    if (
      kept.some(
        (k) =>
          k.type === sg.type &&
          k.scene === sg.scene &&
          sameAnchor(k.anchor, sg.anchor) &&
          sameTarget(k.target, sg.target),
      )
    )
      return void dropped.push({ id: label, why: "the user already has this one (kept)" });
    let id: string;
    if (sg.id && !taken.has(sg.id)) {
      id = sg.id;
      taken.add(id);
    } else id = uniqueId(`${SHORT[sg.type] ?? sg.type}-${sg.scene.replace(/^\d+-/, "")}`, taken);
    const item: AnnotationItem = {
      id,
      type: sg.type,
      scene: sg.scene,
      anchor: sg.anchor,
      ...(sg.target ? { target: sg.target } : {}),
      ...(sg.alternatives?.length ? { alternatives: sg.alternatives } : {}),
      ...(sg.text ? { text: sg.text } : {}),
      ...(sg.durMs !== undefined ? { durMs: sg.durMs } : {}),
      ...(sg.factor !== undefined ? { factor: sg.factor } : {}),
      enabled: false,
      origin: "suggested",
      reason: sg.reason,
    };
    try {
      validateAnnotations({
        basedOn: { vo: o.timeline.voVersion },
        take: o.timeline.take,
        items: [item],
      });
    } catch (err) {
      return void dropped.push({
        id: label,
        why: (err as Error).message.replace(/^annotations: items\[0\]/, ""),
      });
    }
    const v = Math.max(1, Math.min(5, Math.round(sg.value)));
    const bonus = valueBonus(item, emphasis);
    item.weight = { value: Math.min(5, v + bonus.bonus), noise: noiseOf(item) };
    if (bonus.why) item.reason = `${item.reason} (+1: ${bonus.why})`;
    fresh.push(item);
  });

  // Resolve against the recording: unresolvable fresh suggestions are dropped with the reason.
  const rc = resolveContext(o.projectDir, o.timeline);
  const all = [...kept, ...fresh];
  const probe = placeEach(all, o.timeline, rc);
  const ok = new Set(probe.items.map((r) => r.id));
  for (const [id, why] of probe.why) {
    if (fresh.some((f) => f.id === id)) dropped.push({ id, why });
    else if (kept.some((k) => k.id === id)) warnings.push(`kept ${id}: ${why}`);
  }
  const placed = fresh.filter((f) => ok.has(f.id));

  // Privacy redactions (always disabled, outside the budget).
  const privacy = privacySuggestions(
    readLayout(rc.takeDir),
    o.timeline,
    [...kept, ...placed],
    taken,
  );

  // Recommended set over everything; the user's decisions are fixed.
  const items = [...kept, ...placed, ...privacy];
  const fixed = {
    on: new Set(kept.filter((k) => k.enabled).map((k) => k.id)),
    off: new Set(kept.filter((k) => !k.enabled).map((k) => k.id)),
  };
  const resolved = probe.items.filter((r) => ok.has(r.id));
  const rec = recommend(items, resolved, fixed);
  const optimum =
    Math.round(
      items
        .filter((it) => rec.has(it.id))
        .reduce((s, it) => s + (it.weight?.noise ?? noiseOf(it)), 0) * 100,
    ) / 100;
  for (const it of placed) it.enabled = rec.has(it.id) && counted(it.type);
  // Never more than the zoom cap, even if the user kept two and a third came in enabled.
  let zooms = 0;
  for (const it of items)
    if (it.enabled && it.type === "zoom" && ++zooms > MAX_ZOOMS) it.enabled = false;

  const stored = writeAnnotations(o.projectDir, {
    basedOn: { vo: o.timeline.voVersion },
    take: o.timeline.take,
    by: o.by ?? "annotation-designer",
    ...(o.base !== undefined ? { resuggestedFrom: o.base } : {}),
    ...(o.instructions ? { instructions: o.instructions } : {}),
    budget: { optimumNoise: optimum },
    items,
  });
  return {
    version: stored.version,
    added: placed.length,
    enabled: items.filter((x) => x.enabled).length,
    kept: kept.map((k) => k.id),
    dropped,
    privacy: privacy.length,
    budget: formatBudget(budgetOf(items, optimum)),
    warnings,
  };
}

export function formatDesignReport(r: DesignReport): string {
  const lines = [
    `Annotations v${r.version}: ${r.added} suggestion(s) placed, ${r.enabled} enabled${r.kept.length ? `, ${r.kept.length} of the user's kept (${r.kept.join(", ")})` : ""}${r.privacy ? `, ${r.privacy} privacy redaction(s) suggested (disabled — the user confirms)` : ""}.`,
    `Budget: ${r.budget}.`,
  ];
  if (r.dropped.length) {
    lines.push("Not placed (fix and resubmit, or leave out):");
    for (const d of r.dropped) lines.push(`- ${d.id}: ${d.why}`);
  }
  for (const w of r.warnings) lines.push(`! ${w}`);
  return lines.join("\n");
}

// --- import (D57) -----------------------------------------------------------------

export interface ImportReport {
  version: number;
  carried: string[];
  notCarried: { id: string; why: string }[];
}

/** An old layout ref → a text target on the new take (the element's text and role). */
function retarget(
  projectDir: string,
  oldTake: string,
  t: AnnotationTarget | undefined,
): AnnotationTarget | undefined {
  if (!t || !("layout" in t)) return t;
  const [, ms, id] = /^t(\d+)#(e\d+)$/.exec(t.layout) ?? [];
  const snap = readLayout(path.join(projectDir, "takes", oldTake)).find((s) => s.t === Number(ms));
  const el = snap?.els.find((e) => e.id === id);
  const text = (el?.text ?? el?.name)?.slice(0, 80);
  return text ? { text, role: (el as { role: string }).role } : t;
}

export function importAnnotations(o: {
  projectDir: string;
  timeline: Timeline;
  from: number;
}): ImportReport {
  const old = readAnnotations(o.projectDir, o.from);
  if (!old) throw new Error(`annotations v${o.from} do not exist`);
  const rc = resolveContext(o.projectDir, o.timeline);
  const sameTake = old.take === o.timeline.take;
  const candidates = old.items.map((it) =>
    sameTake
      ? it
      : {
          ...it,
          ...(it.target
            ? { target: retarget(o.projectDir, old.take, it.target) as AnnotationTarget }
            : {}),
        },
  );
  const probe = placeEach(candidates, o.timeline, rc);
  const ok = new Set(probe.items.map((r) => r.id));
  const notCarried = candidates
    .filter((c) => !ok.has(c.id))
    .map((c) => ({ id: c.id, why: probe.why.get(c.id) ?? "not placeable" }));
  const carried = candidates.filter((c) => ok.has(c.id));
  let zooms = 0;
  for (const it of carried)
    if (it.enabled && it.type === "zoom" && ++zooms > MAX_ZOOMS) it.enabled = false;
  const stored = writeAnnotations(o.projectDir, {
    basedOn: { vo: o.timeline.voVersion },
    take: o.timeline.take,
    by: "import",
    importedFrom: o.from,
    ...(old.budget ? { budget: old.budget } : {}),
    items: carried,
  });
  return { version: stored.version, carried: carried.map((c) => c.id), notCarried };
}

export const formatImportReport = (r: ImportReport) =>
  [
    `Annotations v${r.version}: imported ${r.carried.length} item(s).`,
    ...(r.notCarried.length
      ? ["Not carried:", ...r.notCarried.map((n) => `- ${n.id}: ${n.why}`)]
      : []),
  ].join("\n");

export type { AnnotationFile };
