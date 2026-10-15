/**
 * The UX0 style tile (D110): the design tokens meet WCAG 2.2 AA in both themes,
 * only tokens.css holds colour literals, the tile pages use only declared tokens,
 * and the scale limits from the spec hold (≤ 8 font sizes, ≤ 8 spacing steps, ≤ 6 radii).
 * Pure text analysis — no browser.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const UX = path.join(import.meta.dirname, "..", "docs", "ux");
// The design system lives in the panel (one source); the tile pages link to it.
const DS = path.join(import.meta.dirname, "..", "src", "panel", "public", "ds");
const read = (f: string) => fs.readFileSync(path.join(UX, f), "utf8");

type Tokens = Record<string, string>;

/** Custom properties declared inside the blocks whose selector matches `selector`. */
function declared(source: string, selector: RegExp): Tokens {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Tokens = {};
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selector.test((m[1] as string).trim())) continue;
    for (const d of (m[2] as string).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g))
      out[d[1] as string] = (d[2] as string).trim();
  }
  return out;
}

const css = fs.readFileSync(path.join(DS, "tokens.css"), "utf8");
const dark = { ...declared(css, /^:root\s*,\s*:root\[data-theme="macchiato"\]$/) };
const light = { ...dark, ...declared(css, /^:root\[data-theme="latte"\]$/) };
const scales = declared(css, /^:root$/);

const rgb = (hex: string): [number, number, number] => {
  assert.match(hex, /^#[0-9a-f]{6}$/i, `a six-digit hex colour, got ${hex}`);
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
};
const lin = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const ratio = (a: string, b: string) => {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const SURFACES = ["sunken", "page", "panel", "raised", "overlay"].map((s) => `--surface-${s}`);
const STATUS = ["ok", "warn", "err", "info", "mauve"].map((s) => `--status-${s}`);

function checks(): { label: string; fg: string; bg: string; min: number }[] {
  const list: { label: string; fg: string; bg: string; min: number }[] = [];
  const text = (fg: string, bg: string) => list.push({ label: `${fg} on ${bg}`, fg, bg, min: 4.5 });
  const graphic = (fg: string, bg: string) =>
    list.push({ label: `${fg} on ${bg} (non-text)`, fg, bg, min: 3 });
  for (const s of SURFACES) {
    for (const t of ["--text-strong", "--text-body", "--text-muted", "--accent", ...STATUS])
      text(t, s);
    graphic("--border-control", s);
    graphic("--focus-ring", s);
  }
  for (const k of STATUS) {
    text(k, `${k}-tint`);
    text("--text-body", `${k}-tint`);
    graphic(k, `${k}-tint`);
  }
  text("--accent", "--accent-tint");
  text("--text-body", "--accent-tint");
  text("--text-on-accent", "--accent");
  text("--text-on-accent", "--accent-hover");
  text("--text-on-accent", "--status-err");
  graphic("--focus-ring", "--accent-tint");
  graphic("--border-control", "--accent-tint");
  return list;
}

test("tokens: both themes declare the same colour names", () => {
  const colourNames = (t: Tokens) =>
    Object.keys(t).filter((k) => /^#[0-9a-f]{6}$/i.test(t[k] ?? ""));
  const latteOwn = declared(css, /^:root\[data-theme="latte"\]$/);
  const darkNames = new Set(colourNames(dark));
  for (const k of colourNames(latteOwn)) assert.ok(darkNames.has(k), `${k} only exists in Latte`);
  for (const k of darkNames) assert.ok(latteOwn[k] !== undefined, `${k} has no Latte value`);
});

for (const [name, tokens] of [
  ["Macchiato (dark)", dark],
  ["Latte (light)", light],
] as const) {
  test(`tokens: WCAG 2.2 AA contrast in ${name}`, () => {
    const failures: string[] = [];
    for (const c of checks()) {
      const fg = tokens[c.fg];
      const bg = tokens[c.bg];
      assert.ok(fg, `${c.fg} is declared`);
      assert.ok(bg, `${c.bg} is declared`);
      const r = ratio(fg, bg);
      if (r < c.min) failures.push(`${c.label}: ${r.toFixed(2)}:1 < ${c.min}:1 (${fg} on ${bg})`);
    }
    assert.deepEqual(failures, []);
  });
}

test("tokens: the scales stay inside the spec's limits", () => {
  const sizes = Object.keys(scales).filter((k) => /^--text-(xs|sm|md|lg|xl|2xl)$/.test(k));
  const space = Object.keys(scales).filter((k) => /^--space-\d$/.test(k));
  const radii = Object.keys(scales).filter((k) => /^--radius-/.test(k));
  assert.ok(sizes.length > 0 && sizes.length <= 8, `font sizes: ${sizes.length}`);
  assert.ok(space.length > 0 && space.length <= 8, `spacing steps: ${space.length}`);
  assert.ok(radii.length > 0 && radii.length <= 6, `radii: ${radii.length}`);
  assert.ok(Number.parseFloat(scales["--target-min"] ?? "0") >= 1.5, "targets ≥ 24 px");
});

test("tile pages link to the panel's design system, not to copies of it", () => {
  for (const f of ["tile.html", "voice.html", "render.html", "map.html", "config.html"]) {
    const src = read(f);
    for (const n of ["tokens", "base", "components"])
      assert.ok(src.includes(`../../src/panel/public/ds/${n}.css`), `${f} links ds/${n}.css`);
    assert.match(src, /<html[^>]*class="ds-root"/, `${f} opts in to the scoped element defaults`);
  }
  for (const n of ["tokens.css", "base.css", "components.css"])
    assert.ok(!fs.existsSync(path.join(UX, n)), `docs/ux/${n} is not a second copy`);
});

test("only tokens.css holds colour literals; the tile uses declared tokens", () => {
  // CSS and HTML: any hex or colour function. JS: only string literals (its helper functions
  // named rgb() are code, not colour values).
  const cssColour = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i;
  const jsColour = /["'`]#[0-9a-f]{3,8}["'`]|["'`](rgba?|hsla?)\(/i;
  const problems: string[] = [];
  const names = new Set(Object.keys({ ...dark, ...scales }));
  const files = [
    ...fs.readdirSync(UX).map((f) => ({ f, dir: UX })),
    ...fs.readdirSync(DS).map((f) => ({ f, dir: DS })),
  ];
  for (const { f, dir } of files) {
    if (f === "tokens.css" || !/\.(css|html|js)$/.test(f)) continue;
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    // Strip text content such as "#/voice" routes or anchors before looking for colours.
    const code = src.replace(/href="#[^"]*"/g, "").replace(/\burl\(#[^)]*\)/g, "");
    for (const [i, line] of code.split("\n").entries())
      if ((f.endsWith(".js") ? jsColour : cssColour).test(line) && !/^\s*(\/\/|\/\*|\*)/.test(line))
        problems.push(`${f}:${i + 1} has a colour literal: ${line.trim().slice(0, 70)}`);
    if (/\.(css|html)$/.test(f))
      for (const m of src.matchAll(/var\((--[a-z0-9-]+)/g))
        if (!names.has(m[1] as string) && !(m[1] as string).startsWith("--tile-"))
          problems.push(`${f} uses an undeclared token ${m[1]}`);
  }
  assert.deepEqual(problems, []);
});

// ---------- Browser checks (skipped without Chromium) ----------

import { pathToFileURL } from "node:url";

async function chromium() {
  try {
    const pw = await import("playwright");
    return fs.existsSync(pw.chromium.executablePath()) ? pw.chromium : undefined;
  } catch {
    return undefined;
  }
}
const browserType = await chromium();
const url = (f: string, q = "") => `${pathToFileURL(path.join(UX, f)).href}?${q}`;

test(
  "tile pages: no console errors, no horizontal page overflow, both themes at 1400 and 900 px",
  { skip: !browserType },
  async () => {
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const problems: string[] = [];
      for (const file of ["tile.html", "voice.html", "render.html", "map.html", "config.html"]) {
        for (const theme of ["macchiato", "latte"]) {
          for (const width of [1400, 900]) {
            const page = await browser.newPage({ viewport: { width, height: 900 } });
            const errors: string[] = [];
            page.on("pageerror", (e) => errors.push(e.message));
            page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
            await page.goto(url(file, `theme=${theme}`));
            const over = (await page.evaluate(
              "document.documentElement.scrollWidth - document.documentElement.clientWidth",
            )) as number;
            if (over > 1) problems.push(`${file} ${theme} ${width}: overflows by ${over}px`);
            for (const e of errors) problems.push(`${file} ${theme} ${width}: ${e}`);
            await page.close();
          }
        }
      }
      assert.deepEqual(problems, []);
    } finally {
      await browser.close();
    }
  },
);

test(
  "tile pages: the review layout collapses by container width, not window width",
  {
    skip: !browserType,
  },
  async () => {
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.goto(url("tile.html"));
      const lists = await page.locator("#review .ds-split-list").all();
      assert.equal(lists.length, 2);
      assert.equal(await lists[0]?.isVisible(), true, "wide workspace shows the list");
      assert.equal(
        await lists[1]?.isVisible(),
        false,
        "the narrow workspace hides it, in a wide window",
      );
      assert.equal(
        await page.locator("#review .ds-split-bar").last().isVisible(),
        true,
        "and shows a picker",
      );
      await page.close();
    } finally {
      await browser.close();
    }
  },
);

test(
  "map prototype: path filters, dim context, focus, groups and keyboard",
  {
    skip: !browserType,
  },
  async () => {
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.goto(url("map.html", "theme=macchiato"));
      const nodes = () => page.locator(".ds-node").count();
      const all = await nodes();
      assert.ok(all >= 15, `all paths shows the whole fixture (${all})`);

      await page.locator("[data-view=line]").click();
      assert.equal(await nodes(), 5, "the production line is the five selected versions");
      assert.equal(await page.locator(".ds-node[data-line=true]").count(), 5);

      await page.locator("[data-view=approved]").click();
      const approvedNodes = await nodes();
      assert.ok(
        approvedNodes < all && approvedNodes > 5,
        `usable approved chains only (${approvedNodes})`,
      );
      assert.equal(
        await page.locator(".ds-node[data-state=blocked]").count(),
        0,
        "a blocked branch is not an approved path",
      );
      assert.equal(await page.locator(".ds-node[data-state=draft]").count(), 0);

      await page.locator("[data-view=all]").click();
      await page.locator(".ds-input").fill("final");
      const matched = await page.locator(".ds-node[data-match=true]").count();
      const dim = await page.locator(".ds-node[data-dim=true]").count();
      assert.ok(matched >= 2, "the finals match");
      assert.ok(dim >= 4, `their prerequisites stay as dim context (${dim})`);
      assert.match((await page.locator(".ds-map-hidden").innerText()).trim(), /hidden/);
      await page.locator(".ds-map-hidden").click();
      assert.equal(await nodes(), all, "Show all restores the view");

      // a group opens in place, and a matching draft opens its group
      await page.locator('.ds-node[data-id="g1"]').click();
      assert.ok((await nodes()) > all, "the drafts group expands");
      await page.locator("[data-act=collapse]").click();
      assert.equal(await nodes(), all);
      await page.locator(".ds-input").fill("draft v40");
      assert.ok(
        (await page.locator(".ds-node[data-match=true]").count()) >= 1,
        "a matching draft opens its group",
      );
      await page.locator(".ds-input").fill("");

      // focus connections: the selected node's ancestors and descendants only
      await page.locator('.ds-node[data-id="vo2"]').click();
      await page.locator("[data-act=focus]").click();
      const focused = await nodes();
      assert.ok(focused > 3 && focused < all, `focus keeps the chain (${focused})`);
      await page.locator("[data-act=focus]").click();

      // keyboard: arrows walk the tree, the outline mirrors the selection
      await page.locator('.ds-node[data-id="vo2"]').focus();
      await page.keyboard.press("ArrowRight");
      assert.equal(
        await page.locator('.ds-node[aria-current="true"]').getAttribute("data-id"),
        "an1",
      );
      await page.keyboard.press("ArrowLeft");
      assert.equal(
        await page.locator('.ds-node[aria-current="true"]').getAttribute("data-id"),
        "vo2",
      );
      assert.equal(
        await page.locator('.ds-outline button[aria-current="true"]').getAttribute("data-id"),
        "vo2",
      );
      assert.match(await page.locator(".ds-map-open").innerText(), /Open Voice v2 in Voice over/);
      await page.close();
    } finally {
      await browser.close();
    }
  },
);

test(
  "showcase dialogs are native: Escape closes, focus returns, danger starts on Cancel",
  {
    skip: !browserType,
  },
  async () => {
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.goto(url("tile.html"));
      const opener = page.locator("[data-open=dlg-danger]");
      await opener.focus();
      await opener.press("Enter");
      assert.equal(await page.evaluate("document.getElementById('dlg-danger').open"), true);
      assert.equal(
        await page.evaluate("document.activeElement?.textContent?.trim()"),
        "Cancel",
        "a danger dialog starts on Cancel",
      );
      await page.keyboard.press("Escape");
      assert.equal(await page.evaluate("document.getElementById('dlg-danger').open"), false);
      assert.equal(
        await page.evaluate("document.activeElement?.getAttribute('data-open')"),
        "dlg-danger",
        "focus returns to the opener",
      );

      // theme toggle flips the tokens and the live contrast stays AA
      await page.locator("[data-theme-toggle]").click();
      assert.equal(await page.evaluate("document.documentElement.dataset.theme"), "latte");
      const failing = await page.locator(".tile-ratio", { hasText: "✗" }).count();
      assert.equal(failing, 0, "no measured pair fails in Latte");
      await page.close();
    } finally {
      await browser.close();
    }
  },
);

test(
  "config prototype: search across both scopes, explicit edit scope, shadowing, no secrets",
  {
    skip: !browserType,
  },
  async () => {
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.goto(url("config.html", "theme=macchiato"));
      const rows = () => page.locator(".ds-srow").count();
      const all = await rows();
      assert.equal(all, 18, "every setting of the fixture is listed");
      assert.match(await page.locator(".ds-cfg-status").innerText(), /18 settings/);

      // "/" focuses the search outside editable controls; typing narrows by key, label, doc and value
      await page.locator("body").click({ position: { x: 5, y: 400 } });
      await page.keyboard.press("/");
      assert.equal(await page.evaluate("document.activeElement?.type"), "search");
      await page.keyboard.type("voice");
      assert.equal(
        await rows(),
        3,
        "voice matches the TTS chain doc, the voice name and the auto-suggest doc",
      );
      assert.ok((await page.locator("mark.ds-mark").count()) >= 3, "matches are highlighted");
      assert.match(
        await page.locator(".ds-cfg-status").innerText(),
        /3 settings in 2 groups match/,
      );
      assert.match(await page.locator(".ds-cfg-main").innerText(), /5 groups have no match/);

      // a value is searchable, and the search never reaches a secret (none is in the data)
      await page.locator(".ds-input").fill("Stefan_trained");
      assert.equal(await rows(), 1);
      await page.locator(".ds-input").fill("sk-");
      assert.equal(await rows(), 0);
      assert.match(await page.locator(".ds-cfg-groups").innerText(), /No settings match/);
      assert.match(await page.locator(".ds-cfg-groups").innerText(), /Secrets are never searched/);

      // Escape clears the query while the search owns focus
      await page.locator(".ds-input").focus();
      await page.keyboard.press("Escape");
      assert.equal(await page.locator(".ds-input").inputValue(), "");
      assert.equal(await rows(), all);

      // both scopes, the environment and the default are visible together; edit names its scope
      await page.locator('[data-toggle="voiceName"]').click();
      const scopes = await page.locator('.ds-srow[data-key="voiceName"] .ds-scope').allInnerTexts();
      assert.equal(scopes.length, 4);
      assert.match(
        scopes.join("\n"),
        /Environment[\s\S]*Project override[\s\S]*Global value[\s\S]*Default/,
      );
      await page.locator('[data-edit="voiceName"][data-scope="project"]').click();
      assert.match(
        await page.locator(".ds-srow-edit").innerText(),
        /Editing the project override \(keycraft\)/,
      );
      assert.match(
        await page.locator(".ds-srow-edit").innerText(),
        /projects\/keycraft\/config\.json/,
      );
      await page.locator("[data-cancel]").click();

      // an environment override shadows a global edit: the panel says so before you save
      await page.locator('[data-toggle="ttsChain"]').click();
      await page.locator('[data-edit="ttsChain"][data-scope="global"]').click();
      assert.match(
        await page.locator(".ds-srow-edit .ds-notice").innerText(),
        /no effect right now[\s\S]*DEMO_REC_TTS_CHAIN/,
      );
      await page.close();

      // no project open: project editing is disabled, with the reason
      const p2 = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await p2.goto(url("config.html", "project=none&open=fps"));
      const disabled = p2.locator('.ds-srow[data-key="fps"] button[aria-disabled="true"]');
      assert.equal(await disabled.count(), 1);
      assert.match(
        await p2.locator('.ds-srow[data-key="fps"] .ds-why').innerText(),
        /Open a project to override/,
      );
      await p2.close();

      // narrow: the group nav becomes chips, rows stack, no page overflow
      const p3 = await browser.newPage({ viewport: { width: 900, height: 900 } });
      await p3.goto(url("config.html"));
      assert.equal(
        await p3.evaluate("getComputedStyle(document.querySelector('.ds-cfg-nav')).position"),
        "static",
      );
      await p3.close();
    } finally {
      await browser.close();
    }
  },
);
