# gdrive-publish

Publish a folder of markdown, CSV and Excel files to Google Drive as **native
Google types** — markdown becomes Google Docs, CSV/XLSX become Google Sheets —
while **relative links between your files are rewritten to the real Google Doc
URLs**. A `toc.md` linking to `./details.md` becomes a Doc whose link opens the
*details* Doc.

Re-publishing updates the same Drive files in place, so **URLs you shared stay
valid**.

> Status: complete — core library, CLI, and pi extension. All behaviour below
> is verified by `npm test` (offline) and was smoke-tested against a real
> Drive.

## Using it from pi

The `gdrive_publish` tool is **inert unless this project is set up for
publishing**: it is registered only when the working directory (or an ancestor,
up to the repo root) has a `.gdrive-manifest.json` *and* a cached OAuth token
exists. Sessions in unrelated repositories never see a tool that can write to
Drive.

| Situation | What is registered |
|---|---|
| unrelated directory | `/gdrive-publish-init`, `/gdrive-publish-status` only |
| manifest present, not authenticated | the same two commands only |
| manifest + token present | additionally the `gdrive_publish` tool |

```text
/gdrive-publish-status                 # what is missing, and why
/gdrive-publish-init Project X Docs    # create the Drive folder + manifest
/reload                                # picks up the now-registered tool

gdrive_publish { mode: "plan" }        # read-only, never prompts
gdrive_publish { mode: "publish" }     # asks for confirmation first
```

Writes are confirm-gated: in an interactive session `publish` shows the
create/update/orphan counts via `ctx.ui.confirm`, and in a non-interactive
session it **refuses** unless `assumeYes: true` is passed explicitly. The
accompanying [skill](../../skills/gdrive-publish/SKILL.md) tells the agent to
plan first, to never prune unasked, and how to explain each warning.

## How it works

Publishing is two-phase, which is what makes link rewriting possible at all:

```
phase 0  scan the tree, build the link graph            (no network)
phase 1  create folders; create EMPTY Doc shells for each .md;
         convert-upload CSV/XLSX  -> every fileId is now known
         -> manifest checkpointed with `pending` markers
phase 2  rewrite relative links to real Doc/Sheet URLs, inline images,
         fill content via files.update  -> fileIds (and URLs) unchanged
phase 3  final manifest write + report
```

Drive cannot pre-allocate ids for Workspace types (`files.generateIds` does not
support convert-on-upload), so a single-pass "rewrite then upload" is
impossible. Phase 1 exists purely to learn the ids.

## Install / auth

Requires Node 24+ (TypeScript runs directly, no build step).

```bash
gdrive-publish login          # one-time browser consent, scope: drive.file
```

Credentials are resolved in this order, and the chosen source is reported by
**name** — never by value:

1. `GDRIVE_PUBLISH_CLIENT_ID` + `GDRIVE_PUBLISH_CLIENT_SECRET`
2. `GDRIVE_PUBLISH_CLIENT_SECRET_FILE=/path/to/client_secret.json`
3. `~/.config/gdrive-publish/client_secret.json`
4. an rclone drive remote (`GDRIVE_PUBLISH_RCLONE_REMOTE=name`, or the only one)

Tokens are cached per client identity as
`~/.config/gdrive-publish/token-<sha256(client_id)[0:8]>.json` (mode 0600), so
switching credential sources costs one extra consent instead of an opaque
`invalid_client` error.

## Usage

```bash
gdrive-publish init docs/ --name "Project X Docs"   # creates the Drive folder
gdrive-publish plan docs/                           # what would happen (no writes)
gdrive-publish publish docs/                        # do it
gdrive-publish publish docs/ --dry-run              # plan, write nothing
gdrive-publish publish docs/ --prune                # trash orphaned Drive files
gdrive-publish status docs/ --json                  # manifest + credential state
```

Every command except `login` is fully non-interactive: flags, `--json`, and
exit codes (`0` ok, `1` failure, `2` usage, `3` completed with errors), so it
works from CI and git hooks.

## The manifest

`.gdrive-manifest.json` sits next to your docs and **should be committed** — it
is the identity map from source path to Drive fileId, and therefore the reason
URLs stay stable for everyone. `publish` never touches git; it just tells you
the file changed.

It is written via temp-file + atomic rename, and checkpointed after phase 1
with `pending: true` entries. If a run dies between creating shells and filling
them, the next run fills those exact Docs instead of creating duplicates.

## Behaviour worth knowing

| Input | Result |
|---|---|
| `[x](./other.md)` | rewritten to the other file's Doc URL |
| `[x](./data.csv)` | rewritten to the Sheet URL |
| `[x](./other.md#section)` | links to the top of the Doc, anchor dropped (warned) |
| `[x](../outside.md)` | left verbatim (warned) — outside the publish root |
| `[x](https://…)` | untouched |
| `[x](./missing.md)` | left verbatim (warned) |
| links inside ``` fences / `code spans` | never rewritten |
| `![img](./pic.png)` | **inlined as a base64 `data:` URI** so Drive embeds a real copy |
| YAML front matter | stripped (Drive mangles it); `title:` becomes the Doc name |
| Doc name | front-matter `title` → first H1 → filename stem |
| `.csv` | dialect + encoding sniffed, normalised to UTF-8 comma CSV, then converted |
| `.xlsx` / `.xls` | uploaded as-is and converted (macros/formatting lost, warned) |
| unsupported files | skipped with a warning |
| local file deleted | reported as an orphan; only `--prune` removes it, and only to **trash** |
| file changed in Drive | local content wins, loud warning naming the editor (Drive keeps revision history) |

### Why images are inlined

The obvious approach — upload the image, share it, link to
`drive.google.com/uc?export=view&id=…` — **cannot work** on a Workspace that
blocks anyone-with-link sharing: `POST /permissions {type:"anyone"}` fails with
`publishOutNotPermitted`, and Drive's importer fetches image URLs
*anonymously*, so even domain-shared images render as a 1×1 placeholder.
Base64 `data:` URIs embed byte-identical images with no permissions at all.
See `spike/FINDINGS.md`.

Guardrails: a warning above 2 MB per image, and a hard error above 10 MB of
prepared document payload (base64 inflates by ~33%).

## Scope and blast radius

Only `https://www.googleapis.com/auth/drive.file` is requested: the tool can
only see files it created itself. `init` creates its own root folder, which you
can then move and share freely in Drive — access survives the move (verified).
Nothing is ever hard-deleted; `--prune` uses trash.

## Tests

```bash
npm test          # offline: fixtures + fake Drive client, no credentials needed
```

The offline suite asserts the properties that actually matter: phase-1-before-
phase-2 ordering, update-in-place (never recreate), id stability across
re-runs, crash recovery from `pending` entries, code-fence immunity, CSV
dialect handling, orphan safety, and trash-not-delete.

One verification rule learned the hard way: **image embedding must be checked
by rendering** (export PDF → rasterise → look at pixels). The presence of an
`<img>` tag, an `![]()` construct, or a `word/media/*` part in a docx export
all report success on a document that is visibly blank.

## Layout

```
core/       pure logic, zero pi imports, injectable DriveClient
  auth.ts       credential chain, token cache, loopback consent
  drive.ts      DriveClient interface + REST implementation
  links.ts      link parsing/rewriting (code-fence aware)
  naming.ts     front matter + Doc naming
  csv.ts        dialect sniffing (row-consistency based) + normalisation
  prepare.ts    front-matter stripping, link rewriting, image inlining
  publish.ts    planner + two-phase publisher
  manifest.ts   atomic, sorted, checkpointed manifest IO
  report.ts     text and JSON rendering
cli.ts      non-interactive CLI
index.ts    pi extension: readiness gating, typed tool, confirm prompts
test/       offline suite + fake Drive client
```
