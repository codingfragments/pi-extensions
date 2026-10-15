/**
 * Cost estimate before synthesis (D84): which sections the engine would
 * synthesize vs take from the content cache, how many characters that is,
 * ElevenLabs credits (flash/turbo models bill 0.5 credit per character), and
 * money from `tts.pricePer1kChars` (list-price defaults, editable).
 *
 * Free to run: it only checks engine health (no synthesis).
 */

import fs from "node:fs";
import path from "node:path";
import type { DemoRecConfig } from "../config.ts";
import type { Runtime } from "../runtime.ts";
import type { VoSection } from "../vo/script.ts";
import { readVo } from "../vo/store.ts";
import { readState, requireSelected } from "../workdir/state.ts";
import type { TtsEngine } from "./engines.ts";
import { buildEngines } from "./factory.ts";
import { audioDir, cacheKey, modelFromIdentity, selectEngine } from "./synthesize.ts";

export interface TtsEstimate {
  engine: string;
  voice: { id: string; name: string };
  model: string | null;
  sections: { key: string; chars: number; cached: boolean }[];
  toSynthesize: number;
  cached: number;
  chars: number;
  /** ElevenLabs credits (null for other engines). */
  credits: number | null;
  /** Money estimate with the configured price (0 for free engines). */
  cost: number;
  currency: string;
  /** "per 1,000 credits" / "per 1,000 characters". */
  priceUnit: string;
  price: number;
  /** Engines skipped on the way (no key, voice not found, …). */
  skipped: { engine: string; reason: string }[];
}

/** Text an engine speaks for a section (same as the synthesizer). */
export const spokenText = (s: VoSection) =>
  s.segments
    .map((g) => g.text)
    .join(" ")
    .trim();

/** Credits per character for an ElevenLabs model. */
export const creditRate = (model: string | undefined) =>
  /flash|turbo/i.test(model ?? "") ? 0.5 : 1;

export async function estimateTts(
  projectDir: string,
  sections: VoSection[],
  engines: TtsEngine[],
  cfg: DemoRecConfig,
  signal?: AbortSignal,
): Promise<TtsEstimate> {
  const pick = await selectEngine(engines, signal);
  const voice = pick.health.voice as { id: string; name: string };
  const identity = pick.engine.identity(voice.id);
  const model = modelFromIdentity(identity) ?? null;
  const cache = path.join(audioDir(projectDir), "cache");
  const rows = sections
    .filter((s) => s.body.trim())
    .map((s) => {
      const text = spokenText(s);
      const key = cacheKey(identity, text);
      const cached =
        fs.existsSync(path.join(cache, `${key}.wav`)) &&
        fs.existsSync(path.join(cache, `${key}.json`));
      return { key: s.key, chars: text.length, cached };
    });
  const chars = rows.filter((r) => !r.cached).reduce((n, r) => n + r.chars, 0);
  const eleven = pick.engine.id === "elevenlabs";
  const credits = eleven ? Math.ceil(chars * creditRate(model ?? undefined)) : null;
  const price =
    cfg.tts.pricePer1kChars[pick.engine.id as keyof DemoRecConfig["tts"]["pricePer1kChars"]] ?? 0;
  return {
    engine: pick.engine.id,
    voice,
    model,
    sections: rows,
    toSynthesize: rows.filter((r) => !r.cached).length,
    cached: rows.filter((r) => r.cached).length,
    chars,
    credits,
    cost: +((((credits ?? chars) as number) / 1000) * price).toFixed(2),
    currency: cfg.tts.currency,
    priceUnit: eleven ? "per 1,000 credits" : "per 1,000 characters",
    price,
    skipped: pick.skipped,
  };
}

export function formatEstimate(e: TtsEstimate): string {
  return (
    `${e.engine} “${e.voice.name}”${e.model ? ` (${e.model})` : ""}: ${e.toSynthesize} of ${e.sections.length} section(s) to synthesize, ${e.cached} cached · ` +
    `${e.chars.toLocaleString("en-US")} characters${e.credits !== null ? ` · ≈ ${e.credits.toLocaleString("en-US")} credits` : ""}` +
    `${e.price > 0 ? ` · ≈ ${e.currency}${e.cost.toFixed(2)} (at ${e.currency}${e.price} ${e.priceUnit})` : " · free"}`
  );
}

const briefText = (dir: string) =>
  fs.existsSync(path.join(dir, "brief.md"))
    ? fs.readFileSync(path.join(dir, "brief.md"), "utf8")
    : "";

/**
 * The gate and the free estimate of "Generate voice & render" (D84): the voice-over must be
 * accepted, usable and on the working line. Used by the route and by `POST /api/estimate` (D94).
 */
export async function voiceEstimate(rt: Runtime, version: number) {
  const p = rt.requireProject();
  const state = readState(p.dir) ?? p.state;
  requireSelected(p.dir, state, "vo", version);
  if (state.line.vo !== version)
    throw new Error(
      `voice-over v${version} is not on the working line (v${state.line.vo ?? "none"}) — switch to it first`,
    );
  const vo = readVo(p.dir, version);
  if (!vo) throw new Error(`voice-over v${version} is missing on disk`);
  const cfg = rt.getConfig(true);
  const estimate = await estimateTts(
    p.dir,
    vo.validated.resolved,
    buildEngines(cfg, { brief: briefText(p.dir) }),
    cfg,
  );
  return { estimate, vo, project: p };
}
