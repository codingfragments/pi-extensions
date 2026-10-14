/**
 * demo_rec_brand — brand packages (S5, D24): list, show, inspect material,
 * create, update, duplicate, preview, use (default via config, diff-first).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readAnalysis } from "../analysis/take.ts";
import { type LoadedBrand, listBrands, resolveBrand } from "../brand/brand.ts";
import {
  createBrand,
  duplicateBrand,
  formatInventory,
  inspectSource,
  renderBrandPreview,
  updateBrand,
} from "../brand/manage.ts";
import { type Scope, applyChange, formatChange, planChange } from "../config-edit.ts";
import { titleInfoFor } from "../edit/pipeline.ts";
import type { Runtime } from "../runtime.ts";
import { type ToolContent, result, text } from "./common.ts";
import { configFiles } from "./config.ts";
import { listTakes } from "./take.ts";

/** A real keyframe from the active project's latest analyzed take (for previews). */
export function sampleKeyframe(rt: Runtime): string | undefined {
  const p = rt.activeProject();
  if (!p) return undefined;
  for (const t of listTakes(p.dir).reverse()) {
    const a = readAnalysis(path.join(p.dir, "takes", t.id));
    const k = a?.scenes
      .flatMap((s) => s.keyframes)
      .find((x) => x.label !== "start" && fs.existsSync(x.file));
    if (k) return k.file;
  }
  return undefined;
}

/** Render preview PNGs for a (possibly in-memory patched) brand. */
export async function renderPreviewFiles(
  rt: Runtime,
  loaded: LoadedBrand,
): Promise<{ title?: string; framed: string }> {
  const cfg = rt.getConfig();
  const p = rt.activeProject();
  const title = p
    ? titleInfoFor(p.dir, cfg)
    : {
        app: "Acme Pulse",
        title: "Finding the churn problem",
        date: new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" }),
      };
  const keyframe = sampleKeyframe(rt);
  return renderBrandPreview(loaded, {
    cacheDir: path.join(cfg.root, ".cache", "brand-assets"),
    outDir: previewDir(cfg.root),
    size: cfg.output,
    title,
    ...(keyframe ? { keyframe } : {}),
  });
}

export function previewDir(root: string): string {
  return path.join(root, ".cache", "brand-previews");
}

export async function previewContent(
  rt: Runtime,
  name: string,
): Promise<{ content: ToolContent[]; files: { title?: string; framed: string } }> {
  const loaded = resolveBrand(rt.getConfig().root, name);
  const files = await renderPreviewFiles(rt, loaded);
  const content: ToolContent[] = [];
  if (files.title)
    content.push(text("title card:"), {
      type: "image",
      data: fs.readFileSync(files.title).toString("base64"),
      mimeType: "image/png",
    });
  content.push(
    text(`framed footage + callout${loaded.brand.logoBug.enabled ? " + logo bug" : ""}:`),
    {
      type: "image",
      data: fs.readFileSync(files.framed).toString("base64"),
      mimeType: "image/png",
    },
  );
  return { content, files };
}

/** Preview after a write: the brand is already saved, so a failed render must not fail the call. */
async function safePreview(rt: Runtime, name: string): Promise<{ content: ToolContent[] }> {
  try {
    return await previewContent(rt, name);
  } catch (err) {
    return {
      content: [
        text(
          `(preview not rendered: ${(err as Error).message.split("\n")[0]} — check /demo doctor, then preview again)`,
        ),
      ],
    };
  }
}

export function registerBrandTool(pi: ExtensionAPI, rt: Runtime): void {
  pi.registerTool({
    name: "demo_rec_brand",
    label: "Demo brand",
    description:
      "Brand packages for the rendered video (see the demo-brand skill). list | show <name> | inspect <source zip/folder> (inventory + logo " +
      "candidates as images + colors found) | create <name> from a source with a mapping | update <name> with a patch | duplicate <from> <to> | " +
      "preview <name> (title card + framed sample frame as images) | use <name> (sets the default brand; without confirm it returns the diff — " +
      "ask the user first). Built-in: neutral. User brands live in <root>/brands/ (outside the repo).",
    parameters: Type.Object({
      action: StringEnum([
        "list",
        "show",
        "inspect",
        "create",
        "update",
        "duplicate",
        "preview",
        "use",
      ] as const),
      name: Type.Optional(Type.String({ description: "brand name (lowercase, digits, dashes)" })),
      source: Type.Optional(
        Type.String({ description: "inspect/create: path to a zip or folder of brand material" }),
      ),
      to: Type.Optional(Type.String({ description: "duplicate: new brand name" })),
      displayName: Type.Optional(Type.String()),
      logoLight: Type.Optional(
        Type.String({
          description: "create: logo for DARK backgrounds (light mark), path inside the source",
        }),
      ),
      logoDark: Type.Optional(
        Type.String({ description: "create: logo for LIGHT backgrounds, path inside the source" }),
      ),
      font: Type.Optional(
        Type.String({ description: "create: font file inside the source (woff2/ttf/otf)" }),
      ),
      backdropImage: Type.Optional(
        Type.String({ description: "create: optional backdrop image inside the source" }),
      ),
      settings: Type.Optional(
        Type.String({
          description:
            'create/update: JSON for brand.json fields, e.g. {"colors":{"accent":"#632CA6"},"logoBug":{"enabled":true}}',
        }),
      ),
      overwrite: Type.Optional(Type.Boolean()),
      scope: Type.Optional(StringEnum(["global", "project"] as const)),
      confirm: Type.Optional(
        Type.Boolean({
          description: "use: write the config (only after the user agreed to the diff)",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      rt.bindUi(ctx?.ui);
      const cfg = rt.getConfig();
      const need = (v: string | undefined, what: string) => {
        if (!v) throw new Error(`${params.action} needs ${what}`);
        return v;
      };
      const settings = () => {
        if (!params.settings) return undefined;
        try {
          return JSON.parse(params.settings) as Record<string, unknown>;
        } catch (err) {
          throw new Error(`settings must be JSON (${(err as Error).message})`);
        }
      };
      switch (params.action) {
        case "list": {
          const lines = listBrands(cfg.root).map(
            (b) =>
              `${b.name === cfg.brand ? "▶" : " "} ${b.name}${b.builtin ? " (built-in)" : ""}${b.error ? `  ✖ ${b.error}` : ""}`,
          );
          return result(
            `${lines.join("\n")}\n\ndefault brand: ${cfg.brand} · user brands: ${path.join(cfg.root, "brands")}`,
          );
        }
        case "show": {
          const l = resolveBrand(cfg.root, need(params.name, "name"));
          return result(
            `${l.brand.displayName} (${l.builtin ? "built-in" : l.dir})\n${JSON.stringify(l.brand, null, 2)}${l.warnings.length ? `\nwarnings:\n- ${l.warnings.join("\n- ")}` : ""}`,
          );
        }
        case "inspect": {
          const inv = await inspectSource(
            need(params.source, "source"),
            path.join(cfg.root, ".cache", "brand-inspect", String(Date.now())),
          );
          const content: ToolContent[] = [text(formatInventory(inv))];
          for (const pv of inv.previews) {
            content.push(text(`logo candidate: ${pv.rel} (on a checkerboard)`), {
              type: "image",
              data: fs.readFileSync(pv.png).toString("base64"),
              mimeType: "image/png",
            });
          }
          return result(content);
        }
        case "create": {
          const s = settings();
          const l = createBrand(cfg.root, {
            name: need(params.name, "name"),
            ...(params.source ? { source: params.source } : {}),
            ...(params.displayName ? { displayName: params.displayName } : {}),
            ...(params.logoLight ? { logoLight: params.logoLight } : {}),
            ...(params.logoDark ? { logoDark: params.logoDark } : {}),
            ...(params.font ? { font: params.font } : {}),
            ...(params.backdropImage ? { backdropImage: params.backdropImage } : {}),
            ...(s ? { settings: s } : {}),
            ...(params.overwrite ? { overwrite: true } : {}),
          });
          rt.bus.publish(
            "brand.changed",
            { name: l.brand.name, message: `brand ${l.brand.name} created` },
            rt.activeProjectSlug,
          );
          const pv = await safePreview(rt, l.brand.name);
          return result([
            text(
              `Created brand "${l.brand.name}" at ${l.dir}.${l.warnings.length ? `\nwarnings:\n- ${l.warnings.join("\n- ")}` : ""}`,
            ),
            ...pv.content,
          ]);
        }
        case "update": {
          const s = settings();
          if (!s) throw new Error("update needs settings (a JSON patch)");
          const l = updateBrand(cfg.root, need(params.name, "name"), s);
          rt.bus.publish(
            "brand.changed",
            { name: l.brand.name, message: `brand ${l.brand.name} updated` },
            rt.activeProjectSlug,
          );
          const pv = await safePreview(rt, l.brand.name);
          return result([
            text(
              `Updated "${l.brand.name}".${l.warnings.length ? `\nwarnings:\n- ${l.warnings.join("\n- ")}` : ""}`,
            ),
            ...pv.content,
          ]);
        }
        case "duplicate": {
          const l = duplicateBrand(cfg.root, need(params.name, "name"), need(params.to, "to"));
          rt.bus.publish(
            "brand.changed",
            { name: l.brand.name, message: `brand ${l.brand.name} created (copy)` },
            rt.activeProjectSlug,
          );
          return result(`Duplicated into "${l.brand.name}" at ${l.dir}. Edit it with update.`);
        }
        case "preview": {
          const pv = await previewContent(rt, need(params.name, "name"));
          return result(pv.content);
        }
        default: {
          const name = need(params.name, "name");
          resolveBrand(cfg.root, name); // must exist
          const scope: Scope = params.scope ?? "global";
          const change = planChange(configFiles(rt), scope, "brand", name, {
            env: process.env,
            home: os.homedir(),
          });
          if (!params.confirm)
            return result(
              `Planned change (NOT written yet):\n${formatChange(change)}\n\nShow this to the user; if they agree, call again with confirm: true.`,
            );
          applyChange(change);
          rt.getConfig(true);
          rt.bus.publish(
            "config.changed",
            { key: "brand", scope, message: `default brand → ${name} (${scope})` },
            rt.activeProjectSlug,
          );
          return result(
            `Default brand is now "${name}" (${scope}). Re-render to apply (no new voice needed).`,
          );
        }
      }
    },
  });
}
