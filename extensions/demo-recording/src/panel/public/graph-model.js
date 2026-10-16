// The project map's model (UX4b, D119, docs/UX.md §4): which nodes of GET /api/graph are shown for a
// view, a search and a focus, how they are laid out, and how the keyboard walks them. Pure functions,
// no DOM and no imports, tested in Node.
//
// Rules: looking never changes the production line; a search keeps the dependencies of its matches as
// dim context; a group never hides a match (a matching draft opens its group); the map's state lives in
// the route (`#/map?view=approved&q=final&sel=vo:3&focus=1&open=drafts:render:annotations:1`).

export const MAP_VIEWS = ["all", "approved", "line"];
/** How many members of an open draft group are drawn before "+ N more". */
export const GROUP_CAP = 8;

export const STAGE_SCREEN = {
  storyboard: "storyboard",
  recording: "recording",
  vo: "voice",
  annotations: "annotations",
  render: "render",
};
export const STAGE_NAME = {
  storyboard: "Storyboard",
  recording: "Recording",
  vo: "Voice over",
  annotations: "Annotations",
  render: "Render",
};

// ---------------------------------------------------------------- state in the route

/** The map's state from a parsed route (`route.query`). Unknown values fall back to the defaults. */
export function mapStateFromRoute(route) {
  const q = route?.query ?? {};
  return {
    view: MAP_VIEWS.includes(q.view) ? q.view : "all",
    q: q.q ?? "",
    sel: q.sel || null,
    focus: q.focus === "1" && !!q.sel,
    open: new Set(
      String(q.open ?? "")
        .split(",")
        .filter(Boolean),
    ),
  };
}

/** The route query for a state; defaults are left out so the URL stays short. */
export function mapQueryFromState(s) {
  const query = {};
  if (s.view !== "all") query.view = s.view;
  if (s.q) query.q = s.q;
  if (s.sel) query.sel = s.sel;
  if (s.focus && s.sel) query.focus = "1";
  if (s.open?.size) query.open = [...s.open].join(",");
  return query;
}

/** The route that opens the map on a node ("Show in map"). */
export const mapRouteFor = (id) => ({ screen: "map", query: { sel: id, focus: "1" } });

const MEMORY = "demo-rec-map:";
export function readMapMemory(slug, storage = globalThis.localStorage) {
  try {
    const v = JSON.parse(storage?.getItem(MEMORY + slug) ?? "null");
    return v && MAP_VIEWS.includes(v.view) ? { view: v.view, open: new Set(v.open ?? []) } : null;
  } catch {
    return null;
  }
}
export function writeMapMemory(slug, s, storage = globalThis.localStorage) {
  try {
    if (slug)
      storage?.setItem(MEMORY + slug, JSON.stringify({ view: s.view, open: [...(s.open ?? [])] }));
  } catch {
    // no storage: the view is simply not remembered
  }
}

// ---------------------------------------------------------------- the graph as an index

/** Lookups over a graph: nodes by id, dependency parents and children, the owner of a QA node. */
export function indexGraph(graph) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const parents = new Map();
  const kids = new Map();
  const owner = new Map();
  for (const e of graph.edges) {
    if (e.rel === "contains") {
      owner.set(e.to, e.from);
      continue;
    }
    parents.set(e.to, [...(parents.get(e.to) ?? []), e.from]);
    kids.set(e.from, [...(kids.get(e.from) ?? []), e.to]);
  }
  return { byId, parents, kids, owner };
}

/** Everything a node depends on, nearest first. */
export function ancestorsOf(ix, id) {
  const out = [];
  const seen = new Set();
  const walk = (n) => {
    for (const p of ix.parents.get(n) ?? []) {
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(p);
      walk(p);
    }
  };
  walk(ix.owner.get(id) ?? id);
  return out;
}

/** Everything that depends on a node (its QA node included). */
export function descendantsOf(ix, id) {
  const out = [];
  const seen = new Set();
  const walk = (n) => {
    for (const k of ix.kids.get(n) ?? []) {
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(k);
      walk(k);
    }
  };
  walk(id);
  for (const [qa, o] of ix.owner) if (o === id || out.includes(o)) out.push(qa);
  return out;
}

const WORDS = (n) =>
  [
    n.label,
    n.short,
    n.meta,
    STAGE_NAME[n.stage],
    n.kind === "qa" ? "qa quality check" : "",
    n.approved && !n.blocked ? "approved" : "",
    n.blocked ? `blocked by dependency ${n.blocked}` : "",
    n.draft ? "draft" : "",
    n.inLine ? "production line" : "",
    n.review === "waiting" ? "waiting for review" : "",
    n.availability !== "present" ? n.availability : "",
    n.unknownLink ? "link unknown" : "",
    n.render?.kind === "final" ? "final" : "",
  ]
    .join(" ")
    .toLowerCase();

/** Does a node match the search text (every word of it)? */
export function matches(n, q, members = []) {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${WORDS(n)} ${members.map(WORDS).join(" ")}`;
  return words.every((w) => hay.includes(w));
}

// ---------------------------------------------------------------- what is shown

/**
 * The nodes shown for a state: { shown: Map<id, {match, dim}>, items, hidden, groups }.
 * `items` are the nodes to draw in order (draft groups expanded in place, with a "more" pseudo node
 * when an open group is longer than GROUP_CAP).
 */
export function visibleNodes(graph, ix, state) {
  const nodes = graph.nodes;
  const members = (g) => (g.members ?? []).map((id) => ix.byId.get(id)).filter(Boolean);
  const isMember = (n) => !!n.group;
  // 1. the view
  const base = new Set();
  for (const n of nodes) {
    if (isMember(n)) continue; // members are decided with their group
    const owner = n.kind === "qa" ? ix.byId.get(ix.owner.get(n.id)) : null;
    const subject = owner ?? n;
    const keep =
      state.view === "all"
        ? true
        : state.view === "line"
          ? subject.inLine
          : subject.kind === "version" && subject.approved && subject.usable;
    if (keep) base.add(n.id);
  }
  // 2. the search: matches stay, their dependencies stay as dim context
  const text = state.q.trim();
  const shown = new Map();
  const autoOpen = new Set();
  if (text) {
    for (const id of base) {
      const n = ix.byId.get(id);
      const ms = n.kind === "drafts" ? members(n) : [];
      const hitMembers = ms.filter((m) => matches(m, text));
      const own = n.kind === "drafts" ? matches(n, text) : matches(n, text);
      if (own || hitMembers.length) {
        shown.set(id, { match: true, dim: false });
        if (hitMembers.length) autoOpen.add(id); // a group never hides a match
        for (const a of ancestorsOf(ix, id))
          if (base.has(a) && !shown.has(a)) shown.set(a, { match: false, dim: true });
      }
    }
    // a QA node follows a matching owner
    for (const [qa, o] of ix.owner)
      if (shown.get(o)?.match && base.has(qa) && !shown.has(qa))
        shown.set(qa, { match: false, dim: false });
  } else for (const id of base) shown.set(id, { match: false, dim: false });
  // 3. focus: the selected node, what it depends on and what depends on it
  if (state.focus && state.sel && ix.byId.has(state.sel)) {
    const keep = new Set([
      state.sel,
      ...ancestorsOf(ix, state.sel),
      ...descendantsOf(ix, state.sel),
    ]);
    if (ix.owner.has(state.sel)) keep.add(ix.owner.get(state.sel));
    for (const id of [...shown.keys()]) if (!keep.has(id)) shown.delete(id);
  }
  // 4. draft groups open in place (on request, or because a member matches)
  const items = [];
  const groups = [];
  for (const n of nodes) {
    if (isMember(n) || !shown.has(n.id)) continue;
    if (n.kind !== "drafts") {
      items.push({ ...n, ...shown.get(n.id) });
      continue;
    }
    const all = state.open.has(`${n.id}*`);
    const open = all || state.open.has(n.id) || autoOpen.has(n.id);
    groups.push({ id: n.id, open, count: n.members.length });
    if (!open) {
      items.push({ ...n, ...shown.get(n.id) });
      continue;
    }
    let list = members(n);
    if (text) {
      const hits = list.filter((m) => matches(m, text));
      if (hits.length) list = hits;
    }
    const cap = all ? list.length : GROUP_CAP;
    for (const m of list.slice(0, cap)) {
      const hit = !!text && matches(m, text);
      items.push({ ...m, match: hit, dim: false });
      shown.set(m.id, { match: hit, dim: false });
    }
    if (list.length > cap)
      items.push({
        id: `more:${n.id}`,
        kind: "more",
        stage: "render",
        label: `+ ${list.length - cap} more`,
        short: "more",
        meta: "show all of them",
        group: n.id,
        parentOf: n.id,
        approved: false,
        usable: true,
        blocked: null,
        inLine: false,
        draft: true,
        review: null,
        availability: "present",
        unknownLink: null,
        at: null,
        match: false,
        dim: false,
      });
  }
  const total = nodes.filter((n) => !isMember(n)).length;
  // an open group counts as shown (its members stand in for it)
  const counted =
    items.filter((n) => n.kind !== "more" && !n.group).length + groups.filter((g) => g.open).length;
  return { shown, items, hidden: Math.max(0, total - counted), groups };
}

// ---------------------------------------------------------------- layout

export const LAYOUT = { pad: 20, nodeH: 68, qaH: 36, gap: 16, minCol: 160, maxCol: 232, qaGap: 6 };

const STAGE_ORDER = ["storyboard", "recording", "vo", "annotations", "render"];

/**
 * Positions in px: one column per stage, branches top to bottom, a parent centred on its children,
 * a final's QA node directly under it, an unknown-link node last. `heights` are the measured heights of
 * nodes that came out taller than the default. Edges as cubic curves between the
 * nodes that are both drawn.
 */
export function layoutMap(graph, ix, items, width, heights = new Map()) {
  const L = LAYOUT;
  const col = Math.max(
    L.minCol,
    Math.min(L.maxCol, Math.floor((width - L.pad * 2) / STAGE_ORDER.length)),
  );
  const nodeW = col - 24;
  const byId = new Map(items.map((n) => [n.id, n]));
  // the first dependency that is drawn (an open group's members hang from the group's own parent)
  const parentOf = (n) => (ix.parents.get(n.id) ?? []).find((p) => byId.has(p)) ?? null;
  const childrenOf = new Map();
  const roots = [];
  const qaOf = new Map();
  for (const n of items) {
    if (n.kind === "qa") {
      const o = ix.owner.get(n.id);
      if (o && byId.has(o)) qaOf.set(o, n);
      continue;
    }
    const p =
      n.kind === "more"
        ? ((ix.parents.get(n.parentOf) ?? []).find((x) => byId.has(x)) ?? null)
        : parentOf(n);
    if (p) childrenOf.set(p, [...(childrenOf.get(p) ?? []), n]);
    else roots.push(n);
  }
  const stageIdx = (n) => STAGE_ORDER.indexOf(n.stage);
  const order = (a, b) =>
    stageIdx(a) - stageIdx(b) ||
    (a.kind === "more" ? 1 : 0) - (b.kind === "more" ? 1 : 0) ||
    (a.version ?? 0) - (b.version ?? 0) ||
    a.id.localeCompare(b.id);
  roots.sort((a, b) => (a.unknownLink ? 1 : 0) - (b.unknownLink ? 1 : 0) || order(a, b));
  for (const list of childrenOf.values()) list.sort(order);
  const pos = new Map();
  let y = L.pad;
  // the drawn height wins (badges and titles wrap): the panel measures the nodes and lays out again
  const height = (n) => heights.get(n.id) ?? (n.kind === "qa" ? L.qaH : L.nodeH);
  const place = (n) => {
    const kids = childrenOf.get(n.id) ?? [];
    const qa = qaOf.get(n.id);
    if (!kids.length) {
      pos.set(n.id, { x: L.pad + stageIdx(n) * col, y, w: nodeW, h: height(n) });
      y += height(n) + (qa ? L.qaGap + height(qa) : 0) + L.gap;
      return;
    }
    for (const k of kids) place(k);
    const first = pos.get(kids[0].id);
    const last = pos.get(kids.at(-1).id);
    const mid = (first.y + first.h / 2 + (last.y + last.h / 2)) / 2;
    pos.set(n.id, {
      x: L.pad + stageIdx(n) * col,
      y: Math.max(L.pad, mid - height(n) / 2),
      w: nodeW,
      h: height(n),
    });
  };
  for (const r of roots) place(r);
  for (const [o, qa] of qaOf) {
    const p = pos.get(o);
    if (p) pos.set(qa.id, { x: p.x, y: p.y + p.h + L.qaGap, w: nodeW, h: height(qa) });
  }
  const placed = items.filter((n) => pos.has(n.id)).map((n) => ({ ...n, ...pos.get(n.id) }));
  const at = new Map(placed.map((n) => [n.id, n]));
  const lineIds = new Set(Object.values(graph.line ?? {}));
  const edges = [];
  for (const e of graph.edges) {
    const from = at.get(e.from);
    const to = at.get(e.to);
    if (e.rel === "contains") {
      if (from && to)
        edges.push({
          ...e,
          d: `M${from.x + nodeW / 2},${from.y + from.h} L${to.x + nodeW / 2},${to.y}`,
          line: false,
          dim: !!to.dim,
          unknown: false,
          direct: false,
        });
      continue;
    }
    if (!to || !from) continue;
    const x1 = from.x + from.w;
    const y1 = from.y + from.h / 2;
    const x2 = to.x;
    const y2 = to.y + to.h / 2;
    const mx = (x1 + x2) / 2;
    edges.push({
      ...e,
      d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`,
      line: lineIds.has(e.from) && lineIds.has(e.to),
      dim: !!(from.dim || to.dim),
      unknown: false,
      direct: !!e.direct,
    });
  }
  for (const n of placed)
    if (n.unknownLink)
      edges.push({
        from: "?",
        to: n.id,
        rel: "depends-on",
        d: `M${n.x - 36},${n.y + n.h / 2} L${n.x},${n.y + n.h / 2}`,
        line: false,
        dim: false,
        unknown: true,
        direct: false,
      });
  // "+ N more" hangs from the group's parent like the members do
  for (const m of placed.filter((n) => n.kind === "more")) {
    const p = (ix.parents.get(m.parentOf) ?? []).map((id) => at.get(id)).find(Boolean);
    if (!p) continue;
    const x1 = p.x + p.w;
    const y1 = p.y + p.h / 2;
    const mx = (x1 + m.x) / 2;
    edges.push({
      from: p.id,
      to: m.id,
      rel: "depends-on",
      d: `M${x1},${y1} C${mx},${y1} ${mx},${m.y + m.h / 2} ${m.x},${m.y + m.h / 2}`,
      line: false,
      dim: !!p.dim,
      unknown: false,
      direct: false,
    });
  }
  const counts = new Map();
  for (const n of placed) counts.set(n.stage, (counts.get(n.stage) ?? 0) + 1);
  return {
    nodes: placed,
    edges,
    col,
    nodeW,
    width: L.pad * 2 + STAGE_ORDER.length * col,
    height: Math.max(...placed.map((n) => n.y + n.h), 0) + L.pad,
    heads: STAGE_ORDER.map((stage) => ({ stage, count: counts.get(stage) ?? 0 })),
  };
}

// ---------------------------------------------------------------- the outline and the keyboard

/** The same shown nodes as a nested list by dependency: the accessible twin of the drawing. */
export function outlineOf(ix, items) {
  const ids = new Set(items.map((n) => n.id));
  const byId = new Map(items.map((n) => [n.id, n]));
  const kids = new Map();
  const roots = [];
  for (const n of items) {
    if (n.kind === "more") continue;
    const p =
      n.kind === "qa"
        ? ix.owner.get(n.id)
        : ((ix.parents.get(n.id) ?? []).find((x) => ids.has(x)) ??
          (n.group && (ix.parents.get(n.id) ?? []).find((x) => ids.has(x))));
    if (p && ids.has(p)) kids.set(p, [...(kids.get(p) ?? []), n.id]);
    else roots.push(n.id);
  }
  const build = (id) => ({ node: byId.get(id), children: (kids.get(id) ?? []).map(build) });
  return roots.map(build);
}

/** The node a key moves to: Left a dependency, Right a dependent, Up and Down the neighbour in the column. */
export function neighbour(ix, layout, id, key) {
  const here = layout.nodes.find((n) => n.id === id);
  if (!here) return null;
  const ids = new Set(layout.nodes.map((n) => n.id));
  if (key === "ArrowLeft") {
    if (here.kind === "qa") return ix.owner.get(id) ?? null; // from a QA node back to its final
    return (ix.parents.get(id) ?? []).find((p) => ids.has(p)) ?? null;
  }
  if (key === "ArrowRight") {
    const y = (k) => layout.nodes.find((n) => n.id === k)?.y ?? 0;
    const next = (ix.kids.get(id) ?? []).filter((k) => ids.has(k)).sort((a, b) => y(a) - y(b));
    // the topmost dependent; a final with no dependents goes on to its QA node
    return next[0] ?? [...ix.owner].find(([qa, o]) => o === id && ids.has(qa))?.[0] ?? null;
  }
  const column = layout.nodes.filter((n) => n.stage === here.stage).sort((a, b) => a.y - b.y);
  const i = column.findIndex((n) => n.id === id);
  return (column[i + (key === "ArrowDown" ? 1 : -1)] ?? null)?.id ?? null;
}

// ---------------------------------------------------------------- the selection

/** What the details panel shows about a node: what it is built on, and the screen to open it in. */
export function detailsOf(graph, ix, id) {
  const n = ix.byId.get(id);
  if (!n) return null;
  const subject = n.kind === "qa" ? ix.byId.get(ix.owner.get(n.id)) : n;
  const built = ancestorsOf(ix, id)
    .map((a) => ix.byId.get(a))
    .filter(Boolean)
    .reverse();
  const broken = built.find((b) => !b.approved);
  const direct = graph.edges.find((e) => e.to === id && e.direct);
  return {
    node: n,
    built,
    /** the version this one is built on that is not approved */
    broken: n.blocked ? (broken ?? null) : null,
    direct: !!direct,
    open:
      n.kind === "drafts" || !subject
        ? { screen: "render", version: undefined, label: "Render" }
        : {
            screen: STAGE_SCREEN[subject.stage],
            version: subject.version,
            label: STAGE_NAME[subject.stage],
          },
  };
}

/** A selection (or focus) that the current view, search or focus hides: said, with a way to reveal it. */
export function hiddenSelection(graph, ix, state, items) {
  if (!state.sel) return null;
  const n = ix.byId.get(state.sel);
  if (!n) return { id: state.sel, missing: true, label: state.sel };
  const shownIds = new Set(items.map((i) => i.id));
  const groupShown = n.group && shownIds.has(n.group);
  if (shownIds.has(n.id) || groupShown) return null;
  const why =
    state.view !== "all"
      ? `the “${state.view === "approved" ? "Approved paths" : "Production line"}” view`
      : state.q
        ? `the search “${state.q}”`
        : "the focus";
  return { id: n.id, missing: false, label: n.label, why };
}
