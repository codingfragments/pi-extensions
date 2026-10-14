/**
 * Full S4 pipeline on the Acme Pulse fixture with the CONFIGURED voice chain
 * (your ElevenLabs voice when the key + voice name are set): record → analyze
 * → example voice-over → approve (as cli) → voice → edit. Leaves the outputs
 * for watching. Used by `cli.ts fixture-demo` and the live ElevenLabs check.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeTake } from "../analysis/take.ts";
import type { DemoRecConfig } from "../config.ts";
import { type EditResult, runEdit } from "../edit/pipeline.ts";
import { serveFixture } from "../fixture/server.ts";
import { recordTake } from "../recorder/runner.ts";
import { writeStoryboard } from "../storyboard/store.ts";
import { buildEngines } from "../tts/factory.ts";
import { type VoiceManifest, renderVoice } from "../tts/synthesize.ts";
import { writeVo } from "../vo/store.ts";
import { ensureProject } from "../workdir/layout.ts";
import { acceptTake, approve } from "../workdir/state.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_STORYBOARD = path.join(
  HERE,
  "..",
  "..",
  "fixtures",
  "storyboards",
  "s3-human.yaml",
);

export const FIXTURE_VO = (take: string) => `---
take: ${take}
---
## _intro
Churn looks fine on this dashboard. Split it by region, and it is not.

## 01-dashboard — Where churn hides
Headline churn is three point one percent. [@emea-bar] The regional chart says otherwise: EMEA is far above everyone else.

## _bridge:02-search
So instead of building a report, I'll just ask.

## 02-search — Ask in plain language
Plain language search. [@type-start] Churn by region, nothing more. [@results-visible] It gets the grouping right first try, and EMEA leads at {{dom:results-visible|EMEA\\s+([\\d.]+%)}}.

## 03-assistant — Ask why
Now the why. [@question] I ask the assistant directly. [@answer] It names the accounts behind the number, led by Litware Bank.

## _outro
Two questions, and the regional churn problem is on the table.
`;

export interface FixtureDemoResult {
  projectDir: string;
  voice: VoiceManifest;
  edit: EditResult;
}

export async function runFixtureDemo(
  config: DemoRecConfig,
  opts: { project?: string; log?: (m: string) => void; voiceName?: string } = {},
): Promise<FixtureDemoResult> {
  const log = opts.log ?? (() => {});
  const fixture = await serveFixture(0);
  try {
    const project = ensureProject(config.root, {
      project: opts.project ?? "fixture-demo",
      appName: "Acme Pulse",
      appUrl: fixture.url,
    });
    // Stage chain: store and approve the storyboard the take is based on.
    const stored = writeStoryboard(
      project.dir,
      fs.readFileSync(FIXTURE_STORYBOARD, "utf8").replace("start_url: /", "start_url: /?slow=1"),
    );
    approve(project.dir, "storyboard", stored.version);
    const storyboard = stored.storyboard;
    log("recording the fixture take …");
    const take = await recordTake({
      projectDir: project.dir,
      storyboard,
      storyboardVersion: stored.version,
      baseUrl: fixture.url,
      viewport: config.viewport,
      fps: config.fps,
      capture: config.capture,
    });
    log(`${take.takeId}: ${(take.durationMs / 1000).toFixed(1)} s — analyzing …`);
    await analyzeTake(take.takeDir);
    acceptTake(project.dir, take.takeId);
    const vo = writeVo(project.dir, FIXTURE_VO(take.takeId));
    approve(project.dir, "vo", vo.version);
    const engines = buildEngines({
      ...config,
      ...(opts.voiceName ? { voiceName: opts.voiceName } : {}),
    });
    log(`synthesizing voice (chain: ${config.ttsChain.join(" → ")}) …`);
    const voice = await renderVoice({
      projectDir: project.dir,
      voVersion: vo.version,
      take: take.takeId,
      sections: vo.validated.resolved,
      engines,
      alignModel: config.align.model,
      onProgress: (p) =>
        log(`  voice ${p.done}/${p.total} ${p.section}${p.cached ? " (cached)" : ""}`),
    });
    log(
      `voice: ${voice.engine} "${voice.voice.name}"${voice.skipped.length ? ` (skipped: ${voice.skipped.map((s) => `${s.engine}: ${s.reason}`).join("; ")})` : ""}`,
    );
    log("editing + rendering …");
    const edit = await runEdit({
      projectDir: project.dir,
      config,
      onProgress: (p) => log(`  render ${p.done}/${p.total} ${p.label}`),
    });
    return { projectDir: project.dir, voice, edit };
  } finally {
    await fixture.close();
  }
}
