// The Login card on the Project page (S7, D147): the state of the app's saved login, and the ways to change it. The same engine as `/demo login`.
import { html, useEffect, useState } from "/vendor/preact-htm.module.js";
import { post, useApi } from "./core.js";
import { confirmAsk, errorToast, toast } from "./dialog.js";
import { ACTION_LABEL, SESSION_STORAGE_NOTE, loginView } from "./login-core.js";

export function LoginCard({ events }) {
  const { data, reload } = useApi("/api/login", events, /^(auth|project)\./);
  const [busy, setBusy] = useState(null);
  const [rule, setRule] = useState({ url: "", expectText: "", expectSelector: "" });
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setRule({
      url: data?.rule?.url ?? "",
      expectText: data?.rule?.expectText ?? "",
      expectSelector: data?.rule?.expectSelector ?? "",
    });
  }, [data?.rule?.url, data?.rule?.expectText, data?.rule?.expectSelector, data?.project]);
  const v = loginView(data);
  if (!v) return null;
  const run = async (what, fn) => {
    setBusy(what);
    try {
      await fn();
    } catch (e) {
      errorToast(e, "login");
    } finally {
      setBusy(null);
      reload();
    }
  };
  const act = {
    start: () => run("start", () => post("/api/login-start", {})),
    confirm: () =>
      run("confirm", async () => {
        const r = await post("/api/login-confirm", {});
        if (r.saved)
          toast(`login saved for ${v.app}: a fresh browser with it is logged in`, { kind: "ok" });
        else toast(`not saved: ${r.problem}`, { kind: "error" });
      }),
    cancel: () => run("cancel", () => post("/api/login-cancel", {})),
    check: () =>
      run("check", async () => {
        const r = await post("/api/login-check", {});
        toast(`login for ${v.app}: ${r.probe.state} (${r.probe.reason})`, {
          kind: r.probe.state === "valid" ? "ok" : "info",
        });
      }),
    forget: async () => {
      if (
        await confirmAsk({
          title: `Forget the saved login for ${v.app}?`,
          text: "The saved session is deleted. Discovery and recordings of an app that needs a login stop until you log in again.",
          confirmLabel: "Forget it",
          danger: true,
        })
      )
        run("forget", () => post("/api/login-forget", {}));
    },
  };
  const saveRule = () => run("rule", () => post("/api/login-rule", rule));
  return html`<section class="card ds-login" aria-label="Login" data-login-state=${data.windowOpen ? "window" : (data.session?.state ?? "none")}>
    <div class="ds-row-flex">
      <span class="ds-status" data-tone=${v.tone === "neutral" ? undefined : v.tone} aria-hidden="true">${v.icon}</span>
      <strong>Login for ${v.app}: ${v.title}</strong>
      <span class="ds-grow"></span>
      ${v.actions.map((a, i) => html`<button class=${`ds-btn ds-btn--sm ${i === 0 ? "ds-btn--primary" : ""}`} type="button" key=${a} data-act=${`login-${a}`} aria-busy=${busy === a ? "true" : undefined} disabled=${!!busy} onClick=${act[a]}>${ACTION_LABEL[a]}</button>`)}
    </div>
    <p class="ds-small ds-muted" data-login-text>${v.text}</p>
    <details class="ds-small" open=${open} onToggle=${(e) => setOpen(e.currentTarget.open)}>
      <summary>The app's own check (optional)</summary>
      <div class="ds-stack">
        <p class="ds-muted">By default a session counts as gone when the app lands on a login-looking address or shows a password field. If that is wrong for this app, say what proves you are logged in.</p>
        <label class="ds-field"><span class="ds-label">Page to open (default: the start page)</span><input class="ds-input" data-rule="url" placeholder="/dashboard" value=${rule.url} onInput=${(e) => setRule({ ...rule, url: e.target.value })} /></label>
        <label class="ds-field"><span class="ds-label">A text that is only there when you are logged in</span><input class="ds-input" data-rule="text" placeholder="Sign out" value=${rule.expectText} onInput=${(e) => setRule({ ...rule, expectText: e.target.value })} /></label>
        <label class="ds-field"><span class="ds-label">or a CSS selector that is only there when you are logged in</span><input class="ds-input" data-rule="selector" placeholder="[data-user-menu]" value=${rule.expectSelector} onInput=${(e) => setRule({ ...rule, expectSelector: e.target.value })} /></label>
        <div class="ds-row-flex"><button class="ds-btn ds-btn--sm" type="button" data-act="login-rule-save" disabled=${!!busy} onClick=${saveRule}>Save the check</button><span class="ds-muted">Leave all three empty to go back to the default.</span></div>
        <p class="ds-muted">${SESSION_STORAGE_NOTE}</p>
      </div>
    </details>
  </section>`;
}
