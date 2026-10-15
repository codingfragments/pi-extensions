import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ACTIVE_ENTRY, registerDemoCommand } from "./src/commands/demo.ts";
import { Runtime } from "./src/runtime.ts";
import { registerAnnotationsTool } from "./src/tools/annotations.ts";
import { registerBrandTool } from "./src/tools/brand.ts";
import { registerBrowserTool } from "./src/tools/browser.ts";
import { registerConfigTool } from "./src/tools/config.ts";
import { registerEditTool } from "./src/tools/edit.ts";
import { registerProjectTool } from "./src/tools/project.ts";
import { registerRecordTool } from "./src/tools/record.ts";
import { registerRenderTool } from "./src/tools/render.ts";
import { registerStoryboardTool } from "./src/tools/storyboard.ts";
import { registerTakeTool } from "./src/tools/take.ts";
import { registerTtsTool } from "./src/tools/tts.ts";
import { registerVoTool } from "./src/tools/vo.ts";

/**
 * demo-recording — automated PoC / demo video recorder for web apps.
 *
 *   docs/VISION.md               agreed decisions (D1–D20)
 *   docs/IMPLEMENTATION_PLAN.md  vertical slices S0–S8 (currently: S5)
 *
 * Skills ship inside this extension (./skills) and are contributed through
 * `resources_discover`, so they also load when the extension is installed via
 * a filtered package source that selects only this entry file.
 *
 * Nothing long-lived starts here: the panel starts lazily on first use and is
 * closed on `session_shutdown`.
 */
const here = dirname(fileURLToPath(import.meta.url));

export default function (pi: ExtensionAPI) {
  // Panel actions reach the director as user messages through pi.sendUserMessage.
  const rt = new Runtime(undefined, pi);

  pi.on("resources_discover", async () => ({
    skillPaths: [join(here, "skills")],
  }));

  pi.on("session_start", async (_event, ctx) => {
    // Restore the active project from the session's custom entries.
    let active: string | undefined;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === ACTIVE_ENTRY) {
        active = (entry.data as { project?: string } | undefined)?.project;
      }
    }
    if (active) {
      rt.setActiveProject(active);
      rt.primeContext();
    }
  });

  pi.on("session_shutdown", async () => {
    await rt.shutdown();
  });

  registerDemoCommand(pi, rt);
  registerProjectTool(pi, rt);
  registerBrowserTool(pi, rt);
  registerStoryboardTool(pi, rt);
  registerRecordTool(pi, rt);
  registerTakeTool(pi, rt);
  registerVoTool(pi, rt);
  registerTtsTool(pi, rt);
  registerEditTool(pi, rt);
  registerConfigTool(pi, rt);
  registerBrandTool(pi, rt);
  registerAnnotationsTool(pi, rt);
  registerRenderTool(pi, rt);
}
