/**
 * Questions the Director asked, over HTTP (item 11, P4, A4; D140 to D143). See `../questions.ts`.
 *
 *   GET  /api/questions               the questions waiting for you, and the last few answered or dismissed
 *   POST /api/question-answer         { id, option }: answer one (an option's number or word). Resolves it once; wakes the Director with the answer
 *   POST /api/question-cancel         { id }: dismiss one without choosing (a quiet note to the Director)
 */

import {
  answerQuestion,
  answeredMessage,
  cancelQuestion,
  dismissedMessage,
  readQuestions,
} from "../questions.ts";
import type { Runtime } from "../runtime.ts";
import { PANEL_PREFIX } from "./bridge.ts";
import type { GetRoute, PostRoute } from "./server.ts";

export function questionRoutes(rt: Runtime): {
  get: Record<string, GetRoute>;
  post: Record<string, PostRoute>;
} {
  const project = () => rt.requireProject();
  return {
    get: {
      questions: () => {
        const p = rt.activeProject();
        if (!p) return { pending: [], recent: [] };
        const all = readQuestions(p.dir);
        return {
          pending: all.filter((q) => q.status === "pending"),
          recent: all.filter((q) => q.status !== "pending").slice(-5),
        };
      },
    },
    post: {
      "question-answer": (body) => {
        const p = project();
        const id = String(body.id ?? "");
        const r = answerQuestion(p.dir, id, String(body.option ?? ""), "panel");
        if (!r.ok) {
          if (r.reason === "unknown") throw new Error(`there is no question ${id}`);
          if (r.reason === "no-such-option")
            throw new Error(
              `${id} has no option "${body.option}": choose ${r.question?.options.map((o) => `${o.key} (${o.word})`).join(", ")}`,
            );
          const a = r.question?.answer;
          throw new Error(
            r.question?.status === "answered"
              ? `${id} was already answered${a ? ` with ${a.key} · ${a.label} in ${a.by === "chat" ? "the chat" : "the panel"}` : ""}`
              : `${id} was dismissed${r.question?.cancelled ? ` (${r.question.cancelled.why})` : ""}`,
          );
        }
        const q = r.question;
        rt.bus.publish(
          "question.answered",
          {
            id: q.id,
            option: q.answer?.key,
            by: "panel",
            message: `answered ${q.id} with ${q.answer?.key} · ${q.answer?.label}`,
          },
          p.slug,
        );
        rt.notifyAgent(answeredMessage(PANEL_PREFIX, q));
        return { question: q };
      },
      "question-cancel": (body) => {
        const p = project();
        const q = cancelQuestion(p.dir, String(body.id ?? ""), "you dismissed it");
        rt.bus.publish(
          "question.cancelled",
          { id: q.id, by: "panel", message: `dismissed ${q.id}` },
          p.slug,
        );
        rt.tellAgent(dismissedMessage(PANEL_PREFIX, q));
        return { question: q };
      },
    },
  };
}
