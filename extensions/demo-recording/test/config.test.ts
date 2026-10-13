import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { configFilePath, resolveConfig } from "../src/config.ts";

const HOME = "/home/tester";
const noFile = () => undefined;

test("defaults: ~/DemoRecordings, 1600x900@2x, 1080p30, EL-first chain", () => {
  const cfg = resolveConfig({ env: {}, home: HOME, readFile: noFile });
  assert.equal(cfg.root, path.join(HOME, "DemoRecordings"));
  assert.deepEqual(cfg.viewport, { width: 1600, height: 900, dpr: 2 });
  assert.deepEqual(cfg.output, { width: 1920, height: 1080 });
  assert.equal(cfg.fps, 30);
  assert.deepEqual(cfg.ttsChain, ["elevenlabs", "openai", "kokoro"]);
  assert.deepEqual(cfg.sources, ["defaults"]);
});

test("config file path: DEMO_REC_CONFIG wins over ~/.config default", () => {
  assert.equal(
    configFilePath({}, HOME),
    path.join(HOME, ".config", "demo-recording", "config.json"),
  );
  assert.equal(configFilePath({ DEMO_REC_CONFIG: "/x/c.json" }, HOME), "/x/c.json");
});

test("precedence: defaults < file < env", () => {
  const file = JSON.stringify({
    root: "~/Videos/demos",
    panelPort: 4000,
    viewport: { width: 1440 },
    ttsChain: ["openai", "say"],
    voiceName: "Stefan v2",
  });
  const fromFile = resolveConfig({ env: {}, home: HOME, readFile: () => file });
  assert.equal(fromFile.root, path.join(HOME, "Videos", "demos"));
  assert.equal(fromFile.panelPort, 4000);
  assert.deepEqual(
    fromFile.viewport,
    { width: 1440, height: 900, dpr: 2 },
    "partial override keeps other fields",
  );
  assert.deepEqual(fromFile.ttsChain, ["openai", "say"]);
  assert.equal(fromFile.voiceName, "Stefan v2");

  const withEnv = resolveConfig({
    env: {
      DEMO_REC_ROOT: "/data/rec",
      DEMO_REC_PANEL_PORT: "5000",
      DEMO_REC_TTS_CHAIN: "kokoro,say",
      DEMO_REC_VOICE: "Other",
    },
    home: HOME,
    readFile: () => file,
  });
  assert.equal(withEnv.root, "/data/rec");
  assert.equal(withEnv.panelPort, 5000);
  assert.deepEqual(withEnv.ttsChain, ["kokoro", "say"]);
  assert.equal(withEnv.voiceName, "Other");
  assert.equal(withEnv.sources.length, 3);
  assert.match(withEnv.sources[2] ?? "", /DEMO_REC_ROOT/);
});

test("malformed or invalid config is a hard error with a useful message", () => {
  assert.throws(
    () => resolveConfig({ env: {}, home: HOME, readFile: () => "{nope" }),
    /not valid JSON/,
  );
  assert.throws(() => resolveConfig({ env: {}, home: HOME, readFile: () => "[]" }), /JSON object/);
  assert.throws(
    () => resolveConfig({ env: {}, home: HOME, readFile: () => '{"fps":0}' }),
    /"fps" must be a positive integer/,
  );
  assert.throws(
    () => resolveConfig({ env: {}, home: HOME, readFile: () => '{"ttsChain":["polly"]}' }),
    /unknown TTS engine "polly"/,
  );
  assert.throws(
    () => resolveConfig({ env: { DEMO_REC_PANEL_PORT: "abc" }, home: HOME, readFile: noFile }),
    /DEMO_REC_PANEL_PORT/,
  );
});
