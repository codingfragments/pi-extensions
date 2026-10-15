/**
 * demo_rec_config — view and change settings (S5 config skill).
 * Two-phase writes: without `confirm: true` the tool only returns the diff;
 * the agent shows it to the user and asks before calling again with confirm.
 */

import os from "node:os";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  type Scope,
  applyChange,
  describeConfig,
  formatChange,
  formatEntries,
  layerFiles,
  parseValue,
  planChange,
} from "../config-edit.ts";
import type { Runtime } from "../runtime.ts";
import { result } from "./common.ts";

export function configFiles(rt: Runtime) {
  const p = rt.activeProject();
  return layerFiles(process.env, os.homedir(), p?.dir);
}

export function registerConfigTool(pi: ExtensionAPI, rt: Runtime): void {
  pi.registerTool({
    name: "demo_rec_config",
    label: "Demo config",
    description:
      "demo-recording settings (see the demo-config skill). show: effective value + source (default/global/project/env) + docs for every " +
      "setting, optionally filtered by a key prefix. set/unset: change the global config (~/.config/demo-recording/config.json) or the active " +
      "project's config.json — WITHOUT confirm it only returns the diff (show it to the user and ask); call again with confirm: true to write. " +
      "Values are validated before writing. API keys are never stored here (environment only).",
    parameters: Type.Object({
      action: StringEnum(["show", "set", "unset"] as const),
      key: Type.Optional(
        Type.String({
          description:
            "dotted key, e.g. voiceName, tts.elevenlabs.model, improvise.models (show: optional prefix)",
        }),
      ),
      value: Type.Optional(
        Type.String({ description: 'set: JSON value (3000, true, ["a","b"]) or plain text' }),
      ),
      scope: Type.Optional(
        StringEnum(["global", "project"] as const, {
          description: "where to write (default global)",
        }),
      ),
      confirm: Type.Optional(
        Type.Boolean({
          description: "set/unset: write for real (only after the user agreed to the diff)",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      rt.bindUi(ctx?.ui);
      const files = configFiles(rt);
      if (params.action === "show") {
        return result(
          formatEntries(describeConfig(files, process.env, os.homedir(), params.key ?? ""), files),
        );
      }
      if (!params.key) throw new Error(`${params.action} needs key`);
      const scope: Scope = params.scope ?? "global";
      if (scope === "project" && params.key === "root")
        throw new Error('"root" can only be set globally (it decides where projects live)');
      if (params.action === "set" && params.value === undefined) throw new Error("set needs value");
      const change = planChange(
        files,
        scope,
        params.key,
        params.action === "set" ? parseValue(params.value as string) : undefined,
        {
          env: process.env,
          home: os.homedir(),
          unset: params.action === "unset",
        },
      );
      if (!params.confirm) {
        return result(
          `Planned change (NOT written yet):\n${formatChange(change)}\n\nShow this to the user; if they agree, call again with confirm: true.`,
          {
            planned: true,
          },
        );
      }
      applyChange(change);
      rt.getConfig(true);
      rt.bus.publish(
        "config.changed",
        {
          key: change.key,
          scope,
          by: "agent",
          file: change.file,
          before: change.before ?? null,
          after: change.after ?? null,
          effective: change.effective ?? null,
          ...(change.shadowedBy ? { shadowedBy: change.shadowedBy } : {}),
          message: `config: ${change.key}: ${JSON.stringify(change.before) ?? "unset"} → ${JSON.stringify(change.after) ?? "unset"} (${scope})`,
        },
        rt.activeProjectSlug,
      );
      return result(`Written.\n${formatChange(change)}`, { planned: false });
    },
  });
}
