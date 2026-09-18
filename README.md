# pi-extensions

Monorepo for [pi](https://pi.dev) coding agent extensions maintained by [codingfragments](https://github.com/codingfragments).

Each extension lives in its own folder under `extensions/`, is independently
loadable, and can be installed on its own via pi's package system.

## Layout

```
pi-extensions/
├── extensions/            # one folder per extension
│   ├── _template/         # copy this to start a new extension
│   └── <name>/
│       ├── index.ts       # entry point, exports default(pi: ExtensionAPI)
│       ├── package.json   # optional, only if the extension needs npm deps
│       └── ...
├── skills/                 # shared Agent Skills (SKILL.md folders or .md files)
├── prompts/                 # shared prompt templates (.md)
├── themes/                  # shared themes (.json)
├── .pi/
│   └── settings.json        # project-local pi config: auto-loads extensions/ while developing this repo
└── AGENTS.md                # instructions for humans/agents developing extensions here
```

## Requirements

- [pi](https://pi.dev) v0.37+ (`npm install -g --ignore-scripts @earendil-works/pi-coding-agent`)
- Node.js 20+
- npm

## Developing an extension

1. Copy the template:
   ```bash
   cp -r extensions/_template extensions/my-extension
   ```
2. Edit `extensions/my-extension/index.ts`.
3. Run pi from the repo root — the project-local `.pi/settings.json` auto-discovers
   everything under `extensions/`, so your new extension loads automatically:
   ```bash
   pi
   ```
4. Iterate with `/reload` inside the pi session after each edit.
5. If your extension needs npm packages, add a `package.json` next to its
   `index.ts` (see [Extensions: Available Imports](https://pi.dev/docs/latest/extensions#available-imports))
   and run `npm install` inside that extension's folder.

See [AGENTS.md](AGENTS.md) for a deeper primer on the extension API, event
lifecycle, and conventions used in this repo — it's written to be loaded as
context by pi itself while you work here.

## Using an extension from this monorepo elsewhere

Reference a single extension directly from git without installing the whole
monorepo, using pi's package filtering (see
[Pi Packages](https://pi.dev/docs/latest/packages#package-filtering)):

```json
{
  "packages": [
    {
      "source": "git:github.com/codingfragments/pi-extensions@v0.1.0",
      "extensions": ["extensions/my-extension/index.ts"]
    }
  ]
}
```

Or try it without installing:

```bash
pi -e git:github.com/codingfragments/pi-extensions
```

Pin to a tag or commit for stability; `pi update --extensions` will not move
pinned refs on its own.

## Local development via a static path (no reinstalling)

For active development against a long-lived pi config, point a fixed local
path at your working copy of this repo (or a specific extension folder) in
`~/.pi/agent/settings.json`:

```json
{
  "extensions": ["~/dev/pi-extensions/extensions/my-extension"]
}
```

Combine this with a pinned `git:` package entry for "stable" use, and toggle
which one is active with `pi config` to avoid loading the same extension
twice. See the [Extensions docs](https://pi.dev/docs/latest/extensions) and
[Packages docs](https://pi.dev/docs/latest/packages) for details.

### Don't run the static path and the git package at the same time

`packages` entries are deduplicated against each other by identity (npm name,
git repo URL without ref, or resolved local absolute path — see
[Packages: Scope and Deduplication](https://pi.dev/docs/latest/packages#scope-and-deduplication)).
That dedup logic does **not** reach across mechanisms: a raw local-path entry
in `extensions`/`skills`/`prompts`/`themes` and a `packages` git entry that
happens to clone the same repo are two independent loads. Pi has no way to
know they're "the same content" — you'll get every tool, skill, and command
registered twice (duplicate `/commands`, duplicate skills in pickers, and
undefined behavior if two tools share an exact name).

Rule of thumb:

- **On the machine where you actively edit this repo** (e.g. via a dotfiles
  symlink into `~/.pi/agent/settings.json`): use the static local-path
  arrays only. You are the live source; there's never a reason to *also*
  add a `packages: ["git:...pi-extensions..."]` entry on that same machine.
- **On any other machine, or for anyone else installing this**: use the
  pinned `packages` git entry, and don't set local static paths pointing at
  the same content.
- If you want to sanity-check the consumer experience from your dev machine,
  temporarily disable the static-path entries first (comment them out or use
  `pi config`) — never run both at once, even briefly.

## Extensions in this repo

| Extension | Description |
|---|---|
| [herdr-display-agent-sync](extensions/herdr-display-agent-sync/index.ts) | Syncs the pi session name (or cwd fallback) into herdr's sidebar `display_agent` label, refreshing on every agent event. |
| [gdrive-publish](extensions/gdrive-publish/README.md) | Publishes markdown/CSV/XLSX to Google Drive as native Docs/Sheets, rewriting relative links to the real Doc URLs and keeping shared URLs stable across re-publishes. Ships a CLI plus a `gdrive_publish` tool that only registers in configured projects. |

## Skills in this repo

| Skill | Description |
|---|---|
| [grill-me](skills/grill-me/SKILL.md) | Adversarially stress-tests a plan, design doc, PR, or code by interrogating it with tough questions before it ships. |
| [gdrive-publish](skills/gdrive-publish/SKILL.md) | Guides publishing a docs folder to Google Drive as native Docs/Sheets: plan first, read the warning taxonomy, commit the manifest, never prune or auto-approve without being asked. |

## License

MIT — see [LICENSE](LICENSE).
