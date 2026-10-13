import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { shutdownBrowser } from "./browser.ts";
import { registerExplorationTools } from "./exploration.ts";

/**
 * poc-video — two-pass POC demo video pipeline.
 *
 * Implemented: pass-1 exploration tools (poc_video_*) backed by a
 * persistent-profile Chromium, run-dir scaffolding (scripts/pass1-init.mjs),
 * storyboard/vo contracts + validator.
 * Pending: pass-2 recording runner, control bus + panel, VO/TTS, assembly.
 * Workflow instructions: skills/poc-video/SKILL.md
 */
export default function (pi: ExtensionAPI) {
  registerExplorationTools(pi);

  pi.on("session_shutdown", async () => {
    await shutdownBrowser();
  });

  pi.registerCommand("poc-video", {
    description: "POC demo video pipeline — build status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "poc-video: pass-1 tools live (poc_video_open/navigate/click/type/press/screenshot/state/close) + " +
          "storyboard/vo contracts + validator. Runner, panel, VO/TTS and assembly pending. " +
          "Workflow: skills/poc-video/SKILL.md",
        "info",
      );
    },
  });
}
