import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Template extension — copy this folder to `extensions/<your-name>/` and
 * rename this file's contents as needed. See ../../AGENTS.md for the full
 * extension API primer and repo conventions.
 */
export default function (pi: ExtensionAPI) {
  // React to lifecycle events.
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("_template extension loaded", "info");
  });

  // Register a custom tool the LLM can call.
  pi.registerTool({
    name: "template_tool",
    label: "Template Tool",
    description: "Replace this with a clear, specific description of what the tool does.",
    parameters: Type.Object({
      input: Type.String({ description: "Describe the parameter" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      return {
        content: [{ type: "text", text: `template_tool received: ${params.input}` }],
        details: {},
      };
    },
  });

  // Register a slash command.
  pi.registerCommand("template", {
    description: "Template command — replace with something useful",
    handler: async (args, ctx) => {
      ctx.ui.notify(`template command ran with args: ${args || "(none)"}`, "info");
    },
  });
}
