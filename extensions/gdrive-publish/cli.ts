#!/usr/bin/env node
/**
 * gdrive-publish CLI.
 *
 * Fully non-interactive except for `login`: every other command works headless
 * with flags, `--json`, and meaningful exit codes, so the same binary is usable
 * from CI, git hooks, and the pi extension.
 *
 * Command surface, flags and help text are defined once in ./commands.ts and
 * derived everywhere else (overview, `help <command>`, `<command> --help`,
 * flag validation, and the generated CLI reference in MANUAL.md), so the help
 * cannot drift from the behaviour.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  BIN,
  VERSION,
  findCommand,
  parseArgv,
  renderCommand,
  renderOverview,
  suggestCommand,
  validate,
} from "./commands.ts";
import type { CommandSpec, ParsedArgv } from "./commands.ts";
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

/** Arguments as validated against the command table. */
interface Args {
  target?: string;
  flags: Set<string>;
  options: Map<string, string>;
}

function fail(code: number, message: string): never {
  process.stderr.write(`gdrive-publish: ${message}\n`);
  process.exit(code);
}

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
  const parsed = parseArgv(process.argv.slice(2));

  try {
    // `--version` wins anywhere and never touches Drive.
    if (parsed.wantsVersion) {
      process.stdout.write(`${BIN} ${VERSION}\n`);
      return;
    }

    if (parsed.command === undefined || parsed.command === "help") {
      if (parsed.wantsHelp && parsed.command !== undefined) {
        process.stdout.write(renderOverview());
        return;
      }
      if (parsed.target !== undefined) {
        const spec = findCommand(parsed.target);
        if (!spec) {
          const suggestion = suggestCommand(parsed.target);
          fail(
            2,
            `unknown command: ${parsed.target}${
              suggestion ? ` (did you mean "${suggestion}"?)` : ""
            }\ntry: ${BIN} help`,
          );
        }
        process.stdout.write(renderCommand(spec));
        return;
      }
      process.stdout.write(renderOverview());
      return;
    }

    const spec = findCommand(parsed.command);
    if (!spec) {
      const suggestion = suggestCommand(parsed.command);
      process.stderr.write(renderOverview());
      fail(
        2,
        `unknown command: ${parsed.command}${
          suggestion ? ` (did you mean "${suggestion}"?)` : ""
        }\ntry: ${BIN} help`,
      );
    }
    const commandSpec = spec as CommandSpec;

    // `--help` wins over execution - critically on destructive commands:
    // `publish <dir> --help` must print help, never publish.
    if (parsed.wantsHelp) {
      process.stdout.write(renderCommand(commandSpec));
      return;
    }

    const errors = validate(commandSpec, parsed);
    if (errors.length > 0) {
      for (const error of errors) process.stderr.write(`${BIN}: ${error}\n`);
      process.stderr.write(`\ntry: ${BIN} help ${commandSpec.name}\n`);
      process.exit(2);
    }

    const args: Args = {
      ...(parsed.target !== undefined ? { target: parsed.target } : {}),
      flags: parsed.flags,
      options: parsed.options,
    };

    switch (commandSpec.name) {
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
      default:
        fail(2, `unhandled command: ${commandSpec.name}`);
    }
  } catch (e) {
    if (e instanceof AuthError) fail(1, e.message);
    fail(1, String(e instanceof Error ? e.message : e));
  }
}

await main();
