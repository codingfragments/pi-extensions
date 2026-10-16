// The project map (UX4b, D100, D112, D119): a large overlay over whichever screen is current, showing
// every version of every stage as a connected graph grouped by stage. The model (what is shown, the
// layout, the keyboard) is in graph-model.js; this file draws it.
//
// It is part of the route (`#/map?view=&q=&sel=&focus=&open=`): Escape and Back close it, a reload brings
// it back, and "Open in <screen>" navigates to the exact version while the map stays one Back away.
// Looking, filtering and focusing never change the production line.
import {
  html,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "/vendor/preact-htm.module.js";
import { useApi } from "./core.js";
import {
  MAP_VIEWS,
  STAGE_NAME,
  detailsOf,
  hiddenSelection,
  indexGraph,
  layoutMap,
  mapQueryFromState,
  mapStateFromRoute,
  neighbour,
  outlineOf,
  readMapMemory,
  visibleNodes,
  writeMapMemory,
} from "./graph-model.js";
import { formatRoute } from "./route.js";
import { HISTORY_EVENTS } from "./version-ui.js";

const ZOOM_MIN = 0.3;
const ZOOM_MAX = 1.6;
const ZOOM_STEP = 1.2;
const VIEW_LABEL = { all: "All paths", approved: "Approved paths", line: "Production line" };
const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])';
const mb = (n) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;

/** Escape in the search clears it first; the next Escape closes the map. */
function clearOnEscape(e) {
  if (e.key !== "Escape" || !e.currentTarget.value) return;
  e.preventDefault();
  e.stopPropagation();
  e.currentTarget.value = "";
  e.currentTarget.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The badges of a node: an icon and a word each, never colour alone. */
function Badges({ n }) {
  const out = [];
  const add = (tone, ico, label) =>
    out.push(
      html`<span class="ds-badge" data-tone=${tone} key=${label}><span class="ds-badge-ico" aria-hidden="true">${ico}</span>${label}</span>`,
    );
  if (n.kind === "version" || n.kind === "drafts") {
    if (n.inLine) add("accent", "▶", "In production line");
    if (n.blocked) add("err", "!", "Blocked by dependency");
    if (n.unknownLink) add("err", "?", "Link unknown");
    if (n.review === "waiting") add("warn", "●", "Waiting for review");
    if (n.availability === "deleted") add("warn", "!", "Files deleted");
    if (n.availability === "pruned") add("neutral", "–", "Files pruned");
    if (n.draft && n.kind === "version" && n.stage !== "render")
      add("neutral", "✎", "Draft version");
    if (n.stage === "render" && n.render?.kind === "draft" && n.kind === "version")
      add("neutral", "✎", "Draft render");
    if (n.stage === "render" && n.render?.kind === "final" && !n.approved)
      add("neutral", "·", "Final render");
  }
  return out.length ? html`<span class="ds-node-badges">${out}</span>` : null;
}

function nodeLabel(n) {
  const bits = [n.label, n.meta];
  if (n.approved && !n.blocked) bits.push("approved");
  if (n.inLine) bits.push("in production line");
  if (n.blocked) bits.push(`blocked by dependency: ${n.blocked}`);
  if (n.draft && n.kind === "version") bits.push("draft");
  if (n.review === "waiting") bits.push("waiting for review");
  if (n.unknownLink) bits.push(`link unknown: ${n.unknownLink}`);
  if (n.availability !== "present") bits.push(`files ${n.availability}`);
  return bits.filter(Boolean).join(", ");
}

function RenderFiles({ version, events }) {
  const { data } = useApi("/api/renders", events, /^(render|edit)\./);
  const r = data?.renders?.find((x) => x.version === version);
  if (!r) return null;
  if (!r.variants.length) return html`<p class="ds-small ds-muted">No variants yet.</p>`;
  return html`<div class="ds-stack" aria-label="Variants and files">
    <h4>Variants and files</h4>
    ${r.variants.map((v) => {
      const files = Object.entries(v.sizes ?? {});
      return html`<details key=${v.key} class="ds-small">
        <summary><strong>${v.key}</strong> · ${mb(v.bytes ?? 0)}${v.present ? "" : " · files removed"}</summary>
        ${files.length ? html`<ul class="ds-checklist ds-mono">${files.map(([name, size]) => html`<li key=${name}>${name} <span class="ds-muted">${mb(size)}</span></li>`)}</ul>` : html`<p class="ds-muted">No files on disk.</p>`}
      </details>`;
    })}
  </div>`;
}

function Outline({ tree, sel, onPick }) {
  if (!tree.length)
    return html`<p class="ds-small ds-muted" style="padding:var(--space-3)">Nothing is shown.</p>`;
  const list = (items) =>
    html`<ul>${items.map(
      (t) => html`<li key=${t.node.id}>
      <button type="button" data-id=${t.node.id} aria-current=${sel === t.node.id ? "true" : undefined} data-dim=${t.node.dim ? "true" : undefined} onClick=${() => onPick(t.node.id)}>
        ${t.node.label} <span class="ds-muted ds-xs">${t.node.meta}</span>
      </button>${t.children.length ? list(t.children) : null}</li>`,
    )}</ul>`;
  return list(tree);
}

/**
 * The overlay. `route` is the parsed `#/map…` route; `go` changes it (replace for filters, so Back closes
 * the map instead of stepping through them); `onClose` leaves the map; `slug` keys the remembered view.
 */
export function ProjectMap({ route, go, slug, events, onClose }) {
  const { data } = useApi("/api/graph", events, HISTORY_EVENTS);
  const [snap, setSnap] = useState(null);
  useEffect(() => {
    if (data?.project && snap === null) setSnap(data);
  }, [data]);
  const changed = !!snap && !!data?.project && data.rev !== snap.rev;
  const g = snap;
  const ix = useMemo(() => (g ? indexGraph(g) : null), [g]);
  const st = useMemo(() => mapStateFromRoute(route), [route.raw]);
  const box = useRef(null);
  const canvas = useRef(null);
  const search = useRef(null);
  const [width, setWidth] = useState(1000);
  const [qText, setQText] = useState(st.q);
  // zoom: the whole graph in one look (Fit), or closer. A view setting, not part of the address.
  const [zoom, setZoom] = useState(1);
  const keysApi = useRef({});
  useEffect(() => setQText(st.q), [st.q]);

  const update = useCallback(
    (next) => {
      const s = { ...st, ...next };
      if (!s.sel) s.focus = false;
      writeMapMemory(slug, s);
      go({ screen: "map", query: mapQueryFromState(s) }, { replace: true });
    },
    [st, go, slug],
  );
  // opening the map from the header applies the view that was left; an explicit route wins
  useEffect(() => {
    if (Object.keys(route.query).length) return;
    const m = readMapMemory(slug);
    if (m && (m.view !== "all" || m.open.size))
      go(
        { screen: "map", query: mapQueryFromState({ ...st, view: m.view, open: m.open }) },
        { replace: true },
      );
  }, []);
  // whatever view is on screen (from a link, too) is the one remembered for next time
  useEffect(() => writeMapMemory(slug, st), [slug, st.view, [...st.open].join(",")]);
  // typing in the search updates the route a moment later
  useEffect(() => {
    if (qText === st.q) return;
    const t = setTimeout(() => update({ q: qText }), 150);
    return () => clearTimeout(t);
  }, [qText]);

  const vis = useMemo(() => (g && ix ? visibleNodes(g, ix, st) : null), [g, ix, route.raw]);
  // nodes that draw taller than the default (wrapped badges and titles) are measured, then laid out again
  const [heights, setHeights] = useState({ width: 0, map: new Map() });
  const measured = heights.width === width ? heights.map : undefined;
  const layout = useMemo(
    () => (g && ix && vis ? layoutMap(g, ix, vis.items, width, measured) : null),
    [g, ix, vis, width, measured],
  );
  useLayoutEffect(() => {
    if (!layout || !canvas.current) return;
    const map = new Map(measured ?? []);
    let again = false;
    // CSS zoom scales what getBoundingClientRect reports: measure in the layout's own units, whatever the zoom
    const stage = canvas.current.querySelector(".ds-map-stage");
    const scale = stage && layout.width ? stage.getBoundingClientRect().width / layout.width : 1;
    for (const el of canvas.current.querySelectorAll(".ds-node")) {
      const h = Math.ceil(el.getBoundingClientRect().height / (scale > 0 ? scale : 1) - 0.01);
      const n = layout.nodes.find((x) => x.id === el.dataset.id);
      if (n && h > n.h + 1) {
        map.set(n.id, h);
        again = true;
      }
    }
    if (again) setHeights({ width, map });
  }, [layout]);
  const tree = useMemo(() => (ix && vis ? outlineOf(ix, vis.items) : []), [ix, vis]);
  const details = useMemo(
    () => (g && ix && st.sel ? detailsOf(g, ix, st.sel) : null),
    [g, ix, st.sel],
  );
  const lost = useMemo(
    () => (g && ix && vis ? hiddenSelection(g, ix, st, vis.items) : null),
    [g, ix, vis, route.raw],
  );

  // measure the canvas, so the columns share the width
  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const measure = () =>
      setWidth((w) => (Math.abs(w - el.clientWidth) < 2 ? w : el.clientWidth || 1000));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [!!g]);

  // a modal layer: the page behind is inert, focus goes in and comes back, Tab stays inside
  useLayoutEffect(() => {
    const opener = document.activeElement;
    const behind = [...document.querySelectorAll("#app > *")].filter(
      (e) => !e.classList.contains("ds-overlay"),
    );
    for (const e of behind) e.inert = true;
    box.current?.focus();
    const onKey = (e) => {
      if (document.querySelector(".modal-backdrop")) return; // a dialog on top takes the key first
      const el = box.current;
      if (e.key === "Escape") {
        if (e.target === search.current && search.current.value) return; // clears the search first
        e.stopPropagation();
        onClose();
      } else if (e.key === "Tab" && el) {
        const items = [...el.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null);
        if (!items.length) return;
        const [first, last] = [items[0], items.at(-1)];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      } else if (
        ["+", "=", "-", "_", "0"].includes(e.key) &&
        !e.ctrlKey &&
        !e.metaKey &&
        !/input|textarea|select/i.test(document.activeElement?.tagName ?? "")
      ) {
        e.preventDefault();
        if (e.key === "0") keysApi.current.fit?.();
        else keysApi.current.zoomBy?.(e.key === "-" || e.key === "_" ? 1 / ZOOM_STEP : ZOOM_STEP);
      } else if (
        e.key === "/" &&
        !/input|textarea|select/i.test(document.activeElement?.tagName ?? "")
      ) {
        e.preventDefault();
        search.current?.focus();
        search.current?.select();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      for (const e of behind) e.inert = false;
      const back =
        opener && document.contains(opener) && opener !== document.body
          ? opener
          : document.querySelector(".map-link");
      back?.focus();
    };
  }, []);

  const select = (id) => update({ sel: id });
  const pick = (id) => {
    const n = ix?.byId.get(id);
    if (!n) return;
    if (n.kind === "drafts") {
      const open = new Set(st.open);
      open.has(id) ? open.delete(id) : open.add(id);
      update({ sel: id, open });
    } else select(id);
  };
  const onNode = (e) => {
    const id = e.currentTarget.dataset.id;
    if (id.startsWith("more:")) {
      const open = new Set(st.open);
      const gid = id.slice(5);
      open.delete(gid);
      open.add(`${gid}*`);
      update({ open });
    } else pick(id);
  };
  const onKeyNode = (e) => {
    if (!layout || !ix) return;
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    const next = neighbour(ix, layout, e.currentTarget.dataset.id, e.key);
    if (!next) return;
    e.preventDefault();
    refocus.current = next;
    select(next);
  };
  const clampZoom = (z) => Math.round(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z)) * 100) / 100;
  // zooming keeps what is in the middle of the view in the middle of the view
  const anchor = useRef(null);
  const zoomNow = useRef(zoom); // the zoom as of the last request, so quick repeats (a held key) add up
  zoomNow.current = zoom;
  const zoomBy = (f) => {
    const c = canvas.current;
    const z1 = zoomNow.current;
    const z2 = clampZoom(z1 * f);
    if (c && z2 !== z1 && !anchor.current)
      anchor.current = {
        x: (c.scrollLeft + c.clientWidth / 2) / z1,
        y: (c.scrollTop + c.clientHeight / 2) / z1,
      };
    zoomNow.current = z2;
    setZoom(z2);
  };
  useLayoutEffect(() => {
    const c = canvas.current;
    const a = anchor.current;
    anchor.current = null;
    if (!c || !a) return;
    c.scrollTo({
      left: Math.max(0, a.x * zoom - c.clientWidth / 2),
      top: Math.max(0, a.y * zoom - c.clientHeight / 2),
      behavior: "auto",
    });
  }, [zoom]);
  const fit = () => {
    const c = canvas.current;
    if (!c || !layout) return;
    const z = Math.min(
      1,
      (c.clientWidth - 16) / (layout.width + 8),
      (c.clientHeight - 16) / (layout.height + 44),
    );
    setZoom(clampZoom(z));
    c.scrollTo({ top: 0, left: 0 });
  };
  keysApi.current = { zoomBy, fit };
  const reset = () => {
    setZoom(1);
    setQText("");
    update({ view: "all", q: "", focus: false, open: new Set() });
  };

  // after an arrow key the focus follows the selection, once the new state is drawn
  const refocus = useRef(null);
  useLayoutEffect(() => {
    if (refocus.current && refocus.current === st.sel) {
      box.current?.querySelector(`.ds-node[data-id="${CSS.escape(st.sel)}"]`)?.focus();
      refocus.current = null;
    }
  }, [st.sel, layout]);
  const sel = details?.node;
  const selNode = sel && layout?.nodes.find((n) => n.id === sel.id);
  useEffect(() => {
    if (selNode && canvas.current) {
      const c = canvas.current;
      const y = selNode.y * zoom;
      if (y < c.scrollTop || y + selNode.h * zoom > c.scrollTop + c.clientHeight)
        c.scrollTo({ top: Math.max(0, y - 40), behavior: "auto" });
    }
  }, [st.sel]);
  // pinch / Ctrl + wheel on the graph zooms it (a plain wheel still scrolls)
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const onWheel = (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      keysApi.current.zoomBy?.(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
    };
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => c.removeEventListener("wheel", onWheel);
  }, [!!layout?.nodes.length]);

  const open = details?.open;
  return html`<div class="ds-root ds-overlay">
    <section class="ds-map" role="dialog" aria-modal="true" aria-labelledby="map-title" tabindex="-1" ref=${box}>
      <div class="ds-map-head">
        <h2 id="map-title">Project map</h2>
        <span class="ds-muted ds-small ds-map-count" role="status">${vis ? `${vis.items.filter((n) => n.kind !== "more").length} shown` : "loading…"}</span>
        ${changed ? html`<button class="ds-chip ds-map-update" type="button" onClick=${() => setSnap(data)}>The project changed · Refresh the map</button>` : null}
        <span class="ds-grow"></span>
        <button class="ds-btn ds-btn--ghost" type="button" aria-label="Close the map" onClick=${onClose}>×</button>
      </div>
      <div class="ds-map-toolbar">
        <span class="ds-seg" role="group" aria-label="Which paths">
          ${MAP_VIEWS.map((v) => html`<button type="button" key=${v} data-view=${v} aria-pressed=${st.view === v} onClick=${() => update({ view: v })}>${VIEW_LABEL[v]}</button>`)}
        </span>
        <label class="ds-search">
          <span class="ds-sr-only">Search the map</span><span class="ds-search-icon" aria-hidden="true">⌕</span>
          <input class="ds-input" type="search" placeholder="Search versions…" autocomplete="off" ref=${search} value=${qText}
            onInput=${(e) => setQText(e.target.value)}
            onKeyDown=${clearOnEscape} />
          <kbd class="ds-kbd">/</kbd>
        </label>
        <button class="ds-chip" type="button" data-act="focus" aria-pressed=${st.focus} aria-disabled=${st.sel ? undefined : "true"} title=${st.sel ? "show only what the selection depends on and what depends on it" : "select a version first"}
          onClick=${() => st.sel && update({ focus: !st.focus })}>Focus connections</button>
        <span class="ds-seg" role="group" aria-label="Zoom">
          <button type="button" data-act="zoom-out" aria-label="Zoom out" title="Zoom out (−)" disabled=${zoom <= ZOOM_MIN} onClick=${() => zoomBy(1 / ZOOM_STEP)}>−</button>
          <button type="button" data-act="fit" title="Fit the whole graph in the window (0)" onClick=${fit}>Fit</button>
          <button type="button" data-act="zoom-in" aria-label="Zoom in" title="Zoom in (+)" disabled=${zoom >= ZOOM_MAX} onClick=${() => zoomBy(ZOOM_STEP)}>+</button>
        </span>
        <span class="ds-small ds-muted ds-map-zoom-level" data-zoom title="Zoom level">${Math.round(zoom * 100)}%</span>
        <button class="ds-btn ds-btn--ghost" type="button" data-act="collapse" onClick=${() => update({ open: new Set() })}>Collapse groups</button>
        <button class="ds-btn ds-btn--ghost" type="button" data-act="reset" onClick=${reset}>Reset view</button>
        ${vis && vis.hidden > 0 ? html`<button class="ds-chip ds-map-hidden" type="button" onClick=${reset}>${vis.hidden} hidden · Show all</button>` : null}
      </div>
      ${
        lost
          ? html`<div class="ds-notice ds-map-notice" data-tone="warn" role="note"><span class="ds-status" data-tone="warn" aria-hidden="true">!</span>
              <div class="ds-grow">${lost.missing ? html`<strong>${lost.label}</strong> is not in this project.` : html`<strong>${lost.label}</strong> is hidden by ${lost.why}.`}</div>
              ${
                lost.missing
                  ? null
                  : html`<button class="ds-btn ds-btn--sm" type="button" data-act="reveal" onClick=${() => {
                      setQText("");
                      update({ view: "all", q: "", focus: false });
                    }}>Show it</button>`
              }</div>`
          : null
      }
      <div class="ds-map-body">
        <div class="ds-map-canvas" tabindex="0" role="region" aria-label="Dependency graph, scrolls in both directions. Arrow keys move between versions." ref=${canvas}>
          ${
            !g
              ? html`<div class="ds-state"><div class="ds-state-ico" aria-hidden="true">…</div><h3>Loading the map</h3></div>`
              : !layout?.nodes.length
                ? html`<div class="ds-state"><div class="ds-state-ico" aria-hidden="true">⌕</div><h3>${g.nodes.length ? "Nothing matches" : "Nothing yet"}</h3><p>${g.nodes.length ? "The view, the search and the focus show no version." : "Versions appear here as the project grows."}</p>${g.nodes.length ? html`<button class="ds-btn" type="button" onClick=${reset}>Reset view</button>` : null}</div>`
                : html`<div class="ds-map-zoom" style=${`zoom:${zoom}`}><div class="ds-map-heads" style=${`inline-size:${layout.width}px`}>
                    ${layout.heads.map((h, i) => html`<div class="ds-map-colhead" key=${h.stage} style=${`inline-size:${layout.col}px;${i === 0 ? `padding-inline-start:${32}px` : ""}`}>${STAGE_NAME[h.stage]} · ${h.count}</div>`)}
                  </div>
                  <div class="ds-map-stage" style=${`inline-size:${layout.width}px;block-size:${layout.height}px`}>
                    <svg width=${layout.width} height=${layout.height} aria-hidden="true">
                      ${layout.edges.map((e, i) => html`<path key=${i} class="ds-edge" d=${e.d} data-line=${e.line ? "true" : undefined} data-dim=${e.dim ? "true" : undefined} data-unknown=${e.unknown ? "true" : undefined} data-direct=${e.direct ? "true" : undefined} />`)}
                    </svg>
                    ${layout.nodes.map(
                      (
                        n,
                      ) => html`<button type="button" class=${`ds-node${n.kind === "qa" ? " ds-node--qa" : ""}`} key=${n.id} data-id=${n.id} data-kind=${n.kind}
                        data-state=${n.unknownLink ? "unknown" : n.blocked ? "blocked" : n.draft && n.kind === "version" ? "draft" : undefined}
                        data-tone=${n.kind === "qa" ? (n.qa?.status === "pass" || n.qa?.status === "confirmed" ? "ok" : "err") : undefined}
                        data-line=${n.inLine && n.kind !== "qa" ? "true" : undefined} data-group=${n.kind === "drafts" ? "true" : undefined}
                        data-dim=${n.dim ? "true" : undefined} data-match=${n.match ? "true" : undefined}
                        aria-current=${n.id === st.sel ? "true" : undefined} aria-label=${nodeLabel(n)}
                        style=${`inset-inline-start:${n.x}px;inset-block-start:${n.y}px;inline-size:${n.w}px;min-block-size:${n.h}px`}
                        onClick=${onNode} onKeyDown=${onKeyNode}>
                        <span class="ds-node-title">${n.approved && !n.blocked && !n.draft ? html`<span class="ds-ok" aria-hidden="true">✓</span> ` : null}${n.label}</span>
                        <span class="ds-node-meta">${n.meta}</span>
                        <${Badges} n=${n} />
                      </button>`,
                    )}
                  </div></div>`
          }
        </div>
        <aside class="ds-map-side" aria-label="Selection and outline">
          <div class="ds-map-selected" aria-live="polite">
            ${
              sel
                ? html`<h3>${sel.label}</h3>
                  <div class="ds-node-badges">${sel.approved && !sel.blocked ? html`<span class="ds-badge" data-tone="ok"><span class="ds-badge-ico" aria-hidden="true">✓</span>Approved</span>` : null}<${Badges} n=${sel} /></div>
                  <p class="ds-small ds-muted">${sel.meta}${sel.availability !== "present" ? ` · files ${sel.availability}` : ""}</p>
                  ${details.built.length ? html`<p class="ds-small"><span class="ds-muted">Built on</span> ${details.built.map((b, i) => html`${i ? " → " : ""}<span style=${b.approved ? undefined : "color:var(--status-warn)"}>${b.label}${b.approved ? "" : " (not approved)"}</span>`)}</p>` : sel.unknownLink ? html`<p class="ds-small" style="color:var(--status-err)">${sel.unknownLink}</p>` : html`<p class="ds-small ds-muted">A root: nothing it depends on.</p>`}
                  ${sel.blocked ? html`<p class="ds-small">Blocked by dependency: ${sel.blocked}.</p>` : null}
                  ${details.direct ? html`<p class="ds-small ds-muted">Made before annotations existed: linked straight to the voice-over it recorded.</p>` : null}
                  ${sel.stage === "render" && sel.kind === "version" ? html`<${RenderFiles} version=${sel.version} events=${events} />` : null}
                  ${sel.kind === "qa" ? html`<p class="ds-small">${sel.qa.blocking} blocking, ${sel.qa.warnings} warning(s), ${sel.qa.confirmed} confirmed.</p>` : null}`
                : html`<p class="ds-small ds-muted">Select a version to see what it is built on. Looking never changes what the next steps use.</p>`
            }
          </div>
          <nav class="ds-outline" aria-label="Outline of the shown versions"><${Outline} tree=${tree} sel=${st.sel} onPick=${pick} /></nav>
        </aside>
      </div>
      <div class="ds-map-foot">
        <span class="ds-muted ds-small ds-map-summary">${sel ? `${sel.label}${sel.inLine ? " · in production line" : ""}` : "Looking never changes what the next steps use."}</span>
        <span class="ds-grow"></span>
        ${open ? html`<a class="ds-btn ds-btn--primary ds-map-open" href=${formatRoute({ screen: open.screen, ...(open.version !== undefined ? { version: open.version } : {}) })}>Open ${sel.short} in ${open.label}</a>` : html`<button class="ds-btn ds-btn--primary ds-map-open" type="button" aria-disabled="true">Open in stage</button>`}
      </div>
    </section>
  </div>`;
}
