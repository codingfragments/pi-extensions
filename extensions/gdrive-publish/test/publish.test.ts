/**
 * End-to-end publish tests against the fake Drive client.
 *
 * These assert the properties the spike identified as load-bearing:
 * two-phase ordering, update-in-place (never recreate), stable ids across
 * re-runs, pending-entry recovery, inline images, and trash-not-delete.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as manifestIo from "../core/manifest.ts";
import { buildPlan, publish } from "../core/publish.ts";
import type { Manifest } from "../core/types.ts";
import { FakeDrive } from "./fake-drive.ts";

function fixture(files: Record<string, string | Buffer>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gdp-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

function freshManifest(): Manifest {
  return manifestIo.emptyManifest("fldROOT", "Test Docs");
}

async function run(
  root: string,
  manifest: Manifest,
  opts: { prune?: boolean; drive?: FakeDrive } = {},
) {
  const drive = opts.drive ?? new FakeDrive();
  drive.files.set("fldROOT", { id: "fldROOT", name: "Test Docs", mimeType: "folder" });
  const plan = buildPlan({ root, manifest });
  const summary = await publish({
    root,
    drive,
    manifest,
    plan,
    prune: opts.prune ?? false,
    now: () => new Date("2024-01-01T00:00:00.000Z"),
  });
  return { drive, plan, summary };
}

test("rewrites a relative link to the sibling Doc URL (the core requirement)", async () => {
  const root = fixture({
    "toc.md": "# TOC\n\nSee [the details](./details.md) and [again](details.md).\n",
    "details.md": "# Details\n\nBack to [toc](./toc.md).\n",
  });
  const manifest = freshManifest();
  const { drive, summary } = await run(root, manifest);

  const detailsId = manifest.entries["details.md"]?.fileId as string;
  const tocId = manifest.entries["toc.md"]?.fileId as string;
  assert.ok(detailsId && tocId);
  const tocBody = drive.contentOf(tocId);
  assert.match(tocBody, new RegExp(`/document/d/${detailsId}/edit`));
  // both link forms rewritten
  assert.equal(tocBody.split(detailsId).length - 1, 2);
  assert.match(drive.contentOf(detailsId), new RegExp(`/document/d/${tocId}/edit`));
  assert.equal(summary.created, 2);
});

test("phase 1 reserves every id before any content is filled", async () => {
  const root = fixture({
    "a.md": "# A\n[b](./b.md)\n",
    "b.md": "# B\n[a](./a.md)\n",
  });
  const { drive } = await run(root, freshManifest());
  const lastCreate = Math.max(
    ...drive.calls.map((c, i) => (c.startsWith("createEmptyDoc") ? i : -1)),
  );
  const firstFill = drive.calls.findIndex((c) => c.startsWith("updateMedia"));
  assert.ok(
    lastCreate < firstFill,
    `expected all shells before the first fill, got: ${drive.calls.join(" ")}`,
  );
});

test("re-publishing updates in place and keeps fileIds stable", async () => {
  const root = fixture({ "a.md": "# A\nv1\n" });
  const manifest = freshManifest();
  const first = await run(root, manifest);
  const idAfterFirst = manifest.entries["a.md"]?.fileId as string;

  fs.writeFileSync(path.join(root, "a.md"), "# A\nv2\n");
  const second = await run(root, manifest, { drive: first.drive });

  assert.equal(manifest.entries["a.md"]?.fileId, idAfterFirst, "fileId must not change");
  assert.equal(second.summary.created, 0);
  assert.equal(second.summary.updated, 1);
  assert.match(first.drive.contentOf(idAfterFirst), /v2/);
  // exactly one Doc was ever created
  assert.equal(first.drive.calls.filter((c) => c.startsWith("createEmptyDoc")).length, 1);
});

test("unchanged files are skipped on re-run", async () => {
  const root = fixture({ "a.md": "# A\n" });
  const manifest = freshManifest();
  const first = await run(root, manifest);
  const second = await run(root, manifest, { drive: first.drive });
  assert.equal(second.summary.unchanged, 1);
  assert.equal(second.summary.updated, 0);
  assert.equal(second.summary.created, 0);
});

test("a crash after phase 1 is recovered without creating duplicates", async () => {
  const root = fixture({ "a.md": "# A\n" });
  const manifest = freshManifest();
  // Simulate the checkpointed state: id reserved, content never filled.
  const drive = new FakeDrive();
  drive.files.set("fldROOT", { id: "fldROOT", name: "Test Docs", mimeType: "folder" });
  const shell = await drive.createEmptyDoc("A", "fldROOT");
  manifest.entries["a.md"] = {
    fileId: shell.id,
    kind: "markdown",
    name: "A",
    url: `https://docs.google.com/document/d/${shell.id}/edit`,
    contentHash: "",
    publishedAt: "2024-01-01T00:00:00.000Z",
    pending: true,
  };

  const { plan, summary } = await run(root, manifest, { drive });
  assert.ok(plan.diagnostics.some((d) => d.code === "PENDING_RESUMED"));
  assert.equal(summary.created, 0, "must not create a second Doc");
  assert.equal(manifest.entries["a.md"]?.fileId, shell.id);
  assert.equal(manifest.entries["a.md"]?.pending, undefined, "pending flag must be cleared");
  assert.match(drive.contentOf(shell.id), /# A/);
});

test("images are inlined as data URIs, not published as files", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const root = fixture({
    "doc.md": "# Doc\n\n![pixel](./img/pixel.png)\n",
    "img/pixel.png": png,
  });
  const manifest = freshManifest();
  const { drive, summary } = await run(root, manifest);
  const id = manifest.entries["doc.md"]?.fileId as string;
  assert.match(drive.contentOf(id), /!\[pixel\]\(data:image\/png;base64,iVBOR/);
  assert.equal(summary.created, 1, "the image must not become its own Drive file");
  assert.equal(manifest.entries["img/pixel.png"], undefined);
  assert.equal(
    drive.calls.filter((c) => c.includes("pixel.png")).length,
    0,
    "no upload call for the image itself",
  );
});

test("links inside code fences are never rewritten", async () => {
  const root = fixture({
    "a.md": ["# A", "", "```md", "[b](./b.md)", "```", "", "[b](./b.md)"].join("\n"),
    "b.md": "# B\n",
  });
  const manifest = freshManifest();
  const { drive } = await run(root, manifest);
  const body = drive.contentOf(manifest.entries["a.md"]?.fileId as string);
  assert.match(body, /```md\n\[b\]\(\.\/b\.md\)\n```/, "fenced link must stay literal");
  const bId = manifest.entries["b.md"]?.fileId as string;
  assert.equal(body.split(bId).length - 1, 1, "only the real link is rewritten");
});

test("diagnostics cover anchors, escapes, missing targets and unsupported files", async () => {
  const root = fixture({
    "a.md": [
      "# A",
      "[anchor](./b.md#section)",
      "[escape](../outside.md)",
      "[missing](./nope.md)",
      "[external](https://example.test)",
    ].join("\n"),
    "b.md": "# B\n",
    "notes.txt": "not published",
  });
  const manifest = freshManifest();
  const { drive, summary } = await run(root, manifest);
  const codes = summary.diagnostics.map((d) => d.code);
  assert.ok(codes.includes("ANCHOR_DROPPED"));
  assert.ok(codes.includes("LINK_OUTSIDE_ROOT"));
  assert.ok(codes.includes("LINK_TARGET_MISSING"));
  assert.ok(codes.includes("UNSUPPORTED_FILE"));
  const body = drive.contentOf(manifest.entries["a.md"]?.fileId as string);
  assert.match(body, /\[external\]\(https:\/\/example\.test\)/, "external links untouched");
  assert.match(body, /\[escape\]\(\.\.\/outside\.md\)/, "escaping link left verbatim");
});

test("front matter is stripped and its title becomes the Doc name", async () => {
  const root = fixture({
    "a.md": ["---", "title: Real Title", "---", "", "# Heading", "body"].join("\n"),
  });
  const manifest = freshManifest();
  const { drive, summary } = await run(root, manifest);
  const entry = manifest.entries["a.md"];
  assert.equal(entry?.name, "Real Title");
  const body = drive.contentOf(entry?.fileId as string);
  assert.doesNotMatch(body, /title: Real Title/, "front matter must not reach Drive");
  assert.match(body, /# Heading/);
  assert.ok(summary.diagnostics.some((d) => d.code === "FRONTMATTER_STRIPPED"));
});

test("CSV is normalised and uploaded as a Sheet; xlsx is passed through", async () => {
  const root = fixture({
    "data.csv": Buffer.from("Spalte 1;Spalte 2\nWert 1;Wert 2\n", "latin1"),
    "book.xlsx": Buffer.from("PK\u0003\u0004fake-xlsx"),
  });
  const manifest = freshManifest();
  const { drive, summary } = await run(root, manifest);
  const csvId = manifest.entries["data.csv"]?.fileId as string;
  assert.match(drive.contentOf(csvId), /Spalte 1,Spalte 2/, "normalised to comma");
  const codes = summary.diagnostics.map((d) => d.code);
  assert.ok(codes.includes("CSV_NORMALISED"));
  assert.ok(codes.includes("XLSX_LOSSY"));
  assert.ok(
    drive.calls.some((c) => c.startsWith("convertUpload") && c.includes("spreadsheet")),
    "must convert to a native Sheet",
  );
});

test("orphans are reported but never removed without --prune", async () => {
  const root = fixture({ "a.md": "# A\n" });
  const manifest = freshManifest();
  const first = await run(root, manifest);
  const orphanId = manifest.entries["a.md"]?.fileId as string;
  fs.rmSync(path.join(root, "a.md"));
  fs.writeFileSync(path.join(root, "b.md"), "# B\n");

  const second = await run(root, manifest, { drive: first.drive });
  assert.equal(second.summary.orphans, 1);
  assert.equal(second.summary.pruned, 0);
  assert.ok(second.summary.diagnostics.some((d) => d.code === "ORPHAN"));
  assert.equal(first.drive.files.get(orphanId)?.trashed, undefined, "must not be trashed");
  assert.ok(manifest.entries["a.md"], "manifest entry kept");
});

test("--prune trashes orphans (never deletes) and drops the manifest entry", async () => {
  const root = fixture({ "a.md": "# A\n" });
  const manifest = freshManifest();
  const first = await run(root, manifest);
  const orphanId = manifest.entries["a.md"]?.fileId as string;
  fs.rmSync(path.join(root, "a.md"));

  const second = await run(root, manifest, { drive: first.drive, prune: true });
  assert.equal(second.summary.pruned, 1);
  assert.equal(first.drive.files.get(orphanId)?.trashed, true);
  assert.equal(manifest.entries["a.md"], undefined);
  assert.ok(first.drive.calls.some((c) => c === `trash(${orphanId})`));
});

test("Drive-side modification warns loudly but local content still wins", async () => {
  const root = fixture({ "a.md": "# A\nv1\n" });
  const manifest = freshManifest();
  const first = await run(root, manifest);
  const id = manifest.entries["a.md"]?.fileId as string;
  first.drive.modifiedTimes.set(id, "2099-01-01T00:00:00.000Z");
  const driveFile = first.drive.files.get(id);
  assert.ok(driveFile);
  driveFile.lastModifyingUser = { displayName: "Someone Else" };

  fs.writeFileSync(path.join(root, "a.md"), "# A\nv2-local\n");
  const second = await run(root, manifest, { drive: first.drive });
  const warning = second.summary.diagnostics.find((d) => d.code === "DRIVE_MODIFIED");
  assert.ok(warning, "expected a DRIVE_MODIFIED warning");
  assert.match(warning?.message ?? "", /Someone Else/);
  assert.match(first.drive.contentOf(id), /v2-local/, "local content wins");
});

test("nested folders are created parents-first and mirrored in Drive", async () => {
  const root = fixture({
    "guide/deep/nested.md": "# Nested\n",
    "guide/top.md": "# Top\n[n](./deep/nested.md)\n",
  });
  const manifest = freshManifest();
  const { drive } = await run(root, manifest);
  assert.ok(manifest.folders.guide);
  assert.ok(manifest.folders["guide/deep"]);
  const guideIdx = drive.calls.findIndex((c) => c === "createFolder(guide,fldROOT)");
  const deepIdx = drive.calls.findIndex((c) =>
    c.startsWith(`createFolder(deep,${manifest.folders.guide as string}`),
  );
  assert.ok(guideIdx >= 0 && deepIdx > guideIdx, "parent folder must be created first");
  const topBody = drive.contentOf(manifest.entries["guide/top.md"]?.fileId as string);
  assert.match(topBody, new RegExp(manifest.entries["guide/deep/nested.md"]?.fileId as string));
});

test("the manifest is written atomically, sorted and with pending cleared", async () => {
  const root = fixture({ "b.md": "# B\n", "a.md": "# A\n" });
  const manifest = freshManifest();
  await run(root, manifest);
  const written = fs.readFileSync(path.join(root, ".gdrive-manifest.json"), "utf8");
  assert.match(written, /\n$/, "trailing newline for diff friendliness");
  const keys = Object.keys((JSON.parse(written) as Manifest).entries);
  assert.deepEqual(keys, ["a.md", "b.md"], "entries sorted for reviewable diffs");
  assert.equal(manifestIo.pendingEntries(JSON.parse(written) as Manifest).length, 0);
  assert.equal(
    fs.readdirSync(root).filter((f) => f.includes(".tmp")).length,
    0,
    "no temp files left behind",
  );
});
