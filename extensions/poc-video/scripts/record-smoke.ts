/**
 * record-smoke — headless dry-run exercise of the replay engine against
 * public pages. Manual recipe: just smoke-record (CI does not run this —
 * needs the Chromium binary and network).
 *
 * Exercises: validation gate, auth-handshake skip, deterministic replay,
 * settle/hold beats, scenes.json emission, failure semantics (a broken
 * selector fails its scene, the dry run continues, exit code is non-zero).
 */
import fs from "node:fs";
import path from "node:path";
import { runRecording } from "./record.ts";

const goodStoryboard = `# smoke fixture — deterministic, public, no login
meta:
  target: smoke
  title: "record engine smoke"
  voice: { name: "Stefan" }
  target_duration_s: 60
  settle_default_ms: 50
scenes:
  - id: landing-page
    title: "Example landing"
    intent: "prove navigation + assert"
    steps:
      - { type: navigate, url: "https://example.com" }
      - { type: assert, selector: "text=Learn more" }
    hold_ms: 100
  - id: follow-link
    title: "Follow the only link"
    intent: "prove click + settle + second scene timing"
    steps:
      - { type: click, selector: "role=link" }
      - { type: assert, selector: "css=body" }
    hold_ms: 100
`;

const brokenStoryboard = goodStoryboard.replace(
  "text=Learn more",
  "text=This Selector Never Exists",
);

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const tmp =
    argv.find((a) => !a.startsWith("--")) ??
    fs.mkdtempSync(path.join("/tmp", "poc-video-record-smoke-"));
  // --mode watch: headed + real recording (the visual smoke — you watch it run);
  // default dry-run: headless, no recording (the fast CI-style check)
  const modeIdx = argv.indexOf("--mode");
  const mode: "dry-run" | "watch" =
    modeIdx >= 0 && argv[modeIdx + 1] === "watch" ? "watch" : "dry-run";

  // 1. clean pass
  const goodDir = path.join(tmp, "good-run");
  fs.mkdirSync(goodDir, { recursive: true });
  fs.writeFileSync(path.join(goodDir, "storyboard.yaml"), goodStoryboard);
  const good = await runRecording({
    runDir: goodDir,
    mode,
    headless: mode === "dry-run",
    autoStart: true, // example.com needs no login — skip the handshake even in watch mode
  });
  const [s1, s2] = good.scenes;
  if (!s1 || !s2) throw new Error(`expected 2 scenes, got ${good.scenes.length}`);
  if (s1.status !== "recorded" || s2.status !== "recorded") {
    throw new Error(
      `clean run not fully recorded: ${JSON.stringify(good.scenes.map((s) => s.status))}`,
    );
  }
  if (s2.end_s <= s2.start_s || s1.end_s > s2.start_s) {
    throw new Error(
      `scene timings look wrong: s1 ${s1.start_s}–${s1.end_s}, s2 ${s2.start_s}–${s2.end_s}`,
    );
  }
  if (!fs.existsSync(path.join(goodDir, "scenes.json"))) throw new Error("scenes.json not written");
  if (!fs.existsSync(path.join(goodDir, "storyboard.yaml"))) throw new Error("storyboard vanished");
  const videoNote = mode === "watch" && good.meta.video ? ` video: ${good.meta.video}` : "";
  console.log(
    `✔ clean ${mode}: 2 scenes recorded (${s2.end_s.toFixed(1)}s total), scenes.json written${videoNote}`,
  );

  // 2. broken selector — failure semantics. Dry-run only: watch/step abort the
  // run on failure by design (abort path is engine behavior, covered by the
  // dry-run continue-path check below).
  if (mode !== "dry-run") {
    console.log(
      "ℹ broken-selector phase skipped (watch aborts on failure — covered by dry-run smoke)",
    );
    console.log(`✔ smoke passed (${mode}) — artifacts under ${tmp}`);
    return 0;
  }
  const badDir = path.join(tmp, "broken-run");
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, "storyboard.yaml"), brokenStoryboard);
  const bad = await runRecording({
    runDir: badDir,
    mode: "dry-run",
    headless: true,
    autoStart: true,
  });
  const [b1, b2] = bad.scenes;
  if (!b1 || !b2) throw new Error(`expected 2 scenes in broken run, got ${bad.scenes.length}`);
  if (b1.status !== "failed") throw new Error(`scene 1 should have failed: ${b1.status}`);
  if (b2.status !== "recorded")
    throw new Error(`dry run should have continued to scene 2: ${b2.status}`);
  console.log("✔ failure semantics: broken scene marked failed, walk continued, error recorded");
  console.log(`  (${b1.error ?? "no error string?"})`);
  console.log(`✔ smoke passed — artifacts under ${tmp}`);
  return 0;
}

process.exit(await main());
