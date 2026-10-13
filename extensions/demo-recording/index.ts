import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * demo-recording — automated PoC / demo video recorder for web apps.
 *
 * SCAFFOLD ONLY. No engine code yet. See:
 *   docs/VISION.md               agreed decisions (D1–D20)
 *   docs/IMPLEMENTATION_PLAN.md  vertical slices S0–S7
 *
 * Skills ship inside this extension (./skills) and are contributed through
 * `resources_discover`, so they also load when the extension is installed via
 * a filtered package source that selects only this entry file.
 */
const here = dirname(fileURLToPath(import.meta.url));

export default function (pi: ExtensionAPI) {
  pi.on("resources_discover", async () => ({
    skillPaths: [join(here, "skills")],
  }));

  pi.registerCommand("demo", {
    description:
      "Demo recorder (scaffold — see extensions/demo-recording/docs/IMPLEMENTATION_PLAN.md)",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "demo-recording is scaffolded but not implemented yet. Next slice: S0 (skeleton, workdir, fixture, panel).",
        "info",
      );
    },
  });
}
