#!/usr/bin/env node
/**
 * gdrive-publish CLI.
 *
 * Fully non-interactive except for `login` (decision 6): every other command
 * works headless with flags, `--json`, and meaningful exit codes, so the same
 * binary is usable from CI, git hooks, and the pi extension.
 *
 *   gdrive-publish login
 *   gdrive-publish init <dir> --name "Project X Docs"
 *   gdrive-publish plan <dir> [--json]
 *   gdrive-publish publish <dir> [--dry-run] [--json] [--prune] [--yes]
 *   gdrive-publish status <dir> [--json]
 *
 * Exit codes: 0 success, 1 runtime failure, 2 usage error, 3 published with
 * errors in the diagnostics.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  AuthError,
  CachedTokenProvider,
  clientHash,
  consent,
  resolveCredentials,
  writeToken,
} from "./core/auth.ts";
import { RestDriveClient } from "./core/drive.ts";
import * as manifestIo from "./core/manifest.ts";
import { buildPlan, publish } from "./core/publish.ts";
import { planJson, renderPlan, renderSummary, summaryJson } from "./core/report.ts";
import { folderUrl } from "./core/types.ts";

interface Args {
  command: string;
  target?: string;
  flags: Set<string>;
  options: Map<string, string>;
}

function parseArgs(argv: string[]): Args {
  const flags = new Set<string>();
  const options = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        options.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else if (arg === "--name" || arg === "--remote") {
        const next = argv[i + 1];
        if (next === undefined) fail(2, `${arg} requires a value`);
        options.set(arg.slice(2), next as string);
        i++;
      } else {
        flags.add(arg.slice(2));
      }
      continue;
    }
    positional.push(arg);
  }
  return {
    command: positional[0] ?? "help",
    ...(positional[1] !== undefined ? { target: positional[1] } : {}),
    flags,
    options,
  };
}

function fail(code: number, message: string): never {
  process.stderr.write(`gdrive-publish: ${message}\n`);
  process.exit(code);
}

const USAGE = `gdrive-publish - publish markdown/CSV/XLSX to native Google Drive types

  login                          authorise (opens a browser once)
  init <dir> --name "Docs"       create the Drive folder and the manifest
  plan <dir> [--json]            show what publishing would do (no writes)
  publish <dir> [options]        publish; local content wins
  status <dir> [--json]          show manifest state and credentials

Options
  --dry-run     plan only (publish is a no-op)
  --json        machine-readable output
  --prune       move orphaned Drive files to trash (never deletes)
  --yes         skip confirmation when there are warnings (non-interactive)
  --name        folder name for init
  --remote      rclone remote to take client credentials from

Environment
  GDRIVE_PUBLISH_CLIENT_ID / _CLIENT_SECRET   OAuth client (highest priority)
  GDRIVE_PUBLISH_CLIENT_SECRET_FILE           path to client_secret.json
  GDRIVE_PUBLISH_RCLONE_REMOTE                rclone remote name
`;

function resolveRoot(target: string | undefined): string {
  if (!target) fail(2, "a directory argument is required");
  const root = path.resolve(target as string);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    fail(2, `not a directory: ${root}`);
  }
  return root;
}

function credentialsOrFail(args: Args): ReturnType<typeof resolveCredentials> {
  const env = { ...process.env };
  const remote = args.options.get("remote");
  if (remote) env.GDRIVE_PUBLISH_RCLONE_REMOTE = remote;
  try {
    return resolveCredentials(env);
  } catch (e) {
    if (e instanceof AuthError) fail(1, e.message);
    throw e;
  }
}

async function cmdLogin(args: Args): Promise<void> {
  const creds = credentialsOrFail(args);
  process.stdout.write(`credentials: ${creds.source} (client ${clientHash(creds.clientId)})\n`);
  process.stdout.write("opening a browser for Google consent (scope: drive.file)…\n");
  const token = await consent(creds, (url) => {
    try {
      execFileSync("open", [url], { stdio: "ignore" });
    } catch {
      process.stdout.write(`open this URL manually:\n\n${url}\n\n`);
    }
  });
  const p = writeToken(token);
  process.stdout.write(`authorised; token cached at ${p}\n`);
}

async function cmdInit(args: Args): Promise<void> {
  const root = resolveRoot(args.target);
  const name = args.options.get("name");
  if (!name) fail(2, 'init requires --name "Folder Name"');
  if (manifestIo.load(root)) fail(1, `${root} already has a manifest`);
  const creds = credentialsOrFail(args);
  const drive = new RestDriveClient(new CachedTokenProvider(creds));
  const folder = await drive.createFolder(name as string);
  const manifest = manifestIo.emptyManifest(folder.id, folder.name);
  manifest.credentialSource = creds.source;
  manifest.clientIdHash = clientHash(creds.clientId);
  const p = manifestIo.save(root, manifest);
  process.stdout.write(`created Drive folder "${folder.name}"\n  ${folderUrl(folder.id)}\n`);
  process.stdout.write(
    `manifest: ${p}\n  -> commit it; move/share the folder in Drive as you like\n`,
  );
}

function cmdPlan(args: Args): void {
  const root = resolveRoot(args.target);
  const manifest = manifestIo.load(root);
  const plan = buildPlan({ root, manifest });
  if (args.flags.has("json")) {
    process.stdout.write(`${JSON.stringify(planJson(plan), null, 2)}\n`);
  } else {
    process.stdout.write(`${renderPlan(plan, root)}\n`);
  }
  if (plan.diagnostics.some((d) => d.severity === "error")) process.exit(3);
}

async function cmdPublish(args: Args): Promise<void> {
  const root = resolveRoot(args.target);
  const manifest = manifestIo.load(root);
  if (!manifest) {
    fail(1, `no manifest in ${root} - run: gdrive-publish init ${args.target} --name "Docs"`);
  }
  const plan = buildPlan({ root, manifest });
  const json = args.flags.has("json");

  if (args.flags.has("dry-run")) {
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ dryRun: true, ...(planJson(plan) as object) }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(`${renderPlan(plan, root)}\n\n  dry run: nothing was written\n`);
    }
    return;
  }

  // Credential identity mismatch is informational but important: drive.file
  // access is per-client, so a different client cannot see existing Docs.
  const creds = credentialsOrFail(args);
  const hash = clientHash(creds.clientId);
  if (manifest.clientIdHash && manifest.clientIdHash !== hash) {
    process.stderr.write(
      `gdrive-publish: WARN credential identity changed (manifest ${manifest.clientIdHash}, now ${hash}); drive.file access is per-client, so existing Docs may be invisible and would be recreated\n`,
    );
  }

  const drive = new RestDriveClient(new CachedTokenProvider(creds));
  const summary = await publish({
    root,
    drive,
    manifest,
    plan,
    prune: args.flags.has("prune"),
    onProgress: json ? undefined : (m) => process.stdout.write(`  ${m}\n`),
  });
  if (json) {
    process.stdout.write(`${JSON.stringify(summaryJson(summary), null, 2)}\n`);
  } else {
    process.stdout.write(`${renderSummary(summary)}\n`);
  }
  if (summary.diagnostics.some((d) => d.severity === "error")) process.exit(3);
}

function cmdStatus(args: Args): void {
  const root = resolveRoot(args.target);
  const manifest = manifestIo.load(root);
  const creds = credentialsOrFail(args);
  const info = {
    root,
    manifest: manifest
      ? {
          rootFolderId: manifest.rootFolderId,
          rootFolderName: manifest.rootFolderName,
          rootFolderUrl: folderUrl(manifest.rootFolderId),
          entries: Object.keys(manifest.entries).length,
          pending: manifestIo.pendingEntries(manifest),
          credentialSource: manifest.credentialSource ?? null,
          clientIdHash: manifest.clientIdHash ?? null,
        }
      : null,
    credentials: { source: creds.source, clientIdHash: clientHash(creds.clientId) },
  };
  if (args.flags.has("json")) {
    process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
    return;
  }
  process.stdout.write(`root: ${root}\n`);
  process.stdout.write(`credentials: ${creds.source} (client ${info.credentials.clientIdHash})\n`);
  if (!info.manifest) {
    process.stdout.write("manifest: none (run init)\n");
    return;
  }
  process.stdout.write(
    `manifest: ${info.manifest.entries} entr(ies), folder "${info.manifest.rootFolderName}"\n  ${info.manifest.rootFolderUrl}\n`,
  );
  if (info.manifest.pending.length) {
    process.stdout.write(`pending (unfilled) Docs: ${info.manifest.pending.join(", ")}\n`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  try {
    switch (args.command) {
      case "login":
        await cmdLogin(args);
        break;
      case "init":
        await cmdInit(args);
        break;
      case "plan":
        cmdPlan(args);
        break;
      case "publish":
        await cmdPublish(args);
        break;
      case "status":
        cmdStatus(args);
        break;
      case "help":
      case "--help":
        process.stdout.write(USAGE);
        break;
      default:
        process.stderr.write(USAGE);
        fail(2, `unknown command: ${args.command}`);
    }
  } catch (e) {
    if (e instanceof AuthError) fail(1, e.message);
    fail(1, String(e instanceof Error ? e.message : e));
  }
}

await main();
