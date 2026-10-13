/**
 * Model guards (S5): catch silent capability gaps.
 *
 * - pi replaces every image with "(tool image omitted: model does not support
 *   images)" when the session model has no image input. Discovery and take
 *   analysis are vision-first (D4), so they warn loudly instead of running blind.
 * - The improvise chain is called directly through pi's registry; models that
 *   aren't available there silently fall back to `fallback:` texts.
 */

import { parseModelSpec } from "./recorder/improvise.ts";

export interface ModelInfo {
  provider: string;
  id: string;
  input?: string[];
  contextWindow?: number;
}

/** Warning text when the director model can't see images (undefined = fine). */
export function visionWarning(model: ModelInfo | undefined): string | undefined {
  if (!model) return undefined;
  if (model.input?.includes("image")) return undefined;
  return `⚠ The current model (${model.provider}/${model.id}) has no image input: pi drops every screenshot and keyframe, so this runs on page text only (blind to charts, layout, visual polish). Switch to a vision model for discovery and voice-over (e.g. a Claude Sonnet/Opus or GPT-5.6 model) — check \`pi --list-models\` (images column).`;
}

/** Warning when the context window is small for vision-heavy discovery. */
export function contextWarning(model: ModelInfo | undefined): string | undefined {
  if (!model?.contextWindow || model.contextWindow >= 190_000) return undefined;
  return `⚠ ${model.provider}/${model.id} has a ${Math.round(model.contextWindow / 1000)}k context; long discoveries (screenshots + page text) will be compacted. ≥ 200k recommended.`;
}

export interface RegistryLike {
  find(provider: string, id: string): unknown;
  hasConfiguredAuth?(model: never): boolean;
}

export interface ImproviseModelStatus {
  spec: string;
  ok: boolean;
  reason: string;
}

/** Which improvise models are usable through pi (found + authenticated). */
export function improviseModelStatus(
  specs: string[],
  registry: RegistryLike,
): ImproviseModelStatus[] {
  return specs.map((spec) => {
    let provider: string;
    let id: string;
    try {
      ({ provider, id } = parseModelSpec(spec));
    } catch (err) {
      return { spec, ok: false, reason: (err as Error).message };
    }
    const model = registry.find(provider, id) as ({ input?: string[] } & object) | undefined;
    if (!model) return { spec, ok: false, reason: "not in pi's model list" };
    if (registry.hasConfiguredAuth && !registry.hasConfiguredAuth(model as never)) {
      return {
        spec,
        ok: false,
        reason: `no credentials for provider "${provider}" in pi (run /login or set its API key)`,
      };
    }
    return { spec, ok: true, reason: "available" };
  });
}
