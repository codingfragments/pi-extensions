/**
 * Report rendering: human-readable text and machine-readable JSON
 * (`--json` keeps the CLI usable from CI and from the pi extension).
 */

import fs from "node:fs";
import { describeDialect, normaliseCsv } from "./csv.ts";
import type { Diagnostic, Plan, PublishSummary } from "./types.ts";

export function renderPlan(plan: Plan, root: string): string {
  const lines: string[] = [];
  lines.push(`plan ${root}`);
  const creates = plan.items.filter((i) => i.action === "create");
  const updates = plan.items.filter((i) => i.action === "update");
  const unchanged = plan.items.filter((i) => i.action === "unchanged");

  for (const item of plan.items) {
    const marker = item.action === "create" ? "+" : item.action === "update" ? "~" : "=";
    let detail = `-> ${item.kind === "markdown" ? "Doc" : "Sheet"} "${item.name}"`;
    if (item.kind === "csv") {
      try {
        const sniffed = normaliseCsv(fs.readFileSync(`${root}/${item.relPath}`));
        if (sniffed.normalised) detail += ` (${describeDialect(sniffed)} -> normalised)`;
      } catch {
        // unreadable file is reported via diagnostics
      }
    }
    lines.push(`  ${marker} ${item.relPath.padEnd(40)} ${detail}`);
  }
  for (const orphan of plan.orphans) {
    lines.push(`  ! ${orphan.relPath.padEnd(40)} -> orphan "${orphan.name}" (not pruned)`);
  }
  lines.push("");
  lines.push(
    `  ${creates.length} to create, ${updates.length} to update, ${unchanged.length} unchanged, ${plan.orphans.length} orphan(s)`,
  );
  const diag = renderDiagnostics(plan.diagnostics);
  if (diag) lines.push("", diag);
  return lines.join("\n");
}

export function renderDiagnostics(diagnostics: Diagnostic[]): string {
  if (diagnostics.length === 0) return "";
  const lines: string[] = [];
  const errors = diagnostics.filter((d) => d.severity === "error");
  const warnings = diagnostics.filter((d) => d.severity === "warn");
  for (const d of errors) {
    lines.push(`  ERROR ${d.code}${d.relPath ? ` ${d.relPath}` : ""}: ${d.message}`);
  }
  for (const d of warnings) {
    lines.push(`  WARN  ${d.code}${d.relPath ? ` ${d.relPath}` : ""}: ${d.message}`);
  }
  return lines.join("\n");
}

export function renderSummary(summary: PublishSummary): string {
  const lines: string[] = [];
  lines.push(
    `  ${summary.created} created, ${summary.updated} updated, ${summary.unchanged} unchanged, ` +
      `${summary.pruned} pruned, ${summary.orphans} orphan(s) kept`,
  );
  const diag = renderDiagnostics(summary.diagnostics);
  if (diag) lines.push(diag);
  lines.push(`  folder: ${summary.rootFolderUrl}`);
  lines.push(`  manifest updated: ${summary.manifestPath}`);
  lines.push("  -> review and commit the manifest to keep URLs stable for others");
  return lines.join("\n");
}

export function planJson(plan: Plan): unknown {
  return {
    root: plan.root,
    rootFolderId: plan.rootFolderId ?? null,
    folders: plan.folders,
    items: plan.items,
    orphans: plan.orphans,
    diagnostics: plan.diagnostics,
  };
}

export function summaryJson(summary: PublishSummary): unknown {
  return {
    created: summary.created,
    updated: summary.updated,
    unchanged: summary.unchanged,
    pruned: summary.pruned,
    orphans: summary.orphans,
    manifestPath: summary.manifestPath,
    rootFolderUrl: summary.rootFolderUrl,
    diagnostics: summary.diagnostics,
  };
}
