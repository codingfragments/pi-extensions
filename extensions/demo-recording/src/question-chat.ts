/**
 * The chat side of a question (item 11b, D141): the labelled message that shows it, and the one rule by which a typed reply answers it.
 *
 * A reply answers a waiting question only when ALL of this holds, otherwise it is normal chat and goes to the model untouched:
 *  - it is your own typing (`source: "interactive"`): never what an extension sends, an RPC client, or the model;
 *  - it is exactly one option's number or word, case aside, of exactly one waiting question.
 * Then the reply is ours (swallowed, so the model does not see it twice) and the engine wakes the Director with the answer, like a click would.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { answerFor } from "./question-flow.ts";
import { matchReply, pendingQuestions } from "./questions.ts";
import { QUESTION_MESSAGE, type Runtime } from "./runtime.ts";

export function registerQuestionChat(pi: ExtensionAPI, rt: Runtime): void {
  pi.on("input", async (event, ctx) => {
    try {
      if (event.source !== "interactive") return { action: "continue" as const };
      const p = rt.activeProject();
      if (!p) return { action: "continue" as const };
      const hit = matchReply(pendingQuestions(p.dir), event.text);
      if (hit === "ambiguous") {
        ctx.ui?.notify(
          "Several questions wait for you and that fits more than one: answer in the panel.",
          "warning",
        );
        return { action: "continue" as const };
      }
      if (!hit) return { action: "continue" as const };
      answerFor(rt, hit.question.id, hit.option.key, "chat");
      return { action: "handled" as const };
    } catch {
      return { action: "continue" as const };
    }
  });

  // the role, what is asked, the options with their numbers
  if (typeof pi.registerMessageRenderer === "function")
    pi.registerMessageRenderer(QUESTION_MESSAGE, (message, { outputPad }, theme) => {
      const box = new Box(outputPad, 1, (t: string) => theme.bg("customMessageBg", t));
      const [head = "", ...rest] = String(message.content).split("\n");
      const colon = head.indexOf(":");
      box.addChild(
        new Text(
          `${theme.fg("warning", "?")} ${theme.fg("accent", head.slice(0, colon + 1))}${head.slice(colon + 1)}${rest.length ? `\n${rest.join("\n")}` : ""}`,
          0,
          0,
        ),
      );
      return box;
    });
}
