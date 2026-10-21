/**
 * One login at a time, started from the chat (`/demo login`) or from the Login card (S7, D147). `startLogin` opens the window and returns handles: `opened` (the window
 * is up), `confirm` / `cancel` (your answer, from whichever place), and `done` (the saved-and-checked result). The result is published (`auth.saved`, `auth.failed`) and a
 * recording that was waiting for a new login carries on (`loginSaved`).
 */

import type { Page } from "playwright";
import { loginSaved } from "../question-flow.ts";
import type { Runtime } from "../runtime.ts";
import type { ProjectHandle } from "../workdir/layout.ts";
import { type LoginResult, loginSession } from "./session.ts";

export interface LoginHandle {
  app: string;
  startedAt: number;
  opened: Promise<void>;
  confirm: () => void;
  cancel: () => void;
  done: Promise<LoginResult>;
}

/** Test seam: a headless window and a script that acts as the user. A real login is headed and has none. */
export interface LoginSeam {
  headed?: boolean;
  afterOpen?: (page: Page) => Promise<void>;
}

export function startLogin(rt: Runtime, p: ProjectHandle, seam: LoginSeam = {}): LoginHandle {
  if (rt.login) throw new Error("a login window is already open");
  const cfg = rt.getConfig();
  let confirmed!: () => void;
  let gaveUp!: (e: Error) => void;
  const waitForDone = new Promise<void>((res, rej) => {
    confirmed = res;
    gaveUp = rej;
  });
  waitForDone.catch(() => undefined);
  let open!: () => void;
  const opened = new Promise<void>((r) => {
    open = r;
  });
  const done = loginSession({
    root: cfg.root,
    app: p.app,
    headed: seam.headed ?? true,
    ...(seam.afterOpen ? { afterOpen: seam.afterOpen } : {}),
    viewport: { width: cfg.viewport.width, height: cfg.viewport.height },
    waitForDone,
    onOpened: () => {
      rt.bus.publish(
        "auth.opened",
        {
          app: p.app.slug,
          message: `login window open on ${p.app.baseUrl}: log in by hand, then say so`,
        },
        p.slug,
      );
      open();
    },
  }).then((r) => {
    rt.login = undefined;
    if (r.saved) loginSaved(rt, p.app.slug, p.app.name);
    else
      rt.bus.publish(
        "auth.failed",
        { app: p.app.slug, message: `login not saved: ${r.problem ?? "unknown reason"}` },
        p.slug,
      );
    return r;
  });
  done.catch(() => {
    rt.login = undefined;
  });
  const handle: LoginHandle = {
    app: p.app.slug,
    startedAt: Date.now(),
    opened,
    confirm: () => confirmed(),
    cancel: () => gaveUp(new Error("you cancelled the login")),
    done,
  };
  rt.login = handle;
  return handle;
}
