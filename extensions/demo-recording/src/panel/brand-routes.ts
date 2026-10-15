/**
 * Panel routes for the Brand tab (S5, D24/D27): list brands, live preview with
 * unsaved tweaks, diff-confirmed save, duplicate, set default, and re-render
 * the latest edit with another brand (no LLM, no TTS).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listBrands, loadBrandDir, resolveBrand } from "../brand/brand.ts";
import { duplicateBrand, patchedBrand, planBrandUpdate, updateBrand } from "../brand/manage.ts";
import { type Scope, applyChange, planChange } from "../config-edit.ts";
import type { Runtime } from "../runtime.ts";
import { previewDir, renderPreviewFiles } from "../tools/brand.ts";
import { configFiles } from "../tools/config.ts";
import { startEdit } from "../tools/edit.ts";
import { latestVersion } from "../workdir/versioning.ts";
import type { GetRoute, PostRoute } from "./server.ts";

function str(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== "string" || !v) throw new Error(`"${key}" is required`);
  return v;
}

function patchOf(body: Record<string, unknown>): Record<string, unknown> {
  const p = body.patch ?? {};
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error('"patch" must be an object');
  return p as Record<string, unknown>;
}

/** Rendered variants of the latest edit: out/edit-vN/<variant>/full.mp4 (project-relative). */
export function editOutputs(
  projectDir: string,
): { version: number; variants: { name: string; full: string; mtime: number }[] } | null {
  const v = latestVersion(path.join(projectDir, "edit"), "timeline.v", ".json");
  if (v === undefined) return null;
  const base = path.join(projectDir, "out", `edit-v${v}`);
  const variants = fs.existsSync(base)
    ? fs
        .readdirSync(base, { withFileTypes: true })
        .filter((d) => d.isDirectory() && fs.existsSync(path.join(base, d.name, "full.mp4")))
        .map((d) => ({
          name: d.name,
          full: `out/edit-v${v}/${d.name}/full.mp4`,
          mtime: fs.statSync(path.join(base, d.name, "full.mp4")).mtimeMs,
        }))
    : [];
  return { version: v, variants };
}

export function brandRoutes(rt: Runtime): {
  get: Record<string, GetRoute>;
  post: Record<string, PostRoute>;
} {
  return {
    get: {
      brands: () => {
        const cfg = rt.getConfig();
        const p = rt.activeProject();
        const job = rt.jobs.latest("edit");
        return {
          default: cfg.brand,
          project: p?.slug ?? null,
          userDir: path.join(cfg.root, "brands"),
          brands: listBrands(cfg.root).map((b) => {
            if (b.error) return { name: b.name, builtin: b.builtin, error: b.error };
            const l = loadBrandDir(b.dir, b.builtin);
            return { name: b.name, builtin: b.builtin, brand: l.brand, warnings: l.warnings };
          }),
          edit: p ? editOutputs(p.dir) : null,
          job: job ? { id: job.id, status: job.status, error: job.error ?? null } : null,
        };
      },
    },
    post: {
      /** Preview with unsaved tweaks (nothing is written). */
      "brand-preview": async (body) => {
        const cfg = rt.getConfig();
        const loaded = patchedBrand(cfg.root, str(body, "name"), patchOf(body));
        const files = await renderPreviewFiles(rt, loaded);
        const rel = (f: string) =>
          `/media/previews/${path.relative(previewDir(cfg.root), f)}?t=${Date.now()}`;
        return {
          ...(files.title ? { title: rel(files.title) } : {}),
          framed: rel(files.framed),
          warnings: loaded.warnings,
        };
      },
      /** Two-phase: without confirm → the brand.json diff; with confirm → write. */
      "brand-save": (body) => {
        const cfg = rt.getConfig();
        const name = str(body, "name");
        const patch = patchOf(body);
        const plan = planBrandUpdate(cfg.root, name, patch);
        if (body.confirm !== true)
          return { planned: true, file: plan.file, diff: plan.diff, warnings: plan.warnings };
        updateBrand(cfg.root, name, patch);
        rt.bus.publish(
          "brand.changed",
          {
            name,
            by: "panel",
            file: plan.file,
            changed: Object.keys(patch),
            diff: plan.diff,
            message: `brand ${name} saved (${Object.keys(patch).join(", ") || "no changes"})`,
          },
          rt.activeProjectSlug,
        );
        return { saved: true, file: plan.file };
      },
      "brand-duplicate": (body) => {
        const l = duplicateBrand(rt.getConfig().root, str(body, "name"), str(body, "to"));
        rt.bus.publish(
          "brand.changed",
          {
            name: l.brand.name,
            by: "panel",
            from: str(body, "name"),
            message: `brand ${l.brand.name} created (copy of ${str(body, "name")})`,
          },
          rt.activeProjectSlug,
        );
        return { name: l.brand.name, dir: l.dir };
      },
      /** Two-phase default-brand change (config key "brand"). */
      "brand-use": (body) => {
        const name = str(body, "name");
        resolveBrand(rt.getConfig().root, name);
        const scope: Scope = body.scope === "project" ? "project" : "global";
        const change = planChange(configFiles(rt), scope, "brand", name, {
          env: process.env,
          home: os.homedir(),
        });
        if (body.confirm !== true)
          return {
            planned: true,
            file: change.file,
            diff: change.diff,
            shadowedBy: change.shadowedBy ?? null,
          };
        applyChange(change);
        rt.getConfig(true);
        rt.bus.publish(
          "config.changed",
          { key: "brand", scope, message: `default brand → ${name} (${scope})` },
          rt.activeProjectSlug,
        );
        return { saved: true, file: change.file };
      },
      /** Re-render the latest edit with a brand: timeline + raw.mp4 + voice only. */
      "export-render": (body) => {
        const brand = str(body, "brand");
        const job = startEdit(rt, "rerender", brand);
        return { job: job.id };
      },
    },
  };
}
