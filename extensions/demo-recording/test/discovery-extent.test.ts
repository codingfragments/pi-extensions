/**
 * Two things that keep a discovery step cheap: a list that loads more as you scroll may extend ONCE (then a scroll stays inside what is loaded), and a look does not
 * send the unchanged page chrome again. Pure parts first; then a real page that loads 20 rows more every time it is scrolled to the bottom.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { reduceDigest, topBlocks } from "../src/discovery/digest.ts";
import { NODE_CAP, allowedScroll, grew } from "../src/discovery/extent.ts";
import { DiscoverySession } from "../src/discovery/session.ts";
import { ensureApp } from "../src/workdir/layout.ts";

async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}
const skip = !(await chromiumAvailable()) && "chromium not installed";

const NAV = `- navigation "Primary Navigation":
  - list:
    - listitem:
      - link "Issues":
        - /url: /issues/
    - listitem:
      - link "Explore":
        - /url: /explore/`;
const page1 = `- link "Skip to main content":
  - /url: "#main"
${NAV}
- main:
  - heading "Feed" [level=1]
  - table:
    - row "a"`;
const page2 = `- link "Skip to main content":
  - /url: "#main"
${NAV}
- main:
  - heading "Traces" [level=1]`;
const page3 = page2
  .replace("Primary Navigation", "Primary Navigation")
  .replace('link "Explore"', 'link "Explore!"');

test("digest: the top-level items, the first look in full, the same chrome as one line afterwards, a changed chrome in full again", () => {
  assert.equal(topBlocks(page1).length, 3);
  const prev = new Map<string, string>();
  const first = reduceDigest(page1, prev);
  assert.equal(first.text, page1, "the first look is complete");
  assert.deepEqual(first.collapsed, []);
  const second = reduceDigest(page2, prev);
  assert.deepEqual(second.collapsed, ['- navigation "Primary Navigation"']);
  assert.match(
    second.text,
    /- navigation "Primary Navigation": \(unchanged since the last look, 8 lines; its targets are still valid\)/,
  );
  assert.match(second.text, /heading "Traces"/, "the page's own content is there");
  assert.doesNotMatch(second.text, /link "Issues"/, "the repeated navigation is not");
  assert.ok(second.text.length < page2.length, "shorter");
  const third = reduceDigest(page3, prev);
  assert.deepEqual(third.collapsed, [], "a changed navigation is sent again");
  assert.match(third.text, /Explore!/);
  const full = reduceDigest(page3, prev, true);
  assert.deepEqual(full.collapsed, [], "full_digest sends everything");
});

test("extension rules: a page may grow once; then a scroll stays inside what is loaded; a runaway page is not scrolled at all", () => {
  const ext = (o: Partial<Parameters<typeof grew>[0]> = {}) => ({
    scrollH: 3000,
    clientH: 800,
    top: 0,
    rows: 100,
    nodes: 5000,
    ...o,
  });
  assert.equal(grew(ext(), ext({ rows: 105 })), true, "five rows");
  assert.equal(grew(ext(), ext({ scrollH: 3400 })), true, "a screenful of height");
  assert.equal(grew(ext(), ext({ rows: 103, scrollH: 3100 })), false, "a few lazy items");
  const none = { extends: false, grewRows: 0, grewPx: 0, knownH: 0 };
  assert.equal(allowedScroll(none, ext(), 750), 750, "an ordinary page scrolls freely");
  assert.equal(allowedScroll(none, ext(), -400), -400, "up is always allowed");
  const once = { extends: true, grewRows: 20, grewPx: 900, knownH: 3900 };
  assert.equal(allowedScroll(once, ext({ top: 0 }), 750), 750, "inside the loaded content");
  assert.equal(
    allowedScroll(once, ext({ top: 2800 }), 750),
    3900 - 60 - (2800 + 800),
    "clamped at the end of what is loaded",
  );
  assert.equal(allowedScroll(once, ext({ top: 3040 }), 750), 0, "at the end: refused");
  assert.equal(
    allowedScroll(none, ext({ nodes: NODE_CAP + 1 }), 750),
    0,
    "too many elements: refused",
  );
});

function infiniteApp(): Promise<{ url: string; close: () => Promise<void>; rows: () => number }> {
  let rows = 0;
  const html = `<!doctype html><meta charset=utf-8><title>Traces</title>
<body style="margin:0"><h1>Traces</h1><nav aria-label="Primary Navigation"><a href="/">Home</a></nav>
<main><ul id=list></ul></main>
<script>
  const list = document.getElementById("list");
  let n = 0, loading = false;
  function more() { for (let i = 0; i < 20; i++) { const li = document.createElement("li"); li.textContent = "trace " + (++n); li.style.height = "40px"; list.appendChild(li); } loading = false; }
  more();
  window.addEventListener("scroll", () => {
    if (loading) return;
    if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 200) { loading = true; fetch("/more").then(() => setTimeout(more, 100)); }
  });
</script></body>`;
  const server = http.createServer((req, res) => {
    if (req.url === "/more") {
      rows += 20;
      res.end("ok");
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(html);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
        rows: () => rows,
      }),
    ),
  );
}

test(
  "a list that loads more on scroll: the first scroll to the bottom extends it and says so; the next scroll down stays inside what is loaded; it never runs on",
  { skip, timeout: 120_000 },
  async () => {
    const app = infiniteApp();
    const a = await app;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-ext-"));
    try {
      const info = ensureApp(root, "Infinite", a.url);
      const d = await DiscoverySession.open({
        root,
        app: info,
        viewport: { width: 1000, height: 600 },
        budgets: { discoveryScreens: 40, discoveryActions: 100, discoveryMinutes: 10 },
        heartbeatSec: 0,
      });
      try {
        const notes: string[] = [];
        let refused = 0;
        for (let i = 0; i < 12; i++) {
          const r = await d.act({ action: "scroll", dy: 900 });
          notes.push(r.note ?? "");
          if (/NOT scrolled/.test(r.note ?? "")) refused++;
        }
        const grown = notes.find((n) => /loads more as you scroll/.test(n));
        assert.ok(grown, `the extension was noticed: ${notes.join(" | ")}`);
        assert.match(grown, /it extended once, which is enough to understand it/);
        assert.ok(refused > 0, `later scrolls to the end were refused: ${notes.join(" | ")}`);
        assert.ok(
          notes.some((n) =>
            /^NOT scrolled: this page loads more rows as you scroll and it has already extended once/.test(
              n,
            ),
          ),
        );
        assert.ok(
          a.rows() <= 40,
          `the list was extended at most about twice by the server's count (${a.rows()} rows asked for)`,
        );
        // up is always fine
        const up = await d.act({ action: "scroll", dy: -500 });
        assert.match(up.note ?? "", /^scrolled -500px/);
      } finally {
        await d.close();
      }
    } finally {
      await a.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "a look repeats nothing that has not changed: the second digest of the same app says its navigation is unchanged, and full_digest sends it again",
  { skip, timeout: 120_000 },
  async () => {
    const a = await infiniteApp();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-dig-"));
    try {
      const info = ensureApp(root, "Digest", a.url);
      const d = await DiscoverySession.open({
        root,
        app: info,
        viewport: { width: 1000, height: 600 },
        budgets: { discoveryScreens: 40, discoveryActions: 100, discoveryMinutes: 10 },
        heartbeatSec: 0,
      });
      try {
        const one = await d.look();
        assert.match(one.digest, /navigation "Primary Navigation"/);
        assert.doesNotMatch(one.digest, /unchanged since the last look/);
        const two = await d.look();
        assert.match(
          two.digest,
          /navigation "Primary Navigation": \(unchanged since the last look/,
        );
        const three = await d.look({ fullDigest: true });
        assert.doesNotMatch(three.digest, /unchanged since the last look/);
        // the file on disk is always the full snapshot
        assert.match(fs.readFileSync(path.join(d.dir, "dom", "s002.yaml"), "utf8"), /link "Home"/);
      } finally {
        await d.close();
      }
    } finally {
      await a.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
