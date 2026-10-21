/**
 * Item 14 (E, D146): managing projects. The zip reader, what goes into an archive (and what never does), the read-back that must pass before anything is
 * deleted, the Projects routes, switching, and `/demo archive` from the chat.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { cmdArchive } from "../src/commands/demo.ts";
import { resolveConfig } from "../src/config.ts";
import {
  ACTIVE_ENTRY,
  archiveProject,
  deleteProject,
  folderBytes,
  listProjectRows,
  planArchive,
  verifyArchive,
} from "../src/projects/manage.ts";
import { Runtime } from "../src/runtime.ts";
import { crcOf, crcOfEntry, readZipIndex, writeZip } from "../src/util/zip.ts";
import { appDir, ensureProject, projectDir } from "../src/workdir/layout.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

/** The seeded project, with the things an archive must treat differently: a cache, a saved login, a draft render and a final render. */
function seedWithExtras() {
  const seed = seedPanelProject();
  const p = ensureProject(seed.root, {
    project: "keycraft",
    appName: "Keycraft",
    appUrl: "https://keycraft.example",
  });
  const app = appDir(seed.root, p.app.slug);
  fs.mkdirSync(path.join(seed.dir, "previews"), { recursive: true });
  fs.writeFileSync(path.join(seed.dir, "previews", "clip.mp4"), "cache");
  fs.mkdirSync(path.join(app, "auth"), { recursive: true });
  fs.writeFileSync(path.join(app, "auth", "state.json"), '{"cookies":"SECRET"}');
  fs.mkdirSync(path.join(app, "discovery", "s1", "screens"), { recursive: true });
  fs.writeFileSync(path.join(app, "discovery", "s1", "screens", "s001.jpg"), "jpg");
  for (const [v, kind] of [
    [1, "draft"],
    [2, "final"],
  ] as const) {
    fs.mkdirSync(path.join(seed.dir, "render", `v${v}`), { recursive: true });
    fs.writeFileSync(path.join(seed.dir, "render", `v${v}`, "full.mp4"), `${kind} video`);
    fs.writeFileSync(
      path.join(seed.dir, "render", `v${v}.json`),
      JSON.stringify({ kind, version: v }),
    );
  }
  return { ...seed, app, appSlug: p.app.slug };
}
const names = (entries: { name: string }[]) => entries.map((e) => e.name);

test("the zip reader: names, sizes and CRCs of what the writer wrote, and the stored bytes of each entry", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zip-"));
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "hello");
    fs.writeFileSync(path.join(dir, "b.bin"), Buffer.alloc(3000, 7));
    const out = path.join(dir, "x.zip");
    await writeZip(out, [
      { name: "p/a.txt", file: path.join(dir, "a.txt") },
      { name: "p/sub/b.bin", file: path.join(dir, "b.bin") },
    ]);
    const idx = readZipIndex(out);
    assert.deepEqual(
      idx.map((e) => [e.name, e.size]),
      [
        ["p/a.txt", 5],
        ["p/sub/b.bin", 3000],
      ],
    );
    for (const e of idx)
      assert.equal(
        await crcOfEntry(out, e),
        await crcOf(path.join(dir, e.name.endsWith("a.txt") ? "a.txt" : "b.bin")),
      );
    assert.throws(() => readZipIndex(path.join(dir, "a.txt")), /not a zip file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("what goes in: the project and its app, under their own paths; never caches, never the app's saved login; draft videos only on request", () => {
  const s = seedWithExtras();
  try {
    const plan = planArchive(s.root, s.slug);
    const n = names(plan.entries);
    assert.ok(n.includes(`projects/${s.slug}/state.json`));
    assert.ok(
      n.includes(`projects/${s.slug}/render/v1/full.mp4`) &&
        n.includes(`projects/${s.slug}/render/v2/full.mp4`),
    );
    assert.ok(n.includes(`apps/${s.appSlug}/app.json`), "the app record");
    assert.ok(
      n.includes(`apps/${s.appSlug}/discovery/s1/screens/s001.jpg`),
      "the discovery screens the storyboard's pictures point to",
    );
    assert.ok(!n.some((x) => x.includes("/previews/")), "no caches");
    assert.ok(!n.some((x) => x.includes("/auth/")), "the saved login never goes into a backup");
    assert.deepEqual(plan.left, { caches: 1, auth: true, drafts: 0 });
    const lean = planArchive(s.root, s.slug, { withoutDrafts: true });
    const ln = names(lean.entries);
    assert.ok(
      !ln.includes(`projects/${s.slug}/render/v1/full.mp4`),
      "the draft's video is left out",
    );
    assert.ok(ln.includes(`projects/${s.slug}/render/v1.json`), "its record stays");
    assert.ok(ln.includes(`projects/${s.slug}/render/v2/full.mp4`), "a final is never left out");
    assert.ok(lean.left.drafts >= 1, "the seed has more draft renders than the one added here");
    assert.ok(
      !ln.some((x) => /\/render\/v[4-7]\/.+\.mp4$/.test(x)),
      "no draft video of the seeded drafts either",
    );
    assert.throws(() => planArchive(s.root, "nope"), /no demo project "nope"/);
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test("archive: one verified zip in <root>/archive, the project untouched; a damaged zip does not verify; a project too big is refused with the reason", async () => {
  const s = seedWithExtras();
  try {
    const r = await archiveProject(s.root, s.slug, { now: new Date("2026-10-21T09:08:07Z") });
    assert.equal(r.file, path.join(s.root, "archive", `${s.slug}-20261021-090807.zip`));
    assert.equal(r.verified, true);
    assert.ok(r.files > 5 && r.bytes > 0);
    assert.ok(fs.existsSync(path.join(s.dir, "state.json")), "the project stays");
    assert.equal(
      fs.readdirSync(path.join(s.root, "archive")).filter((f) => f.endsWith(".part")).length,
      0,
    );
    const again = await archiveProject(s.root, s.slug, { now: new Date("2026-10-21T09:08:07Z") });
    assert.equal(
      again.file,
      path.join(s.root, "archive", `${s.slug}-20261021-090807-2.zip`),
      "the same second: a number, nothing replaced",
    );
    // a flipped byte in the zip is found
    const entries = planArchive(s.root, s.slug).entries;
    const bad = path.join(s.root, "bad.zip");
    fs.copyFileSync(r.file, bad);
    const idx = readZipIndex(bad).find((e) => e.name.endsWith("state.json"));
    const buf = fs.readFileSync(bad);
    const at = (idx?.offset ?? 0) + 30 + Buffer.byteLength(idx?.name ?? "") + 2;
    buf.writeUInt8((buf.readUInt8(at) ^ 0xff) & 0xff, at);
    fs.writeFileSync(bad, buf);
    await assert.rejects(() => verifyArchive(bad, entries), /state\.json: the bytes differ/);
    // too big: the reason, no zip left
    await assert.rejects(
      () =>
        archiveProject(s.root, s.slug, { limitBytes: 10, now: new Date("2026-10-21T09:08:08Z") }),
      /too big for one zip \(the writer stops at 4 GiB\): try again without the draft renders/,
    );
    await assert.rejects(
      () =>
        archiveProject(s.root, s.slug, {
          limitBytes: 10,
          withoutDrafts: true,
          now: new Date("2026-10-21T09:08:09Z"),
        }),
      /even without the draft renders/,
    );
    assert.deepEqual(
      fs.readdirSync(path.join(s.root, "archive")).sort(),
      [path.basename(r.file), path.basename(again.file)].sort(),
      "a refused archive leaves nothing behind",
    );
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test("delete: the name must be typed; the zip is verified first; only the project's folder goes, the app stays; a failed zip deletes nothing", async () => {
  const s = seedWithExtras();
  try {
    await assert.rejects(
      () => deleteProject(s.root, s.slug, "keycraf"),
      /type the project's name \(keycraft\) to delete it/,
    );
    assert.ok(fs.existsSync(s.dir), "a wrong name deletes nothing");
    await assert.rejects(
      () => deleteProject(s.root, s.slug, s.slug, { limitBytes: 10 }),
      /too big for one zip/,
    );
    assert.ok(fs.existsSync(s.dir), "no zip, no delete");
    const r = await deleteProject(s.root, s.slug, s.slug);
    assert.equal(r.removed, projectDir(s.root, s.slug));
    assert.equal(fs.existsSync(s.dir), false);
    assert.ok(fs.existsSync(r.file), "the zip is there");
    assert.ok(fs.existsSync(path.join(s.app, "app.json")), "the app is shared and stays");
    assert.deepEqual(listProjectRows(s.root), []);
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test("the list: name, app, phase, size, last change, which is active", () => {
  const s = seedWithExtras();
  try {
    ensureProject(s.root, { project: "second", appName: "Other", appUrl: "https://other.example" });
    const rows = listProjectRows(s.root, "second");
    assert.deepEqual(
      rows.map((r) => [r.slug, r.active]),
      [
        ["keycraft", false],
        ["second", true],
      ],
    );
    const k = rows.find((r) => r.slug === "keycraft");
    assert.equal(k?.appName, "Keycraft");
    assert.ok((k?.bytes ?? 0) > 0 && k?.bytes === folderBytes(s.dir));
    assert.match(k?.updatedAt ?? "", /^\d{4}-\d\d-\d\dT/);
    assert.equal(rows.find((r) => r.slug === "second")?.phase, "brief");
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

interface Reply {
  error?: string;
  active?: string | null;
  archive?: string;
  projects: { slug: string }[];
  verified?: boolean;
  file: string;
  wasActive?: boolean;
}

function runtimeFor(s: ReturnType<typeof seedWithExtras>) {
  process.env.DEMO_REC_NO_OPEN = "1";
  const entries: unknown[][] = [];
  const told: string[] = [];
  const rt = new Runtime(
    () => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(s.root, "none.json") } }),
      root: s.root,
      panelPort: 0,
    }),
    {
      sendUserMessage: () => undefined,
      sendMessage: (m: { content: string }) => told.push(m.content),
      appendEntry: (...a: unknown[]) => entries.push(a),
    } as never,
  );
  rt.setActiveProject(s.slug);
  return { rt, entries, told };
}

test("the routes: list, switch (remembered, the Director told, refused while a job runs), archive, delete (the active one clears)", async () => {
  const s = seedWithExtras();
  const { rt, entries, told } = runtimeFor(s);
  try {
    ensureProject(s.root, { project: "second", appName: "Other", appUrl: "https://other.example" });
    const panel = await rt.ensurePanel();
    const call = async (n: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${panel.port}/api/${n}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${panel.token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, json: (await res.json()) as Reply };
    };
    const list = await call("projects");
    assert.deepEqual(
      [list.json.active, list.json.projects.map((p: { slug: string }) => p.slug)],
      ["keycraft", ["keycraft", "second"]],
    );
    assert.equal(list.json.archive, path.join(s.root, "archive"));
    // switching: refused while a job of the active project runs
    const running = rt.jobs.running;
    (rt.jobs as { running: unknown }).running = () => ({ kind: "tts", id: "tts-1" });
    const refused = await call("project-switch", { slug: "second" });
    assert.equal(refused.status, 400);
    assert.match(String(refused.json.error), /a tts job of "keycraft" is running \(tts-1\)/);
    assert.equal(rt.activeProjectSlug, "keycraft");
    const refusedArchive = await call("project-archive", { slug: "keycraft" });
    assert.match(String(refusedArchive.json.error), /before you archive it/);
    (rt.jobs as { running: unknown }).running = running;
    const ok = await call("project-switch", { slug: "second" });
    assert.equal(ok.status, 200);
    assert.equal(rt.activeProjectSlug, "second");
    assert.deepEqual(
      entries.at(-1),
      [ACTIVE_ENTRY, { project: "second" }],
      "remembered across a restart of pi",
    );
    assert.match(
      told.at(-1) ?? "",
      /^\[demo-panel · You\] The user switched the active project to "second"/,
    );
    assert.equal((await call("project-switch", { slug: "nope" })).status, 400);
    // archive the other one; the active one is untouched
    const arch = await call("project-archive", { slug: "keycraft" });
    assert.equal(arch.status, 200);
    assert.equal(arch.json.verified, true);
    assert.ok(fs.existsSync(arch.json.file));
    // delete: the wrong name, then the right one; the active project clears
    const wrong = await call("project-delete", { slug: "second", confirmName: "sec" });
    assert.match(String(wrong.json.error), /type the project's name \(second\)/);
    const del = await call("project-delete", { slug: "second", confirmName: "second" });
    assert.equal(del.status, 200);
    assert.equal(del.json.wasActive, true);
    assert.equal(rt.activeProjectSlug, undefined);
    assert.deepEqual(entries.at(-1), [ACTIVE_ENTRY, { project: null }]);
    assert.deepEqual(
      (await call("projects")).json.projects.map((p: { slug: string }) => p.slug),
      ["keycraft"],
    );
  } finally {
    await rt.shutdown();
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test("/demo archive: the active project by default, --delete only with the name, the reason on refusal, what was left out", async () => {
  const s = seedWithExtras();
  const { rt } = runtimeFor(s);
  try {
    const said: string[] = [];
    const ctx = { ui: { notify: (t: string) => said.push(t) } } as never;
    await cmdArchive(rt, [], ctx);
    assert.match(
      said.at(-1) ?? "",
      /^archived keycraft: \d+ files, [\d.]+ MB, read back and verified\n.*archive\/keycraft-\d{8}-\d{6}\.zip\nleft out: 1 cache item\(s\), the saved login of the app$/,
    );
    await cmdArchive(rt, ["--delete"], ctx);
    assert.match(said.at(-1) ?? "", /^--delete needs the project's name/);
    await cmdArchive(rt, ["keycraft", "--wat"], ctx);
    assert.match(said.at(-1) ?? "", /unknown option --wat/);
    assert.ok(fs.existsSync(s.dir), "nothing deleted so far");
    await cmdArchive(rt, ["keycraft", "--delete", "--no-drafts"], ctx);
    assert.match(
      said.at(-1) ?? "",
      /^deleted keycraft: .*\nleft out: .*\d+ draft render folder\(s\)\nthe project folder is gone; there is no active project now \(\/demo open\)$/s,
    );
    assert.equal(fs.existsSync(s.dir), false);
    assert.equal(rt.activeProjectSlug, undefined);
    await cmdArchive(rt, [], ctx);
    assert.match(said.at(-1) ?? "", /^no project: \/demo archive <project>/);
  } finally {
    await rt.shutdown();
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});
