/**
 * UX17 (D131): the voices of the account as a picker in Config (voiceName) and in the brief (Voice), with a text
 * fallback. The list route is read-only, cached, never carries the key, and a seeded panel never lists a real account.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { VOICES_TTL_MS, voiceListRoutes } from "../src/panel/voice-list-routes.ts";
import { Runtime } from "../src/runtime.ts";
import type { FetchLike } from "../src/tts/engines.ts";
import { answerDialogs } from "./helpers/panel-dialogs.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";

const KEY = "xi-secret-key-0123456789";
const VOICES = {
  voices: [
    { voice_id: "p1", name: "Rachel", category: "premade" },
    { voice_id: "c1", name: "Stefan_trained", category: "cloned" },
    { voice_id: "p2", name: "Adam", category: "premade" },
    { voice_id: "g1", name: "Narrator_gen", category: "generated" },
  ],
};
// biome-ignore lint/suspicious/noExplicitAny: the tests index into replies of many shapes
type Reply = Record<string, any>;
const reply = (status: number, body: unknown) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Awaited<ReturnType<FetchLike>>;

test("the list: yours first, shaped for a picker, the key never in the reply, cached with a refresh and a TTL", async () => {
  let calls = 0;
  let t = 1_000;
  const fetch: FetchLike = async () => {
    calls++;
    return reply(200, VOICES);
  };
  const routes = voiceListRoutes({ apiKey: () => KEY, fetch, now: () => t });
  const get = (q = "") => routes.get.voices?.(new URLSearchParams(q)) as Promise<Reply>;
  const a = await get();
  assert.equal(a.available, true);
  assert.deepEqual(
    a.voices.map((v: { name: string; own: boolean }) => [v.name, v.own]),
    [
      ["Narrator_gen", true],
      ["Stefan_trained", true],
      ["Adam", false],
      ["Rachel", false],
    ],
  );
  assert.equal(JSON.stringify(a).includes(KEY), false, "the key is not in the reply");
  await get();
  assert.equal(calls, 1, "the second call is the cache");
  await get("refresh=1");
  assert.equal(calls, 2, "refresh asks again");
  t += VOICES_TTL_MS + 1;
  await get();
  assert.equal(calls, 3, "and so does an expired cache");
});

test("no key, a refused key and a network failure are told as data, and never carry the key", async () => {
  const none = voiceListRoutes({ apiKey: () => undefined });
  assert.deepEqual(await none.get.voices?.(new URLSearchParams()), {
    available: false,
    reason: "ELEVENLABS_API_KEY is not set",
  });
  const refused = voiceListRoutes({
    apiKey: () => KEY,
    fetch: async () => reply(401, { detail: { status: "missing_permissions" } }),
  });
  const r = (await refused.get.voices?.(new URLSearchParams())) as {
    available: boolean;
    reason: string;
  };
  assert.equal(r.available, false);
  assert.match(r.reason, /Voices: Read|rejected the API key/);
  const down = voiceListRoutes({
    apiKey: () => KEY,
    fetch: async () => {
      throw new Error(`connect failed for ${KEY}`);
    },
  });
  const d = (await down.get.voices?.(new URLSearchParams())) as {
    available: boolean;
    reason: string;
  };
  assert.equal(d.available, false);
  assert.equal(d.reason.includes(KEY), false, "a message that mentions the key is cleaned");
});

test("a seeded panel never lists a real account (tests, screenshots and the audit)", async () => {
  const seed = seedPanelProject();
  const saved = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = KEY;
  try {
    const rt = new Runtime(() => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: path.join(seed.root, "none.json") } }),
      root: seed.root,
      panelPort: 0,
    }));
    const r = (await (rt.routeTables().get.voices as (q: URLSearchParams) => unknown)(
      new URLSearchParams(),
    )) as {
      available: boolean;
      reason: string;
    };
    assert.deepEqual([r.available, r.reason], [false, "ELEVENLABS_API_KEY is not set"]);
    await rt.shutdown();
  } finally {
    if (saved === undefined) Reflect.deleteProperty(process.env, "ELEVENLABS_API_KEY");
    else process.env.ELEVENLABS_API_KEY = saved;
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
const skip = !browserType && "needs Playwright Chromium";

test(
  "in the panel: Config and the brief offer the voices as a select; a typo-proof save; a text fallback without a list",
  { skip, timeout: 120_000 },
  async () => {
    const seed = seedPanelProject();
    const globalFile = path.join(seed.root, "global.json");
    fs.writeFileSync(globalFile, JSON.stringify({ voiceName: "Narrator_voice" }));
    process.env.DEMO_REC_CONFIG = globalFile;
    process.env.DEMO_REC_NO_OPEN = "1";
    const rt = new Runtime(() => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: globalFile } }),
      root: seed.root,
      panelPort: 0,
    }));
    rt.tellAgent = () => undefined;
    rt.setActiveProject(seed.slug);
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    const page = await (
      await browser.newContext({ viewport: { width: 1400, height: 1200 } })
    ).newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const dlg = answerDialogs(page);
    let available = true;
    await page.route("**/api/voices*", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          available
            ? {
                available: true,
                at: 1,
                voices: [
                  { id: "c1", name: "Stefan_trained", category: "cloned", own: true },
                  { id: "p1", name: "Rachel", category: "premade", own: false },
                ],
              }
            : { available: false, reason: "ELEVENLABS_API_KEY is not set" },
        ),
      }),
    );
    try {
      // Config → voiceName: a select with yours first; the value that is not in the account is kept and said
      await page.goto(`${panel.url}#/config?q=voiceName`);
      await page.waitForSelector(".ds-srow[data-key='voiceName']");
      await page.click(".ds-srow[data-key='voiceName'] [data-toggle]");
      await page.click(".ds-srow[data-key='voiceName'] [data-act=edit-global]");
      const select = page.locator("#edit-voiceName[data-voices=list]");
      await select.waitFor();
      const optgroups = await page
        .locator("#edit-voiceName optgroup")
        .evaluateAll("(els) => els.length");
      void optgroups;
      assert.deepEqual(await page.locator("#edit-voiceName optgroup").count(), 2);
      assert.match(
        await page.locator("#edit-voiceName").innerText(),
        /Narrator_voice \(not in your account\)/,
      );
      assert.equal(await select.inputValue(), "Narrator_voice");
      await select.selectOption("Stefan_trained");
      await page.click(".ds-srow[data-key='voiceName'] [data-act=save]");
      for (
        let i = 0;
        i < 100 && JSON.parse(fs.readFileSync(globalFile, "utf8")).voiceName !== "Stefan_trained";
        i++
      )
        await new Promise((r) => setTimeout(r, 50));
      assert.equal(JSON.parse(fs.readFileSync(globalFile, "utf8")).voiceName, "Stefan_trained");
      assert.match(dlg.seen.at(-1) ?? "", /Set voiceName\?[\s\S]*Stefan_trained/);

      // the brief: a Voice field with the same list, and "type a name" still possible
      await page.goto(`${panel.url}#/project?group=brief&field=voice`);
      await page.waitForSelector("[data-fact=voice] select[data-voices=list]");
      assert.equal(await page.inputValue("[data-fact=voice] select"), "");
      await page.selectOption("[data-fact=voice] select", "Rachel");
      await page.click("button:has-text('Save facts')");
      for (
        let i = 0;
        i < 100 &&
        !/Voice:\*{0,2}\s*Rachel/.test(fs.readFileSync(path.join(seed.dir, "brief.md"), "utf8"));
        i++
      )
        await new Promise((r) => setTimeout(r, 50));
      assert.match(
        fs.readFileSync(path.join(seed.dir, "brief.md"), "utf8"),
        /Voice:\*{0,2}\s*Rachel/,
      );
      await page.reload();
      await page.waitForSelector("[data-fact=voice] select");
      assert.equal(await page.inputValue("[data-fact=voice] select"), "Rachel");
      await page.selectOption("[data-fact=voice] select", "__type__");
      await page.waitForSelector("[data-fact=voice] input[type=text]");
      assert.equal(await page.locator("[data-fact=voice] input[type=text]").inputValue(), "Rachel");

      // without a list: the text field it always was, with the reason and a way to try again
      available = false;
      await page.goto(`${panel.url}#/project?group=brief&field=voice`);
      await page.waitForSelector("[data-fact=voice] [data-voices=unavailable]");
      assert.match(
        await page.locator("[data-fact=voice]").innerText(),
        /ELEVENLABS_API_KEY is not set/,
      );
      assert.equal(await page.locator("[data-fact=voice] input[type=text]").count(), 1);
      assert.deepEqual(errors, []);
    } finally {
      dlg.stop();
      await browser.close();
      await rt.shutdown();
      fs.rmSync(seed.root, { recursive: true, force: true });
    }
  },
);
