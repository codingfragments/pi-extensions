/**
 * A tiny app that needs a login, for the S7 tests (real Chromium, no network): /login (a form), /app (the dashboard, "Dashboard" and a logout link, only logged in),
 * and ways of staying logged in: a cookie (default), a token in sessionStorage (which a saved state cannot keep). `expire()` makes the server forget every session.
 */

import http from "node:http";
import type { Page } from "playwright";

export interface LoginFixture {
  base: string;
  /** The server forgets every session: a saved login is now expired. */
  expire(): void;
  close(): Promise<void>;
}

export async function loginFixture(): Promise<LoginFixture> {
  const sessions = new Set<string>();
  let n = 0;
  const html = (body: string) =>
    `<!doctype html><meta charset=utf-8><title>app</title><body>${body}</body>`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const cookie = /(?:^|; )sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    res.setHeader("content-type", "text/html");
    if (url.pathname === "/login")
      return res.end(
        html(
          `<h1>Sign in</h1><form method=post action="/do-login?mode=${url.searchParams.get("mode") ?? "cookie"}"><input name=user><input type=password name=pw><button>Sign in</button></form>`,
        ),
      );
    if (url.pathname === "/do-login") {
      const sid = `s${++n}`;
      sessions.add(sid);
      if ((url.searchParams.get("mode") ?? "cookie") === "cookie")
        res.setHeader("set-cookie", `sid=${sid}; Path=/; HttpOnly`);
      return res.end(
        html(
          `<script>if (${JSON.stringify(url.searchParams.get("mode"))} === "session") sessionStorage.setItem("sid", ${JSON.stringify(sid)}); location.href = "/app?mode=${url.searchParams.get("mode") ?? "cookie"}";</script>`,
        ),
      );
    }
    if (url.pathname === "/app") {
      if ((url.searchParams.get("mode") ?? "cookie") === "session")
        return res.end(
          html(
            `<h1 id=s>checking</h1><script>document.getElementById("s").textContent = sessionStorage.getItem("sid") ? "Dashboard" : "Signed out"; if (!sessionStorage.getItem("sid")) location.href = "/login";</script>`,
          ),
        );
      if (!cookie || !sessions.has(cookie)) {
        res.statusCode = 302;
        res.setHeader("location", "/login");
        return res.end();
      }
      return res.end(html("<h1>Dashboard</h1><p>Welcome back</p>"));
    }
    if (url.pathname === "/") {
      res.statusCode = 302;
      res.setHeader("location", "/app");
      return res.end();
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    base,
    expire: () => sessions.clear(),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** What the user does at the login window: fill the form and submit. */
export async function logInByHand(
  page: Page,
  mode: "cookie" | "session" = "cookie",
): Promise<void> {
  if (mode === "session") await page.goto(`${new URL(page.url()).origin}/login?mode=session`);
  await page.fill("input[name=user]", "demo");
  await page.fill("input[name=pw]", "secret");
  await Promise.all([page.waitForURL(/\/app/), page.click("button")]);
}
