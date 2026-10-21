/**
 * Spike S7 (login and sessions): what a manual login leaves in a Playwright `storageState`, and what a later headless context gets back. A small fixture app
 * with four ways to stay logged in (a cookie, a localStorage token, a sessionStorage token, an IndexedDB token) and a server-side expiry. Real Chromium, no network.
 * The answers are written into docs/spikes/S7-login.md.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

async function chromium() {
  try {
    const pw = await import("playwright");
    return fs.existsSync(pw.chromium.executablePath()) ? pw.chromium : undefined;
  } catch {
    return undefined;
  }
}
const browserType = await chromium();

/** The fixture: /login sets what each variant keeps; /app says "in" or "out"; /api/me is 401 when the server-side session is gone. */
function fixture() {
  const sessions = new Map<string, number>(); // token -> expires at
  let now = Date.now();
  const clock = { advance: (ms: number) => (now += ms) };
  const page = (body: string) => `<!doctype html><meta charset=utf-8><body>${body}</body>`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const cookie = /(?:^|; )sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    const valid = (t?: string | null) => !!t && (sessions.get(t) ?? 0) > now;
    if (url.pathname === "/login") {
      res.setHeader("content-type", "text/html");
      return res.end(
        page(
          "<h1>Sign in</h1><form method=post action=/do-login><input name=user><input type=password name=pw><button>Sign in</button></form>",
        ),
      );
    }
    if (url.pathname === "/do-login") {
      const token = `t${sessions.size + 1}`;
      sessions.set(token, now + 60_000);
      const mode = url.searchParams.get("mode") ?? "cookie";
      res.setHeader("content-type", "text/html");
      if (mode === "cookie") res.setHeader("set-cookie", `sid=${token}; Path=/; HttpOnly`);
      if (mode === "session-cookie") res.setHeader("set-cookie", `sid=${token}; Path=/`); // no Max-Age/Expires: a browser-session cookie
      return res.end(
        page(`<script>
          const t = ${JSON.stringify(token)}, mode = ${JSON.stringify(mode)};
          if (mode === "local") localStorage.setItem("tok", t);
          if (mode === "session") sessionStorage.setItem("tok", t);
          if (mode === "idb") { const r = indexedDB.open("auth", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => { r.result.transaction("kv", "readwrite").objectStore("kv").put(t, "tok").onsuccess = () => (location.href = "/app?mode=idb"); }; }
          else location.href = "/app?mode=" + mode;
        </script>logging in`),
      );
    }
    if (url.pathname === "/api/me") {
      const tok = cookie ?? req.headers["x-token"]?.toString();
      res.statusCode = valid(tok) ? 200 : 401;
      return res.end(valid(tok) ? "me" : "no");
    }
    if (url.pathname === "/app") {
      const mode = url.searchParams.get("mode") ?? "cookie";
      if (mode === "cookie" || mode === "session-cookie") {
        if (!valid(cookie)) {
          res.statusCode = 302;
          res.setHeader("location", "/login");
          return res.end();
        }
        res.setHeader("content-type", "text/html");
        return res.end(page("<h1 id=in>Dashboard</h1>"));
      }
      // token variants: the page decides in the browser
      res.setHeader("content-type", "text/html");
      return res.end(
        page(`<h1 id=state>checking</h1><script>
          const mode = ${JSON.stringify(mode)};
          const get = () => mode === "local" ? Promise.resolve(localStorage.getItem("tok")) : mode === "session" ? Promise.resolve(sessionStorage.getItem("tok"))
            : new Promise((ok) => { const r = indexedDB.open("auth", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => { const g = r.result.transaction("kv").objectStore("kv").get("tok"); g.onsuccess = () => ok(g.result ?? null); }; });
          get().then((t) => fetch("/api/me", { headers: { "x-token": t ?? "" } })).then((r) => { document.getElementById("state").textContent = r.ok ? "in" : "out"; });
        </script>`),
      );
    }
    res.statusCode = 404;
    res.end();
  });
  return { server, sessions, clock };
}

test(
  "S7: what survives a saved state, per way of staying logged in",
  { skip: !browserType && "needs Playwright Chromium", timeout: 120_000 },
  async () => {
    const fx = fixture();
    await new Promise<void>((r) => fx.server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(fx.server.address() as { port: number }).port}`;
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "s7-"));
    const result: Record<string, { saved: string; reused: string }> = {};
    try {
      for (const mode of ["cookie", "session-cookie", "local", "session", "idb"]) {
        // "the user" logs in by hand in one context
        const a = await browser.newContext();
        const pa = await a.newPage();
        await pa.goto(`${base}/login`);
        await pa.evaluate(
          `document.querySelector('form').action = '/do-login?mode=${mode}'; document.querySelector('form').submit()`,
        );
        await pa.waitForURL(/\/app/);
        await pa.waitForFunction(
          `document.querySelector('#in, #state')?.textContent === 'in' || document.querySelector('#in')`,
        );
        const file = path.join(tmp, `${mode}.json`);
        const state = await a.storageState({ path: file, indexedDB: true });
        fs.chmodSync(file, 0o600);
        await a.close();
        const saved = `${state.cookies.length} cookie(s), ${state.origins.flatMap((o) => o.localStorage).length} localStorage item(s), ${state.origins.filter((o) => (o as { indexedDB?: unknown[] }).indexedDB?.length).length} origin(s) with IndexedDB`;
        // a later headless context gets the file
        const b = await browser.newContext({ storageState: file });
        const pb = await b.newPage();
        await pb.goto(`${base}/app?mode=${mode}`);
        await pb.waitForFunction(
          `document.querySelector('#in') || ['in','out'].includes(document.querySelector('#state')?.textContent)`,
          undefined,
          { timeout: 10_000 },
        );
        const reused = (await pb.locator("#in").count())
          ? "in"
          : pb.url().includes("/login")
            ? "out (redirected to /login)"
            : await pb.locator("#state").innerText();
        result[mode] = { saved, reused };
        await b.close();
      }
      console.log(JSON.stringify(result, null, 2));
      // what the answer is, as the engine will rely on it
      assert.equal(result.cookie?.reused, "in", "a cookie session is reused");
      assert.equal(
        result["session-cookie"]?.reused,
        "in",
        "a cookie without an expiry is saved and reused too (Playwright stores it)",
      );
      assert.equal(result.local?.reused, "in", "a localStorage token is reused");
      assert.equal(
        result.idb?.reused,
        "in",
        "an IndexedDB token is reused when the state is saved with indexedDB: true",
      );
      assert.match(
        result.session?.reused ?? "",
        /^out/,
        "a sessionStorage token is NOT kept by a saved state",
      );
    } finally {
      await browser.close();
      fx.server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  },
);

test(
  "S7: what an expired session looks like, and how the engine can tell without knowing the app",
  { skip: !browserType && "needs Playwright Chromium", timeout: 120_000 },
  async () => {
    const fx = fixture();
    await new Promise<void>((r) => fx.server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(fx.server.address() as { port: number }).port}`;
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const ctx = await browser.newContext();
      const p = await ctx.newPage();
      await p.goto(`${base}/login`);
      await p.evaluate(
        `document.querySelector('form').action = '/do-login?mode=cookie'; document.querySelector('form').submit()`,
      );
      await p.waitForSelector("#in");
      const probe = async () => {
        const page = await ctx.newPage();
        const res = await page.goto(`${base}/app?mode=cookie`);
        const info = {
          status: res?.status(),
          url: new URL(page.url()).pathname,
          password: await page.locator("input[type=password]").count(),
        };
        await page.close();
        return info;
      };
      assert.deepEqual(
        await probe(),
        { status: 200, url: "/app", password: 0 },
        "logged in: the page, no password field",
      );
      // the server forgets the session (expiry): the same state now lands on the login page
      fx.sessions.clear();
      assert.deepEqual(
        await probe(),
        { status: 200, url: "/login", password: 1 },
        "expired: redirected to /login, a password field on the page",
      );
      // a navigation inside a running take shows the same facts, so the recorder can check them after every navigation
      await ctx.close();
    } finally {
      await browser.close();
      fx.server.close();
    }
  },
);
