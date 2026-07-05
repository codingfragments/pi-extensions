# _template

Copy this folder to start a new extension:

```bash
cp -r extensions/_template extensions/my-extension
```

Then:

1. Rename references to `template_tool` / `/template` in `index.ts`.
2. Update this README with what the extension actually does, its
   configuration (if any), and any security-relevant notes (does it run
   shell commands? read secrets? call external APIs?).
3. Add a `package.json` only if you need npm dependencies (see
   [../../AGENTS.md](../../AGENTS.md#packagejson-rules-if-an-extension-needs-npm-dependencies)).
4. Add a row for it in the root [README.md](../../README.md#extensions-in-this-repo).
