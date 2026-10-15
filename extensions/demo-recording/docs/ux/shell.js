// Frame builder for the UX0 mock screens: header, stepper, next-action band, status strip,
// Activity drawer. Reads data-* attributes from <body>. Throw-away prototype code: UX2 builds the real one.

(() => {
  const STAGES = [
    ["storyboard", "Storyboard"],
    ["recording", "Recording"],
    ["vo", "Voice over"],
    ["annotations", "Annotations"],
    ["render", "Render"],
  ];
  const GLYPH = { complete: "✓", needs: "●", running: "▶", blocked: "!", upcoming: "○" };
  const WORDS = {
    complete: "complete",
    needs: "needs you",
    running: "running",
    blocked: "blocked",
    upcoming: "not started",
  };
  const esc = (s) =>
    String(s).replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
    );

  const THEME_KEY = "demo-rec-theme";
  function applyTheme() {
    const wanted =
      new URLSearchParams(location.search).get("theme") ?? localStorage.getItem(THEME_KEY);
    document.documentElement.dataset.theme = wanted === "latte" ? "latte" : "macchiato";
  }
  function toggleTheme() {
    const next = document.documentElement.dataset.theme === "latte" ? "macchiato" : "latte";
    document.documentElement.dataset.theme = next;
    localStorage.setItem(THEME_KEY, next);
    return next;
  }
  applyTheme();

  function buildFrame() {
    const d = document.body.dataset;
    const current = d.stage;
    const states = (d.steps ?? "").split(",");
    const steps = STAGES.map(([id, label], i) => {
      const st = states[i] || "upcoming";
      const here = id === current;
      return `<li><a class="ds-step" href="#/${id}" data-state="${st}" ${here ? 'aria-current="step"' : ""} title="${label}: ${WORDS[st]}">
      <span class="ds-step-dot" aria-hidden="true">${GLYPH[st]}</span><span class="ds-step-label">${label}</span><span class="ds-sr-only"> — ${WORDS[st]}</span></a></li>`;
    }).join("");
    const next = d.nextText
      ? `<div class="ds-next" data-tone="${d.nextTone ?? "needs"}" role="region" aria-label="Next step">
        <span class="ds-status" data-tone="accent" aria-hidden="true">●</span>
        <span class="ds-next-label">${esc(d.nextLabel ?? "Needs you")}</span>
        <span class="ds-next-text">${esc(d.nextText)}</span>
        <span class="ds-grow"></span>
        ${d.nextMore ? `<a class="ds-small" href="#">${esc(d.nextMore)}</a>` : ""}
        ${d.nextAction ? `<button class="ds-btn ds-btn--primary" type="button">${esc(d.nextAction)}</button>` : ""}
      </div>`
      : "";
    const tone = d.stripTone ?? "idle";
    const strip = `<div class="ds-strip" data-tone="${tone}" role="status" aria-live="polite">
      <span class="ds-status" data-tone="${tone === "err" ? "err" : tone === "running" ? "info" : "ok"}" aria-hidden="true">${tone === "err" ? "!" : tone === "running" ? "▶" : "✓"}</span>
      <span>${esc(d.stripText ?? "Nothing running")}</span>
      ${d.stripProgress ? `<span class="ds-progress" role="progressbar" aria-valuenow="${d.stripProgress}" aria-valuemin="0" aria-valuemax="100"><span style="inline-size:${d.stripProgress}%"></span></span><span class="ds-muted ds-xs">${d.stripProgress}%</span>` : ""}
      ${tone === "err" ? `<a href="#" class="ds-small">Show error</a>` : ""}
      <span class="ds-grow"></span>
      <span class="ds-muted ds-xs"><span class="ds-status" data-tone="ok" aria-hidden="true">●</span> connected</span>
      <button class="ds-btn ds-btn--sm" type="button" data-act="drawer" aria-expanded="${d.drawer === "open"}" aria-controls="activity">Activity ↑</button>
    </div>`;
    const drawer = `<aside class="ds-drawer" id="activity" aria-label="Activity" ${d.drawer === "open" ? "" : "hidden"}>
      <div class="ds-drawer-head"><h2>Activity</h2><span class="ds-grow"></span><button class="ds-btn ds-btn--ghost ds-btn--icon" type="button" data-act="drawer" aria-label="Close activity">×</button></div>
      <div class="ds-drawer-body">
        <section class="ds-stack" aria-label="Running jobs">
          <h3>Running</h3>
          <div class="ds-card"><div class="ds-card-head"><span class="ds-status" data-tone="info" aria-hidden="true">▶</span><strong>Rendering draft</strong><span class="ds-grow"></span><span class="ds-muted ds-small">3 of 6 scenes</span></div>
            <div class="ds-progress" style="inline-size:100%" role="progressbar" aria-valuenow="50" aria-valuemin="0" aria-valuemax="100"><span style="inline-size:50%"></span></div></div>
        </section>
        <section class="ds-stack" aria-label="Preview"><h3>Preview</h3>
          <div class="ds-footage" role="img" aria-label="Latest frame of the draft render"><div class="ds-footage-bar"><i></i><i></i><i></i></div><div class="ds-footage-body"><span></span><span class="ds-hot"></span><span></span></div><span class="ds-footage-time">0:41</span></div></section>
        <section class="ds-stack" aria-label="Log"><div class="ds-row-flex"><h3>Log</h3><span class="ds-grow"></span><button class="ds-btn ds-btn--sm" type="button">Full log</button><button class="ds-btn ds-btn--sm ds-btn--ghost" type="button">Copy</button></div>
          <ul class="ds-log"><li><time>12:41:07</time><span>render started · draft · annotations v4</span></li><li><time>12:41:09</time><span>scene 1 of 6 · 2.1 s</span></li><li><time>12:41:12</time><span>scene 2 of 6 · 3.0 s</span></li><li><time>12:41:15</time><span>scene 3 of 6 · 2.8 s</span></li></ul></section>
      </div></aside>`;
    const head = `<div class="ds-hwrap"><header class="ds-header">
      <span class="ds-brand">${esc(d.project ?? "Keycraft")} <span class="ds-brand-sub ds-muted ds-small">· demo-recording</span></span>
      <a class="ds-step" href="#/project" ${current === "project" ? 'aria-current="step"' : ""} data-state="complete"><span class="ds-step-dot" aria-hidden="true">✓</span><span class="ds-step-label">Project</span></a>
      <nav aria-label="Production stages" style="flex:1;min-inline-size:0"><ol class="ds-steps">${steps}</ol></nav>
      <span class="ds-header-tools">
        <button class="ds-btn ds-btn--ghost" type="button" data-act="map">◇ Map</button>
        <button class="ds-btn ds-btn--ghost" type="button" ${current === "config" ? 'aria-current="page"' : ""}>⚙ Config</button>
        <button class="ds-btn ds-btn--ghost" type="button" data-act="theme" aria-label="Switch theme">◐ Theme</button>
      </span></header>${next}</div>`;
    const main = document.querySelector("main");
    main.insertAdjacentHTML("beforebegin", head);
    document.body.insertAdjacentHTML("beforeend", strip + drawer);
    document.body.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "theme") toggleTheme();
      if (act === "drawer") {
        const el = document.getElementById("activity");
        el.hidden = !el.hidden;
        for (const b of document.querySelectorAll('[data-act="drawer"][aria-controls]'))
          b.setAttribute("aria-expanded", String(!el.hidden));
      }
      if (act === "map") location.href = `map.html${location.search}`;
    });
    document.addEventListener("keydown", (e) => {
      const el = document.getElementById("activity");
      if (e.key === "Escape" && !el.hidden && !document.querySelector("dialog[open]"))
        el.hidden = true;
    });
  }

  window.DSShell = { buildFrame, applyTheme, toggleTheme };
})();
