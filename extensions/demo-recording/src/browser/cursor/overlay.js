// demo-recording virtual cursor (D1). Injected with addInitScript into every
// document. It FOLLOWS real dispatched mouse events (page.mouse → CDP → DOM
// mousemove), so anything that moves the mouse is visible in the capture, and
// hover states fire naturally. pointer-events:none keeps it out of hit-testing.
//
// - cursor style (arrow / hand / I-beam) mirrors the computed `cursor` value of
//   the element under the pointer
// - click ripple on mousedown
// - position persists in sessionStorage across full navigations
// - re-attaches itself if a framework wipes <html> children
(() => {
  if (window.__demoRecCursor) return;
  const ID = "__demo_rec_cursor";
  const KEY = "__demo_rec_cursor_pos";
  const SIZE = 26;

  const SHAPES = {
    arrow: {
      hot: [3, 2],
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26"><path d="M3 2 L3 21 L8 16.5 L11.5 24 L15 22.5 L11.6 15.2 L18.5 15.2 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    },
    hand: {
      hot: [9, 2],
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26"><path d="M8 13 V4.5 a1.8 1.8 0 0 1 3.6 0 V11 a1.8 1.8 0 0 1 3.6 0 V12 a1.8 1.8 0 0 1 3.6 0 V13 a1.8 1.8 0 0 1 3.6 0 V18 c0 3.5 -2.5 6 -6 6 h-2.5 c-2.2 0 -3.6 -1 -4.8 -2.6 L3.6 16.6 a1.8 1.8 0 0 1 2.8 -2.3 Z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    },
    text: {
      hot: [13, 13],
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26"><path d="M9 4 h3 l1 1 l1 -1 h3 M13 5 V21 M9 22 h3 l1 -1 l1 1 h3" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/><path d="M9 4 h3 l1 1 l1 -1 h3 M13 5 V21 M9 22 h3 l1 -1 l1 1 h3" fill="none" stroke="#111" stroke-width="1.6" stroke-linecap="round"/></svg>',
    },
  };

  let pos = { x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) };
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) || "null");
    if (saved && typeof saved.x === "number") pos = saved;
  } catch {}
  let shape = "arrow";
  let el = null;
  let hidden = false;

  function ensure() {
    if (el?.isConnected) return el;
    const root = document.documentElement;
    if (!root) return null;
    el = document.createElement("div");
    el.id = ID;
    el.setAttribute("data-demo-rec", "cursor");
    el.setAttribute("aria-hidden", "true");
    el.style.cssText = `position:fixed;left:0;top:0;width:${SIZE}px;height:${SIZE}px;z-index:2147483647;pointer-events:none;will-change:transform;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.35));`;
    root.appendChild(el);
    paintShape();
    paintPos();
    return el;
  }

  function paintShape() {
    if (el) el.innerHTML = SHAPES[shape].svg;
  }

  function paintPos() {
    if (!el) return;
    const [hx, hy] = SHAPES[shape].hot;
    el.style.transform = `translate(${pos.x - hx}px, ${pos.y - hy}px)`;
    el.style.display = hidden ? "none" : "block";
  }

  function shapeFor(target) {
    if (!(target instanceof Element)) return "arrow";
    const c = getComputedStyle(target).cursor;
    if (c === "pointer") return "hand";
    if (c === "text" || c === "vertical-text") return "text";
    if (c === "auto") {
      // Browsers show an I-beam over editable text and selectable text by default.
      if (
        target.matches(
          'input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]), textarea, [contenteditable=""], [contenteditable=true]',
        )
      )
        return "text";
      if (target.closest("a[href], button, [role=button], summary, label[for]")) return "hand";
    }
    return "arrow";
  }

  let saveTimer = 0;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        sessionStorage.setItem(KEY, JSON.stringify(pos));
      } catch {}
    }, 100);
  }

  function ripple() {
    const root = document.documentElement;
    if (!root) return;
    const r = document.createElement("div");
    r.setAttribute("data-demo-rec", "ripple");
    r.setAttribute("aria-hidden", "true");
    r.style.cssText = `position:fixed;left:${pos.x - 18}px;top:${pos.y - 18}px;width:36px;height:36px;border-radius:50%;z-index:2147483646;pointer-events:none;background:rgba(79,70,229,.28);border:2px solid rgba(79,70,229,.55);transform:scale(.3);opacity:1;transition:transform .42s cubic-bezier(.2,.7,.3,1),opacity .42s ease-out;`;
    root.appendChild(r);
    requestAnimationFrame(() => {
      r.style.transform = "scale(1.25)";
      r.style.opacity = "0";
    });
    setTimeout(() => r.remove(), 520);
  }

  // Planned moves are animated HERE, on requestAnimationFrame — the same clock
  // the compositor (and therefore the screencast) paints on. Following CDP
  // mousemove deliveries instead makes the cursor judder: their arrival jitters
  // by several ms, which shows up as uneven per-frame steps in the video.
  let anim = null; // { start, samples: [[t, x, y], ...] }
  const step = (ts) => {
    if (!anim) return;
    const s = anim.samples;
    const t = ts - anim.start;
    const last = s[s.length - 1];
    if (t >= last[0]) {
      pos = { x: last[1], y: last[2] };
      anim = null;
      paintPos();
      save();
      return;
    }
    let i = anim.i || 0;
    while (i + 1 < s.length && s[i + 1][0] <= t) i++;
    anim.i = i;
    const a = s[i];
    const b = s[Math.min(i + 1, s.length - 1)];
    const f = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0;
    pos = { x: a[1] + (b[1] - a[1]) * f, y: a[2] + (b[2] - a[2]) * f };
    paintPos();
    requestAnimationFrame(step);
  };

  document.addEventListener(
    "mousemove",
    (e) => {
      if (!ensure()) return;
      // Shape always follows the real pointer target; position only when no
      // planned animation owns it.
      const next = shapeFor(e.target);
      if (next !== shape) {
        shape = next;
        paintShape();
      }
      if (anim) return;
      pos = { x: e.clientX, y: e.clientY };
      paintPos();
      save();
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    "mousedown",
    () => {
      ensure();
      ripple();
    },
    { capture: true, passive: true },
  );

  const attach = () => {
    ensure();
    new MutationObserver(() => {
      if (!el?.isConnected) ensure();
    }).observe(document.documentElement, { childList: true });
  };
  if (document.documentElement) attach();
  else document.addEventListener("DOMContentLoaded", attach, { once: true });

  window.__demoRecCursor = {
    get pos() {
      return { ...pos };
    },
    get shape() {
      return shape;
    },
    hide() {
      hidden = true;
      paintPos();
    },
    show() {
      hidden = false;
      paintPos();
    },
    /** Play a planned trajectory: samples = [[ms, x, y], ...] starting now. */
    animate(samples) {
      if (!Array.isArray(samples) || samples.length < 2) return false;
      ensure();
      anim = { start: performance.now(), samples, i: 0 };
      requestAnimationFrame(step);
      return true;
    },
  };
})();
