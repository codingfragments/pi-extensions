/**
 * Annotation files (S5 part 7, D31–D37; docs/ANNOTATIONS.md).
 *
 *   annotations/vN.json  { version, basedOn: { vo: N }, take, items: [...] }
 *
 * Each item is one annotation, anchored to a moment of a scene and (for the
 * page-space types) to an element on screen. Render order:
 *   page space (on the recorded page, moves with zoom): redact → highlight → spotlight
 *   zoom
 *   screen space (on the finished frame): callout → chapter
 */

export const ANNOTATION_TYPES = [
  "zoom",
  "highlight",
  "spotlight",
  "redact",
  "callout",
  "chapter",
] as const;
export type AnnotationType = (typeof ANNOTATION_TYPES)[number];

/** When it happens, in the scene. */
export type Anchor =
  /** A storyboard mark (exact: uses the timeline's anchor time). */
  | { mark: string; offsetMs?: number }
  /** The start of the scene. */
  | { sceneStart: true; offsetMs?: number };

/** What it points at (page-space types and zoom). */
export type AnnotationTarget =
  /** The element a step acted on (its settled box when recorded with S5 part 6). */
  | { step: number }
  /** An element from the layout snapshot at the anchor whose text (or name) contains this; smallest match wins. */
  | { text: string; role?: string }
  /** An explicit layout element: "t<ms>#e<n>" (snapshot time + element id). */
  | { layout: string }
  /** An explicit box in CSS px of the viewport. */
  | { box: { x: number; y: number; w: number; h: number } };

export interface Weight {
  /** 1–5, from the designer (part 8). */
  value: number;
  /** Deterministic noise cost (part 8, Q7). */
  noise: number;
}

export interface AnnotationItem {
  id: string;
  type: AnnotationType;
  scene: string;
  anchor: Anchor;
  target?: AnnotationTarget;
  /** callout / chapter text (≤ 60 chars). */
  text?: string;
  /** How long it stays (ms); each type has a default. */
  durMs?: number;
  /** zoom factor (default 1.5, max 1.8). */
  factor?: number;
  enabled: boolean;
  /** Set by the designer (part 8); ignored by the renderer. */
  weight?: Weight;
  reason?: string;
  origin?: "suggested" | "edited" | "manual";
}

export interface AnnotationFile {
  version: number;
  basedOn: { vo: number };
  take: string;
  by?: string;
  importedFrom?: number;
  items: AnnotationItem[];
}

/** Defaults per type (ms) — see docs/ANNOTATIONS.md. */
export const DEFAULT_DURATION: Record<AnnotationType, number> = {
  zoom: 3500,
  highlight: 2000,
  spotlight: 1800,
  redact: 0, // 0 = from the anchor to the end of the scene
  callout: 2500,
  chapter: 2500,
};

/** How long before the anchor each type starts (it should be fully there at the event). */
export const LEAD_MS: Record<AnnotationType, number> = {
  zoom: 600,
  highlight: 150,
  spotlight: 300,
  redact: 0,
  callout: 150,
  chapter: 0,
};

export const FADE_MS: Record<AnnotationType, number> = {
  zoom: 0, // eased instead: 0.6 s in, 0.5 s out
  highlight: 200,
  spotlight: 300,
  redact: 0, // never fades: a blur that fades shows the secret
  callout: 150,
  chapter: 300,
};

/** Entry motion on top of the fade (px at 1080p; grow = start scale − 1). */
export const MOTION = {
  highlight: { grow: 0.06, ms: 260 },
  callout: { dy: 12, ms: 260 },
  chapter: { dx: -16, ms: 320 },
} as const satisfies Record<string, { dx?: number; dy?: number; grow?: number; ms: number }>;

export const ZOOM_IN_MS = 600;
export const ZOOM_OUT_MS = 500;
export const MAX_ZOOMS = 2;
export const MAX_ZOOM_FACTOR = 1.8;
export const MAX_TEXT = 60;
