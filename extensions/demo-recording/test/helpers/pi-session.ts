/**
 * A REAL pi agent session with a scripted model (no network, no credits): the real agent loop, the real extension
 * runner and the real event order, with the answers of the model written by the test. Used to pin what pi really
 * tells an extension about a run (docs/DIRECTOR_STATE.md) and to run our extension inside a real session.
 *
 * Nothing of the user's pi (extensions, skills, settings, credentials) is read: every directory is a temp folder.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";

export { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

// biome-ignore lint/suspicious/noExplicitAny: pi's extension API, passed through as it is
type Api = any;

/** The events of a run that matter to "what is the Director doing", with the fields we rely on. */
export const WATCHED = [
  "input",
  "before_agent_start",
  "agent_start",
  "turn_start",
  "message_start",
  "message_end",
  "tool_execution_start",
  "tool_execution_end",
  "turn_end",
  "agent_end",
  "agent_before_settle",
  "agent_settled",
] as const;

export interface Seen {
  ev: (typeof WATCHED)[number];
  /** The facts of the event we care about. */
  d: Record<string, unknown>;
  /** ctx.isIdle() at that moment. */
  idle?: boolean;
  at: number;
}

export async function fauxSession(
  opts: { extensions?: ((pi: Api) => void | Promise<void>)[] } = {},
) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-"));
  const agentDir = path.join(tmp, "agent");
  const faux = fauxProvider({ models: [{ id: "scripted" }] });
  const seen: Seen[] = [];
  const t0 = Date.now();

  const watcher = (pi: Api) => {
    for (const ev of WATCHED) {
      pi.on(ev, async (e: Api, ctx: Api) => {
        const d: Record<string, unknown> = {};
        if (ev === "input")
          Object.assign(d, {
            source: e.source,
            text: e.text,
            streamingBehavior: e.streamingBehavior,
          });
        if (ev === "before_agent_start")
          Object.assign(d, {
            messageType: e.messageType,
            prompt: e.prompt,
            customType: e.message?.customType,
          });
        if (ev === "turn_start" || ev === "turn_end") d.turnIndex = e.turnIndex;
        if (ev === "message_start" || ev === "message_end")
          d.role = `${e.message?.role}${e.message?.customType ? `:${e.message.customType}` : ""}`;
        if (ev === "tool_execution_start") Object.assign(d, { tool: e.toolName, args: e.args });
        if (ev === "tool_execution_end") Object.assign(d, { tool: e.toolName, isError: e.isError });
        if (ev === "agent_settled") d.aborted = e.aborted;
        let idle: boolean | undefined;
        try {
          idle = ctx?.isIdle?.();
        } catch {
          // a stale context
        }
        seen.push({ ev, d, ...(idle === undefined ? {} : { idle }), at: Date.now() - t0 });
      });
    }
  };

  const loader = new DefaultResourceLoader({
    cwd: tmp,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [watcher, ...(opts.extensions ?? [])],
  });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({ agentDir } as Api);
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey(faux.getModel().provider, "scripted");
  const { session } = await createAgentSession({
    cwd: tmp,
    agentDir,
    model: faux.getModel(),
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    modelRuntime,
    noTools: "builtin",
  } as Api);

  return {
    session,
    faux,
    seen,
    tmp,
    /** The names of the watched events, in order (message events left out unless asked for). */
    names: (withMessages = false) =>
      seen.map((s) => s.ev).filter((n) => withMessages || !n.startsWith("message_")),
    /** Wait until pi says it will not continue by itself. */
    settled: (n = 1, timeoutMs = 15_000) =>
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("agent_settled never came")), timeoutMs);
        const tick = setInterval(() => {
          if (seen.filter((s) => s.ev === "agent_settled").length >= n) {
            clearInterval(tick);
            clearTimeout(t);
            resolve();
          }
        }, 10);
      }),
    dispose() {
      session.dispose();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}
