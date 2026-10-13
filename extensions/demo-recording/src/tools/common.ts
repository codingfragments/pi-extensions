import { Type } from "typebox";
import { parseTarget } from "../storyboard/parse.ts";
import type { Target } from "../storyboard/types.ts";

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export function text(t: string): ToolContent {
  return { type: "text", text: t };
}

export function result(content: ToolContent[] | string, details: Record<string, unknown> = {}) {
  return { content: typeof content === "string" ? [text(content)] : content, details };
}

/** LLM-friendly target schema: one flat object, validated by the storyboard parser. */
export const TargetSchema = Type.Object(
  {
    role: Type.Optional(
      Type.String({ description: "ARIA role, e.g. link, button, searchbox, textbox, tab" }),
    ),
    name: Type.Optional(
      Type.String({ description: "Accessible name (with role), as shown in the aria digest" }),
    ),
    text: Type.Optional(Type.String({ description: "Visible text (when no role/name fits)" })),
    label: Type.Optional(Type.String({ description: "Form label text" })),
    css: Type.Optional(Type.String({ description: "CSS selector — last resort" })),
    exact: Type.Optional(Type.Boolean()),
  },
  {
    description:
      "Element target, same syntax as storyboard targets. Prefer {role, name} from the aria digest.",
  },
);

export function toTarget(raw: unknown): Target | undefined {
  if (raw === undefined || raw === null) return undefined;
  return parseTarget(raw, "target");
}
