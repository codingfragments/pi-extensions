# AGENTS.md — developing pi extensions in this repo

This file is loaded automatically by pi (as `AGENTS.md`) when working in this
repository. It exists so an agent (or a human) has enough context to build,
test, and ship a new extension here without re-discovering pi's extension API
from scratch every time.

If anything here goes stale, prefer the live docs at
<https://pi.dev/docs/latest/extensions> and <https://pi.dev/docs/latest/packages>
over this file, and update this file to match.

## What this repo is

A monorepo of independent [pi](https://pi.dev) extensions. One folder per
extension under `extensions/`. Each extension can be:

- run directly from this repo while developing (`.pi/settings.json` auto-loads
  everything under `extensions/`), and
- installed independently by others via `pi install git:github.com/codingfragments/pi-extensions@<ref>`
  with a package filter selecting just that one extension's entry file.

Do not couple extensions to each other. Shared code goes in a small local
package under the consuming extension's own folder, not a cross-extension
import — pi loads each extension with a separate module root, so cross-folder
imports between `extensions/*` are fragile and should be avoided.

## Extension anatomy

An extension is a TypeScript (or JS) module with a default export: a factory
function that receives `ExtensionAPI`. It can be sync or async.

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("my-extension loaded!", "info");
  });

  pi.registerTool({
    name: "my_tool",
    label: "My Tool",
    description: "Does one clear thing.",
    parameters: Type.Object({
      input: Type.String({ description: "What to act on" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return { content: [{ type: "text", text: `handled: ${params.input}` }], details: {} };
    },
  });

  pi.registerCommand("mycmd", {
    description: "Say hello",
    handler: async (args, ctx) => ctx.ui.notify(`hi ${args || "world"}`, "info"),
  });
}
```

Extensions load via [jiti](https://github.com/unjs/jiti) — plain TypeScript
runs without a build step. No compiler required for development.

## File layout per extension

Pick the simplest option that fits:

```
extensions/
├── simple-thing.ts              # single file, no deps — just drop it in
├── multi-file-thing/
│   ├── index.ts                 # entry point (default export)
│   ├── tools.ts
│   └── utils.ts
└── needs-npm-deps/
    ├── package.json             # declares deps + "pi": { "extensions": ["./src/index.ts"] }
    ├── package-lock.json
    ├── node_modules/            # after `npm install` inside this folder
    └── src/
        └── index.ts
```

Auto-discovery rules pi uses when scanning a directory (relevant when someone
points `extensions` settings at this repo's `extensions/` folder, or when a
subfolder is loaded as a package):

- A `.ts`/`.js` file directly under the scanned directory is its own extension.
- A subdirectory is checked for a `package.json` with a `pi.extensions` entry
  first; if absent, it falls back to `index.ts` then `index.js` in that
  subdirectory.
- Only one level of subdirectory nesting is auto-discovered this way — don't
  bury the entry point deeper without a `package.json` pointing at it.

### package.json rules if an extension needs npm dependencies

- Runtime dependencies go in `"dependencies"` (package installs run with
  `--omit=dev`, so `devDependencies` are not available at runtime once someone
  installs this via `pi install`).
- If the extension imports any of pi's own bundled core packages, list them in
  `"peerDependencies"` with a `"*"` range and do **not** bundle them:
  `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`,
  `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`.
- Any other pi package you depend on must be a real bundled dependency
  (`dependencies` + `bundledDependencies`), referenced through its
  `node_modules/` path.

## Available imports

| Package | Purpose |
|---|---|
| `@earendil-works/pi-coding-agent` | Extension types: `ExtensionAPI`, `ExtensionContext`, event types, `isToolCallEventType`, `isBashToolResult`, etc. |
| `typebox` | Schema definitions (`Type.Object(...)`) for tool parameters |
| `@earendil-works/pi-ai` | AI utilities, e.g. `StringEnum` for Google-compatible enum schemas |
| `@earendil-works/pi-tui` | TUI components for custom rendering (`ctx.ui.custom(...)`) |
| `node:*` | Node built-ins are available directly |

## Key ExtensionAPI methods

- `pi.on(eventName, handler)` — subscribe to lifecycle events (see below)
- `pi.registerTool({ name, label, description, parameters, execute })` — add a tool the LLM can call
- `pi.registerCommand(name, { description, handler })` — add a `/name` slash command
- `pi.registerShortcut(keybinding, handler)` — add a keyboard shortcut
- `pi.registerFlag(name, handler)` — add a CLI flag
- `pi.registerProvider(id, config)` — register a model provider (see async factory example below)
- `pi.appendEntry(...)` — persist state into the session file, survives restarts

## ctx.ui — user interaction

Available inside most event handlers, tool `execute`, and command handlers:

- `ctx.ui.notify(message, "info" | "warn" | "error")`
- `ctx.ui.confirm(title, message)` → `Promise<boolean>`
- `ctx.ui.select(...)`, `ctx.ui.input(...)`
- `ctx.ui.setStatus(key, text)` — footer status text
- `ctx.ui.setWidget(key, lines)` — small widget above the editor
- `ctx.ui.custom(...)` — full custom TUI component for complex interactions
  (see [TUI components docs](https://pi.dev/docs/latest/tui))

Check `ctx.hasUI` before prompting — some modes (`-p`, `--mode json`,
`--mode rpc`) have no interactive UI.

## Events you'll actually use most

Full list and payloads: <https://pi.dev/docs/latest/extensions#events>. The
ones worth knowing by name:

- `session_start` / `session_shutdown` — session lifecycle; start background
  resources (timers, watchers, sockets) in `session_start`, never in the
  factory function itself, and clean them up idempotently in
  `session_shutdown`.
- `before_agent_start` — inject a message and/or rewrite the system prompt
  before a turn begins.
- `tool_call` — fires before a tool executes; **can block** by returning
  `{ block: true, reason }`; `event.input` is mutable, use
  `isToolCallEventType("bash", event)` (etc.) to narrow types.
- `tool_result` — fires after a tool executes; chainable middleware, can
  patch `content`/`details`/`isError`.
- `context` — fires before each LLM call; can filter/modify the message list
  non-destructively.
- `project_trust` — only for user/global and CLI (`-e`) extensions; decide
  whether to trust a project's local `.pi` config before it loads.
- `model_select` / `thinking_level_select` — react to model or thinking-level
  changes.

## Long-lived resources

Extension factory functions can run in invocations that never start a
session (e.g. `--list-models`). Never start processes, sockets, file
watchers, or timers directly in the factory — defer to `session_start`, and
tear down in `session_shutdown`.

## Testing an extension

```bash
# Quick one-off test without touching this repo's .pi/settings.json:
pi -e ./extensions/my-extension

# From the repo root, everything under extensions/ auto-loads already
# via .pi/settings.json — just run:
pi
```

Use `/reload` inside a running pi session after editing files to pick up
changes without restarting.

## Shipping / sharing an extension

1. Make sure the extension's folder is self-contained (own `package.json` if
   it needs deps, own `index.ts` entry point).
2. Tag a release in this repo once the extension is stable, e.g. `v0.1.0`.
3. Document install instructions in the extension's own README and in the
   table in the root `README.md`.
4. Consumers install a single extension out of this monorepo with a filtered
   package source:
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

## Conventions for this repo

- One extension per folder under `extensions/`. Do not put multiple unrelated
  extensions in one file.
- Prefer `Type.Object(...)` (typebox) for tool parameter schemas — it's what
  pi bundles and expects.
- Keep `README.md` in the repo root up to date with a one-line description of
  each shipped extension.
- Favor small, single-purpose extensions over one large do-everything
  extension — easier to install selectively, easier to reason about tool
  call permissions.
- Security: extensions run with full system permissions. Never silently
  exfiltrate data, never log secrets, and call out any destructive
  capability (e.g. running shell commands, writing files) clearly in the
  extension's own README.
- Tool/skill/command names should be collision-resistant once this repo is
  shared as a package: avoid bare, generic names (`ask_user`, `search`,
  `format`) that are likely to collide with tools from other packages a
  consumer might have installed. Prefer a distinctive name or short prefix
  tied to this repo (e.g. `ask-user` as shipped here, not `ask` or `query`).
  Cheap to get right up front, painful to rename once consumers depend on it.
- Local static-path config (`extensions`/`skills`/`prompts`/`themes` in
  `~/.pi/agent/settings.json`) and a `packages` git/npm entry for this same
  repo are **not** deduplicated against each other and must never both be
  active on the same machine — see the README's
  ["Don't run the static path and the git package at the same time"](README.md#dont-run-the-static-path-and-the-git-package-at-the-same-time)
  section before wiring up a new machine or publishing a release.

## Reference docs

- Extensions: <https://pi.dev/docs/latest/extensions>
- Packages: <https://pi.dev/docs/latest/packages>
- Settings: <https://pi.dev/docs/latest/settings>
- TUI components: <https://pi.dev/docs/latest/tui>
- Custom providers: <https://pi.dev/docs/latest/custom-provider>
- Custom models: <https://pi.dev/docs/latest/models>
- Example extensions: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions>
