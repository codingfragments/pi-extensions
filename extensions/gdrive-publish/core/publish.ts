/**
 * Planning (offline) and publishing (two-phase, Drive-facing).
 *
 * Phase 1 reserves ids: create folders, create empty Doc shells for markdown,
 * convert-upload tabular sources. The manifest is checkpointed here with
 * `pending` markers so a crash cannot leak unrecorded Docs (decision 20).
 *
 * Phase 2 rewrites links against the now-known ids and fills content via
 * `files.update` + media, which keeps every fileId - and therefore every
 * shared URL - stable (verified in the spike, U2/U6).
 */

import fs from "node:fs";
import { describeDialect, normaliseCsv } from "./csv.ts";
import type { DriveClient } from "./drive.ts";
import { DriveError } from "./drive.ts";
import * as manifestIo from "./manifest.ts";
import { documentName, tabularName } from "./naming.ts";
import { prepareMarkdown } from "./prepare.ts";
import type { ResolvedTarget } from "./prepare.ts";
import { folderPaths, scan } from "./scan.ts";
import { GOOGLE_DOC, GOOGLE_SHEET, driveUrl, folderUrl } from "./types.ts";
import type { Diagnostic, Manifest, Plan, PlanItem, PublishSummary, SourceFile } from "./types.ts";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export interface PlanOptions {
  root: string;
  manifest: Manifest | null;
}

function nameFor(file: SourceFile): string {
  if (file.kind === "markdown") {
    return documentName(file.relPath, fs.readFileSync(file.absPath, "utf8"));
  }
  return tabularName(file.relPath);
}

function hashFor(file: SourceFile): string {
  return manifestIo.contentHash(fs.readFileSync(file.absPath));
}

/** Build an offline plan: what would be created, updated, left alone, orphaned. */
export function buildPlan(opts: PlanOptions): Plan {
  const { files, skipped } = scan(opts.root);
  const diagnostics: Diagnostic[] = [];
  for (const relPath of skipped) {
    diagnostics.push({
      code: "UNSUPPORTED_FILE",
      severity: "warn",
      relPath,
      message: "unsupported file type, not published",
    });
  }

  const manifest = opts.manifest;
  const items: PlanItem[] = [];
  for (const file of files) {
    if (file.kind === "image") continue; // images are inlined, never published standalone
    const existing = manifest?.entries[file.relPath];
    const folder = file.relPath.includes("/")
      ? file.relPath.slice(0, file.relPath.lastIndexOf("/"))
      : "";
    const name = nameFor(file);
    if (!existing) {
      items.push({ relPath: file.relPath, kind: file.kind, action: "create", name, folder });
      continue;
    }
    if (existing.pending) {
      diagnostics.push({
        code: "PENDING_RESUMED",
        severity: "warn",
        relPath: file.relPath,
        message: `previous run left this Doc empty; filling it in place (${existing.fileId})`,
      });
      items.push({
        relPath: file.relPath,
        kind: file.kind,
        action: "update",
        name,
        fileId: existing.fileId,
        folder,
      });
      continue;
    }
    const changed = hashFor(file) !== existing.contentHash || existing.name !== name;
    items.push({
      relPath: file.relPath,
      kind: file.kind,
      action: changed ? "update" : "unchanged",
      name,
      fileId: existing.fileId,
      folder,
    });
  }

  const present = new Set(files.map((f) => f.relPath));
  const orphans = Object.entries(manifest?.entries ?? {})
    .filter(([relPath]) => !present.has(relPath))
    .map(([relPath, entry]) => ({ relPath, fileId: entry.fileId, name: entry.name }));
  for (const orphan of orphans) {
    diagnostics.push({
      code: "ORPHAN",
      severity: "warn",
      relPath: orphan.relPath,
      message: `published previously but missing locally; use --prune to move it to Drive trash (${orphan.fileId})`,
    });
  }

  return {
    root: opts.root,
    ...(manifest ? { rootFolderId: manifest.rootFolderId } : {}),
    folders: folderPaths(files.filter((f) => f.kind !== "image")),
    items,
    orphans,
    diagnostics,
  };
}

export interface PublishOptions {
  root: string;
  drive: DriveClient;
  manifest: Manifest;
  plan: Plan;
  prune: boolean;
  /** Called with progress messages (CLI prints them; the extension shows a widget). */
  onProgress?: (message: string) => void;
  /** Wall-clock source, injectable for tests. */
  now?: () => Date;
}

/**
 * Execute a plan. Local content always wins; Drive-side modifications are
 * reported loudly but not merged (decision 3).
 */
export async function publish(opts: PublishOptions): Promise<PublishSummary> {
  const { root, drive, manifest, plan } = opts;
  const now = opts.now ?? (() => new Date());
  const progress = opts.onProgress ?? (() => {});
  const diagnostics: Diagnostic[] = [...plan.diagnostics];
  let created = 0;
  let updated = 0;
  let pruned = 0;

  // ---- phase 1: folders + id reservation ---------------------------------
  for (const folder of plan.folders) {
    if (manifest.folders[folder]) continue;
    const parentPath = folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "";
    const parentId = parentPath ? manifest.folders[parentPath] : manifest.rootFolderId;
    if (!parentId) throw new Error(`internal: parent folder "${parentPath}" not created yet`);
    const name = folder.split("/").pop() as string;
    const made = await drive.createFolder(name, parentId);
    manifest.folders[folder] = made.id;
    progress(`created folder ${folder}`);
  }

  const resolved = new Map<string, ResolvedTarget>();
  const toFill: { item: PlanItem; fileId: string }[] = [];

  for (const item of plan.items) {
    const parentId = item.folder ? manifest.folders[item.folder] : manifest.rootFolderId;
    if (!parentId) throw new Error(`internal: folder "${item.folder}" missing after phase 1`);

    if (item.action === "create") {
      if (item.kind === "markdown") {
        const shell = await drive.createEmptyDoc(item.name, parentId);
        manifest.entries[item.relPath] = {
          fileId: shell.id,
          kind: item.kind,
          name: item.name,
          url: driveUrl(item.kind, shell.id),
          contentHash: "",
          publishedAt: now().toISOString(),
          pending: true,
        };
        toFill.push({ item, fileId: shell.id });
        resolved.set(item.relPath, {
          fileId: shell.id,
          url: driveUrl(item.kind, shell.id),
          kind: item.kind,
        });
        created++;
        progress(`reserved Doc for ${item.relPath}`);
      } else {
        const { media, mediaMime, note } = tabularPayload(root, item.relPath, item.kind);
        if (note) diagnostics.push(note);
        const file = await drive.convertUpload(item.name, GOOGLE_SHEET, mediaMime, media, parentId);
        manifest.entries[item.relPath] = {
          fileId: file.id,
          kind: item.kind,
          name: item.name,
          url: driveUrl(item.kind, file.id),
          contentHash: manifestIo.contentHash(fs.readFileSync(`${root}/${item.relPath}`)),
          publishedAt: now().toISOString(),
        };
        resolved.set(item.relPath, {
          fileId: file.id,
          url: driveUrl(item.kind, file.id),
          kind: item.kind,
        });
        created++;
        progress(`created sheet ${item.relPath}`);
      }
      continue;
    }

    // update / unchanged: the id is already known
    const fileId = item.fileId as string;
    resolved.set(item.relPath, { fileId, url: driveUrl(item.kind, fileId), kind: item.kind });
    if (item.action === "update") {
      const divergence = await checkDivergence(drive, fileId, manifest, item.relPath);
      if (divergence) diagnostics.push(divergence);
      if (item.kind === "markdown") {
        toFill.push({ item, fileId });
      } else {
        const { media, mediaMime, note } = tabularPayload(root, item.relPath, item.kind);
        if (note) diagnostics.push(note);
        await drive.updateMedia(fileId, mediaMime, media);
        const entry = manifest.entries[item.relPath];
        if (entry) {
          entry.name = item.name;
          entry.contentHash = manifestIo.contentHash(fs.readFileSync(`${root}/${item.relPath}`));
          entry.publishedAt = now().toISOString();
        }
        updated++;
        progress(`updated sheet ${item.relPath}`);
      }
    }
  }

  // Checkpoint: ids exist in Drive and are now recorded, pending fill.
  manifestIo.save(root, manifest);

  // ---- phase 2: rewrite links and fill content ---------------------------
  const known = new Set(scan(root).files.map((f) => f.relPath));
  for (const { item, fileId } of toFill) {
    const markdown = fs.readFileSync(`${root}/${item.relPath}`, "utf8");
    const prepared = prepareMarkdown({
      relPath: item.relPath,
      markdown,
      resolved,
      root,
      known,
    });
    diagnostics.push(...prepared.diagnostics);
    if (prepared.diagnostics.some((d) => d.severity === "error")) {
      progress(`SKIPPED ${item.relPath} (see errors)`);
      continue;
    }
    await drive.updateMedia(fileId, "text/markdown", prepared.content);
    const entry = manifest.entries[item.relPath];
    if (entry) {
      entry.name = item.name;
      entry.contentHash = manifestIo.contentHash(fs.readFileSync(`${root}/${item.relPath}`));
      entry.publishedAt = now().toISOString();
      // The key must disappear from the serialised manifest: assigning
      // undefined would keep it in Object.keys and inflate `status` counts.
      // biome-ignore lint/performance/noDelete: see comment above
      delete entry.pending;
    }
    if (item.action === "update") updated++;
    progress(`published ${item.relPath}`);
  }

  // ---- prune (opt-in, trash only) ----------------------------------------
  if (opts.prune) {
    for (const orphan of plan.orphans) {
      try {
        await drive.trash(orphan.fileId);
        // A pruned entry must not survive as an undefined-valued key.
        delete manifest.entries[orphan.relPath];
        pruned++;
        progress(`trashed ${orphan.relPath}`);
      } catch (e) {
        diagnostics.push({
          code: "DRIVE_FILE_GONE",
          severity: "warn",
          relPath: orphan.relPath,
          message: `could not trash ${orphan.fileId}: ${String(e).slice(0, 160)}`,
        });
      }
    }
  }

  const manifestFile = manifestIo.save(root, manifest);
  return {
    created,
    updated,
    unchanged: plan.items.filter((i) => i.action === "unchanged").length,
    pruned,
    orphans: plan.orphans.length - pruned,
    diagnostics,
    manifestPath: manifestFile,
    rootFolderUrl: folderUrl(manifest.rootFolderId),
  };
}

function tabularPayload(
  root: string,
  relPath: string,
  kind: "csv" | "xlsx" | "markdown" | "image",
): { media: Buffer | string; mediaMime: string; note?: Diagnostic } {
  const buf = fs.readFileSync(`${root}/${relPath}`);
  if (kind === "csv") {
    const sniffed = normaliseCsv(buf);
    return {
      media: sniffed.text,
      mediaMime: "text/csv",
      ...(sniffed.normalised
        ? {
            note: {
              code: "CSV_NORMALISED" as const,
              severity: "warn" as const,
              relPath,
              message: `normalised to UTF-8 comma CSV (detected ${describeDialect(sniffed)})`,
            },
          }
        : {}),
    };
  }
  return {
    media: buf,
    mediaMime: XLSX_MIME,
    note: {
      code: "XLSX_LOSSY",
      severity: "warn",
      relPath,
      message: "converted to a Google Sheet; macros and some formatting are lost",
    },
  };
}

/** Warn when Drive's copy changed after our last publish (decision 3). */
async function checkDivergence(
  drive: DriveClient,
  fileId: string,
  manifest: Manifest,
  relPath: string,
): Promise<Diagnostic | null> {
  const entry = manifest.entries[relPath];
  if (!entry) return null;
  try {
    const meta = await drive.get(fileId);
    if (meta.trashed) {
      return {
        code: "DRIVE_FILE_GONE",
        severity: "error",
        relPath,
        message: `Drive file ${fileId} is in the trash; restore it or re-run with --repair`,
      };
    }
    if (meta.modifiedTime && entry.publishedAt && meta.modifiedTime > entry.publishedAt) {
      const who =
        meta.lastModifyingUser?.displayName ?? meta.lastModifyingUser?.emailAddress ?? "someone";
      return {
        code: "DRIVE_MODIFIED",
        severity: "warn",
        relPath,
        message: `changed in Drive by ${who} at ${meta.modifiedTime}; local content wins (Drive revision history keeps their version)`,
      };
    }
    return null;
  } catch (e) {
    if (e instanceof DriveError && (e.status === 404 || e.status === 403)) {
      return {
        code: "DRIVE_FILE_GONE",
        severity: "error",
        relPath,
        message: `Drive file ${fileId} is not accessible (${e.status}); re-run with --repair to recreate it`,
      };
    }
    throw e;
  }
}

export { GOOGLE_DOC, GOOGLE_SHEET };
