/**
 * Wire page observers (observers.js) and console/page errors to a callback,
 * with the event time in epoch ms (same clock as the screencast).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Page } from "playwright";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "observers.js");

export interface ObservedEvent {
  type: "route" | "alert" | "idle-start" | "idle-end" | "console-error" | "page-error";
  at: number;
  data: Record<string, unknown>;
}

export async function installObservers(
  context: BrowserContext,
  page: Page,
  onEvent: (e: ObservedEvent) => void,
): Promise<void> {
  await context.exposeBinding("__demoRecReport", (_source, e: ObservedEvent) => {
    if (e && typeof e.type === "string")
      onEvent({ type: e.type, at: Math.round(e.at), data: e.data ?? {} });
  });
  await context.addInitScript({ content: fs.readFileSync(SCRIPT, "utf8") });
  page.on("console", (msg) => {
    if (msg.type() === "error")
      onEvent({ type: "console-error", at: Date.now(), data: { text: msg.text().slice(0, 300) } });
  });
  page.on("pageerror", (err) =>
    onEvent({
      type: "page-error",
      at: Date.now(),
      data: { text: String(err.message).slice(0, 300) },
    }),
  );
}
