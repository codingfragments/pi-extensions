/**
 * Item 7c (D-R2-10): timestamped notes on a take. Review input: stored per take, nothing sent as you type; "Request a
 * new take" bundles every open note of the storyboard's takes into the Director's message and the input log, once.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { hasBinary } from "../src/media/ffmpeg.ts";
import {
  addNote,
  deleteNote,
  editNote,
  formatNotes,
  markSent,
  openNotes,
  readNotes,
  restoreNote,
} from "../src/recording/notes.ts";
import { Runtime } from "../src/runtime.ts";
import { readInputs } from "../src/workdir/inputs.ts";
import { answerDialogs } from "./helpers/panel-dialogs.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";
import { seedReviewTakes } from "./helpers/review-take.ts";

function project() {
  const seed = seedPanelProject();
  // a second take of the same storyboard
  const t2 = path.join(seed.dir, "takes", "take-002");
  fs.mkdirSync(t2, { recursive: true });
  fs.writeFileSync(
    path.join(t2, "take.json"),
    JSON.stringify({ take: "take-002", storyboardVersion: 1, status: "ok", durationMs: 6000 }),
  );
  return seed;
}

test("the store: add (ids, order by time), edit, delete and restore, validation", () => {
  const seed = project();
  try {
    const a = addNote(seed.dir, "take-001", {
      t: 5000.4,
      scene: "02-search",
      text: "  cursor lingers  ",
    });
    const b = addNote(seed.dir, "take-001", { t: 1200, text: "wrong answer shown" });
    assert.deepEqual(
      [a.id, b.id, a.t, a.text, a.scene, b.scene],
      ["n-001", "n-002", 5000, "cursor lingers", "02-search", undefined],
    );
    assert.deepEqual(
      readNotes(seed.dir, "take-001").map((n) => n.id),
      ["n-002", "n-001"],
      "by time on the take clock",
    );
    assert.deepEqual(readNotes(seed.dir, "take-002"), [], "per take");
    assert.equal(
      editNote(seed.dir, "take-001", "n-001", "cursor lingers too long").text,
      "cursor lingers too long",
    );
    // delete returns the note; restore puts it back as it was, with its own id, so nothing is renumbered
    const gone = deleteNote(seed.dir, "take-001", "n-002");
    assert.deepEqual(
      readNotes(seed.dir, "take-001").map((n) => n.id),
      ["n-001"],
    );
    restoreNote(seed.dir, "take-001", gone);
    assert.deepEqual(
      readNotes(seed.dir, "take-001").map((n) => [n.id, n.t, n.text]),
      [
        ["n-002", 1200, "wrong answer shown"],
        ["n-001", 5000, "cursor lingers too long"],
      ],
    );
    assert.equal(
      addNote(seed.dir, "take-001", { t: 1, text: "next" }).id,
      "n-003",
      "ids do not repeat",
    );
    assert.equal(
      restoreNote(seed.dir, "take-001", gone).id,
      "n-002",
      "restoring twice adds nothing",
    );
    assert.equal(readNotes(seed.dir, "take-001").length, 3);
    // refusals
    assert.throws(() => addNote(seed.dir, "take-001", { t: 1, text: "   " }), /needs text/);
    assert.throws(() => addNote(seed.dir, "take-001", { t: -1, text: "x" }), /needs a time/);
    assert.throws(
      () => addNote(seed.dir, "take-001", { t: Number.NaN, text: "x" }),
      /needs a time/,
    );
    assert.throws(
      () => addNote(seed.dir, "take-001", { t: 1, text: "x".repeat(1001) }),
      /1000 characters/,
    );
    assert.throws(() => addNote(seed.dir, "take-009", { t: 1, text: "x" }), /no take-009/);
    assert.throws(() => addNote(seed.dir, "../x", { t: 1, text: "x" }), /not a take id/);
    assert.throws(() => editNote(seed.dir, "take-001", "n-099", "x"), /no note n-099/);
    assert.throws(() => deleteNote(seed.dir, "take-001", "n-099"), /no note n-099/);
  } finally {
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});

test("open notes across takes, the message lines, marking them sent (a sent note is a record: no edit)", () => {
  const seed = project();
  try {
    addNote(seed.dir, "take-001", { t: 83_400, scene: "03-compare", text: "two\nlines" });
    addNote(seed.dir, "take-002", { t: 500, text: "slow start" });
    const open = openNotes(seed.dir, ["take-001", "take-002"]);
    assert.deepEqual(
      open.map((n) => [n.take, n.id]),
      [
        ["take-001", "n-001"],
        ["take-002", "n-001"],
      ],
    );
    assert.equal(
      formatNotes(open),
      "- take-001 1:23.4 · 03-compare: two ⏎ lines\n- take-002 0:00.5: slow start",
    );
    markSent(seed.dir, [open[0] as (typeof open)[number]], 1, new Date("2026-10-19T12:00:00Z"));
    assert.deepEqual(
      openNotes(seed.dir, ["take-001", "take-002"]).map((n) => n.take),
      ["take-002"],
      "only the unsent ones",
    );
    const sent = readNotes(seed.dir, "take-001")[0];
    assert.deepEqual(sent?.sent, { at: "2026-10-19T12:00:00.000Z", storyboard: 1 });
    assert.throws(() => editNote(seed.dir, "take-001", "n-001", "changed"), /already sent/);
    assert.equal(
      deleteNote(seed.dir, "take-001", "n-001").sent?.storyboard,
      1,
      "can still be removed, and Undo keeps its state",
    );
  } finally {
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});

test("the routes: notes in the take list; a take request carries the open notes once, in the message and the input log", async () => {
  process.env.DEMO_REC_NO_OPEN = "1";
  const seed = project();
  const cfg = path.join(seed.root, "c.json");
  fs.writeFileSync(cfg, "{}");
  const rt = new Runtime(() => ({
    ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
    root: seed.root,
    panelPort: 0,
  }));
  const told: string[] = [];
  const r = rt as unknown as { notifyAgent: (t: string) => void; tellAgent: (t: string) => void };
  r.notifyAgent = (t) => told.push(t);
  r.tellAgent = () => undefined;
  rt.setActiveProject(seed.slug);
  const panel = await rt.ensurePanel();
  const base = `http://127.0.0.1:${panel.port}/api`;
  const auth = { authorization: `Bearer ${panel.token}` };
  const get = async (n: string) =>
    (await (await fetch(`${base}/${n}`, { headers: auth })).json()) as Record<string, unknown>;
  const post = async (n: string, body: unknown) => {
    const res = await fetch(`${base}/${n}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  type Rec = {
    openNotes: number;
    takes: { id: string; notes: { id: string; text: string; sent?: unknown }[] }[];
  };
  try {
    const add = await post("take-note-add", {
      take: "take-001",
      t: 2500,
      scene: "01-dash",
      text: "the KPI flashes",
    });
    assert.equal(add.status, 200);
    await post("take-note-add", { take: "take-002", t: 100, text: "starts late" });
    assert.equal(
      (await post("take-note-add", { take: "take-001", t: 1, text: "" })).status,
      400,
      "an empty note is refused",
    );
    const edited = await post("take-note-edit", {
      take: "take-001",
      id: "n-001",
      text: "the KPI flashes twice",
    });
    assert.equal((edited.json.note as { text: string }).text, "the KPI flashes twice");
    let rec = (await get("recordings?storyboard=1")) as unknown as Rec;
    assert.equal(rec.openNotes, 2);
    assert.deepEqual(
      rec.takes.find((t) => t.id === "take-001")?.notes.map((n) => n.text),
      ["the KPI flashes twice"],
    );
    // delete and undo through the routes
    const del = await post("take-note-delete", { take: "take-002", id: "n-001" });
    assert.equal(((await get("recordings?storyboard=1")) as unknown as Rec).openNotes, 1);
    await post("take-note-restore", { take: "take-002", note: del.json.note });
    assert.equal(((await get("recordings?storyboard=1")) as unknown as Rec).openNotes, 2);

    // nothing was sent while writing notes
    assert.deepEqual(told, []);
    assert.deepEqual(
      readInputs(seed.dir).filter((i) => /re-record/.test(i.text)),
      [],
    );
    // the request carries them: the message, the input log, then they are marked sent
    const rr = await post("rerecord", { storyboard: 1, note: "calmer" });
    assert.equal(rr.status, 200);
    assert.equal(rr.json.notesSent, 2);
    assert.equal(told.length, 1);
    assert.match(told[0] ?? "", /notes: "calmer"/);
    assert.match(
      told[0] ?? "",
      /Notes on earlier takes:\n- take-001 0:02\.5 · 01-dash: the KPI flashes twice\n- take-002 0:00\.1: starts late/,
    );
    const logged = readInputs(seed.dir).find((i) => /re-record/.test(i.text));
    assert.match(
      logged?.text ?? "",
      /calmer[\s\S]*Notes on earlier takes[\s\S]*the KPI flashes twice/,
    );
    assert.deepEqual(logged?.refs, ["take-001#n-001", "take-002#n-001"]);
    rec = (await get("recordings?storyboard=1")) as unknown as Rec;
    assert.equal(rec.openNotes, 0);
    assert.ok(
      rec.takes.every((t) => t.notes.every((n) => n.sent)),
      "every note says it was sent",
    );
    assert.equal(
      (await post("take-note-edit", { take: "take-001", id: "n-001", text: "x" })).status,
      400,
      "a sent note is a record",
    );
    // a second request carries nothing twice
    const again = await post("rerecord", { storyboard: 1 });
    assert.equal(again.json.notesSent, 0);
    assert.doesNotMatch(told[1] ?? "", /Notes on earlier takes/);
  } finally {
    await rt.shutdown();
    fs.rmSync(seed.root, { recursive: true, force: true });
  }
});

async function chromium() {
  try {
    const pw = await import("playwright");
    return fs.existsSync(pw.chromium.executablePath()) ? pw.chromium : undefined;
  } catch {
    return undefined;
  }
}
const browserType = await chromium();
const skip = (!browserType || !hasBinary("ffmpeg")) && "needs Playwright Chromium + ffmpeg";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test(
  "in the browser: add a note at the paused moment (button and N), cancel with Esc, N is not taken from a text field, edit, delete and Undo, a chip seeks, a request sends them once",
  { skip, timeout: 150_000 },
  async () => {
    process.env.DEMO_REC_NO_OPEN = "1";
    const seed = seedPanelProject();
    seedReviewTakes(seed);
    const cfg = path.join(seed.root, "c.json");
    fs.writeFileSync(cfg, "{}");
    const rt = new Runtime(() => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
      root: seed.root,
      panelPort: 0,
    }));
    const told: string[] = [];
    const r = rt as unknown as { notifyAgent: (t: string) => void; tellAgent: (t: string) => void };
    r.notifyAgent = (t) => told.push(t);
    r.tellAgent = () => undefined;
    rt.setActiveProject(seed.slug);
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    const rect = (sel: string) =>
      `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; })()`;
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      const dlg = answerDialogs(page);
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${panel.url}#/recording`);
      await page.waitForSelector(".ds-rv-notes");
      assert.match(await page.locator(".ds-rv-notes").innerText(), /No notes yet/);
      assert.equal(await page.locator("[data-open-notes]").count(), 0);
      const at = (ms: number) =>
        page.waitForFunction(
          `Math.abs(document.querySelector('.ds-rv-video').currentTime - ${ms / 1000}) < 0.15`,
        );
      const seekTo = async (sel: string, ms: number) => {
        await page.click(sel);
        await at(ms);
      };
      // 1: the button, at the moment the video is at, with its scene
      await seekTo(".ds-chapter:nth-child(2) .ds-frame[data-label=m1]", 2700);
      assert.match(
        await page.locator("[data-act=add-note]").innerText(),
        /Add note at 0:02\.7 · 02-search/,
      );
      await page.click("[data-act=add-note]");
      await page.waitForSelector(".ds-note-box textarea");
      await page.waitForFunction("document.activeElement?.tagName === 'TEXTAREA'");
      assert.equal(
        await page.evaluate("document.querySelector('.ds-rv-video').paused"),
        true,
        "the video pauses",
      );
      assert.match(
        await page.locator(".ds-note-box label").innerText(),
        /New note at 0:02\.7 · 02-search/,
      );
      await page.keyboard.type("cursor lingers on the empty state");
      await page.keyboard.press("Control+Enter");
      await page.waitForSelector(".ds-note[data-note=n-001]");
      assert.match(
        await page.locator(".ds-note[data-note=n-001]").innerText(),
        /0:02\.7[\s\S]*02-search[\s\S]*cursor lingers on the empty state/,
      );
      assert.match(await page.locator(".ds-rv-notes h3").innerText(), /1 open/i);
      await page.waitForSelector("[data-open-notes]");
      assert.match(
        await page.locator("[data-open-notes]").innerText(),
        /1 open note will go with it/,
      );
      // 2: the key N, in a chapter further on; Esc cancels and writes nothing
      await seekTo(".ds-chapter:nth-child(3) .ds-chapter-head", 4000);
      await page.focus(".ds-chapter:nth-child(3) .ds-chapter-head");
      await page.keyboard.press("n");
      await page.waitForSelector(".ds-note-box textarea");
      assert.match(
        await page.locator(".ds-note-box label").innerText(),
        /New note at 0:04\.0 · 03-compare/,
      );
      await page.waitForFunction("document.activeElement?.tagName === 'TEXTAREA'");
      await page.keyboard.type("n and + are text here");
      assert.equal(
        await page.inputValue(".ds-note-box textarea"),
        "n and + are text here",
        "typing keeps its letters",
      );
      await page.keyboard.press("Escape");
      await page.waitForSelector(".ds-note-box", { state: "detached" });
      assert.equal(await page.locator(".ds-note").count(), 1, "cancelled: nothing written");
      // a text field outside the workspace is not taken over
      await page.fill("textarea[aria-label='notes for the next take']", "n");
      assert.equal(await page.locator(".ds-note-box").count(), 0);
      await page.fill("textarea[aria-label='notes for the next take']", "");
      // 3: edit in place
      await page.click(".ds-note[data-note=n-001] [data-act=note-edit]");
      await page.fill(".ds-note-box textarea", "cursor lingers too long");
      await page.click("[data-act=note-save]");
      await page.waitForFunction(
        "document.querySelector('.ds-note[data-note=n-001] .ds-note-text')?.textContent === 'cursor lingers too long'",
      );
      // 4: delete and Undo (the note comes back as it was)
      await page.click(".ds-note[data-note=n-001] [data-act=note-delete]");
      await page.waitForSelector(".ds-note", { state: "detached" });
      await page.click("[data-act=toast-action]");
      await page.waitForSelector(".ds-note[data-note=n-001]");
      assert.match(
        await page.locator(".ds-note[data-note=n-001]").innerText(),
        /0:02\.7[\s\S]*cursor lingers too long/,
      );
      // 5: the time chip seeks
      await seekTo(".ds-chapter:nth-child(1) .ds-chapter-head", 0);
      await page.click(".ds-note[data-note=n-001] [data-act=note-seek]");
      await at(2700);
      // 6: the request carries it, once; then it is a record
      const before = told.length;
      await page.click(
        "[data-act]:has-text('Request a new take'), button:has-text('Request a new take')",
      );
      for (let i = 0; i < 100 && told.length === before; i++) await wait(50);
      assert.match(
        told.at(-1) ?? "",
        /Notes on earlier takes:\n- take-001 0:02\.7 · 02-search: cursor lingers too long/,
      );
      await page.waitForSelector(".ds-note[data-sent=true]");
      assert.equal(
        await page.locator(".ds-note[data-note=n-001] [data-act=note-edit]").count(),
        0,
        "a sent note is not editable",
      );
      assert.match(await page.locator(".ds-rv-notes h3").innerText(), /all sent/i);
      assert.equal(await page.locator("[data-open-notes]").count(), 0);
      dlg.stop();
      assert.deepEqual(errors, []);

      // layout: three columns when there is room, the notes under the chapters when not, the order of a stacked page
      const col = async (w: number) => {
        await page.setViewportSize({ width: w, height: 900 });
        await wait(250);
      };
      await col(1400);
      const pane = (await page.evaluate(rect(".ds-rv-pane"))) as { right: number };
      const notes = (await page.evaluate(rect(".ds-rv-notes"))) as { left: number };
      assert.ok(
        notes.left >= pane.right - 1,
        "1400 px: the notes are a third column beside the player",
      );
      await col(1100);
      const chapters = (await page.evaluate(rect(".ds-rv-chapters"))) as {
        bottom: number;
        left: number;
      };
      const under = (await page.evaluate(rect(".ds-rv-notes"))) as { top: number; left: number };
      assert.ok(
        under.top >= chapters.bottom - 1 && Math.abs(under.left - chapters.left) < 2,
        "1100 px: the notes under the chapters",
      );
      await col(800);
      const p3 = (await page.evaluate(rect(".ds-rv-pane"))) as { bottom: number };
      const n3 = (await page.evaluate(rect(".ds-rv-notes"))) as { top: number; bottom: number };
      const c3 = (await page.evaluate(rect(".ds-rv-chapters"))) as { top: number };
      assert.ok(
        p3.bottom <= n3.top + 1 && n3.bottom <= c3.top + 1,
        "800 px: the player, then the notes, then the chapters",
      );
      assert.equal(
        await page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
        true,
        "no sideways scroll",
      );
    } finally {
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
