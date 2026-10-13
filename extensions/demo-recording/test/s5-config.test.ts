import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  applyChange,
  describeConfig,
  knownKeys,
  lineDiff,
  parseValue,
  planChange,
} from "../src/config-edit.ts";
import { resolveConfig } from "../src/config.ts";
import { runDoctor } from "../src/doctor.ts";
import { contextWarning, improviseModelStatus, visionWarning } from "../src/models.ts";
import { type FetchLike, listElevenLabsVoices, sortVoices } from "../src/tts/engines.ts";

let home: string;
let files: { global: string; project: string };
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-cfg-"));
  files = {
    global: path.join(home, ".config", "demo-recording", "config.json"),
    project: path.join(home, "proj", "config.json"),
  };
  fs.mkdirSync(path.dirname(files.global), { recursive: true });
  fs.mkdirSync(path.dirname(files.project), { recursive: true });
  fs.writeFileSync(
    files.global,
    `${JSON.stringify({ _comment: { about: "docs" }, voiceName: "Global Voice", fps: 30 }, null, 2)}\n`,
  );
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

test("layers: defaults < global < project < env, with the source of each value", () => {
  fs.writeFileSync(
    files.project,
    JSON.stringify({ voiceName: "Project Voice", budgets: { discoveryScreens: 80 } }),
  );
  const cfg = resolveConfig({ env: {}, home, projectConfigFile: files.project });
  assert.equal(cfg.voiceName, "Project Voice");
  assert.equal(cfg.budgets.discoveryScreens, 80);
  assert.equal(cfg.budgets.discoveryActions, 150, "untouched keys keep defaults");
  assert.equal(cfg.sources.length, 3);

  const entries = Object.fromEntries(describeConfig(files, {}, home).map((e) => [e.key, e]));
  assert.equal(entries.voiceName?.source, "project");
  assert.equal(entries.fps?.source, "global");
  assert.equal(entries["budgets.discoveryScreens"]?.source, "project");
  assert.equal(entries["align.model"]?.source, "default");
  assert.equal(entries["capture.maxWidth"]?.source, "unset");
  assert.match(entries.voiceName?.doc ?? "", /ElevenLabs voice/);
  const env = Object.fromEntries(
    describeConfig(files, { DEMO_REC_VOICE: "Env Voice" }, home).map((e) => [e.key, e]),
  );
  assert.equal(env.voiceName?.source, "env");
  assert.equal(env.voiceName?.value, "Env Voice");
});

test("planChange: diff only, nothing written; apply keeps _comment; validated by the resolver", () => {
  const before = fs.readFileSync(files.global, "utf8");
  const c = planChange(files, "global", "improvise.hesitateMs", 4500, { env: {}, home });
  assert.equal(fs.readFileSync(files.global, "utf8"), before, "planning writes nothing");
  assert.match(c.diff, /^- {3}"fps": 30$\n^\+ {3}"fps": 30,$\n^\+ {3}"improvise": \{$/m);
  assert.equal(c.effective, 4500);
  applyChange(c);
  const after = JSON.parse(fs.readFileSync(files.global, "utf8"));
  assert.deepEqual(after._comment, { about: "docs" }, "docs block kept");
  assert.equal(after.improvise.hesitateMs, 4500);

  assert.throws(
    () => planChange(files, "global", "fps", 0, { env: {}, home }),
    /"fps" must be a positive integer/,
  );
  assert.throws(
    () => planChange(files, "global", "ttsChain", ["polly"], { env: {}, home }),
    /unknown TTS engine "polly"/,
  );
  assert.throws(
    () => planChange(files, "global", "hesitateMs", 1, { env: {}, home }),
    /unknown setting "hesitateMs" — did you mean improvise.hesitateMs/,
  );
  assert.throws(
    () => planChange(files, "global", "elevenlabs.apiKey", "x", { env: {}, home }),
    /looks like a secret — API keys come from the environment/,
  );
});

test("project scope + shadowing + unset", () => {
  const p = planChange(files, "project", "voiceName", "Demo Voice", { env: {}, home });
  applyChange(p);
  assert.equal(JSON.parse(fs.readFileSync(files.project, "utf8")).voiceName, "Demo Voice");
  const g = planChange(files, "global", "voiceName", "New Global", { env: {}, home });
  assert.match(
    g.shadowedBy ?? "",
    /^project /,
    "a global write under a project override is flagged",
  );
  assert.equal(g.effective, "Demo Voice");
  const e = planChange(files, "global", "ttsChain", ["kokoro"], {
    env: { DEMO_REC_TTS_CHAIN: "say" },
    home,
  });
  assert.equal(e.shadowedBy, "env DEMO_REC_TTS_CHAIN");
  const u = planChange(files, "project", "voiceName", undefined, { env: {}, home, unset: true });
  applyChange(u);
  assert.equal(JSON.parse(fs.readFileSync(files.project, "utf8")).voiceName, undefined);
  assert.throws(
    () => planChange(files, "project", "voiceName", undefined, { env: {}, home, unset: true }),
    /not set in the project config/,
  );
  assert.throws(
    () => planChange({ global: files.global }, "project", "fps", 25, { env: {}, home }),
    /no active project/,
  );
});

test("parseValue, lineDiff, knownKeys", () => {
  assert.equal(parseValue("3000"), 3000);
  assert.deepEqual(parseValue('["a","b"]'), ["a", "b"]);
  assert.equal(parseValue("Stefan_trained"), "Stefan_trained");
  assert.equal(parseValue("true"), true);
  assert.equal(lineDiff("a\nb\nc", "a\nB\nc"), "- b\n+ B");
  const keys = knownKeys();
  for (const k of [
    "voiceName",
    "tts.elevenlabs.model",
    "improvise.models",
    "capture.maxWidth",
    "tts.say.voice",
    "budgets.discoveryMinutes",
  ])
    assert.ok(keys.includes(k), k);
  assert.ok(!keys.includes("sources"));
});

// ---------------- model guards ----------------

test("vision + context warnings; improvise model availability", async () => {
  assert.equal(
    visionWarning({
      provider: "anthropic",
      id: "claude-sonnet-5",
      input: ["text", "image"],
      contextWindow: 1_000_000,
    }),
    undefined,
  );
  assert.match(
    visionWarning({ provider: "ai-gw-baseten", id: "baseten/zai-org/GLM-5.3", input: ["text"] }) ??
      "",
    /no image input: pi drops every screenshot/,
  );
  assert.match(
    contextWarning({ provider: "x", id: "y", contextWindow: 128_000 }) ?? "",
    /128k context/,
  );
  assert.equal(contextWarning({ provider: "x", id: "y", contextWindow: 272_000 }), undefined);

  const registry = {
    find: (p: string, id: string) =>
      p === "anthropic" && id === "claude-haiku-4-5"
        ? { provider: p }
        : p === "openai"
          ? { provider: p }
          : undefined,
    hasConfiguredAuth: (m: never) => (m as { provider: string }).provider === "anthropic",
  };
  const st = improviseModelStatus(
    ["anthropic/claude-haiku-4-5", "openai/gpt-5.4-mini", "nope/x", "bad"],
    registry,
  );
  assert.deepEqual(
    st.map((s) => s.ok),
    [true, false, false, false],
  );
  assert.match(st[1]?.reason ?? "", /no credentials for provider "openai"/);
  assert.match(st[2]?.reason ?? "", /not in pi's model list/);

  const cfg = resolveConfig({ env: {}, home, readFile: () => undefined });
  const probes = {
    run: () => ({ status: 0, stdout: "x libx264" }),
    env: {},
    nodeVersion: "24.0.0",
    chromiumPath: async () => "/c",
    exists: () => true,
    freeBytes: () => 50 * 1024 ** 3,
    ensureWritable: () => {},
  };
  const results = await runDoctor(cfg, {
    ...probes,
    registry,
    sessionModel: {
      provider: "ai-gw-openai",
      id: "openai/gpt-5.4",
      input: ["text"],
      contextWindow: 128_000,
    },
  });
  const byName = Object.fromEntries(results.map((r) => [r.name, r]));
  assert.equal(byName["improvise models"]?.status, "warn");
  assert.equal(byName["session model"]?.status, "warn");
  assert.match(byName["session model"]?.detail ?? "", /no image input/);
});

// ---------------- voices ----------------

test("listElevenLabsVoices + sortVoices: yours first, alphabetical", async () => {
  const fetch: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      voices: [
        { voice_id: "p1", name: "Rachel", category: "premade" },
        { voice_id: "c2", name: "Stefan_trained", category: "professional" },
        { voice_id: "p2", name: "Adam", category: "premade" },
        { voice_id: "c1", name: "Narrator", category: "cloned" },
      ],
    }),
    text: async () => "",
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  const v = sortVoices(await listElevenLabsVoices({ apiKey: "k", fetch }));
  assert.deepEqual(
    v.map((x) => x.name),
    ["Narrator", "Stefan_trained", "Adam", "Rachel"],
  );
  await assert.rejects(listElevenLabsVoices({}), /ELEVENLABS_API_KEY is not set/);
});
