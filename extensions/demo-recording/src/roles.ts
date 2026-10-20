/**
 * Who is speaking (item 11c, D144). Every message the extension sends carries its role, so a chat or a log full of reports says WHO is talking:
 * `[demo-recording · Cutter] Edit finished …`, `[demo-panel · You] The user APPROVED …`. The model's own text gets its label by a rule in each
 * skill; nothing is written into what the model said.
 *
 * The role names are the cast of docs/ACTORS.md. "You" is the user acting in the panel or the chat (the engine reports it, then the Director reads it).
 */

export const SPEAKERS = [
  "You",
  "Director",
  "Researcher",
  "Storyboard writer",
  "Operator",
  "Voice writer",
  "Cutter",
  "Annotation designer",
  "Brand designer",
  "QA reviewer",
] as const;
export type Speaker = (typeof SPEAKERS)[number];

/** The prefix of an engine report into the Director's session: `[demo-recording · Cutter]`. */
export const reportAs = (who: Speaker): string => `[demo-recording · ${who}]`;

/** The prefix of what you did in the panel: `[demo-panel · You]`. */
export const PANEL_PREFIX = "[demo-panel · You]";

/**
 * Either prefix, with or without a role (a regex source): the old `[demo-panel]` form and the new one both start a report. `group 1` is the
 * machine tag, `group 2` the role (when there is one).
 */
export const PREFIX_SOURCE = "\\[(demo-panel|demo-recording)(?: · ([^\\]]+))?\\]";

/** What a tool call belongs to: the role the Director plays while it runs the tool (the same name Activity and the band show). */
export function roleOfTool(tool: string, args: Record<string, unknown> = {}): Speaker {
  switch (tool) {
    case "demo_rec_browser":
    case "demo_rec_discovery":
      return "Researcher";
    case "demo_rec_storyboard":
      return "Storyboard writer";
    case "demo_rec_record":
      return "Operator";
    case "demo_rec_vo":
    case "demo_rec_tts":
      return "Voice writer";
    case "demo_rec_edit":
      return "Cutter";
    case "demo_rec_annotations":
      return "Annotation designer";
    case "demo_rec_brand":
      return "Brand designer";
    case "demo_rec_render":
      return args.action === "qa" ? "QA reviewer" : "Cutter";
    case "demo_rec_qa":
      return "QA reviewer";
    default:
      return "Director";
  }
}
