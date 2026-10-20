/**
 * demo_rec_ask: the Director asks the user a question and STOPS (item 11, P4, D140 to D143). The question is stored in the project, shown
 * in the panel (and the chat), and answered there; the engine then wakes the Director with a message that carries the answer. Nothing blocks
 * inside this tool. It is for a real decision with a few distinct options, never for approving, spending or replacing something: those stay
 * panel actions and gates.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { LIMITS, ROLES, askQuestion, readQuestions } from "../questions.ts";
import type { Runtime } from "../runtime.ts";
import { result } from "./common.ts";

export function registerAskTool(pi: ExtensionAPI, rt: Runtime): void {
  pi.registerTool({
    name: "demo_rec_ask",
    label: "Demo ask the user",
    description:
      "Ask the user a question when you need a DECISION you cannot make yourself (which angle to take, what to cover, how to resolve a conflict between two " +
      "notes). ask: give the question (a sentence they can answer without any context), why it matters (optional), and 2-4 options, each starting with a " +
      "DIFFERENT word because the user may type it (or its number) in the chat. The question is stored and shown in the panel and the chat; the answer " +
      "arrives as a message. So STOP right after asking: do not wait, do not guess, do not ask again, do not carry on as if it were answered. pending: " +
      "the questions still waiting and the last answers. NOT for approving anything, spending anything or replacing a version: those are the user's " +
      "panel actions, you cannot do them. A question you did not need to ask costs the user's attention.",
    parameters: Type.Object({
      action: StringEnum(["ask", "pending"] as const),
      question: Type.Optional(
        Type.String({
          description: `ask: the question, at most ${LIMITS.what} characters, understandable without context`,
        }),
      ),
      why: Type.Optional(
        Type.String({
          description: `ask: why it matters or what it costs, at most ${LIMITS.why} characters`,
        }),
      ),
      options: Type.Optional(
        Type.Array(
          Type.Object({
            label: Type.String({
              description: `starts with a distinct word, at most ${LIMITS.label} characters`,
            }),
          }),
          {
            description: `ask: ${LIMITS.options[0]}-${LIMITS.options[1]} options`,
          },
        ),
      ),
      role: Type.Optional(
        StringEnum(ROLES, { description: "ask: the role that asks (default Director)" }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      rt.bindUi(ctx?.ui);
      const p = rt.requireProject();
      if (params.action === "pending") {
        const all = readQuestions(p.dir);
        if (!all.length) return result("You have asked nothing yet.");
        return result(
          all
            .slice(-6)
            .map(
              (q) =>
                `${q.id} ${q.status.toUpperCase()}${q.answer ? ` → ${q.answer.key} · ${q.answer.label}` : ""}${q.cancelled ? ` (${q.cancelled.why})` : ""}: ${q.what}`,
            )
            .join("\n"),
        );
      }
      const q = askQuestion(p.dir, {
        role: params.role,
        what: params.question,
        why: params.why,
        options: params.options,
      });
      rt.publishQuestion(q);
      return result(
        `Asked ${q.id}: "${q.what}" (${q.options.map((o) => `${o.key} ${o.label}`).join(" · ")}). The user answers in the panel; the answer arrives as a message. STOP now: do not wait, guess or ask again.`,
        { id: q.id },
      );
    },
  });
}
