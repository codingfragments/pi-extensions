/**
 * UX4b, the map's model (D119, docs/UX.md §4): what is shown for a view, a search and a focus, how it is
 * laid out, and how the keyboard walks it. Pure logic over the real graph of the seeded project and of a
 * generated 300-node project; no browser.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { buildGraph } from "../src/graph/build.ts";
import {
  GROUP_CAP,
  type MapState,
  detailsOf,
  hiddenSelection,
  indexGraph,
  layoutMap,
  mapQueryFromState,
  mapRouteFor,
  mapStateFromRoute,
  neighbour,
  outlineOf,
  readMapMemory,
  visibleNodes,
  writeMapMemory,
} from "../src/panel/public/graph-model.js";
import { parseRoute } from "../src/panel/public/route.js";
import { applyVersionAction, planVersionAction } from "../src/panel/version-actions.ts";
import { readState } from "../src/workdir/state.ts";
import { bigProject } from "./helpers/big-project.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

const state = (over: Partial<MapState> = {}): MapState => ({
  view: "all",
  q: "",
  sel: null,
  focus: false,
  open: new Set(),
  ...over,
});
const seeded = () => {
  const s = seedPanelProject();
  const g = buildGraph(
    s.dir,
    s.slug,
    readState(s.dir) as NonNullable<ReturnType<typeof readState>>,
  );
  return { ...s, g, ix: indexGraph(g) };
};
const ids = (items: { id: string }[]) => items.map((i) => i.id).sort();

test("state in the route: defaults left out, round-trip, junk falls back, remembered per project", () => {
  assert.deepEqual(mapQueryFromState(state()), {});
  const s = state({
    view: "approved",
    q: "final v8",
    sel: "vo:3",
    focus: true,
    open: new Set(["drafts:render:annotations:1", "x*"]),
  });
  const route = parseRoute(`#/map?${new URLSearchParams(mapQueryFromState(s))}`);
  assert.equal(route?.valid, true);
  const back = mapStateFromRoute(route);
  assert.deepEqual(
    [back.view, back.q, back.sel, back.focus, [...back.open].sort()],
    ["approved", "final v8", "vo:3", true, ["drafts:render:annotations:1", "x*"]],
  );
  assert.equal(mapStateFromRoute(parseRoute("#/map?view=weird&focus=1"))?.view, "all");
  assert.equal(
    mapStateFromRoute(parseRoute("#/map?focus=1")).focus,
    false,
    "focus needs a selection",
  );
  assert.deepEqual(mapRouteFor("vo:3"), { screen: "map", query: { sel: "vo:3", focus: "1" } });
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  writeMapMemory("keycraft", state({ view: "line", open: new Set(["g"]) }), storage);
  assert.deepEqual(
    [
      readMapMemory("keycraft", storage)?.view,
      [...(readMapMemory("keycraft", storage)?.open ?? [])],
    ],
    ["line", ["g"]],
  );
  assert.equal(readMapMemory("other", storage), null);
});

test("views: all paths folds drafts into one node; approved paths are usable approved chains; the line is exactly the line", () => {
  const { g, ix } = seeded();
  const all = visibleNodes(g, ix, state());
  assert.equal(all.items.length, 12, "16 nodes, the four draft renders folded into their group");
  assert.equal(all.hidden, 0);
  assert.ok(all.items.some((n) => n.id === "drafts:render:annotations:1"));
  const approved = visibleNodes(g, ix, state({ view: "approved" }));
  assert.deepEqual(ids(approved.items), [
    "annotations:1",
    "qa:render:2",
    "recording:1",
    "render:2",
    "storyboard:1",
    "vo:1",
  ]);
  assert.equal(approved.hidden, 6);
  const line = visibleNodes(g, ix, state({ view: "line" }));
  assert.deepEqual(ids(line.items), [
    "annotations:1",
    "qa:render:2",
    "recording:1",
    "render:2",
    "storyboard:1",
    "vo:1",
  ]);
});

test("approved paths: a branch whose dependency was withdrawn leaves the view, but stays in all paths", () => {
  const s = seedPanelProject();
  const st = () => readState(s.dir) as NonNullable<ReturnType<typeof readState>>;
  applyVersionAction(s.dir, {
    stage: "recording",
    version: 1,
    intent: "withdraw",
    token: planVersionAction(s.dir, st(), { stage: "recording", version: 1, intent: "withdraw" })
      .token,
  });
  const g = buildGraph(s.dir, s.slug, st());
  const ix = indexGraph(g);
  assert.deepEqual(
    ids(visibleNodes(g, ix, state({ view: "approved" })).items),
    ["storyboard:1"],
    "everything built on the take is blocked",
  );
  assert.ok(visibleNodes(g, ix, state()).items.some((n) => n.id === "vo:1"));
  assert.equal(
    detailsOf(g, ix, "vo:1")?.broken?.id,
    "recording:1",
    "the details name the dependency that broke",
  );
});

test("search: matches prominent, their dependencies dim context, the rest hidden and counted; QA follows its final", () => {
  const { g, ix } = seeded();
  const r = visibleNodes(g, ix, state({ q: "final" }));
  const flags = Object.fromEntries(
    r.items.map((n) => [n.id, n.match ? "match" : n.dim ? "dim" : "plain"]),
  );
  assert.equal(flags["render:1"], "match");
  assert.equal(flags["render:2"], "match");
  assert.equal(flags["render:3"], "match");
  assert.equal(flags["annotations:1"], "dim", "the dependency is shown, as context");
  assert.equal(flags["vo:1"], "dim");
  assert.equal(flags["storyboard:1"], "dim");
  assert.equal(flags["qa:render:2"], "plain", "the QA node follows its matching final");
  assert.equal(flags["storyboard:2"], undefined);
  assert.ok(r.hidden > 0);
  // words are all required, in any order; status words work
  assert.deepEqual(
    ids(visibleNodes(g, ix, state({ q: "approved storyboard" })).items.filter((n) => n.match)),
    ["storyboard:1"],
  );
  assert.ok(
    visibleNodes(g, ix, state({ q: "waiting for review" })).items.some((n) => n.id === "vo:2"),
  );
  assert.equal(visibleNodes(g, ix, state({ q: "no such thing" })).items.length, 0);
});

test("a group never hides a match: a matching draft opens its group and shows only the matching members", () => {
  const { g, ix } = seeded();
  const r = visibleNodes(g, ix, state({ q: "draft render v6" }));
  assert.ok(
    !r.items.some((n) => n.id.startsWith("drafts:")),
    "the group is replaced by its member",
  );
  assert.deepEqual(ids(r.items.filter((n) => n.match)), ["render:6"]);
  assert.equal(r.groups[0]?.open, true);
});

test("focus keeps the selected node, what it depends on and what depends on it", () => {
  const { g, ix } = seeded();
  assert.deepEqual(ids(visibleNodes(g, ix, state({ sel: "vo:2", focus: true })).items), [
    "recording:1",
    "storyboard:1",
    "vo:2",
  ]);
  assert.deepEqual(
    ids(visibleNodes(g, ix, state({ sel: "annotations:1", focus: true })).items).filter(
      (i) => i.startsWith("render") || i.startsWith("qa") || i.startsWith("drafts"),
    ),
    [
      "drafts:render:annotations:1",
      "qa:render:1",
      "qa:render:2",
      "render:1",
      "render:2",
      "render:3",
    ],
  );
  assert.deepEqual(
    ids(visibleNodes(g, ix, state({ sel: "qa:render:2", focus: true })).items),
    ["annotations:1", "qa:render:2", "recording:1", "render:2", "storyboard:1", "vo:1"],
    "a QA node brings its final and the chain",
  );
});

test("open groups: in place, capped, '+ N more' on request", () => {
  const { g, ix } = seeded();
  const open = visibleNodes(g, ix, state({ open: new Set(["drafts:render:annotations:1"]) }));
  assert.deepEqual(ids(open.items.filter((n) => n.group)), [
    "render:4",
    "render:5",
    "render:6",
    "render:7",
  ]);
  assert.ok(!open.items.some((n) => n.kind === "drafts"));
  const big = bigProject();
  try {
    const bg = buildGraph(
      big.dir,
      big.slug,
      readState(big.dir) as NonNullable<ReturnType<typeof readState>>,
    );
    const bix = indexGraph(bg);
    const group = bg.nodes
      .filter((n) => n.kind === "drafts")
      .sort((a, b) => (b.members?.length ?? 0) - (a.members?.length ?? 0))[0];
    assert.ok(
      group?.members && group.members.length > GROUP_CAP,
      `a big group (${group?.members?.length})`,
    );
    const capped = visibleNodes(bg, bix, state({ open: new Set([group.id]) }));
    assert.equal(
      capped.items.filter((n) => n.group === group.id && n.kind !== "more").length,
      GROUP_CAP,
    );
    assert.equal(
      capped.items.find((n) => n.kind === "more")?.label,
      `+ ${group.members.length - GROUP_CAP} more`,
    );
    const all = visibleNodes(bg, bix, state({ open: new Set([`${group.id}*`]) }));
    assert.equal(all.items.filter((n) => n.group === group.id).length, group.members.length);
    assert.ok(!all.items.some((n) => n.kind === "more"));
  } finally {
    fs.rmSync(big.root, { recursive: true, force: true });
  }
});

function overlaps(nodes: { x: number; y: number; w: number; h: number; id: string }[]) {
  const bad: string[] = [];
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i] as (typeof nodes)[number];
      const b = nodes[j] as (typeof nodes)[number];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)
        bad.push(`${a.id} / ${b.id}`);
    }
  return bad;
}

test("layout: a column per stage, a parent centred on its children, QA directly under its final, nothing overlaps", () => {
  const { g, ix } = seeded();
  const items = visibleNodes(g, ix, state()).items;
  const l = layoutMap(g, ix, items, 1100);
  const at = (id: string) => l.nodes.find((n) => n.id === id) as (typeof l.nodes)[number];
  const stages = ["storyboard", "recording", "vo", "annotations", "render"];
  for (const n of l.nodes) assert.equal(n.x, 20 + stages.indexOf(n.stage) * l.col, n.id);
  assert.deepEqual(overlaps(l.nodes), []);
  const qa = at("qa:render:2");
  const fin = at("render:2");
  assert.equal(qa.x, fin.x);
  assert.equal(qa.y, fin.y + fin.h + 6, "QA sits right under its final");
  const kids = ["vo:1", "vo:2"].map(at);
  const centre = (n: { y: number; h: number }) => n.y + n.h / 2;
  assert.ok(
    Math.abs(
      centre(at("recording:1")) - (centre(kids[0] as never) + centre(kids[1] as never)) / 2,
    ) < 1,
    "a parent is centred on its children",
  );
  // every drawn dependency has a curve; the headers count what is drawn
  const dep = g.edges.filter(
    (e) =>
      e.rel === "depends-on" &&
      items.some((i) => i.id === e.to) &&
      items.some((i) => i.id === e.from),
  );
  assert.ok(l.edges.filter((e) => !e.unknown && e.rel === "depends-on").length >= dep.length);
  assert.equal(l.heads.find((h) => h.stage === "vo")?.count, 2);
  assert.ok(
    l.edges.some((e) => e.line),
    "the production line is drawn as the line",
  );
});

test("layout: an unknown link is a stub and sorts last; a direct link crosses a stage", async () => {
  const s = seedPanelProject();
  const { startRecord, saveRecord } = await import("../src/render/store.ts");
  const { normalizeOptions } = await import("../src/render/run.ts");
  for (const vo of [1, 99]) {
    const rec = startRecord(s.dir, {
      kind: "draft",
      basedOn: {},
      timeline: 1,
      voVersion: vo,
      take: "take-001",
      by: "edit",
      options: normalizeOptions({}),
      brands: ["neutral"],
      size: { width: 960, height: 540 },
    });
    rec.status = "done";
    saveRecord(s.dir, rec);
  }
  const g = buildGraph(
    s.dir,
    s.slug,
    readState(s.dir) as NonNullable<ReturnType<typeof readState>>,
  );
  const ix = indexGraph(g);
  const l = layoutMap(g, ix, visibleNodes(g, ix, state()).items, 1100);
  assert.equal(
    l.edges.filter((e) => e.unknown).length,
    1,
    "one stub, for the draft whose parent is not recorded",
  );
  assert.equal(l.edges.filter((e) => e.direct).length, 1);
  const unknown = l.nodes.find((n) => n.unknownLink);
  assert.equal(
    unknown && l.nodes.every((n) => n.unknownLink || n.y <= (unknown?.y ?? 0)),
    true,
    "the unknown node sorts last",
  );
  assert.deepEqual(overlaps(l.nodes), []);
});

test("the keyboard walks the dependencies and the column; the outline shows the same nodes once each", () => {
  const { g, ix } = seeded();
  const items = visibleNodes(g, ix, state()).items;
  const l = layoutMap(g, ix, items, 1100);
  assert.equal(neighbour(ix, l, "vo:1", "ArrowLeft"), "recording:1");
  assert.equal(neighbour(ix, l, "vo:1", "ArrowRight"), "annotations:1");
  const col = l.nodes.filter((n) => n.stage === "vo").sort((a, b) => a.y - b.y);
  assert.equal(neighbour(ix, l, col[0]?.id as string, "ArrowDown"), col[1]?.id);
  assert.equal(neighbour(ix, l, col[0]?.id as string, "ArrowUp"), null);
  assert.equal(
    neighbour(ix, l, "qa:render:2", "ArrowLeft"),
    "render:2",
    "from a QA node back to its final",
  );
  assert.equal(neighbour(ix, l, "storyboard:1", "ArrowLeft"), null);
  const flat: string[] = [];
  const walk = (t: { node: { id: string }; children: unknown[] }[]) => {
    for (const n of t) {
      flat.push(n.node.id);
      walk(n.children as never);
    }
  };
  walk(outlineOf(ix, items) as never);
  assert.deepEqual(flat.sort(), ids(items), "the outline lists exactly the drawn nodes, once each");
});

test("a selection the view hides is said, with the reason; a missing one too; the details name what a node is built on", () => {
  const { g, ix } = seeded();
  const items = visibleNodes(g, ix, state({ view: "line", sel: "vo:2" })).items;
  const h = hiddenSelection(g, ix, state({ view: "line", sel: "vo:2" }), items);
  assert.deepEqual([h?.id, h?.why], ["vo:2", "the “Production line” view"]);
  assert.equal(
    hiddenSelection(
      g,
      ix,
      state({ sel: "vo:2" }),
      visibleNodes(g, ix, state({ sel: "vo:2" })).items,
    ),
    null,
  );
  assert.equal(hiddenSelection(g, ix, state({ sel: "vo:99" }), items)?.missing, true);
  const s = state({ q: "storyboard", sel: "render:2" });
  assert.match(
    hiddenSelection(g, ix, s, visibleNodes(g, ix, s).items)?.why ?? "",
    /the search “storyboard”/,
  );
  assert.deepEqual(
    detailsOf(g, ix, "render:2")?.built.map((n) => n.id),
    ["storyboard:1", "recording:1", "vo:1", "annotations:1"],
  );
  assert.deepEqual(detailsOf(g, ix, "render:2")?.open, {
    screen: "render",
    version: 2,
    label: "Render",
  });
  assert.deepEqual(detailsOf(g, ix, "vo:2")?.open, {
    screen: "voice",
    version: 2,
    label: "Voice over",
  });
  assert.deepEqual(
    detailsOf(g, ix, "qa:render:1")?.open,
    { screen: "render", version: 1, label: "Render" },
    "a QA node opens its final",
  );
  assert.equal(detailsOf(g, ix, "drafts:render:annotations:1")?.open.version, undefined);
});

test("a 300-node graph: the model and the layout are fast and nothing overlaps", () => {
  const big = bigProject();
  try {
    const g = buildGraph(
      big.dir,
      big.slug,
      readState(big.dir) as NonNullable<ReturnType<typeof readState>>,
    );
    const ix = indexGraph(g);
    const t0 = performance.now();
    const v = visibleNodes(g, ix, state());
    const l = layoutMap(g, ix, v.items, 1200);
    const search = visibleNodes(g, ix, state({ q: "final" }));
    const ms = performance.now() - t0;
    console.log(
      `map model: ${g.nodes.length} nodes → ${v.items.length} drawn, layout ${l.width}×${l.height} in ${ms.toFixed(0)} ms`,
    );
    assert.ok(ms < 400, `${ms.toFixed(0)} ms`);
    assert.deepEqual(overlaps(l.nodes), []);
    assert.ok(search.items.length > 0 && search.items.length < v.items.length);
  } finally {
    fs.rmSync(big.root, { recursive: true, force: true });
  }
});
