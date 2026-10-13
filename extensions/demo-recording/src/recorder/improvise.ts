/**
 * `improvise` steps (D7, S3): a fast model invents an input (search query,
 * chat question, filter value) from the LIVE screen while the cursor travels
 * to the target, so the viewer sees no pause.
 *
 * Default chain (benchmarked in S3, see docs/IMPLEMENTATION_PLAN.md Q5):
 *   anthropic/claude-haiku-4-5        ~0.84 s text-only (≈1.07 s + screenshot)
 *   openai/gpt-5.4-mini (minimal)     ~1.05 s text-only
 * Text-only (aria digest) is the default: it carries the exact values and is
 * ~2× faster; a step can opt into the screenshot with `vision: true`.
 */

export interface ModelLike {
  provider: string;
  id: string;
  api: string;
  reasoning?: boolean;
  input?: string[];
}

/** The subset of pi's ModelRegistry / ModelRuntime we need. */
export interface ModelAccess {
  find(provider: string, id: string): ModelLike | undefined;
  complete(
    model: ModelLike,
    context: unknown,
    options: Record<string, unknown>,
  ): Promise<{
    content: { type: string; text?: string }[];
    stopReason?: string;
    errorMessage?: string;
  }>;
}

export interface ImproviseRequest {
  prompt: string;
  maxChars: number;
  target: string;
  digest: string;
  screenshot?: Buffer;
  /** Short context from the brief (audience/goal) so inputs fit the story. */
  context?: string;
}

export interface ImproviseResult {
  text: string;
  model: string;
  ms: number;
  tried: string[];
}

export interface Improviser {
  generate(req: ImproviseRequest, signal?: AbortSignal): Promise<ImproviseResult>;
}

export const DEFAULT_IMPROVISE_MODELS = ["anthropic/claude-haiku-4-5", "openai/gpt-5.4-mini"];

const SYSTEM = [
  "You type into a web app during a recorded product demo, like a sharp human presenter.",
  "Reply with ONLY the exact text to type: one line, no quotes, no explanation.",
  "Make it specific to what is on screen (use real names and values you can see).",
].join(" ");

/** Normalize model output into something a keyboard can type. */
export function sanitizeInput(raw: string, maxChars: number): string {
  let s =
    raw
      .trim()
      .split(/\r?\n/)
      .find((l) => l.trim()) ?? "";
  s = s
    .replace(/^(answer|input|text|query|question)\s*:\s*/i, "")
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[^\x20-\x7E\u00A0-\u024F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (/^["'`].*["'`]$/.test(s)) s = s.slice(1, -1).trim();
  if (s.length > maxChars) {
    const cut = s.slice(0, maxChars);
    const space = cut.lastIndexOf(" ");
    s = (space > maxChars * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:-]+$/, "");
  }
  return s;
}

export function parseModelSpec(spec: string): { provider: string; id: string } {
  const i = spec.indexOf("/");
  if (i <= 0 || i === spec.length - 1)
    throw new Error(`model spec must be "provider/id", got "${spec}"`);
  return { provider: spec.slice(0, i), id: spec.slice(i + 1) };
}

export function createImproviser(
  access: ModelAccess,
  specs: string[] = DEFAULT_IMPROVISE_MODELS,
  timeoutMs = 6000,
): Improviser {
  return {
    async generate(req, signal) {
      const tried: string[] = [];
      const errors: string[] = [];
      for (const spec of specs) {
        const { provider, id } = parseModelSpec(spec);
        const model = access.find(provider, id);
        tried.push(spec);
        if (!model) {
          errors.push(`${spec}: not available`);
          continue;
        }
        const content: unknown[] = [];
        if (req.screenshot && model.input?.includes("image")) {
          content.push({
            type: "image",
            data: req.screenshot.toString("base64"),
            mimeType: "image/jpeg",
          });
        }
        content.push({
          type: "text",
          text:
            `${req.context ? `Demo context: ${req.context}\n\n` : ""}Screen (accessibility digest):\n${req.digest}\n\n` +
            `Target: ${req.target}\nInvent: ${req.prompt}\nMax ${req.maxChars} characters.`,
        });
        const options: Record<string, unknown> = { maxTokens: 300 };
        // Keep reasoning models fast: minimal effort (OpenAI-style APIs).
        if (model.reasoning && model.api.includes("openai")) options.reasoningEffort = "minimal";
        const timeout = AbortSignal.timeout(timeoutMs);
        options.signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const t0 = Date.now();
        try {
          const res = await access.complete(
            model,
            { systemPrompt: SYSTEM, messages: [{ role: "user", content, timestamp: Date.now() }] },
            options,
          );
          if (res.stopReason === "error" || res.stopReason === "aborted")
            throw new Error(res.errorMessage ?? res.stopReason);
          const text = sanitizeInput(
            res.content
              .filter((c) => c.type === "text")
              .map((c) => c.text ?? "")
              .join(""),
            req.maxChars,
          );
          if (!text) throw new Error("empty output");
          return { text, model: spec, ms: Date.now() - t0, tried };
        } catch (err) {
          errors.push(`${spec}: ${(err as Error).message}`);
          if (signal?.aborted) break;
        }
      }
      throw new Error(`improvise failed (${errors.join("; ")})`);
    },
  };
}

/** Adapter for pi's ModelRegistry (`find`) and ModelRuntime (`getModel`). */
export function modelAccessFrom(registry: {
  find?: (p: string, id: string) => unknown;
  getModel?: (p: string, id: string) => unknown;
  complete: (model: never, context: never, options?: never) => Promise<unknown>;
}): ModelAccess {
  return {
    find: (p, id) =>
      ((registry.find ?? registry.getModel)?.call(registry, p, id) as ModelLike | undefined) ??
      undefined,
    complete: (model, context, options) =>
      registry.complete(model as never, context as never, options as never) as ReturnType<
        ModelAccess["complete"]
      >,
  };
}
