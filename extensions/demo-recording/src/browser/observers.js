// demo-recording page observers (S3). Injected with addInitScript; reports to
// the engine through the exposed binding `__demoRecReport(event)`.
//   route      — pushState / replaceState / popstate / hashchange
//   alert      — toasts, snackbars, role=alert/status, aria-live regions (with text)
//   idle-start / idle-end — a busy indicator (spinner, aria-busy, progressbar,
//                skeleton) is visible: dead time the editor prefers to cut
(() => {
  if (window.__demoRecObservers) return;
  window.__demoRecObservers = true;
  const report = (type, data) => {
    try {
      window.__demoRecReport?.({ type, at: performance.timeOrigin + performance.now(), data });
    } catch {}
  };

  // ---- routes
  const wrap = (name) => {
    const orig = history[name];
    history[name] = function (...args) {
      const r = orig.apply(this, args);
      report("route", { url: location.href, via: name });
      return r;
    };
  };
  wrap("pushState");
  wrap("replaceState");
  addEventListener("popstate", () => report("route", { url: location.href, via: "popstate" }));
  addEventListener("hashchange", () => report("route", { url: location.href, via: "hash" }));

  // ---- alerts / toasts
  const ALERT_SEL =
    '[role="alert"], [role="status"], [aria-live="assertive"], [class*="toast"], [class*="snackbar"], [class*="notification"], [class*="flash-message"]';
  const ERROR_HINT = /error|danger|fail|critical/i;
  const seen = new WeakSet();
  const inspect = (el) => {
    if (!(el instanceof Element) || seen.has(el)) return;
    if (el.closest("[data-demo-rec]")) return;
    const match = el.matches(ALERT_SEL) ? el : null;
    const nested = match ? [] : [...el.querySelectorAll(ALERT_SEL)];
    for (const node of match ? [match] : nested) {
      if (seen.has(node)) continue;
      seen.add(node);
      // Let the content render before reading it.
      setTimeout(() => {
        const text = (node.innerText || node.textContent || "")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 300);
        if (!text) return;
        const level =
          node.getAttribute("role") === "alert" ||
          ERROR_HINT.test(node.className || "") ||
          ERROR_HINT.test(text)
            ? "error"
            : "info";
        const r = node.getBoundingClientRect();
        report("alert", {
          text,
          level,
          role: node.getAttribute("role") || "",
          box: {
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            h: Math.round(r.height),
          },
        });
      }, 60);
    }
  };

  // ---- busy indicators
  const BUSY_SEL =
    '[aria-busy="true"], [role="progressbar"], [class*="spinner"], [class*="loading"], [class*="skeleton"], [class*="typing"]';
  let busy = false;
  const visible = (el) => {
    if (el.closest("[data-demo-rec]")) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05;
  };
  // A busy region whose text GROWS is content arriving (a streamed chat answer),
  // not dead time (a spinner). Track text length of busy elements and their
  // containers while busy; report the growth at idle-end.
  let textAtStart = 0;
  let textMax = 0;
  const busyText = (els) =>
    els.reduce(
      (n, el) =>
        n +
        ((el.closest("li, article, section, [role=log], [aria-live]") || el).innerText || "")
          .length,
      0,
    );
  const checkBusy = () => {
    const els = [...document.querySelectorAll(BUSY_SEL)].filter(visible);
    const now = els.length > 0;
    if (now) {
      const len = busyText(els);
      if (!busy) textAtStart = len;
      textMax = Math.max(textMax, len);
    }
    if (now !== busy) {
      busy = now;
      if (now) report("idle-start", { reason: "busy-indicator" });
      else {
        report("idle-end", {
          reason: "busy-indicator",
          textGrowth: Math.max(0, textMax - textAtStart),
        });
        textMax = 0;
      }
    }
  };

  const start = () => {
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) inspect(n);
        if (m.type === "attributes" && m.target instanceof Element) inspect(m.target);
      }
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["role", "class"],
    });
    for (const el of document.querySelectorAll(ALERT_SEL)) seen.add(el); // pre-existing banners aren't events
    setInterval(checkBusy, 100);
    checkBusy();
  };
  if (document.documentElement) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
