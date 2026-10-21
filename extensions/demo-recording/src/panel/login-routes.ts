/**
 * The Login card's routes (S7, D147): the same engine as `/demo login`.
 *
 *   GET  /api/login            the active app, its saved login's state (never its content), its own rule, whether a window is open
 *   POST /api/login-start      open the login window (headed) and wait until it is up
 *   POST /api/login-confirm    "I'm logged in": check the open window, save the state, check it in a fresh browser, answer with the result; when it is not good enough yet the window stays open and the answer says why (notYet)
 *   POST /api/login-check-live  look at the open login window now (nothing is closed or saved)
 *   POST /api/login-cancel     close the window without saving
 *   POST /api/login-check      look again now (a fresh headless browser with the saved login)
 *   POST /api/login-forget     forget the saved login
 *   POST /api/login-rule       the app's own check (a page, a text, a selector), or clear it
 */

import { startLogin } from "../auth/login-flow.ts";
import { forgetSession, hasState, probeSession, readMeta, setLoginRule } from "../auth/session.ts";
import type { Runtime } from "../runtime.ts";
import type { GetRoute, PostRoute } from "./server.ts";

export function loginRoutes(rt: Runtime): {
  get: Record<string, GetRoute>;
  post: Record<string, PostRoute>;
} {
  const root = () => rt.getConfig().root;
  const view = () => {
    const p = rt.activeProject();
    if (!p) return { project: null };
    return {
      project: p.slug,
      app: { slug: p.app.slug, name: p.app.name, baseUrl: p.app.baseUrl },
      rule: p.app.login ?? null,
      session: readMeta(root(), p.app.slug),
      windowOpen: !!rt.login && rt.login.app === p.app.slug,
    };
  };
  const text = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    get: { login: () => view() },
    post: {
      "login-start": async () => {
        const p = rt.requireProject();
        const h = startLogin(rt, p, rt.loginSeam);
        h.done.catch(() => undefined);
        await Promise.race([h.opened, h.done]);
        return view();
      },
      "login-confirm": async () => {
        const h = rt.login;
        if (!h) throw new Error("no login window is open");
        const notYet = h.nextNotYet();
        h.confirm();
        const r = await Promise.race([h.done, notYet]);
        if ("why" in r) return { saved: false, notYet: true, problem: r.why, ...view() };
        return {
          saved: r.saved,
          ...(r.problem ? { problem: r.problem } : {}),
          probe: r.probe,
          ...view(),
        };
      },
      "login-check-live": async () => {
        const h = rt.login;
        if (!h) throw new Error("no login window is open");
        const probe = await h.checkLive();
        return { probe, ...view() };
      },
      "login-cancel": async () => {
        const h = rt.login;
        if (!h) return view();
        h.cancel();
        await h.done.catch(() => undefined);
        return view();
      },
      "login-check": async () => {
        const p = rt.requireProject();
        if (!hasState(root(), p.app.slug)) throw new Error("there is no saved login to check");
        const probe = await probeSession({ root: root(), app: p.app });
        rt.bus.publish(
          "auth.checked",
          {
            app: p.app.slug,
            state: probe.state,
            message: `login for ${p.app.name}: ${probe.state} (${probe.reason})`,
          },
          p.slug,
        );
        return { probe, ...view() };
      },
      "login-forget": () => {
        const p = rt.requireProject();
        const had = forgetSession(root(), p.app.slug);
        if (had)
          rt.bus.publish(
            "auth.forgotten",
            { app: p.app.slug, message: `login forgotten for ${p.app.name}` },
            p.slug,
          );
        return { forgotten: had, ...view() };
      },
      "login-rule": (body) => {
        const p = rt.requireProject();
        const rule = {
          url: text(body.url),
          expectText: text(body.expectText),
          expectSelector: text(body.expectSelector),
        };
        if (rule.url) {
          try {
            new URL(rule.url, p.app.baseUrl);
          } catch {
            throw new Error(`"${rule.url}" is not an address`);
          }
        }
        setLoginRule(root(), p.app.slug, rule);
        rt.bus.publish(
          "auth.rule",
          { app: p.app.slug, message: `the app's own login check for ${p.app.name} was changed` },
          p.slug,
        );
        return view();
      },
    },
  };
}
