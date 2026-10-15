/** A fake model for the separate designer run (S5 part 12/13): scripted answers, no real call. */

import type { ModelAccess, ModelLike } from "../../src/recorder/improvise.ts";

/** What a good designer returns for the synthetic project (targets that resolve on it). */
export const GOOD = [
  {
    id: "zoom-row",
    type: "zoom",
    scene: "01-dash",
    anchor: { mark: "m2" },
    target: { step: 1 },
    factor: 1.6,
    value: 5,
    reason: "the EMEA row is the story",
  },
  {
    id: "hl-kpi",
    type: "highlight",
    scene: "01-dash",
    anchor: { mark: "m1" },
    target: { text: "3.1%" },
    value: 3,
    reason: "the voice reads the headline number",
  },
  {
    id: "co-emea",
    type: "callout",
    scene: "01-dash",
    anchor: { word: "EMEA" },
    text: "EMEA: 14.2 %",
    value: 4,
    reason: "lands as the voice says EMEA",
  },
];

export interface Call {
  spec: string;
  system: string;
  user: string;
}

/** A fake pi model access: answers come from a script, one per call. */
export function fake(
  answers: (string | Error)[],
  known = ["a/one", "b/two"],
): { access: ModelAccess; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const access: ModelAccess = {
    find: (provider, id) =>
      known.includes(`${provider}/${id}`)
        ? ({ provider, id, api: "anthropic-messages" } as ModelLike)
        : undefined,
    complete: async (model, context) => {
      const c = context as { systemPrompt: string; messages: { content: { text: string }[] }[] };
      calls.push({
        spec: `${(model as ModelLike).provider}/${(model as ModelLike).id}`,
        system: c.systemPrompt,
        user: c.messages[0]?.content[0]?.text ?? "",
      });
      const a = answers[Math.min(i++, answers.length - 1)];
      if (a instanceof Error) throw a;
      return { content: [{ type: "text", text: a }], stopReason: "stop" };
    },
  };
  return { access, calls };
}
