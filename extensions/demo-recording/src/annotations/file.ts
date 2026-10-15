/**
 * Read, validate and version annotation files (`annotations/vN.json`).
 * Validation is strict about structure and the hard caps (≤ 2 zooms per demo,
 * zoom ≤ 1.8×, texts ≤ 60 chars, no overlapping zooms); everything that
 * depends on the recording (marks, targets) is checked when resolving.
 */

import fs from "node:fs";
import path from "node:path";
import { listVersions, writeNextVersion } from "../workdir/versioning.ts";
import {
  ANNOTATION_TYPES,
  type AnnotationFile,
  type AnnotationItem,
  type AnnotationType,
  MAX_TEXT,
  MAX_ZOOMS,
  MAX_ZOOM_FACTOR,
} from "./types.ts";

export const annotationsDir = (projectDir: string) => path.join(projectDir, "annotations");

export function annotationVersions(projectDir: string): number[] {
  return listVersions(annotationsDir(projectDir), "v", ".json");
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function isTarget(v: unknown): boolean {
  if (!isObj(v)) return false;
  return (
    typeof v.step === "number" ||
    (typeof v.text === "string" && v.text.trim().length > 0) ||
    (typeof v.layout === "string" && /^t\d+#e\d+$/.test(v.layout)) ||
    (isObj(v.box) &&
      ["x", "y", "w", "h"].every((k) => typeof (v.box as Record<string, unknown>)[k] === "number"))
  );
}

/** Validate a parsed annotation file. Throws with a path-precise message. */
export function validateAnnotations(raw: unknown): AnnotationFile {
  const fail = (where: string, msg: string): never => {
    throw new Error(`annotations: ${where} ${msg}`);
  };
  if (!isObj(raw)) return fail("", "must be an object");
  if (!isObj(raw.basedOn) || typeof raw.basedOn.vo !== "number")
    fail("basedOn.vo", "must name the voice-over version (a number)");
  if (typeof raw.take !== "string" || !/^take-\d{3,}$/.test(raw.take))
    fail("take", 'must be a take id like "take-006"');
  if (!Array.isArray(raw.items)) return fail("items", "must be a list");
  const ids = new Set<string>();
  const items = raw.items.map((it, i): AnnotationItem => {
    const at = `items[${i}]`;
    if (!isObj(it)) return fail(at, "must be an object");
    if (typeof it.id !== "string" || !it.id) fail(`${at}.id`, "is required");
    if (ids.has(it.id as string)) fail(`${at}.id`, `"${it.id}" is used twice`);
    ids.add(it.id as string);
    if (!ANNOTATION_TYPES.includes(it.type as AnnotationType))
      fail(`${at}.type`, `must be one of ${ANNOTATION_TYPES.join(", ")}`);
    const type = it.type as AnnotationType;
    if (typeof it.scene !== "string" || !it.scene) fail(`${at}.scene`, "is required");
    const a = it.anchor;
    if (
      !isObj(a) ||
      !(
        typeof a.mark === "string" ||
        a.sceneStart === true ||
        (typeof a.word === "string" && a.word.trim().length > 0)
      )
    )
      fail(
        `${at}.anchor`,
        'must be { mark: "…" }, { sceneStart: true } or { word: "…", occurrence? }',
      );
    const occ = (a as Record<string, unknown>).occurrence;
    if (occ !== undefined && !(Number.isInteger(occ) && (occ as number) >= 1))
      fail(`${at}.anchor.occurrence`, "must be 1, 2, …");
    if (
      (a as Record<string, unknown>).offsetMs !== undefined &&
      typeof (a as Record<string, unknown>).offsetMs !== "number"
    )
      fail(`${at}.anchor.offsetMs`, "must be a number");
    const needsTarget =
      type === "zoom" || type === "highlight" || type === "spotlight" || type === "redact";
    const tg = it.target;
    if (needsTarget && !isObj(tg)) fail(`${at}.target`, `is required for ${type}`);
    if (tg !== undefined && !isTarget(tg))
      fail(
        `${at}.target`,
        'must be { step }, { text, role? }, { layout: "t<ms>#e<n>" } or { box: {x,y,w,h} }',
      );
    if (it.alternatives !== undefined) {
      if (!Array.isArray(it.alternatives)) fail(`${at}.alternatives`, "must be a list of targets");
      (it.alternatives as unknown[]).forEach((alt, k) => {
        if (!isTarget(alt)) fail(`${at}.alternatives[${k}]`, "must be a target like `target`");
      });
    }
    if (type === "callout" || type === "chapter") {
      if (typeof it.text !== "string" || !it.text.trim())
        fail(`${at}.text`, `is required for ${type}`);
      if ((it.text as string).length > MAX_TEXT)
        fail(`${at}.text`, `must be ≤ ${MAX_TEXT} characters — it marks, it doesn't narrate`);
    }
    if (
      it.durMs !== undefined &&
      (typeof it.durMs !== "number" || it.durMs < 0 || it.durMs > 30000)
    )
      fail(`${at}.durMs`, "must be 0..30000");
    if (
      it.factor !== undefined &&
      (typeof it.factor !== "number" || it.factor < 1.1 || it.factor > MAX_ZOOM_FACTOR)
    )
      fail(`${at}.factor`, `must be 1.1..${MAX_ZOOM_FACTOR}`);
    if (typeof it.enabled !== "boolean") fail(`${at}.enabled`, "must be true or false");
    return it as unknown as AnnotationItem;
  });
  const zooms = items.filter((x) => x.enabled && x.type === "zoom");
  if (zooms.length > MAX_ZOOMS)
    fail(
      "items",
      `has ${zooms.length} enabled zooms — at most ${MAX_ZOOMS} per demo (they lose their effect)`,
    );
  return {
    version: typeof raw.version === "number" ? raw.version : 0,
    basedOn: { vo: (raw.basedOn as { vo: number }).vo },
    take: raw.take as string,
    ...(typeof raw.by === "string" ? { by: raw.by } : {}),
    ...(typeof raw.importedFrom === "number" ? { importedFrom: raw.importedFrom } : {}),
    ...(typeof raw.resuggestedFrom === "number" ? { resuggestedFrom: raw.resuggestedFrom } : {}),
    ...(typeof raw.editedFrom === "number" ? { editedFrom: raw.editedFrom } : {}),
    ...(typeof raw.instructions === "string" ? { instructions: raw.instructions } : {}),
    ...(isObj(raw.budget) && typeof raw.budget.optimumNoise === "number"
      ? { budget: { optimumNoise: raw.budget.optimumNoise } }
      : {}),
    items,
  };
}

export function readAnnotations(projectDir: string, version?: number): AnnotationFile | undefined {
  const v = version ?? annotationVersions(projectDir).at(-1);
  if (v === undefined) return undefined;
  const file = path.join(annotationsDir(projectDir), `v${v}.json`);
  if (!fs.existsSync(file)) return undefined;
  const parsed = validateAnnotations(JSON.parse(fs.readFileSync(file, "utf8")));
  return { ...parsed, version: v };
}

/** Validate and store as the next version. */
export function writeAnnotations(
  projectDir: string,
  data: Omit<AnnotationFile, "version">,
): AnnotationFile {
  const check = validateAnnotations({ ...data, version: 0 });
  const stored = writeNextVersion(
    annotationsDir(projectDir),
    "v",
    ".json",
    `${JSON.stringify({ ...data, version: 0 }, null, 2)}\n`,
  );
  // Write the real version number into the file.
  const full: AnnotationFile = { ...check, version: stored.version };
  fs.writeFileSync(stored.file, `${JSON.stringify(full, null, 2)}\n`);
  return full;
}
