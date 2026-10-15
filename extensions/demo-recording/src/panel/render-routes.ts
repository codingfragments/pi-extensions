/**
 * Panel routes for the Render tab (S5 part 9, D59–D68): the render history
 * (with legacy renders), what a new render can use (gate, annotation versions,
 * brands), starting a render as a background engine job (no agent turn),
 * cancel, delete (files go, the record stays), open a variant's folder, and
 * "Use no annotations" for the Annotations tab.
 */

import fs from "node:fs";
import path from "node:path";
import { readDraft } from "../annotations/draft.ts";
import { annotationVersions, readAnnotations, writeAnnotations } from "../annotations/file.ts";
import { listBrands } from "../brand/brand.ts";
import { type RenderRequest, finalBlocker, latestTimelineFor } from "../render/run.ts";
import {
  deleteRenderFiles,
  legacyRenders,
  listRenders,
  readRender,
  variantPresent,
  variantZip,
} from "../render/store.ts";
import type { Runtime } from "../runtime.ts";
import { startRender } from "../tools/render.ts";
import { openInBrowser } from "../util/open.ts";
import { recordInput } from "../workdir/inputs.ts";
import { isUsable } from "../workdir/stages.ts";
import { readState } from "../workdir/state.ts";
import type { GetRoute, PostRoute } from "./server.ts";

export function rendersView(rt: Runtime) {
  const p = rt.activeProject();
  if (!p) return { project: null };
  const cfg = rt.getConfig();
  const state = readState(p.dir) ?? p.state;
  const accepted = state.accepted.render ?? {};
  const job = rt.jobs.latest("render");
  const draft = readDraft(p.dir);
  return {
    project: p.slug,
    finalBlocker: finalBlocker(p.dir) ?? null,
    defaults: {
      brand: cfg.brand,
      annotations: state.line.annotations ?? null,
      keepDrafts: cfg.render.keepDrafts,
    },
    brands: listBrands(cfg.root)
      .filter((b) => !b.error)
      .map((b) => ({ name: b.name, builtin: b.builtin })),
    annotationVersions: annotationVersions(p.dir)
      .reverse()
      .map((v) => {
        const f = readAnnotations(p.dir, v);
        return {
          version: v,
          vo: f?.basedOn.vo ?? null,
          enabled: f?.items.filter((x) => x.enabled).length ?? 0,
          types: [...new Set(f?.items.filter((x) => x.enabled).map((x) => x.type) ?? [])],
          redactions: f?.items.filter((x) => x.enabled && x.type === "redact").length ?? 0,
          accepted: !!state.accepted.annotations?.[String(v)],
          usable: isUsable(p.dir, state.accepted, "annotations", v),
          onLine: state.line.annotations === v,
        };
      }),
    draft: draft ? { base: draft.base, changes: draft.changes } : null,
    hasEdit: latestTimelineFor(p.dir) !== undefined,
    job: job ? { id: job.id, status: job.status, error: job.error ?? null } : null,
    renders: listRenders(p.dir).map((r) => ({
      ...r,
      accepted: !!accepted[String(r.version)],
      onLine: state.line.render === r.version,
      variants: r.variants.map((v) => {
        const present = variantPresent(p.dir, v);
        // Size of every file (the table shows them per row).
        const f = v.files;
        const all = [
          f.full,
          f.fullSubtitled,
          f.vtt,
          f.callouts,
          f.poster,
          ...(f.scenes ?? []),
          ...(f.scenesSubtitled ?? []),
          ...(f.scenesVtt ?? []),
        ].filter((x): x is string => !!x);
        const sizes: Record<string, number> = {};
        if (present)
          for (const rel of all) {
            const file = path.join(p.dir, v.dir, rel);
            if (fs.existsSync(file)) sizes[rel] = fs.statSync(file).size;
          }
        return { ...v, present, sizes };
      }),
    })),
    legacy: legacyRenders(p.dir),
  };
}

export function renderRoutes(rt: Runtime): {
  get: Record<string, GetRoute>;
  post: Record<string, PostRoute>;
} {
  const requireProject = () => rt.requireProject();
  return {
    get: {
      renders: () => rendersView(rt),
    },
    post: {
      /** { kind, annotations?: number|null, fromDraft?, brands?, options?, confirmUnredacted? } → background job. */
      render: (body) => {
        const p = requireProject();
        const kind = body.kind === "final" ? "final" : "draft";
        const req: RenderRequest = {
          kind,
          ...(body.annotations === null
            ? { annotations: null }
            : typeof body.annotations === "number"
              ? { annotations: body.annotations }
              : {}),
          ...(body.fromDraft === true ? { fromDraft: true } : {}),
          ...(Array.isArray(body.brands) && body.brands.length
            ? { brands: body.brands.map(String) }
            : {}),
          ...(body.options && typeof body.options === "object"
            ? { options: body.options as RenderRequest["options"] }
            : {}),
          ...(body.confirmUnredacted === true ? { confirmUnredacted: true } : {}),
          by: "panel",
        };
        const job = startRender(rt, req);
        rt.bus.publish(
          "render.started",
          { job: job.id, kind, message: `${kind} render started` },
          p.slug,
        );
        return { job: job.id };
      },
      "render-cancel": () => {
        const j = rt.jobs.running("render");
        if (j) j.controller.abort();
        return { cancelled: !!j };
      },
      /** Delete a render's files (D64); the record stays as "deleted". Accepted finals need confirmAccepted. */
      "render-delete": (body) => {
        const p = requireProject();
        const v = Number(body.version);
        const rec = readRender(p.dir, v);
        if (!rec) throw new Error(`render v${v} does not exist`);
        const state = readState(p.dir) ?? p.state;
        if (state.accepted.render?.[String(v)] && body.confirmAccepted !== true)
          throw new Error(
            `render v${v} is the accepted deliverable — confirm to delete its files anyway`,
          );
        const bytes = deleteRenderFiles(p.dir, v, "deleted");
        recordInput(p.dir, {
          stage: "render",
          version: v,
          source: "panel",
          kind: "review",
          text: `deleted the files of ${rec.kind} render v${v} (${(bytes / 1e6).toFixed(1)} MB)`,
        });
        rt.bus.publish(
          "render.deleted",
          {
            version: v,
            bytes,
            message: `render v${v}: files deleted (${(bytes / 1e6).toFixed(1)} MB freed)`,
          },
          p.slug,
        );
        return { deleted: v, bytes };
      },
      /** { version, variant } → one zip with everything of the variant (built once, cached). */
      "render-zip": async (body) => {
        const p = requireProject();
        const v = Number(body.version);
        const rec = readRender(p.dir, v);
        if (!rec) throw new Error(`render v${v} does not exist`);
        const variant = rec.variants.find((x) => x.key === body.variant);
        if (!variant) throw new Error(`render v${v} has no variant "${String(body.variant)}"`);
        const z = await variantZip(p.dir, rec, variant);
        if (z.built)
          rt.bus.publish(
            "render.zipped",
            {
              version: v,
              variant: variant.key,
              bytes: z.bytes,
              message: `zip of render v${v} ${variant.key} (${(z.bytes / 1e6).toFixed(1)} MB)`,
            },
            p.slug,
          );
        return { zip: z.rel.split(path.sep).join("/"), bytes: z.bytes };
      },
      /** Open a variant's folder in the file manager. */
      "render-open": (body) => {
        const p = requireProject();
        const v = Number(body.version);
        const rec = readRender(p.dir, v);
        const variant = rec?.variants.find((x) => x.key === body.variant) ?? rec?.variants[0];
        const dir = variant
          ? path.join(p.dir, variant.dir)
          : typeof body.dir === "string"
            ? path.join(p.dir, body.dir)
            : undefined;
        if (!dir || !dir.startsWith(p.dir) || !fs.existsSync(dir))
          throw new Error("no files for that render");
        return { opened: openInBrowser(dir), dir };
      },
      /** "Use no annotations" (D66): an empty annotation version for the working line's VO, to accept like any other. */
      "annotations-empty": () => {
        const p = requireProject();
        const state = readState(p.dir) ?? p.state;
        if (state.line.vo === undefined) throw new Error("accept a voice-over first");
        const tv = latestTimelineFor(p.dir, state.line.vo);
        if (tv === undefined) throw new Error(`run the sync edit for VO v${state.line.vo} first`);
        const t = JSON.parse(
          fs.readFileSync(path.join(p.dir, "edit", `timeline.v${tv}.json`), "utf8"),
        ) as { take: string };
        const stored = writeAnnotations(p.dir, {
          basedOn: { vo: state.line.vo },
          take: t.take,
          by: "user (no annotations)",
          items: [],
        });
        rt.bus.publish(
          "annotations.updated",
          {
            version: stored.version,
            message: `annotations v${stored.version}: no annotations (accept it to render a plain final)`,
          },
          p.slug,
        );
        return { version: stored.version };
      },
    },
  };
}
