import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ACTIVE_ENTRY, registerDemoCommand } from "./src/commands/demo.ts";
import { Runtime } from "./src/runtime.ts";

/**
 * demo-recording — automated PoC / demo video recorder for web apps.
 *
 *   docs/VISION.md               agreed decisions (D1–D20)
 *   docs/IMPLEMENTATION_PLAN.md  vertical slices S0–S7 (currently: S0)
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
  const rt = new Runtime();

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
    if (active) rt.setActiveProject(active);
  });

  pi.on("session_shutdown", async () => {
    await rt.shutdown();
  });

  registerDemoCommand(pi, rt);
}
