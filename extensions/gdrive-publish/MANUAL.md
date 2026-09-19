# gdrive-publish manual

Turns a local documentation folder into native Google Docs and Sheets, with
relative links between your files rewritten into the real Google Doc URLs —
and re-publishing updates the same Drive files, so URLs you have shared stay
valid.

- **Audience:** humans using the CLI. The
  [skill manual](../../skills/gdrive-publish/MANUAL.md) covers driving it from
  pi; the [README](README.md) covers design rationale.
- **Quick proof it works on your machine:**
  [the sandbox](../../sandbox/README.md) is a committed doc tree built for this.

## Requirements

- Node >= 22.6 (Node 24+ recommended). The CLI is plain TypeScript executed
  through Node's native type stripping - no build step. The `gdrive-publish`
  launcher handles the version differences; below 22.6 it exits with
  instructions instead of a syntax error.
- A Google account with Drive. On a Workspace domain, folder creation and
  per-file access work as shown here; only public anyone-with-link sharing is
  ever needed — and it is never used (see [images](#troubleshooting)).

## Installation

Zero-install via npx (recommended for trying it out):

```bash
npx gdrive-publish plan docs/
```

Or install it once:

```bash
npm install -g gdrive-publish      # npm
brew install <tap>/gdrive-publish  # Homebrew (if tapped)
```

Inside the [development monorepo](https://github.com/codingfragments/pi-extensions)
the same CLI also runs as `gdrive-publish`.

## First publish

### 1. Log in (once per machine)

```bash
gdrive-publish login
```

Opens a browser for Google consent, scope
`https://www.googleapis.com/auth/drive.file` — the tool can only see files it
created itself. The refresh token is cached per OAuth client identity under
`~/.config/gdrive-publish/` (mode 0600).

If you already use rclone with a `drive` remote that has its own client
credentials, login borrows them automatically; no Cloud Console setup needed.

### 2. Preview

```bash
gdrive-publish plan docs/
```

Entirely offline — no network, no writes. It reports every diagnostic the real
publish would report, so read it before publishing: broken links, dropped
anchors, escaped links, oversized documents, CSV dialect normalisation.

### 3. Initialise and publish

```bash
gdrive-publish init docs/ --name "Project X Docs"   # creates the Drive folder
gdrive-publish publish docs/
```

Then **commit `.gdrive-manifest.json`** (it sits next to your docs). It maps
source files to Drive fileIds; it is the reason the next person — or the next
machine — updates the same Docs instead of creating duplicates. Publishing
never touches git; it just reminds you.

You can move and share the created folder freely in Drive; publishing keeps
working afterwards.

### 4. Day two

```bash
gdrive-publish plan docs/        # what changed?
gdrive-publish publish docs/     # update in place, URLs stable
```

Edit markdown locally, re-publish. Files are updated in place, and any link
someone bookmarked still opens the right document.

## What happens to your files

| Input | In Drive |
| --- | --- |
| `toc.md` linking `[details](./details.md)` | a Doc whose link opens the *details* Doc |
| `report.csv` | a native Google Sheet; the toc link opens the Sheet |
| German Excel CSV (semicolon, latin-1) | normalised to UTF-8 comma CSV first, so columns split correctly |
| `book.xlsx` | a native Sheet (macros and some formatting are lost — warned) |
| `![diagram](./img/diagram.png)` | the image embedded inside the Doc |
| YAML front matter | stripped (Drive would mangle it); `title:` becomes the Doc name |
| files Drive cannot host (`.txt`, …) | skipped, with a warning |

## The manifest

`.gdrive-manifest.json` is small, sorted and diff-friendly; review it in PRs
like any other file. Losing it does not lose your Drive files — it loses the
*identity map*, so re-publishing would create duplicates instead of updating.
That is why it belongs in git.

A run that dies halfway checkpoints the manifest after reserving Drive ids, so
re-running fills the same Docs rather than duplicating them.

## Safety model

- Scope is `drive.file`: the tool sees only files it created.
- Nothing is ever hard-deleted. `--prune` moves orphans to **trash**.
- Local content always wins. If someone edited a Doc in Drive, you are told
  who and when, their version remains in Drive's revision history, and your
  publish overwrites it.
- `plan` and `publish --dry-run` write nothing, anywhere.

## CLI reference

The reference below is generated from the command table the CLI itself uses
(`npm run docs:cli` to refresh; a test fails if this section is stale).

<!-- BEGIN generated: cli-reference -->

### `login`

```
gdrive-publish login
```

authorise once via the browser (scope: drive.file)

| Option | Description |
|---|---|
| `--remote <name>` | rclone remote to take client credentials from |

```
gdrive-publish login
```

```
gdrive-publish login --remote gdriveDD
```

### `init`

```
gdrive-publish init <dir>
```

create the Drive folder and the manifest for a directory

| Option | Description |
|---|---|
| `--name <name>` (required) | name of the Drive folder to create |
| `--remote <name>` | rclone remote to take client credentials from |

```
gdrive-publish init docs/ --name "Project X Docs"
```

### `plan`

```
gdrive-publish plan <dir>
```

show what publishing would do, without writing anything

| Option | Description |
|---|---|
| `--json` | machine-readable output on stdout |

```
gdrive-publish plan docs/
```

```
gdrive-publish plan docs/ --json | jq .diagnostics
```

### `publish`

```
gdrive-publish publish <dir>
```

publish to Drive; local content always wins

| Option | Description |
|---|---|
| `--dry-run` | plan only; write nothing (same as `plan`) |
| `--prune` | move orphaned Drive files to trash (never hard-deleted) |
| `--json` | machine-readable output on stdout |
| `--yes` | assume yes for confirmations (reserved for non-interactive use) |
| `--remote <name>` | rclone remote to take client credentials from |

```
gdrive-publish publish docs/
```

```
gdrive-publish publish docs/ --dry-run
```

```
gdrive-publish publish docs/ --prune
```

```
gdrive-publish publish docs/ --json
```

### `status`

```
gdrive-publish status <dir>
```

show manifest state and which credentials are in use

| Option | Description |
|---|---|
| `--json` | machine-readable output on stdout |
| `--remote <name>` | rclone remote to take client credentials from |

```
gdrive-publish status docs/
```

```
gdrive-publish status docs/ --json
```

### `help`

```
gdrive-publish help [command]
```

show this overview, or help for one command

```
gdrive-publish help
```

```
gdrive-publish help publish
```

### Environment variables

| Variable | Purpose |
|---|---|
| `GDRIVE_PUBLISH_CLIENT_ID` | OAuth client id (with _CLIENT_SECRET, highest priority) |
| `GDRIVE_PUBLISH_CLIENT_SECRET` | OAuth client secret |
| `GDRIVE_PUBLISH_CLIENT_SECRET_FILE` | path to a Google client_secret.json |
| `GDRIVE_PUBLISH_RCLONE_REMOTE` | rclone remote to borrow client credentials from |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | runtime failure (auth, network, Drive error) |
| 2 | usage error (bad command, missing argument, unknown flag) |
| 3 | completed, but the report contains errors |

Tool version at generation time: 0.2.0.
<!-- END generated: cli-reference -->

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `not authenticated for …` | Run `gdrive-publish login` as the same user, in a terminal (it needs a browser). |
| `ambiguous rclone remotes` | More than one drive remote has its own credentials. Set `GDRIVE_PUBLISH_RCLONE_REMOTE=<name>`. |
| `invalid_client` during login | Usually a stale or wrong client secret. If you maintain your own OAuth client, re-download `client_secret.json`. |
| Links to images do not render | Drive fetches image URLs anonymously, so only images embedded as data URIs render. This tool always inlines images; if you pasted a `drive.google.com/uc?...` link by hand, expect a blank placeholder on Workspaces that block anyone-with-link sharing. |
| `DOC_PAYLOAD_TOO_LARGE` | The prepared document exceeds 10 MB after inlining images as base64. Shrink or remove images. |
| `DRIVE_FILE_GONE` | A manifest entry points at a file that was trashed or became inaccessible. Restore it from trash in Drive, or delete the manifest entry to re-create the Doc. |
| A Doc shows the old content after publish | Check for `DRIVE_MODIFIED` in the report — a Drive-side edit was overwritten by your local version on purpose. |
| Orphan warnings you did not expect | A local file was renamed or deleted. Rename it back, or accept the orphan, or `--prune` to trash the Drive file. |

## Where things live

```
~/.config/gdrive-publish/
  client_secret.json       your own OAuth client, if you use one
  token-<hash>.json        cached tokens, one per OAuth client (0600)
```
