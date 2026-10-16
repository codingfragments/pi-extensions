/**
 * Project facts in `brief.md` (S5 part 5a, D48): the brief stays the single
 * source — the agent reads it as prose, the Project tab edits its fields as
 * a form. A field is a bullet line `- **Label:** value`; placeholders
 * (`_TODO_`, `_…_`, `<…>`) count as empty.
 *
 * Depth (poc | showcase | sales) sets defaults for stance and target length;
 * the brief can override both.
 */

export type Depth = "poc" | "showcase" | "sales";
export type Stance = "champion" | "evaluator" | "teacher";

export const DEPTHS: readonly Depth[] = ["poc", "showcase", "sales"];
export const STANCES: readonly Stance[] = ["champion", "evaluator", "teacher"];

/** Depth defaults (D48 grill): stance and target length in seconds. */
export const DEPTH_DEFAULTS: Record<
  Depth,
  { stance: Stance; length: [number, number]; label: string }
> = {
  poc: {
    stance: "evaluator",
    length: [180, 300],
    label: "PoC — depth over breadth, honest limits, numbers",
  },
  showcase: {
    stance: "teacher",
    length: [120, 180],
    label: "Showcase — broad tour of polished features",
  },
  sales: {
    stance: "champion",
    length: [60, 90],
    label: "Sales — few flows tied to outcomes, a call to action",
  },
};

export interface BriefField {
  key: string;
  label: string;
  /** Older labels still read (e.g. Audience → Persona). */
  aliases?: string[];
}

export const BRIEF_FIELDS: BriefField[] = [
  { key: "app", label: "App" },
  { key: "url", label: "URL" },
  { key: "extraUrls", label: "Extra URLs" },
  { key: "title", label: "Title" },
  { key: "subtitle", label: "Subtitle" },
  { key: "persona", label: "Persona", aliases: ["Audience"] },
  { key: "depth", label: "Depth" },
  { key: "stance", label: "Stance" },
  { key: "goal", label: "Goal / key message", aliases: ["Goal"] },
  { key: "length", label: "Target length" },
  { key: "mustShow", label: "Must show" },
  { key: "mustAvoid", label: "Must avoid" },
  { key: "language", label: "Language" },
  { key: "voice", label: "Voice" },
  /** The project's default voice direction (D82): "stance: evaluator · tone: calm · length: same · focus: … · notes: …". */
  { key: "voiceDirection", label: "Voice direction" },
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const lineRe = (label: string) =>
  new RegExp(`^([ \\t]*[-*][ \\t]+\\*\\*${esc(label)}:?\\*\\*:?)[ \\t]*(.*)$`, "im");

export const isPlaceholder = (v: string) =>
  !v.trim() || /^_.*_$/.test(v.trim()) || /^<.*>$/.test(v.trim()) || /\btodo\b/i.test(v);

/** One field's value (undefined when missing or a placeholder). */
export function briefFieldValue(
  brief: string,
  label: string,
  aliases: string[] = [],
): string | undefined {
  for (const l of [label, ...aliases]) {
    const v = lineRe(l).exec(brief)?.[2]?.trim();
    if (v !== undefined) return isPlaceholder(v) ? undefined : v;
  }
  return undefined;
}

export type BriefFacts = Partial<Record<string, string>>;

export function readBriefFacts(brief: string): BriefFacts {
  const out: BriefFacts = {};
  for (const f of BRIEF_FIELDS) {
    const v = briefFieldValue(brief, f.label, f.aliases);
    if (v !== undefined) out[f.key] = v;
  }
  return out;
}

export function parseDepth(v: string | undefined): Depth | undefined {
  const s = v?.trim().toLowerCase();
  if (!s) return undefined;
  if (s.startsWith("poc") || s.includes("proof")) return "poc";
  if (s.startsWith("show")) return "showcase";
  if (s.startsWith("sale")) return "sales";
  return undefined;
}

export function parseStance(v: string | undefined): Stance | undefined {
  const s = v?.trim().toLowerCase();
  return STANCES.find((x) => s === x || s?.startsWith(x));
}

/**
 * Parse a target length like "3–4 min", "60-90 s", "2:30–3:30", "90s",
 * "3 min". Returns seconds [min, max] (single value → ±15 %).
 */
export function parseTargetLength(v: string | undefined): [number, number] | undefined {
  if (!v) return undefined;
  const s = v
    .toLowerCase()
    .replace(/total|about|approx\.?|~/g, "")
    .trim();
  const unitMin = /\bmin/.test(s);
  const nums = [...s.matchAll(/(\d+(?::\d{2})?(?:[.,]\d+)?)/g)].map((m) => {
    const t = m[1] as string;
    if (t.includes(":")) {
      const [mm, ss] = t.split(":").map(Number);
      return (mm as number) * 60 + (ss as number);
    }
    const n = Number(t.replace(",", "."));
    return unitMin ? n * 60 : n;
  });
  if (!nums.length) return undefined;
  const a = nums[0] as number;
  const b = nums[1] ?? a;
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return lo === hi
    ? [Math.round(lo * 0.85), Math.round(hi * 1.15)]
    : [Math.round(lo), Math.round(hi)];
}

export const formatLength = ([lo, hi]: [number, number]) => {
  const f = (sec: number) => (sec >= 120 && sec % 30 === 0 ? `${sec / 60} min` : `${sec} s`);
  return lo >= 120 && hi >= 120 && lo % 30 === 0 && hi % 30 === 0
    ? `${lo / 60}–${hi / 60} min`
    : `${f(lo)}–${f(hi)}`;
};

export interface EffectiveFacts {
  facts: BriefFacts;
  depth?: Depth;
  /** Stance from the brief, else the depth default. */
  stance?: Stance;
  stanceFromDepth: boolean;
  /** Target length in seconds from the brief, else the depth default. */
  length?: [number, number];
  lengthFromDepth: boolean;
  extraUrls: string[];
}

export function effectiveFacts(brief: string): EffectiveFacts {
  const facts = readBriefFacts(brief);
  const depth = parseDepth(facts.depth);
  const explicitStance = parseStance(facts.stance);
  const explicitLength = parseTargetLength(facts.length);
  const def = depth ? DEPTH_DEFAULTS[depth] : undefined;
  return {
    facts,
    ...(depth ? { depth } : {}),
    ...(explicitStance ? { stance: explicitStance } : def ? { stance: def.stance } : {}),
    stanceFromDepth: !explicitStance && !!def,
    ...(explicitLength ? { length: explicitLength } : def ? { length: def.length } : {}),
    lengthFromDepth: !explicitLength && !!def,
    extraUrls: (facts.extraUrls ?? "")
      .split(/[\s,]+/)
      .map((u) => u.trim())
      .filter((u) => /^https?:\/\//.test(u)),
  };
}

/**
 * Set fields in the brief text. Existing lines are replaced in place (aliases
 * renamed to the current label); missing ones are inserted after the last
 * field line of the first bullet block (before "## …"). Empty value = remove.
 */
export function setBriefFacts(brief: string, patch: BriefFacts): string {
  let text = brief;
  for (const [key, raw] of Object.entries(patch)) {
    const f = BRIEF_FIELDS.find((x) => x.key === key);
    if (!f)
      throw new Error(
        `unknown brief field "${key}" (known: ${BRIEF_FIELDS.map((x) => x.key).join(", ")})`,
      );
    const value = (raw ?? "").replace(/\s*\n\s*/g, " ").trim();
    const labels = [f.label, ...(f.aliases ?? [])];
    const hit = labels.map((l) => ({ l, m: lineRe(l).exec(text) })).find((x) => x.m);
    if (hit?.m) {
      text = value
        ? text.replace(hit.m[0], `- **${f.label}:** ${value}`)
        : text.replace(new RegExp(`${esc(hit.m[0])}\\n?`), "");
      continue;
    }
    if (!value) continue;
    const lines = text.split("\n");
    let insertAt = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*[-*]\s+\*\*[^*]+:?\*\*/.test(lines[i] as string)) insertAt = i;
      else if (insertAt >= 0 && /^##\s/.test(lines[i] as string)) break;
    }
    if (insertAt < 0) {
      const h = lines.findIndex((l) => /^#\s/.test(l));
      lines.splice(h + 1, 0, "", `- **${f.label}:** ${value}`);
    } else lines.splice(insertAt + 1, 0, `- **${f.label}:** ${value}`);
    text = lines.join("\n");
  }
  return text;
}

/** One line of the Project summary (D124). */
export interface BriefSummaryRow {
  key: "persona" | "goal" | "depth" | "length" | "voice" | "url";
  label: string;
  /** The value in human terms, null when there is none. */
  value: string | null;
  /** Where a derived value comes from ("from depth showcase"). */
  note?: string;
  /** One of persona, goal, depth and URL: what the demo-brief skill asks for first. */
  essential: boolean;
  missing: boolean;
}

export interface BriefSummary {
  rows: BriefSummaryRow[];
  /** The labels of the missing essentials, in order. */
  missing: string[];
  /** Nothing essential is filled in yet: a new project. */
  empty: boolean;
}

/**
 * The brief in human terms (D124): audience, goal, depth, length, voice and the app URL, and which of the
 * essentials (persona, goal, depth, URL) are missing. Orientation only: nothing is gated on it. Length and
 * stance are never "missing": they fall back to the depth default and say so.
 */
export function briefSummary(brief: string, app: { baseUrl?: string }): BriefSummary {
  const e = effectiveFacts(brief);
  const f = e.facts;
  const has = (v: string | undefined) => !!v && !isPlaceholder(v);
  const url = has(f.url) ? (f.url as string) : (app.baseUrl ?? "");
  const rows: BriefSummaryRow[] = [
    {
      key: "persona",
      label: "Audience",
      value: has(f.persona) ? (f.persona as string) : null,
      essential: true,
      missing: !has(f.persona),
    },
    {
      key: "goal",
      label: "Goal",
      value: has(f.goal) ? (f.goal as string) : null,
      essential: true,
      missing: !has(f.goal),
    },
    {
      key: "depth",
      label: "Depth",
      value: e.depth ?? null,
      ...(e.depth ? { note: DEPTH_DEFAULTS[e.depth].label.split(" — ")[0] ?? "" } : {}),
      essential: true,
      missing: !e.depth,
    },
    {
      key: "length",
      label: "Length",
      value: e.length ? formatLength(e.length) : null,
      ...(e.length && e.lengthFromDepth && e.depth ? { note: `from depth ${e.depth}` } : {}),
      essential: false,
      missing: false,
    },
    {
      key: "voice",
      label: "Voice",
      value: has(f.voice) && f.voice?.toLowerCase() !== "default" ? (f.voice as string) : null,
      essential: false,
      missing: false,
    },
    { key: "url", label: "App URL", value: url || null, essential: true, missing: !url },
  ];
  const missing = rows.filter((r) => r.missing).map((r) => r.label);
  return {
    rows,
    missing,
    empty: rows.filter((r) => r.essential).every((r) => r.missing || r.key === "url"),
  };
}
