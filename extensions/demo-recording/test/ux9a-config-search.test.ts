/**
 * UX9a (D125): which settings a search and the quick filters show, the highlight, the search state in the
 * address, and that secrets are never indexed. Pure logic over the settings view's shape, no browser.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FILTERS,
  filterGroups,
  haystack,
  highlight,
  isSecret,
  queryFromSearch,
  searchFromQuery,
  showValue,
  wordsOf,
} from "../src/panel/public/config-search.js";

type S = Parameters<typeof haystack>[0];
const s = (o: Partial<S> & { key: string }): S =>
  ({
    label: o.key,
    doc: "",
    type: "string",
    value: null,
    source: "default",
    layers: { default: null, global: null, project: null },
    ...o,
  }) as S;
const GROUPS = [
  {
    id: "voice",
    label: "Voice",
    settings: [
      s({
        key: "voiceName",
        label: "Voice name",
        doc: "Name used for narration.",
        value: "Stefan_trained",
        source: "global",
        layers: { default: "default", global: "Stefan_trained", project: null },
      }),
      s({
        key: "ttsChain",
        label: "Engine order",
        doc: "Which text-to-speech engine goes first.",
        value: ["say"],
        source: "env",
        envSet: true,
        envVar: "DEMO_REC_TTS_CHAIN",
        layers: { default: ["elevenlabs"], global: null, project: null },
      }),
    ],
  },
  {
    id: "capture",
    label: "Capture",
    settings: [
      s({
        key: "fps",
        label: "Frames per second",
        doc: "How smooth the recording is.",
        value: 30,
        source: "project",
        layers: { default: 30, global: 24, project: 30 },
      }),
      s({
        key: "viewport.width",
        label: "Width",
        doc: "Recording width in pixels.",
        value: 1600,
        layers: { default: 1600, global: null, project: null },
      }),
    ],
  },
];
const keys = (r: ReturnType<typeof filterGroups>) =>
  r.groups.flatMap((g) => g.settings.map((x: S) => x.key));

test("no query and no filter: nothing is hidden, groups untouched", () => {
  const r = filterGroups(GROUPS, {});
  assert.deepEqual([r.searching, r.count, r.total], [false, 4, 4]);
  assert.equal(r.groups, GROUPS);
});

test("every word must match, in any order, on key, label, description, values and source words", () => {
  const f = (q: string, project: string | null = "keycraft") =>
    keys(filterGroups(GROUPS, { q, project }));
  assert.deepEqual(
    f("voice"),
    ["voiceName"],
    "label and key, not the engine's description 'text-to-speech'",
  );
  assert.deepEqual(f("NARRATION name"), ["voiceName"], "case-insensitive, any order");
  assert.deepEqual(f("stefan"), ["voiceName"], "a value");
  assert.deepEqual(f("pixels"), ["viewport.width"], "the description");
  assert.deepEqual(f("1600"), ["viewport.width"]);
  assert.deepEqual(f("project"), ["fps"], "the source word");
  assert.deepEqual(f("environment"), ["ttsChain"]);
  assert.deepEqual(f("overridden"), ["fps"], "overridden only with a project open");
  assert.deepEqual(f("overridden", null), []);
  assert.deepEqual(f("changed"), ["voiceName", "ttsChain"], "differs from the default");
  assert.deepEqual(f("voice name pixels"), []);
  assert.deepEqual(f("zzz"), []);
});

test("while searching, groups without a match drop out and the counts say so", () => {
  const r = filterGroups(GROUPS, { q: "fps" });
  assert.deepEqual(
    r.groups.map((g: { id: string }) => g.id),
    ["capture"],
  );
  assert.deepEqual([r.count, r.total, r.searching], [1, 4, true]);
});

test("quick filters: Changed, Overridden here, From environment; they combine with each other and the text", () => {
  const f = (filters: string[], q = "", project: string | null = "keycraft") =>
    keys(filterGroups(GROUPS, { q, filters: new Set(filters), project }));
  assert.deepEqual(f(["changed"]), ["voiceName", "ttsChain"]);
  assert.deepEqual(f(["overridden"]), ["fps"]);
  assert.deepEqual(f(["overridden"], "", null), [], "without a project nothing is overridden here");
  assert.deepEqual(f(["env"]), ["ttsChain"]);
  assert.deepEqual(f(["changed", "env"]), ["ttsChain"], "both must hold");
  assert.deepEqual(f(["changed"], "narration"), ["voiceName"]);
  assert.deepEqual(f(["env", "overridden"]), []);
  assert.deepEqual(
    FILTERS.map(([id]) => id),
    ["changed", "overridden", "env"],
  );
});

test("secrets: their values are never indexed or shown, only that one is set", () => {
  const key = s({
    key: "elevenlabs.apiKey",
    label: "ElevenLabs key",
    value: "sk-top-secret-1",
    layers: { default: null, global: "sk-top-secret-1", project: null },
  });
  assert.equal(isSecret(key), true);
  assert.equal(isSecret(s({ key: "authToken" })), true);
  assert.equal(isSecret(s({ key: "voiceName" })), false);
  assert.equal(showValue(key, "sk-top-secret-1"), "set");
  assert.equal(showValue(key, null), "—");
  assert.equal(haystack(key, null).includes("sk-top-secret"), false);
  assert.deepEqual(
    keys(filterGroups([{ id: "x", label: "X", settings: [key] }], { q: "sk-top" })),
    [],
  );
  assert.deepEqual(
    keys(filterGroups([{ id: "x", label: "X", settings: [key] }], { q: "elevenlabs" })),
    ["elevenlabs.apiKey"],
    "the key and label can still be found",
  );
});

test("values are shown as text: lists joined, objects as JSON, nothing as a dash", () => {
  const plain = s({ key: "a" });
  assert.equal(showValue(plain, ["a", "b"]), "a, b");
  assert.equal(showValue(plain, { x: 1 }), '{"x":1}');
  assert.equal(showValue(plain, 0), "0");
  assert.equal(showValue(plain, false), "false");
  assert.equal(showValue(plain, undefined), "—");
});

test("highlight: the parts that contain a word, merged, case-insensitive; no words, no marks", () => {
  assert.deepEqual(highlight("Voice name", wordsOf("voice")), [
    { t: "Voice", hit: true },
    { t: " name", hit: false },
  ]);
  assert.deepEqual(highlight("aXbxc", wordsOf("x")), [
    { t: "a", hit: false },
    { t: "X", hit: true },
    { t: "b", hit: false },
    { t: "x", hit: true },
    { t: "c", hit: false },
  ]);
  assert.deepEqual(
    highlight("abcd", wordsOf("ab bc")),
    [
      { t: "abc", hit: true },
      { t: "d", hit: false },
    ],
    "overlapping words merge",
  );
  assert.deepEqual(highlight("text", []), [{ t: "text", hit: false }]);
  assert.deepEqual(highlight("", wordsOf("x")), [{ t: "", hit: false }]);
});

test("the search state lives in the address: defaults left out, unknown filters ignored", () => {
  assert.deepEqual(queryFromSearch({}), {});
  assert.deepEqual(queryFromSearch({ q: "voice", filters: new Set(["changed", "env"]) }), {
    q: "voice",
    filter: "changed,env",
  });
  assert.deepEqual(queryFromSearch({ view: "brands", q: "ignored" }), {
    view: "brands",
    q: "ignored",
  });
  const st = searchFromQuery({ q: "voice", filter: "changed,nope,env" });
  assert.deepEqual([st.q, [...st.filters], st.view], ["voice", ["changed", "env"], "settings"]);
  assert.equal(searchFromQuery({ view: "brands" }).view, "brands");
  assert.equal(searchFromQuery({ view: "weird" }).view, "settings");
});
