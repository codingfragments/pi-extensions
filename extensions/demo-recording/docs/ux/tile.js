// Showcase page behaviour (UX0): theme toggle, live contrast ratios, live dialogs and toasts.
(() => {
  const rgb = (hex) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const lum = (hex) => {
    const [r, g, b] = rgb(hex);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const ratio = (a, b) => {
    const x = lum(a);
    const y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function paint() {
    for (const el of document.querySelectorAll("[data-fg][data-bg]")) {
      const fg = token(el.dataset.fg);
      const bg = token(el.dataset.bg);
      el.style.background = `var(${el.dataset.bg})`;
      el.style.color = `var(${el.dataset.fg})`;
      if (!/^#[0-9a-f]{6}$/i.test(fg) || !/^#[0-9a-f]{6}$/i.test(bg)) continue;
      const r = ratio(fg, bg);
      const need = Number(el.dataset.min ?? 4.5);
      const out = el.querySelector(".tile-ratio");
      if (out) out.textContent = `${r >= need ? "✓" : "✗"} ${r.toFixed(2)}:1 (≥ ${need})`;
    }
    for (const el of document.querySelectorAll("[data-swatch]")) {
      const v = token(el.dataset.swatch);
      el.querySelector(".tile-chip").style.background = `var(${el.dataset.swatch})`;
      el.querySelector("code").textContent = `${el.dataset.swatch} ${v}`;
    }
  }

  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-theme-toggle]");
    if (t) {
      DSShell.toggleTheme();
      paint();
    }
    const open = e.target.closest("[data-open]");
    if (open) document.getElementById(open.dataset.open).showModal();
    const close = e.target.closest("[data-close]");
    if (close) close.closest("dialog").close();
    if (e.target.closest("[data-toast]")) {
      const tone = e.target.closest("[data-toast]").dataset.toast;
      const host = document.getElementById("live-toasts");
      host.insertAdjacentHTML(
        "beforeend",
        `<div class="ds-toast" data-tone="${tone}" role="${tone === "err" ? "alert" : "status"}"><span class="ds-status" data-tone="${tone}" aria-hidden="true">${tone === "err" ? "!" : "✓"}</span><div class="ds-grow"><strong>${tone === "err" ? "Could not save the config" : "Draft saved"}</strong><p class="ds-muted">${tone === "err" ? "config.json is read-only. Copy the details to report it." : "Saved just now."}</p></div>${tone === "err" ? '<button class="ds-btn ds-btn--sm" type="button">Copy</button>' : ""}<button class="ds-btn ds-btn--ghost ds-btn--icon ds-btn--sm" type="button" aria-label="Dismiss" data-dismiss>×</button></div>`,
      );
    }
    if (e.target.closest("[data-dismiss]")) e.target.closest(".ds-toast").remove();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "/" && !/input|textarea|select/i.test(document.activeElement?.tagName ?? "")) {
      e.preventDefault();
      document.getElementById("tile-search")?.focus();
    }
  });
  DSShell.applyTheme();
  paint();
})();
