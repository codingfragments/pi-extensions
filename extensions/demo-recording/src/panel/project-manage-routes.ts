/**
 * Managing projects over HTTP (item 14, E; D146). See `../projects/manage.ts`.
 *
 *   GET  /api/projects            every project (name, app, phase, size, last change, which is active), the archive folder
 *   POST /api/project-switch      { slug }: make it the active project (refused while a job of the active one runs)
 *   POST /api/project-archive     { slug, withoutDrafts? }: write <root>/archive/<slug>-<date>.zip and read it back; the project stays
 *   POST /api/project-delete      { slug, confirmName, withoutDrafts? }: archive, verify, and only then remove the folder
 */

import { archiveDir, archiveProject, deleteProject, listProjectRows } from "../projects/manage.ts";
import type { Runtime } from "../runtime.ts";
import type { GetRoute, PostRoute } from "./server.ts";

export function projectManageRoutes(rt: Runtime): {
  get: Record<string, GetRoute>;
  post: Record<string, PostRoute>;
} {
  const root = () => rt.getConfig().root;
  const slugOf = (body: Record<string, unknown>) => {
    const slug = String(body.slug ?? "");
    if (!slug) throw new Error('"slug" is required');
    return slug;
  };
  /** Files change under a running job: a zip of them could not be trusted, and a delete would pull the folder from under it. */
  const notBusy = (slug: string, what: string) => {
    const busy = rt.activeProjectSlug === slug ? rt.jobs.running() : undefined;
    if (busy)
      throw new Error(
        `a ${busy.kind} job of "${slug}" is running (${busy.id}): wait for it or cancel it before you ${what}`,
      );
  };
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  return {
    get: {
      projects: () => ({
        root: root(),
        archive: archiveDir(root()),
        active: rt.activeProjectSlug ?? null,
        projects: listProjectRows(root(), rt.activeProjectSlug),
      }),
    },
    post: {
      "project-switch": (body) => {
        const h = rt.switchProject(slugOf(body));
        return { active: h.slug, phase: h.state.phase };
      },
      "project-archive": async (body) => {
        const slug = slugOf(body);
        notBusy(slug, "archive it");
        const r = await archiveProject(root(), slug, {
          withoutDrafts: body.withoutDrafts === true,
        });
        rt.bus.publish(
          "project.archived",
          {
            project: slug,
            file: r.file,
            bytes: r.bytes,
            files: r.files,
            message: `archived ${slug}: ${r.files} files, ${mb(r.bytes)}`,
          },
          slug,
        );
        return r;
      },
      "project-delete": async (body) => {
        const slug = slugOf(body);
        notBusy(slug, "delete it");
        const wasActive = rt.activeProjectSlug === slug;
        const r = await deleteProject(root(), slug, String(body.confirmName ?? ""), {
          withoutDrafts: body.withoutDrafts === true,
        });
        if (wasActive) rt.clearActiveProject();
        rt.bus.publish(
          "project.deleted",
          {
            project: slug,
            file: r.file,
            bytes: r.bytes,
            wasActive,
            message: `deleted ${slug}; its zip: ${r.file}`,
          },
          wasActive ? undefined : rt.activeProjectSlug,
        );
        return { ...r, wasActive };
      },
    },
  };
}
