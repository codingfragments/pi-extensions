import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initRunDir } from "../scripts/pass1-init.ts";

async function withTmp(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "poc-video-init-"));
  await fn(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

test("initRunDir creates the full run structure", async () => {
  await withTmp(async (root) => {
    const { runDir, created } = await initRunDir("turso", root, { title: "Turso demo" });
    assert.equal(created, true);
    for (const f of ["run.yaml", "storyboard.yaml", "vo.yaml", "findings/README.md"]) {
      assert.ok(fs.existsSync(path.join(runDir, f)), `missing ${f}`);
    }
    assert.ok(fs.existsSync(path.join(runDir, "scenes")));
    const run = fs.readFileSync(path.join(runDir, "run.yaml"), "utf8");
    assert.ok(run.includes("target: turso"));
    assert.ok(run.includes('title: "Turso demo"'));
    assert.ok(run.includes("start_url:"));
    assert.ok(run.includes('name: "Stefan"'));
    // storyboard is the template copy — validates clean against the schema
    const sb = fs.readFileSync(path.join(runDir, "storyboard.yaml"), "utf8");
    assert.ok(sb.includes("meta:"));
  });
});

test("initRunDir is idempotent — never overwrites an existing run", async () => {
  await withTmp(async (root) => {
    await initRunDir("turso", root);
    const first = await initRunDir("turso", root, { title: "CHANGED" });
    assert.equal(first.created, false);
    const run = fs.readFileSync(path.join(root, "turso", "run.yaml"), "utf8");
    assert.ok(!run.includes("CHANGED"), "existing run.yaml must not be overwritten");
  });
});

test("initRunDir rejects non-kebab-case target names", async () => {
  await withTmp(async (root) => {
    await assert.rejects(() => initRunDir("Not Valid", root), /kebab-case/);
  });
});
