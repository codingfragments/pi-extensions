/**
 * Source tree scanning and file classification (decision 7: the publish root
 * directory *is* the publish set).
 */

import fs from "node:fs";
import path from "node:path";
import { MANIFEST_FILENAME } from "./types.ts";
import type { FileKind, SourceFile } from "./types.ts";

export const MARKDOWN_EXT = new Set([".md", ".markdown"]);
export const CSV_EXT = new Set([".csv", ".tsv"]);
export const XLSX_EXT = new Set([".xlsx", ".xls"]);
export const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);

/** Directories never traversed. */
export const IGNORED_DIRS = new Set([
  ".git",
  ".svn",
  "node_modules",
  ".pi",
  "dist",
  "build",
  ".next",
  "coverage",
  ".venv",
  "__pycache__",
  ".DS_Store",
]);

export function classify(relPath: string): FileKind | null {
  const ext = path.extname(relPath).toLowerCase();
  if (MARKDOWN_EXT.has(ext)) return "markdown";
  if (CSV_EXT.has(ext)) return "csv";
  if (XLSX_EXT.has(ext)) return "xlsx";
  if (IMAGE_EXT.has(ext)) return "image";
  return null;
}

export function imageMimeType(relPath: string): string | null {
  switch (path.extname(relPath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".svg":
      return "image/svg+xml";
    default:
      return null;
  }
}

export interface ScanResult {
  files: SourceFile[];
  /** Files skipped because their extension is not supported. */
  skipped: string[];
}

/** Recursively scan a publish root. Symlinked directories are not followed. */
export function scan(root: string): ScanResult {
  const files: SourceFile[] = [];
  const skipped: string[] = [];

  const walk = (dir: string, rel: string): void => {
    const entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") && entry.name !== MANIFEST_FILENAME) {
        // Hidden files/directories are not published (manifest handled separately).
        if (entry.isDirectory()) continue;
        if (entry.name !== MANIFEST_FILENAME) continue;
      }
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name), relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === MANIFEST_FILENAME) continue;
      const kind = classify(relPath);
      if (!kind) {
        skipped.push(relPath);
        continue;
      }
      const absPath = path.join(root, relPath);
      files.push({ relPath, absPath, kind, size: fs.statSync(absPath).size });
    }
  };

  walk("", "");
  return { files, skipped };
}

/** Folder paths needed in Drive, parents before children. */
export function folderPaths(files: SourceFile[]): string[] {
  const set = new Set<string>();
  for (const f of files) {
    const parts = f.relPath.split("/");
    parts.pop();
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      set.add(acc);
    }
  }
  return [...set].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}
