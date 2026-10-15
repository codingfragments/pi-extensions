// Project map prototype (UX0): the layout, filters, dim context, focus and outline
// that UX4 will build for real from GET /api/graph. Plain DOM, no dependencies.
// Fixture data only; shapes mirror the spec's node model (stage, status fields kept
// separate: approved / line / draft / blocked / unknown).

(() => {
  const STAGES = [
    ["storyboard", "Storyboard"],
    ["recording", "Recording"],
    ["vo", "Voice over"],
    ["annotations", "Annotations"],
    ["render", "Render"],
  ];
  const ROW_H = 84;
  const NODE_H = 68;
  const PAD = 20;
  const MIN_COL = 180;
  const MAX_COL = 232;

  /** A branching fixture: two storyboards, three takes, a blocked branch, grouped drafts, a legacy render. */
  const SAMPLE = [
    { id: "sb1", stage: "storyboard", title: "Storyboard v1", meta: "3 scenes", approved: true },
    {
      id: "sb2",
      stage: "storyboard",
      title: "Storyboard v2",
      meta: "5 scenes",
      approved: true,
      line: true,
    },
    {
      id: "t4",
      stage: "recording",
      title: "Take 4",
      meta: "1:48 · of v1",
      parent: "sb1",
      approved: true,
    },
    {
      id: "t5",
      stage: "recording",
      title: "Take 5",
      meta: "2:12 · of v2",
      parent: "sb2",
      approved: false,
    },
    {
      id: "t6",
      stage: "recording",
      title: "Take 6",
      meta: "2:31 · of v2",
      parent: "sb2",
      approved: true,
      line: true,
    },
    { id: "vo1", stage: "vo", title: "Voice v1", meta: "of take 4", parent: "t4", approved: true },
    {
      id: "vo4",
      stage: "vo",
      title: "Voice v4",
      meta: "of take 5",
      parent: "t5",
      approved: true,
      blocked: "Take 5 is not approved",
    },
    {
      id: "vo2",
      stage: "vo",
      title: "Voice v2",
      meta: "of take 6",
      parent: "t6",
      approved: true,
      line: true,
    },
    {
      id: "vo3",
      stage: "vo",
      title: "Voice v3",
      meta: "of take 6 · viewing",
      parent: "t6",
      draft: true,
    },
    {
      id: "an3",
      stage: "annotations",
      title: "Annotations v3",
      meta: "of voice v4",
      parent: "vo4",
      approved: true,
      blocked: "Voice v4 is blocked",
    },
    {
      id: "an1",
      stage: "annotations",
      title: "Annotations v4",
      meta: "12 enabled",
      parent: "vo2",
      approved: true,
      line: true,
    },
    {
      id: "an2",
      stage: "annotations",
      title: "Annotations v5",
      meta: "unsaved edits",
      parent: "vo2",
      draft: true,
    },
    {
      id: "r8",
      stage: "render",
      title: "Final v8",
      meta: "QA passed",
      parent: "an1",
      approved: true,
      line: true,
    },
    { id: "r7", stage: "render", title: "Final v7", meta: "QA: 1 blocking", parent: "an1" },
    {
      id: "g1",
      stage: "render",
      title: "Drafts",
      meta: "14 draft renders",
      parent: "an1",
      group: 14,
    },
    {
      id: "g2",
      stage: "render",
      title: "Drafts",
      meta: "3 draft renders",
      parent: "an2",
      group: 3,
    },
    {
      id: "r3",
      stage: "render",
      title: "Render v3",
      meta: "before the Render stage",
      unknown: "Parent version not recorded",
    },
  ];

  const markText = (text, q) => {
    const t = String(text);
    const needle = q.trim();
    if (!needle) return esc(t);
    const i = t.toLowerCase().indexOf(needle.toLowerCase());
    return i < 0
      ? esc(t)
      : `${esc(t.slice(0, i))}<mark class="ds-mark">${esc(t.slice(i, i + needle.length))}</mark>${esc(t.slice(i + needle.length))}`;
  };
  const esc = (s) =>
    String(s).replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
    );

  function initMap(root, data = SAMPLE) {
    const byId = new Map(data.map((n) => [n.id, n]));
    const kids = new Map();
    for (const n of data) if (n.parent) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n.id]);
    const membersOf = (g) =>
      Array.from({ length: g.group }, (_, i) => ({
        title: `Draft v${(g.id === "g2" ? 20 : 40) - i}`,
        meta: "960×540 · no QA",
      }));
    const ancestors = (id) => {
      const out = [];
      for (let n = byId.get(id); n?.parent; n = byId.get(n.parent)) out.push(n.parent);
      return out;
    };
    const descendants = (id) => (kids.get(id) ?? []).flatMap((k) => [k, ...descendants(k)]);
    const usable = (n) =>
      n.approved &&
      !n.blocked &&
      ancestors(n.id).every((a) => byId.get(a)?.approved && !byId.get(a)?.blocked);
    const lineIds = new Set(data.filter((n) => n.line).map((n) => n.id));

    const state = { view: "all", q: "", focus: false, selected: "vo3", expanded: new Set() };
    const params = new URLSearchParams(location.search);
    if (["all", "approved", "line"].includes(params.get("view") ?? ""))
      state.view = params.get("view");
    state.q = params.get("q") ?? "";
    state.focus = params.get("focus") === "1";
    for (const g of (params.get("open") ?? "").split(",").filter(Boolean)) state.expanded.add(g);
    if (params.get("sel")) state.selected = params.get("sel");

    const q = (sel) => root.querySelector(sel);

    /** Which nodes show, and which are dim context rather than matches. */
    function visibility() {
      const base = data.filter((n) =>
        state.view === "all" ? true : state.view === "line" ? lineIds.has(n.id) : usable(n),
      );
      const text = state.q.trim().toLowerCase();
      const shown = new Map(base.map((n) => [n.id, { match: false, dim: false }]));
      if (text) {
        const hay = (n) =>
          `${n.title} ${n.meta} ${n.stage} ${n.draft ? "draft" : ""} ${n.approved ? "approved" : ""} ${
            n.group
              ? `drafts ${membersOf(n)
                  .map((m) => m.title)
                  .join(" ")}`
              : ""
          }`.toLowerCase();
        const matches = base.filter((n) => hay(n).includes(text));
        shown.clear();
        for (const m of matches) {
          shown.set(m.id, { match: true, dim: false });
          for (const a of ancestors(m.id))
            if (!shown.has(a) && base.some((b) => b.id === a))
              shown.set(a, { match: false, dim: true });
        }
      }
      if (state.focus && byId.has(state.selected)) {
        const keep = new Set([
          state.selected,
          ...ancestors(state.selected),
          ...descendants(state.selected),
        ]);
        for (const id of [...shown.keys()]) if (!keep.has(id)) shown.delete(id);
      }
      // a collapsed group that holds a match opens itself (spec: a group never hides a match)
      return { shown, hidden: data.length - shown.size };
    }

    function layout(nodes) {
      const ids = new Set(nodes.map((n) => n.id));
      const roots = nodes.filter((n) => !n.parent || !ids.has(n.parent));
      let row = 0;
      const pos = new Map();
      const place = (n) => {
        const ch = nodes.filter((c) => c.parent === n.id);
        if (!ch.length) {
          pos.set(n.id, { col: STAGES.findIndex((s) => s[0] === n.stage), row: row++ });
          return;
        }
        for (const c of ch) place(c);
        const rows = ch.map((c) => pos.get(c.id).row);
        pos.set(n.id, {
          col: STAGES.findIndex((s) => s[0] === n.stage),
          row: (Math.min(...rows) + Math.max(...rows)) / 2,
        });
      };
      // roots with a stage parent chain first; orphans (unknown link) last
      for (const r of roots.filter((x) => !x.unknown)) place(r);
      for (const r of roots.filter((x) => x.unknown)) place(r);
      return pos;
    }

    function badges(n) {
      const out = [];
      const add = (tone, ico, label) =>
        out.push(
          `<span class="ds-badge" data-tone="${tone}"><span class="ds-badge-ico" aria-hidden="true">${ico}</span>${label}</span>`,
        );
      if (n.line) add("accent", "▶", "In production line");
      if (n.blocked) add("err", "!", "Blocked by dependency");
      if (n.unknown) add("err", "?", "Link unknown");
      if (n.draft) add("neutral", "✎", "Draft");
      return out.join("");
    }

    function render() {
      const { shown, hidden } = visibility();
      let nodes = data.filter((n) => shown.has(n.id));
      // expand groups in place
      nodes = nodes.flatMap((n) => {
        if (!n.group) return [n];
        const text = state.q.trim().toLowerCase();
        const members = membersOf(n);
        const hits = text ? members.filter((m) => m.title.toLowerCase().includes(text)) : [];
        const open = state.expanded.has(n.id) || shown.get(n.id)?.match;
        if (!open) return [n];
        // searching shows the members that match; otherwise the first few
        const list = (text && hits.length ? hits : members).slice(0, 3);
        const drafts = list.map((m, i) => ({
          id: `${n.id}-d${i}`,
          stage: "render",
          title: m.title,
          meta: m.meta,
          parent: n.parent,
          draft: true,
        }));
        const rest = n.group - list.length;
        if (rest > 0)
          drafts.push({
            id: `${n.id}-more`,
            stage: "render",
            title: `+ ${rest} more`,
            meta: "collapse groups to hide",
            parent: n.parent,
            group: 0,
          });
        for (const d of drafts)
          shown.set(d.id, { match: hits.some((m) => m.title === d.title), dim: false });
        return drafts;
      });
      for (const d of nodes) if (!shown.has(d.id)) shown.set(d.id, { match: false, dim: false });
      const lookup = new Map(nodes.map((n) => [n.id, n]));
      const pos = layout(nodes);
      const rows = Math.max(1, ...[...pos.values()].map((p) => p.row + 1));
      // columns share the canvas width, between a readable minimum and a calm maximum
      const avail = q(".ds-map-canvas").clientWidth || 1000;
      const COL_W = Math.max(
        MIN_COL,
        Math.min(MAX_COL, Math.floor((avail - PAD * 2) / STAGES.length)),
      );
      const NODE_W = COL_W - 28;
      const width = STAGES.length * COL_W + PAD * 2;
      const height = rows * ROW_H + PAD * 2;

      q(".ds-map-heads").style.inlineSize = `${width}px`;
      q(".ds-map-heads").innerHTML = STAGES.map(([id, label]) => {
        const count = nodes.filter((n) => n.stage === id).length;
        return `<div class="ds-map-colhead" style="inline-size:${COL_W}px;${id === STAGES[0][0] ? `padding-inline-start:${PAD + 12}px` : ""}">${label} · ${count}</div>`;
      }).join("");

      const xy = (id) => ({
        x: PAD + pos.get(id).col * COL_W,
        y: PAD + pos.get(id).row * ROW_H + (ROW_H - NODE_H) / 2,
      });
      const edges = nodes
        .filter((n) => n.parent && lookup.has(n.parent))
        .map((n) => {
          const a = xy(n.parent);
          const b = xy(n.id);
          const x1 = a.x + NODE_W;
          const y1 = a.y + NODE_H / 2;
          const x2 = b.x;
          const y2 = b.y + NODE_H / 2;
          const mid = (x1 + x2) / 2;
          const onLine = lineIds.has(n.id) && lineIds.has(n.parent);
          const dim = shown.get(n.id)?.dim || shown.get(n.parent)?.dim;
          return `<path class="ds-edge" d="M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}" ${onLine ? 'data-line="true"' : ""} ${dim ? 'data-dim="true"' : ""}/>`;
        });
      for (const n of nodes.filter((x) => x.unknown)) {
        const b = xy(n.id);
        edges.push(
          `<path class="ds-edge" data-unknown="true" d="M${b.x - 36},${b.y + NODE_H / 2} L${b.x},${b.y + NODE_H / 2}"/>`,
        );
      }
      const stage = q(".ds-map-stage");
      stage.style.inlineSize = `${width}px`;
      stage.style.blockSize = `${height}px`;
      stage.innerHTML = `<svg width="${width}" height="${height}" aria-hidden="true">${edges.join("")}</svg>${nodes
        .map((n) => {
          const { x, y } = xy(n.id);
          const v = shown.get(n.id) ?? {};
          const st = n.unknown ? "unknown" : n.blocked ? "blocked" : n.draft ? "draft" : "";
          return `<button class="ds-node" type="button" data-id="${n.id}" ${st ? `data-state="${st}"` : ""} ${n.line ? 'data-line="true"' : ""} ${n.group ? 'data-group="true"' : ""} ${v.dim ? 'data-dim="true"' : ""} ${v.match ? 'data-match="true"' : ""} ${n.id === state.selected ? 'aria-current="true"' : ""} style="inset-inline-start:${x}px;inset-block-start:${y}px;inline-size:${NODE_W}px;min-block-size:${NODE_H}px" aria-label="${esc(`${n.title}, ${n.meta}${n.approved ? ", approved" : ""}${n.line ? ", in production line" : ""}${n.blocked ? `, blocked: ${n.blocked}` : ""}${n.draft ? ", draft" : ""}`)}">
          <span class="ds-node-title">${n.approved && !n.blocked && !n.draft ? '<span class="ds-ok" aria-hidden="true">✓</span> ' : ""}${markText(n.title, state.q)}</span><span class="ds-node-meta">${markText(n.meta, state.q)}</span><span class="ds-node-badges">${badges(n)}</span></button>`;
        })
        .join("")}`;
      q(".ds-map-hidden").hidden = hidden === 0;
      q(".ds-map-hidden").textContent = `${hidden} hidden · Show all`;
      q(".ds-map-count").textContent = `${nodes.length} shown`;

      // outline: the same visible nodes as an accessible tree
      const tree = (parent) => {
        const ch = nodes.filter((n) =>
          parent ? n.parent === parent : !n.parent || !lookup.has(n.parent),
        );
        if (!ch.length) return "";
        return `<ul>${ch
          .map(
            (n) =>
              `<li><button type="button" data-id="${n.id}" ${n.id === state.selected ? 'aria-current="true"' : ""} ${shown.get(n.id)?.dim ? 'data-dim="true"' : ""}>${esc(n.title)} <span class="ds-muted ds-xs">${esc(n.meta)}</span></button>${tree(n.id)}</li>`,
          )
          .join("")}</ul>`;
      };
      q(".ds-outline").innerHTML = tree(null);

      if (!state.scrolled) {
        state.scrolled = true;
        root
          .querySelector(`.ds-node[data-id="${state.selected}"]`)
          ?.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
      const sel = lookup.get(state.selected) ?? byId.get(state.selected);
      const info = q(".ds-map-selected");
      if (sel) {
        const anc = ancestors(sel.id)
          .map((a) => byId.get(a)?.title)
          .filter(Boolean)
          .reverse();
        const approval = sel.draft
          ? ""
          : sel.approved && !sel.blocked
            ? '<span class="ds-badge" data-tone="ok"><span class="ds-badge-ico" aria-hidden="true">✓</span>Approved</span>'
            : "";
        info.innerHTML = `<h3>${esc(sel.title)}</h3><div class="ds-node-badges">${approval}${badges(sel)}</div>
        <p class="ds-small ds-muted">${esc(sel.meta)}</p>
        <p class="ds-small"><span class="ds-muted">Built on</span> ${anc.length ? esc(anc.join(" → ")) : sel.unknown ? `<span style="color:var(--status-err)">${esc(sel.unknown)}</span>` : "nothing (a root)"}</p>
        ${sel.blocked ? `<p class="ds-small">${esc(sel.blocked)}</p>` : ""}`;
      }
      for (const el of root.querySelectorAll("[data-view]"))
        el.setAttribute("aria-pressed", String(el.dataset.view === state.view));
      const f = q("[data-act=focus]");
      f.setAttribute("aria-pressed", String(state.focus));
      q(".ds-map-open").textContent = sel
        ? `Open ${sel.title} in ${STAGES.find((s) => s[0] === sel.stage)?.[1] ?? "stage"}`
        : "Open in stage";
    }

    root.addEventListener("click", (e) => {
      const node = e.target.closest("[data-id]");
      if (node) {
        const id = node.dataset.id;
        const n = byId.get(id) ?? { id };
        if (n.group && !node.matches(".ds-outline button")) {
          if (state.expanded.has(id)) state.expanded.delete(id);
          else state.expanded.add(id);
        } else if (byId.has(id)) state.selected = id;
        render();
        return;
      }
      const v = e.target.closest("[data-view]");
      if (v) {
        state.view = v.dataset.view;
        render();
        return;
      }
      const act = e.target.closest("[data-act]")?.dataset.act;
      const reset = act === "reset" || e.target.closest(".ds-map-hidden") !== null;
      if (act === "focus") state.focus = !state.focus;
      if (act === "collapse") state.expanded.clear();
      if (reset) {
        Object.assign(state, { view: "all", q: "", focus: false });
        q(".ds-input").value = "";
      }
      if (act || reset) render();
    });
    q(".ds-input").addEventListener("input", (e) => {
      state.q = e.target.value;
      render();
    });
    // keyboard: arrows move along the tree; "/" focuses the search
    root.addEventListener("keydown", (e) => {
      const cur = e.target.closest(".ds-node");
      if (!cur) return;
      const id = cur.dataset.id;
      const n = byId.get(id);
      const go = (next) => {
        if (next) {
          e.preventDefault();
          state.selected = next;
          render();
          root.querySelector(`.ds-node[data-id="${next}"]`)?.focus();
        }
      };
      if (e.key === "ArrowLeft") go(n?.parent);
      if (e.key === "ArrowRight") go(kids.get(id)?.[0]);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const siblings = data.filter((x) => x.stage === n?.stage && x.parent === n?.parent);
        const i = siblings.findIndex((x) => x.id === id);
        go(siblings[i + (e.key === "ArrowDown" ? 1 : -1)]?.id);
      }
    });
    q(".ds-input").value = state.q;
    window.addEventListener("resize", render);
    render();
  }

  window.DSMap = { initMap, SAMPLE };
})();
