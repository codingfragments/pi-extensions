/**
 * Static server for the Acme Pulse fixture SPA (D20) with history-API
 * fallback: any non-file path serves index.html so deep links like
 * `/item/106` work. Binds to 127.0.0.1.
 */

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "demo-app",
);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

export interface FixtureHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export async function serveFixture(port = 0): Promise<FixtureHandle> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const candidate = path.resolve(FIXTURE_DIR, `.${decodeURIComponent(url.pathname)}`);
    const isFile =
      candidate.startsWith(FIXTURE_DIR + path.sep) &&
      fs.existsSync(candidate) &&
      fs.statSync(candidate).isFile();
    const file = isFile ? candidate : path.join(FIXTURE_DIR, "index.html");
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const actual = (server.address() as AddressInfo).port;
  return {
    port: actual,
    url: `http://127.0.0.1:${actual}/`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
