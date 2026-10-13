/**
 * demo_rec_storyboard — write (validate + version + push to the panel) and
 * read storyboards. There is deliberately NO approve action: approval is a
 * human gate that exists only in the panel (D10, IMPLEMENTATION_PLAN §1.1).
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describeTarget } from "../recorder/targets.ts";
import type { Runtime } from "../runtime.ts";
import { formatDiff, storyboardTargets } from "../storyboard/diff.ts";
import { readStoryboard, storyboardVersions, writeStoryboard } from "../storyboard/store.ts";
import { getReview, readState, setPhase } from "../workdir/state.ts";
import { result } from "./common.ts";

export function registerStoryboardTool(pi: ExtensionAPI, rt: Runtime): void {
  pi.registerTool({
    name: "demo_rec_storyboard",
    label: "Demo storyboard",
    description:
      "Write or read the demo storyboard (YAML, see the demo-recording skill for the format). write validates, stores the next immutable version, " +
      "and shows it to the user in the panel's Review tab; errors name the exact field to fix. The user approves storyboards in the panel — " +
      "you cannot approve them. get returns a version (default latest) with its review status.",
    parameters: Type.Object({
      action: StringEnum(["write", "get"] as const),
      yaml: Type.Optional(
        Type.String({
          description: "write: the complete storyboard YAML (version is assigned automatically)",
        }),
      ),
      version: Type.Optional(Type.Number({ description: "get: version number (default latest)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      rt.bindUi(ctx?.ui);
      const p = rt.requireProject();
      if (params.action === "get") {
        const sb = readStoryboard(p.dir, params.version);
        if (!sb) return result("no storyboard written yet");
        const state = readState(p.dir) ?? p.state;
        const review = getReview(state, sb.version);
        const marks = Object.entries(review.scenes).map(
          ([id, r]) => `${id}: ${r.status}${r.note ? ` — "${r.note}"` : ""}`,
        );
        return result(
          `storyboard v${sb.version} (versions: ${storyboardVersions(p.dir).join(", ")}; approved: ${state.approved.storyboard ?? "none"})\n` +
            `${marks.length ? `review:\n${marks.join("\n")}\n` : ""}---\n${sb.text}`,
        );
      }
      if (!params.yaml?.trim()) throw new Error("write needs yaml (the complete storyboard)");
      const written = writeStoryboard(p.dir, params.yaml);
      if (rt.discovery && !rt.discovery.isClosed) rt.discovery.markStoryboardWritten();
      if (["brief", "discovery", "storyboard-review"].includes(p.state.phase))
        setPhase(p.dir, "storyboard-review");

      const warnings: string[] = [];
      const d = rt.discovery;
      if (d && !d.isClosed) {
        const refs = storyboardTargets(written.storyboard);
        const unknown = new Set(
          d.unknownTargets(refs.map((r) => r.target)).map((t) => JSON.stringify(t)),
        );
        for (const r of refs) {
          if (unknown.has(JSON.stringify(r.target)))
            warnings.push(
              `${r.scene} step ${r.step}: target ${describeTarget(r.target)} was never seen or used during discovery`,
            );
        }
      }
      for (const scene of written.storyboard.scenes) {
        if (!scene.screen)
          warnings.push(
            `${scene.id}: no screen thumbnail (set screen: <id from a look>) — the review card will be blank`,
          );
      }
      rt.bus.publish(
        "storyboard.written",
        {
          version: written.version,
          scenes: written.storyboard.scenes.length,
          message: written.diff
            ? formatDiff(written.diff)
            : `storyboard v${written.version} (first version)`,
        },
        p.slug,
      );
      const panel = await rt.ensurePanel();
      return result(
        [
          `Stored storyboard v${written.version} (${written.storyboard.scenes.length} scenes) at ${written.file}.`,
          written.diff ? formatDiff(written.diff) : "First version.",
          warnings.length ? `Warnings:\n- ${warnings.join("\n- ")}` : "No warnings.",
          `The user reviews it in the panel (Review tab): ${panel.url}. Wait for their [demo-panel] feedback; do not record before approval.`,
        ].join("\n"),
        { version: written.version, warnings },
      );
    },
  });
}
