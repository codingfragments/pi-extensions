/**
 * Shared types for gdrive-publish core.
 *
 * This module (and everything under `core/`) must stay free of pi imports and
 * of network/filesystem side effects beyond what is explicitly passed in, so
 * the same logic backs both the CLI and the pi extension.
 */

export const MANIFEST_FILENAME = ".gdrive-manifest.json";
export const MANIFEST_VERSION = 1;

export const GOOGLE_DOC = "application/vnd.google-apps.document";
export const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";
export const GOOGLE_FOLDER = "application/vnd.google-apps.folder";

/** Warning/error codes surfaced in reports. Stable identifiers: do not rename. */
export type DiagnosticCode =
  | "ANCHOR_DROPPED"
  | "LINK_OUTSIDE_ROOT"
  | "LINK_TARGET_MISSING"
  | "LINK_TO_UNSUPPORTED"
  | "FRONTMATTER_STRIPPED"
  | "IMAGE_LARGE"
  | "IMAGE_MISSING"
  | "IMAGE_UNSUPPORTED"
  | "DOC_PAYLOAD_TOO_LARGE"
  | "CSV_NORMALISED"
  | "XLSX_LOSSY"
  | "DRIVE_MODIFIED"
  | "DRIVE_FILE_GONE"
  | "ORPHAN"
  | "UNSUPPORTED_FILE"
  | "PENDING_RESUMED";

export type Severity = "warn" | "error";

export interface Diagnostic {
  code: DiagnosticCode;
  severity: Severity;
  /** Source file the diagnostic belongs to, repo-relative with forward slashes. */
  relPath?: string;
  message: string;
}

export type FileKind = "markdown" | "csv" | "xlsx" | "image";

export interface SourceFile {
  /** Path relative to the publish root, forward slashes, never starts with "./". */
  relPath: string;
  absPath: string;
  kind: FileKind;
  size: number;
}

export type PlanAction = "create" | "update" | "unchanged";

export interface PlanItem {
  relPath: string;
  kind: FileKind;
  action: PlanAction;
  /** Target name in Drive (front-matter title -> first H1 -> filename stem). */
  name: string;
  /** Existing Drive fileId when the manifest already knows this file. */
  fileId?: string;
  /** Drive folder path (relative, "" for the publish root). */
  folder: string;
}

export interface OrphanItem {
  relPath: string;
  fileId: string;
  name: string;
}

export interface Plan {
  root: string;
  rootFolderId?: string;
  /** Drive folder paths that need to exist, parents before children. */
  folders: string[];
  items: PlanItem[];
  orphans: OrphanItem[];
  diagnostics: Diagnostic[];
}

/** One published file, as recorded in the manifest. */
export interface ManifestEntry {
  fileId: string;
  kind: FileKind;
  name: string;
  url: string;
  /** sha256 of the local source bytes at publish time. */
  contentHash: string;
  publishedAt: string;
  /** Set while a Doc shell exists but its content has not been filled yet. */
  pending?: boolean;
}

export interface Manifest {
  version: number;
  rootFolderId: string;
  rootFolderName: string;
  /** Informational: which credential source and client published this tree. */
  credentialSource?: string;
  clientIdHash?: string;
  /** Drive folder ids by relative folder path ("" is the publish root). */
  folders: Record<string, string>;
  /** Published files by source relPath. */
  entries: Record<string, ManifestEntry>;
}

export interface PublishSummary {
  created: number;
  updated: number;
  unchanged: number;
  pruned: number;
  orphans: number;
  diagnostics: Diagnostic[];
  manifestPath: string;
  rootFolderUrl: string;
}

export function driveUrl(kind: FileKind, fileId: string): string {
  if (kind === "csv" || kind === "xlsx") {
    return `https://docs.google.com/spreadsheets/d/${fileId}/edit`;
  }
  return `https://docs.google.com/document/d/${fileId}/edit`;
}

export function folderUrl(folderId: string): string {
  return `https://drive.google.com/drive/folders/${folderId}`;
}
