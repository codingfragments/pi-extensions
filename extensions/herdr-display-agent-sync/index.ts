import net from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * herdr-display-agent-sync
 *
 * Syncs the pi session's display name into herdr's sidebar via
 * `pane.report_metadata` (`display_agent`), so the agent panel shows a
 * meaningful label instead of just the agent type ("pi").
 *
 * Why a separate extension: `~/.pi/agent/extensions/herdr-agent-state.ts`
 * is managed by herdr (overwritten on `herdr integration install pi`). This
 * extension lives in the codingfragments repo and is loaded alongside it,
 * so it survives herdr integration updates.
 *
 * Behavior:
 *   - On `session_start` (TUI only), read `ctx.sessionManager.getSessionName()`.
 *   - If no name is set, fall back to a slug of the cwd basename.
 *   - Report it as `display_agent` with the max TTL (24h = 86_400_000ms).
 *   - Re-report on `agent_start`, `agent_settled`, and `session_info_changed`
 *     so the label refreshes naturally during normal use — the 24h TTL never
 *     visibly expires.
 *   - No-op outside herdr (gates on `HERDR_ENV` / `HERDR_PANE_ID` /
 *     `HERDR_SOCKET_PATH`).
 *
 * Security: only talks to the local herdr unix socket; no network, no file
 * writes, no secrets. Reads the session name (user-defined) and cwd (already
 * known to herdr). No exfiltration.
 */
export default function (pi: ExtensionAPI) {
  const HERDR_ENV = process.env.HERDR_ENV;
  const socketPath = process.env.HERDR_SOCKET_PATH;
  const socketEndpoint =
    process.platform === "win32" && socketPath ? `\\\\.\\pipe\\${socketPath}` : socketPath;
  const paneId = process.env.HERDR_PANE_ID;
  const source = "herdr:pi:display-sync";

  const MAX_TTL_MS = 86_400_000; // 24h — herdr rejects anything above this.

  function enabled(): boolean {
    return HERDR_ENV === "1" && !!socketPath && !!paneId;
  }

  function sendRequest(request: unknown, timeoutMs: number): Promise<boolean> {
    if (!enabled() || !socketEndpoint) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      let done = false;
      const socket = net.createConnection(socketEndpoint);
      function finish(ok: boolean) {
        if (done) return;
        done = true;
        if (timeout) clearTimeout(timeout);
        socket.destroy();
        resolve(ok);
      }
      socket.on("error", () => finish(false));
      socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on("data", () => finish(true));
      socket.on("end", () => finish(false));
      const timeout = setTimeout(() => finish(false), timeoutMs);
      timeout.unref?.();
    });
  }

  // Slugify a fallback label from the cwd basename: lowercase, a-z0-9-_.
  // Matches herdr's agent-name rules (^[a-z][a-z0-9_-]{0,31}$) so display_agent
  // and the persistent name handle stay consistent.
  function cwdFallback(cwd: string | undefined): string | undefined {
    if (!cwd) return undefined;
    let base = cwd.replace(/\/+$/, "").split("/").pop() ?? "";
    base = base
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!base) return undefined;
    // must start with a lowercase letter; if it starts with a digit, prefix "s"
    if (!/^[a-z]/.test(base)) base = `s${base}`;
    return base.slice(0, 32);
  }

  function resolveLabel(ctx: ExtensionContext): string | undefined {
    try {
      const name = ctx.sessionManager.getSessionName();
      if (typeof name === "string" && name.trim().length > 0) {
        return name.trim().slice(0, 32);
      }
    } catch {
      // fall through to cwd
    }
    return cwdFallback(ctx.sessionManager.getCwd() ?? ctx.cwd);
  }

  let lastLabel: string | undefined;

  async function reportLabel(label: string | undefined): Promise<void> {
    if (!label || label === lastLabel) return;
    lastLabel = label;
    await sendRequest(
      {
        id: `${source}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        method: "pane.report_metadata",
        params: {
          pane_id: paneId,
          source,
          display_agent: label,
          ttl_ms: MAX_TTL_MS,
        },
      },
      500,
    );
  }

  if (!enabled()) return;

  let rootSession = false;

  pi.on("session_start", async (_event, ctx) => {
    // TUI only — headless modes have no herdr pane to label.
    if (ctx.mode !== "tui") return;
    rootSession = true;
    await reportLabel(resolveLabel(ctx));
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (!rootSession) return;
    await reportLabel(resolveLabel(ctx));
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!rootSession) return;
    await reportLabel(resolveLabel(ctx));
  });

  // If the user sets/clears the session name via /name, refresh the label.
  pi.on("session_info_changed", async (_event, ctx) => {
    if (!rootSession) return;
    await reportLabel(resolveLabel(ctx));
  });
}
