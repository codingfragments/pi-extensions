/**
 * The UX migration ratchet (D114): the legacy styling in the panel may only shrink. The
 * committed baseline is test/fixtures/ux-ratchet.json; `node scripts/ux-ratchet.ts --update`
 * lowers it after a slice. Also: the design system itself stays token-only.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  type Counts,
  buttonClasses,
  countCss,
  measure,
  readBaseline,
} from "../scripts/ux-ratchet.ts";

const DS = path.join(import.meta.dirname, "..", "src", "panel", "public", "ds");

test("the counters count what they say they count", () => {
  const css = `
    /* #fff00f in a comment is not counted */
    :root { --bg: var(--surface-page); }
    .a { color: #fff; background: rgba(0, 0, 0, 0.5); font-size: 14px; border-radius: 6px; padding: 4px 12px; gap: 0; }
    .b { font-size: var(--text-sm); border-radius: var(--radius-md); padding: var(--space-2); margin: 0 auto; }
    .c { border-radius: 50%; margin: 0 0 8px; color: var(--muted); border: 1px solid var(--line); }
    button.ghost:hover, .chip.on { color: var(--text); }
  `;
  const c = countCss(css);
  assert.equal(c.colourLiterals, 2);
  assert.equal(c.fontSizeLiterals, 1);
  assert.equal(c.radiusLiterals, 1, "50% and tokens are not literals");
  assert.equal(c.spacingLiterals, 2, "padding 4px 12px and margin 0 0 8px");
  assert.equal(c.legacyVarUses, 3, "--muted, --line, --text");
  assert.deepEqual([...buttonClasses(css)].sort(), ["chip", "ghost"]);
});

test("the legacy styling only shrinks: every count is at or below the baseline, and the baseline is current", () => {
  const base = readBaseline();
  assert.ok(base, "test/fixtures/ux-ratchet.json exists (node scripts/ux-ratchet.ts --update)");
  const now = measure();
  const worse: string[] = [];
  const better: string[] = [];
  for (const k of Object.keys(now) as (keyof Counts)[]) {
    if (now[k] > base[k]) worse.push(`${k}: ${now[k]} > baseline ${base[k]}`);
    else if (now[k] < base[k]) better.push(`${k}: ${now[k]} < baseline ${base[k]}`);
  }
  assert.deepEqual(
    worse,
    [],
    "legacy styling grew: use a token or a ds- component instead (ds/tokens.css, ds/components.css)",
  );
  assert.deepEqual(
    better,
    [],
    "this improved the counts: lock it in with `node extensions/demo-recording/scripts/ux-ratchet.ts --update`",
  );
});

test("the design system is token-only and free of legacy names", () => {
  const problems: string[] = [];
  for (const f of ["base.css", "components.css"]) {
    const src = fs.readFileSync(path.join(DS, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    if (/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(src))
      problems.push(`${f} has a colour literal`);
    if (/var\(--(bg|card|inset|line|chip|muted|ok|warn|err|text|mono|border)(?![\w-])/.test(src))
      problems.push(`${f} uses a legacy variable`);
  }
  assert.deepEqual(problems, []);
});
