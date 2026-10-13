import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * poc-video — two-pass POC demo video pipeline.
 *
 * Status: scaffold. Only the contracts (storyboard/vo schemas + validator)
 * exist; the recording runner, control bus, panel, VO generator, TTS and
 * assembler are being built. This entry just marks the extension as loaded
 * and points at the skill that owns the workflow.
 */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("poc-video", {
    description: "POC demo video pipeline — build status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "poc-video: scaffolded (contracts only) — storyboard/vo schemas + validator ready. " +
          "Runner, panel, VO/TTS and assembly not implemented yet. Workflow: skills/poc-video/SKILL.md",
        "info",
      );
    },
  });
}
