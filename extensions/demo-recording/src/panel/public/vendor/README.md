# Vendored panel dependencies

| File | Source | License |
|---|---|---|
| `preact-htm.module.js` | `htm@3.1.1` → `preact/standalone.module.js` (Preact + hooks + htm in one ES module) | htm: Apache-2.0 (`LICENSE-htm.txt`); Preact: MIT |

Vendored so the panel works offline with no bundler and no CDN at runtime.
To update: `npm pack htm@<version>`, copy `package/preact/standalone.module.js`.
