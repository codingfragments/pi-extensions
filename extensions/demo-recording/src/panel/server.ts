/**
 * Side-panel server (D10). Serves the static panel app and a token-protected
 * API + WebSocket that streams bus events.
 *
 * Security (IMPLEMENTATION_PLAN §7):
 * - binds to 127.0.0.1 only;
 * - every /api and /ws request needs the per-session token (blocks CSRF from
 *   other local web pages, which cannot read the token);
 * - the Host header must be a loopback name (blocks DNS-rebinding attacks);
 * - static files carry no data and are served without a token.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type { EventBus } from "../bus.ts";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const HOST = "127.0.0.1";
const PORT_ATTEMPTS = 20;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".json": "application/json; charset=utf-8",
};
const MEDIA_EXT = new Set([".jpg", ".jpeg", ".png", ".mp4", ".wav"]);
const MAX_BODY = 64 * 1024;

export type GetRoute = (query: URLSearchParams) => unknown | Promise<unknown>;
export type PostRoute = (body: Record<string, unknown>) => unknown | Promise<unknown>;

export interface PanelOptions {
  bus: EventBus;
  /** Preferred port; 0 = ephemeral. Falls back to the next free ports. */
  port: number;
  /** Supplies the payload for GET /api/state (active project, config summary…). */
  getState: () => unknown;
  /** Extra GET /api/<name> routes. */
  get?: Record<string, GetRoute>;
  /** POST /api/<name> routes (JSON body, Bearer token header required). */
  post?: Record<string, PostRoute>;
  /** Media roots: GET /media/<root>/<path> serves files below that directory. */
  media?: () => Record<string, string | undefined>;
  /** Override the token (tests). Defaults to 32 random bytes, hex. */
  token?: string;
}

export interface PanelHandle {
  url: string;
  port: number;
  token: string;
  close: () => Promise<void>;
}

function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function tokenFrom(req: http.IncomingMessage, url: URL): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  return url.searchParams.get("token") ?? undefined;
}

function safeEqual(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": MIME[".json"], "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function serveStatic(res: http.ServerResponse, pathname: string): void {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = path.resolve(PUBLIC_DIR, rel);
  if (
    !file.startsWith(PUBLIC_DIR + path.sep) ||
    !fs.existsSync(file) ||
    !fs.statSync(file).isFile()
  ) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  fs.createReadStream(file).pipe(res);
}

function bearer(req: http.IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("body must be a JSON object");
        resolve(parsed as Record<string, unknown>);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function serveMedia(
  res: http.ServerResponse,
  roots: Record<string, string | undefined>,
  pathname: string,
): void {
  const [, , rootName, ...rest] = pathname.split("/");
  const base = rootName ? roots[rootName] : undefined;
  const rel = decodeURIComponent(rest.join("/"));
  if (!base || !rel) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const root = path.resolve(base);
  const file = path.resolve(root, rel);
  if (
    !file.startsWith(root + path.sep) ||
    !MEDIA_EXT.has(path.extname(file).toLowerCase()) ||
    !fs.existsSync(file)
  ) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "cache-control": "private, max-age=3600",
  });
  fs.createReadStream(file).pipe(res);
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, HOST);
  });
}

export async function startPanel(opts: PanelOptions): Promise<PanelHandle> {
  const token = opts.token ?? crypto.randomBytes(32).toString("hex");

  const server = http.createServer((req, res) => {
    if (!isLoopbackHost(req.headers.host)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden host");
      return;
    }
    const url = new URL(req.url ?? "/", `http://${HOST}`);
    if (url.pathname === "/api/health") return sendJson(res, 200, { ok: true });
    if (url.pathname.startsWith("/media/")) {
      if (!safeEqual(tokenFrom(req, url), token))
        return sendJson(res, 401, { error: "unauthorized" });
      return serveMedia(res, opts.media?.() ?? {}, url.pathname);
    }
    if (url.pathname.startsWith("/api/")) {
      const name = url.pathname.slice(5);
      if (req.method === "POST") {
        // State-changing requests: Bearer header only (never a query token) and JSON only.
        // Cross-origin pages cannot set Authorization without a CORS preflight we never grant.
        if (!safeEqual(bearer(req), token)) return sendJson(res, 401, { error: "unauthorized" });
        if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
          return sendJson(res, 415, { error: "content-type must be application/json" });
        }
        const route = opts.post?.[name];
        if (!route) return sendJson(res, 404, { error: "not found" });
        readJson(req)
          .then((body) => route(body))
          .then(
            (result) => sendJson(res, 200, result ?? { ok: true }),
            (err: Error) => sendJson(res, 400, { error: err.message }),
          );
        return;
      }
      if (!safeEqual(tokenFrom(req, url), token))
        return sendJson(res, 401, { error: "unauthorized" });
      if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      if (name === "events") {
        const after = Number(url.searchParams.get("after") ?? 0) || 0;
        return sendJson(res, 200, opts.bus.recent(after));
      }
      if (name === "state") return sendJson(res, 200, opts.getState());
      const route = opts.get?.[name];
      if (!route) return sendJson(res, 404, { error: "not found" });
      Promise.resolve()
        .then(() => route(url.searchParams))
        .then(
          (result) => sendJson(res, 200, result),
          (err: Error) => sendJson(res, 400, { error: err.message }),
        );
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405);
      res.end();
      return;
    }
    serveStatic(res, url.pathname);
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${HOST}`);
    if (
      url.pathname !== "/ws" ||
      !isLoopbackHost(req.headers.host) ||
      !safeEqual(tokenFrom(req, url), token)
    ) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const after = Number(url.searchParams.get("after") ?? 0) || 0;
      for (const event of opts.bus.recent(after)) ws.send(JSON.stringify(event));
      const unsubscribe = opts.bus.subscribe((event) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
      });
      ws.on("close", unsubscribe);
      ws.on("error", unsubscribe);
    });
  });

  let port = -1;
  let lastErr: unknown;
  const attempts = opts.port === 0 ? 1 : PORT_ATTEMPTS;
  for (let i = 0; i < attempts; i++) {
    try {
      port = await listen(server, opts.port === 0 ? 0 : opts.port + i);
      break;
    } catch (err) {
      lastErr = err;
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    }
  }
  if (port < 0) throw new Error(`no free panel port from ${opts.port}: ${String(lastErr)}`);

  let closed = false;
  return {
    port,
    token,
    url: `http://${HOST}:${port}/?token=${token}`,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
