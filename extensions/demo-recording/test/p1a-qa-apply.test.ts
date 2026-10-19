/**
 * P1c PR 17 (Q4): apply the accepted proposals. ONE new draft at the earliest accepted stage, written by the Director (a visible turn) and
 * linked to the fix set; the accepted proposals of later stages become pending fixes in the project; nothing is rendered or synthesized;
 * a recording or a discovery fix is only kept (you start that step yourself).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { registerDirectorWatch } from "../src/director/watch.ts";
import { nextBand, stepStates } from "../src/panel/public/frame-state.js";
import {
  applyFixSet,
  applyMessage,
  fixLinkFor,
  formatPending,
  linkFixDraft,
  listPending,
  openPending,
  pathToRender,
  pendingBlock,
  pendingReminder,
  resolvePending,
} from "../src/qa/apply.ts";
import {
  askRound,
  bullets,
  decideProposal,
  directorBrief,
  proposeReply,
  readFixSet,
  recordProposals,
} from "../src/qa/fixes.ts";
import { qaFile } from "../src/qa/run.ts";
import { listRenders } from "../src/render/store.ts";
import { Runtime } from "../src/runtime.ts";
import { registerQaTool } from "../src/tools/qa.ts";
import { registerVoTool } from "../src/tools/vo.ts";
import { voVersions } from "../src/vo/store.ts";
import { projectContext } from "../src/workdir/context.ts";
import { seedPanelProject } from "./helpers/panel-seed.ts";
import { fauxAssistantMessage, fauxSession, fauxToolCall } from "./helpers/pi-session.ts";

const REPORT = {
  render: 1,
  stage: "render",
  version: 1,
  variant: "neutral",
  createdAt: "2026-10-18T10:00:00.000Z",
  whisper: true,
  items: [
    {
      id: "values-1",
      check: "values",
      level: "warning",
      high: true,
      scene: "01-dash",
      atMs: 2100,
      message: "the narration says 14.3: it isn't on screen",
      identity: { anchor: "m2", value: "14.3" },
    },
    {
      id: "drift-2",
      check: "drift",
      level: "warning",
      high: true,
      scene: "01-dash",
      atMs: 9000,
      message: "the narration for @emea-bar starts 1004 ms after its moment",
      identity: { anchor: "emea-bar" },
    },
    {
      id: "annotations-3",
      check: "annotations",
      level: "blocking",
      hard: "redaction",
      scene: "01-dash",
      atMs: 2500,
      message: "redaction r1 doesn't cover its element here",
      identity: { ref: "r1" },
    },
  ],
};
const P = {
  vo: {
    stage: "vo",
    title: "Rewrite the sentence around @m2",
    change: "Say 14.2 where it says 14.3.",
    why: "Both findings come from that sentence.",
    findings: ["values-1", "drift-2"],
    cost: "re-synthesises 1 section",
  },
  annotations: {
    stage: "annotations",
    title: "Move redaction r1",
    change: "Re-place the redaction over the element's later position.",
    why: "The element moved.",
    findings: ["annotations-3"],
    cost: "nothing",
  },
  recording: {
    stage: "recording",
    title: "Record the scene again",
    change: "A new take of 01-dash with the page loaded first.",
    why: "The page showed a spinner.",
    findings: ["drift-2"],
    cost: "a take: model calls and recording time",
  },
};

function setup() {
  const seed = seedPanelProject();
  fs.mkdirSync(path.dirname(qaFile(seed.dir, 1)), { recursive: true });
  fs.writeFileSync(qaFile(seed.dir, 1), JSON.stringify(REPORT));
  return seed;
}
const cleanup = (root: string) => fs.rmSync(root, { recursive: true, force: true });

/** A fix set with an answered round whose proposals are decided. */
function decided(
  dir: string,
  proposals: (keyof typeof P)[],
  accept: string[],
  notes: Record<string, string> = {},
) {
  const flags = ["values-1", "drift-2", "annotations-3"].map((id) => ({
    id,
    choice: "fix" as const,
  }));
  askRound(dir, 1, { flags, guidance: "" });
  const { round } = recordProposals(dir, "fs-1", {
    nextSteps: ["Approve the new draft", "Render a final"],
    summary: "s",
    proposals: proposals.map((k) => P[k]) as never,
  });
  for (const p of round.proposals ?? []) {
    decideProposal(dir, "fs-1", p.id, {
      decision: accept.includes(p.stage) ? "accepted" : "rejected",
      ...(notes[p.stage] ? { note: notes[p.stage] } : {}),
    });
  }
}

test("applying: the earliest accepted stage gets ONE draft, later accepted stages become pending fixes, rejected ones are neither", () => {
  const seed = setup();
  try {
    decided(seed.dir, ["vo", "annotations", "recording"], ["vo", "annotations"], {
      annotations: "keep the box small",
    });
    const plan = applyFixSet(seed.dir, "fs-1");
    assert.deepEqual([plan.stage, plan.writes, plan.now.map((p) => p.stage)], ["vo", true, ["vo"]]);
    assert.deepEqual(
      plan.pending.map((p) => [p.id, p.stage, p.status]),
      [["pf-1", "annotations", "open"]],
    );
    assert.match(plan.pending[0]?.text ?? "", /^Move redaction r1: Re-place the redaction/);
    assert.equal(plan.pending[0]?.guidance, "keep the box small");
    assert.deepEqual(
      plan.pending[0]?.findings.map((f) => [f.id, f.check, f.scene]),
      [["annotations-3", "annotations", "01-dash"]],
    );
    assert.deepEqual(
      plan.pending[0]?.findings[0]?.identity,
      { ref: "r1" },
      "so it can be recognised again",
    );
    const set = readFixSet(seed.dir, "fs-1");
    assert.equal(set?.status, "open", "open until the Director has written the draft");
    assert.deepEqual(
      [set?.applying?.stage, set?.applying?.proposals, set?.applying?.version],
      ["vo", ["p2"], undefined],
    );
    assert.equal(openPending(seed.dir, "annotations").length, 1);
    assert.equal(openPending(seed.dir, "vo").length, 0);
    // once is enough
    assert.throws(() => applyFixSet(seed.dir, "fs-1"), /already writing this draft/);
    // the message the Director gets is exact about what to do and what not to
    const msg = applyMessage(plan, "[demo-panel]");
    assert.match(
      msg,
      /ACCEPTED 1 fix proposal for the voice-over \(fix set fs-1, round 1, from the QA of render v1\)/,
    );
    assert.match(msg, /write ONE new voice-over draft/);
    assert.match(msg, /demo_rec_qa context first/);
    assert.match(msg, /Do NOT render and do NOT synthesize/);
    assert.match(msg, /pending fixes: leave them/);
    // the Director's brief now carries the accepted proposals, in the user's own wording when they edited
    decideProposal(seed.dir, "fs-1", "p2", { edited: "Say 14.2 only; keep 'steady'." });
    const brief = directorBrief(seed.dir, "fs-1");
    assert.match(brief, /## APPLY: carry out these accepted proposals as ONE new voice-over draft/);
    assert.match(brief, /The user's own wording \(follow it\): Say 14.2 only; keep 'steady'\./);
    assert.doesNotMatch(
      brief,
      /### p3|### p1/,
      "only the accepted proposals of this stage are carried out",
    );
    assert.match(brief, /### p2: Rewrite the sentence around @m2/);
    // the project context tells the Director what waits
    assert.match(
      projectContext(seed.dir, seed.slug),
      /## Pending fixes \(accepted by the user, for a later stage\)\nOpen[^\n]*\n- pf-1 \[annotations\] Move redaction r1/,
    );
  } finally {
    cleanup(seed.root);
  }
});

test("a recording or discovery fix is never done inside this flow: it is kept, and nobody is asked to write", () => {
  const seed = setup();
  try {
    askRound(seed.dir, 1, {
      flags: ["values-1", "drift-2", "annotations-3"].map((id) => ({ id, choice: "fix" as const })),
      guidance: "",
    });
    const { round } = recordProposals(seed.dir, "fs-1", {
      nextSteps: ["Approve the new draft", "Render a final"],
      summary: "s",
      proposals: [{ ...P.recording, findings: ["drift-2", "values-1"] }, P.annotations] as never,
    });
    for (const x of round.proposals ?? [])
      decideProposal(seed.dir, "fs-1", x.id, { decision: "accepted" });
    const plan = applyFixSet(seed.dir, "fs-1");
    assert.deepEqual([plan.stage, plan.writes], ["recording", false]);
    assert.deepEqual(
      plan.pending.map((p) => p.stage),
      ["recording", "annotations"],
      "all accepted fixes are kept",
    );
    const set = readFixSet(seed.dir, "fs-1");
    assert.deepEqual([set?.status, set?.applying?.kept], ["applied", true]);
    assert.equal(linkFixDraft(seed.dir, "vo", 3), undefined, "nothing waits for a draft");
  } finally {
    cleanup(seed.root);
  }
});

test("what cannot be applied is refused", () => {
  const seed = setup();
  try {
    assert.throws(() => applyFixSet(seed.dir, "fs-9"), /there is no fix set fs-9/);
    askRound(seed.dir, 1, { flags: [{ id: "values-1", choice: "fix" }], guidance: "" });
    assert.throws(() => applyFixSet(seed.dir, "fs-1"), /has no answered round to apply/);
    recordProposals(seed.dir, "fs-1", {
      nextSteps: ["Approve the new draft", "Render a final"],
      summary: "s",
      proposals: [{ ...P.vo, findings: ["values-1"] }] as never,
    });
    assert.throws(() => applyFixSet(seed.dir, "fs-1"), /accept at least one proposal first/);
    decideProposal(seed.dir, "fs-1", "p1", { decision: "rejected" });
    assert.throws(() => applyFixSet(seed.dir, "fs-1"), /accept at least one proposal first/);
  } finally {
    cleanup(seed.root);
  }
});

test("the draft the Director writes is linked to the fix set, and only a draft of the right stage", () => {
  const seed = setup();
  try {
    decided(seed.dir, ["vo", "annotations"], ["vo", "annotations"]);
    applyFixSet(seed.dir, "fs-1");
    assert.equal(
      linkFixDraft(seed.dir, "annotations", 5),
      undefined,
      "another stage's draft is not the one",
    );
    assert.equal(fixLinkFor(seed.dir, "vo", 3), undefined);
    const set = linkFixDraft(seed.dir, "vo", 3);
    assert.deepEqual([set?.status, set?.applying?.version], ["applied", 3]);
    assert.deepEqual(fixLinkFor(seed.dir, "vo", 3), { fixset: "fs-1", render: 1 });
    assert.equal(linkFixDraft(seed.dir, "vo", 4), undefined, "once");
    assert.equal(listPending(seed.dir).length, 1);
    assert.match(
      formatPending(seed.dir).join("\n"),
      /Open \(the stage's writer takes these into account\)/,
    );
  } finally {
    cleanup(seed.root);
  }
});

test("the band and the stepper say where a draft comes from", () => {
  const stages = {
    project: "k",
    next: { who: "user", stage: "vo", text: "review voice-over v3" },
    stages: [
      {
        stage: "vo",
        accepted: [{ version: 1 }],
        onInput: [1, 3],
        selected: 3,
        fixLinks: [{ version: 3, fixset: "fs-1", render: 8 }],
      },
    ],
  } as never;
  const states = stepStates({ stages, jobs: [] });
  assert.equal(states.voice?.fixesFrom, 8);
  assert.match(states.voice?.why ?? "", /waiting for review \(fixes from render v8\)$/);
  const band = nextBand({ stages, states, jobs: [] });
  assert.equal(band?.text, "Review voice-over v3 (fixes from render v8)");
  // a draft that was not written from fixes says nothing extra
  const plain = stepStates({
    stages: {
      ...(stages as object),
      stages: [
        { stage: "vo", accepted: [{ version: 1 }], onInput: [1, 3], selected: 3, fixLinks: [] },
      ],
    } as never,
    jobs: [],
  });
  assert.doesNotMatch(plain.voice?.why ?? "", /fixes from/);
});

// --- the whole thing in a real pi session ------------------------------------------------------

test(
  "in a real session: the panel applies, the Director writes ONE voice-over draft, it is linked; nothing is rendered or synthesized",
  { timeout: 40_000 },
  async () => {
    const seed = setup();
    const cfg = path.join(seed.root, "c.json");
    fs.writeFileSync(cfg, "{}");
    const rt = new Runtime(() => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
      root: seed.root,
      panelPort: 0,
    }));
    rt.setActiveProject(seed.slug);
    // biome-ignore lint/suspicious/noExplicitAny: pi's extension API
    const factory = (pi: any) => {
      (rt as unknown as { agent: unknown }).agent = pi;
      registerDirectorWatch(pi, rt);
      registerQaTool(pi, rt);
      registerVoTool(pi, rt);
    };
    const s = await fauxSession({ extensions: [factory] });
    try {
      decided(seed.dir, ["vo", "annotations"], ["vo", "annotations"]);
      const events: string[] = [];
      rt.bus.subscribe((e) => events.push(e.type));
      const before = { vos: voVersions(seed.dir), renders: listRenders(seed.dir).length };
      const script = fs
        .readFileSync(path.join(seed.dir, "vo", `script.v${before.vos.at(-1)}.md`), "utf8")
        .replace("14.2 percent", "14.2 percent, the highest of all");
      let brief = "";
      s.faux.setResponses([
        fauxAssistantMessage([fauxToolCall("demo_rec_qa", { action: "context" })]),
        (context) => {
          brief = JSON.stringify(context.messages);
          return fauxAssistantMessage([
            fauxToolCall("demo_rec_vo", {
              action: "write",
              markdown: script,
              base: before.vos.at(-1) as number,
            }),
          ]);
        },
        fauxAssistantMessage(
          "Written: a new voice-over draft with the number fixed. Please read and approve it.",
        ),
      ]);
      const post = rt.routeTables().post;
      const res = (await post["qa-fix-apply"]?.({ fixset: "fs-1" })) as {
        writes: boolean;
        stage: string;
        pending: unknown[];
      };
      assert.deepEqual([res.writes, res.stage, res.pending.length], [true, "vo", 1]);
      await s.settled(1, 25_000);

      assert.match(
        brief,
        /## APPLY: carry out these accepted proposals as ONE new voice-over draft/,
      );
      assert.match(
        JSON.stringify(s.session.messages),
        /ACCEPTED 1 fix proposal for the voice-over/,
      );
      // one new voice-over version, written by the Director, linked to the fix set
      const after = voVersions(seed.dir);
      assert.equal(after.length, before.vos.length + 1);
      const version = after.at(-1) as number;
      const set = readFixSet(seed.dir, "fs-1");
      assert.deepEqual([set?.status, set?.applying?.version], ["applied", version]);
      assert.deepEqual(fixLinkFor(seed.dir, "vo", version), { fixset: "fs-1", render: 1 });
      assert.ok(events.includes("qa.applied"), "the panel is told");
      // the later fix is pending, for the annotations
      assert.deepEqual(
        openPending(seed.dir).map((p) => [p.stage, p.fixset]),
        [["annotations", "fs-1"]],
      );
      // NOTHING was synthesized or rendered, and no annotation version was made
      assert.equal(rt.jobs.latest("tts"), undefined);
      assert.equal(rt.jobs.latest("render"), undefined);
      assert.equal(rt.jobs.latest("design"), undefined);
      assert.equal(listRenders(seed.dir).length, before.renders);
      assert.equal(
        fs.existsSync(path.join(seed.dir, "vo", "audio", `v${version}.json`)),
        false,
        "no audio for the new draft",
      );
    } finally {
      s.dispose();
      await rt.shutdown();
      cleanup(seed.root);
    }
  },
);

// --- the panel ----------------------------------------------------------------------------------

async function chromium() {
  try {
    const pw = await import("playwright");
    return fs.existsSync(pw.chromium.executablePath()) ? pw.chromium : undefined;
  } catch {
    return undefined;
  }
}
const browserType = await chromium();

test(
  "in the browser: accept, apply, see the Director write, see the draft linked and the pending fix",
  { skip: !browserType && "needs Playwright Chromium", timeout: 90_000 },
  async () => {
    process.env.DEMO_REC_NO_OPEN = "1";
    const seed = setup();
    const cfg = path.join(seed.root, "c.json");
    fs.writeFileSync(cfg, "{}");
    const told: string[] = [];
    const rt = new Runtime(
      () => ({
        ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
        root: seed.root,
        panelPort: 0,
      }),
      { sendUserMessage: (t) => told.push(t), sendMessage: () => {} },
    );
    rt.setActiveProject(seed.slug);
    decided(seed.dir, ["vo", "annotations"], []);
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
      await page.goto(`${panel.url}#/render/v1`);
      const qa = page.locator(".ds-inspector .ds-section", { hasText: "Quality check" });
      // the loop is a window: the list only says where it stands
      await qa.locator("[data-fix-where]").waitFor();
      assert.match(
        await qa.locator("[data-fix-where]").innerText(),
        /Round 1: 2 proposals, 0 accepted/,
      );
      await qa.locator("[data-act=open-fixes]").click();
      const m = page.locator(".modal.fixes");
      await m.locator(".fix-proposal").first().waitFor();
      // readable: the changes are bullets, and the steps to a new render are a numbered list under the proposals
      assert.ok(
        (await m.locator(".fix-proposal .fix-change li").count()) >= 2,
        "bullets, not a paragraph",
      );
      assert.deepEqual(await m.locator(".fix-next li").allInnerTexts(), [
        "Approve the new draft",
        "Render a final",
      ]);
      await m.getByText("Next steps to a new render").first().waitFor();
      assert.equal(
        await m.locator("[data-act=apply-fixes]").count(),
        0,
        "nothing accepted: nothing to apply",
      );
      await m.locator(".fix-proposal[data-stage=vo] [data-decision=accepted]").click();
      await m.locator(".fix-proposal[data-stage=annotations] [data-decision=accepted]").click();
      const apply = m.locator("[data-act=apply-fixes]");
      await apply.waitFor();
      await m.getByRole("button", { name: /Apply 2 accepted proposals/ }).waitFor();
      assert.match(
        await m.locator(".fixes").innerText(),
        /ONE new voice over draft from them\. Nothing is rendered and nothing is synthesized/,
      );
      await apply.click();
      await m
        .getByText(/The Director is writing the voice over draft from the fixes you accepted/)
        .waitFor();
      const steps = await m.locator(".fixes ol[data-next-steps] li").allInnerTexts();
      assert.match(steps[0] ?? "", /Read the new voice-over draft and approve it/);
      assert.match(
        steps.at(-1) ?? "",
        /Render a final[\s\S]*no synthesis or recording happens in a render/,
      );
      assert.match(
        told.at(-1) ?? "",
        /ACCEPTED 1 fix proposal for the voice-over \(fix set fs-1, round 1/,
      );
      assert.equal(await m.locator("[data-act=apply-fixes]").count(), 0, "once");
      assert.equal(
        await m.locator("[data-field=guidance]").count(),
        0,
        "no more asking while it writes",
      );
      await m.getByText("Pending fixes").waitFor();
      assert.match(await m.locator(".fix-pending").innerText(), /Annotations\s+Move redaction r1/);

      // the Director writes the draft (here: the event the tool publishes)
      rt.bus.publish(
        "vo.written",
        { version: 3, by: "agent", message: "voice-over v3 written" },
        seed.slug,
      );
      await m.locator("[data-applied=vo]").waitFor();
      assert.match(
        await m.locator("[data-applied=vo]").innerText(),
        /Applied\. Voice over v3 is a new draft written from your accepted fixes/,
      );
      assert.match((await m.locator("[data-applied=vo] a").getAttribute("href")) ?? "", /#\/voice/);
      if (process.env.P1A_SHOTS)
        await page.screenshot({ path: `${process.env.P1A_SHOTS}-applied.png` });
      await page.close();
    } finally {
      await browser.close();
      await rt.shutdown();
      cleanup(seed.root);
    }
  },
);

// --- readable answers, the stage said, the path to a new render --------------------------------

test("a wall of text is refused with what to cut; the steps to a new render are required", () => {
  const seed = setup();
  try {
    askRound(seed.dir, 1, { flags: [{ id: "values-1", choice: "fix" }], guidance: "" });
    const base = { ...P.vo, findings: ["values-1"] };
    const wall = "x".repeat(500);
    assert.throws(
      () =>
        recordProposals(seed.dir, "fs-1", {
          summary: wall,
          nextSteps: ["a", "b"],
          proposals: [base] as never,
        }),
      /summary is 500 characters: at most 400/,
    );
    assert.throws(
      () =>
        recordProposals(seed.dir, "fs-1", {
          summary: "ok",
          nextSteps: [],
          proposals: [base] as never,
        }),
      /nextSteps: 2 to 7 short steps from the fix to a new render/,
    );
    assert.throws(
      () =>
        recordProposals(seed.dir, "fs-1", {
          summary: "ok",
          nextSteps: ["a", "b".repeat(200)],
          proposals: [base] as never,
        }),
      /nextSteps 2 is 200 characters: at most 170/,
    );
    assert.throws(
      () =>
        recordProposals(seed.dir, "fs-1", {
          summary: "ok",
          nextSteps: ["a", "b"],
          proposals: [{ ...base, why: wall, change: "y".repeat(1500) }] as never,
        }),
      /why is over 320 characters[\s\S]*change is over 1400 characters: bullets, one per edit/,
    );
    // nothing was stored by the refusals
    assert.equal(readFixSet(seed.dir, "fs-1")?.rounds[0]?.status, "asked");
  } finally {
    cleanup(seed.root);
  }
});

test("the chat reply is structured: the stage, the fixes, bullets per change, the numbered steps to a new render", () => {
  const seed = setup();
  try {
    askRound(seed.dir, 1, {
      flags: ["values-1", "drift-2", "annotations-3"].map((id) => ({ id, choice: "fix" as const })),
      guidance: "",
    });
    const steps = [
      "Read the new voice-over draft and approve it",
      "Generate voice, edit and a draft to watch (asks for your Allow)",
      "Render a final and read its QA",
    ];
    const { set, round } = recordProposals(seed.dir, "fs-1", {
      summary: "One sentence causes both.",
      nextSteps: steps,
      proposals: [
        { ...P.vo, change: "- Say 14.2 instead of 14.3\n- Move 'steady' before @m2" },
        P.annotations,
      ] as never,
    });
    const reply = proposeReply(set, round);
    assert.match(
      reply,
      /^\*\*Stage:\*\* Voice-over, the earliest that needs a fix \(then Annotations\)\n\*\*Fixes:\*\* 3 of 3 findings\n/,
    );
    assert.match(
      reply,
      /\*\*Voice-over: Rewrite the sentence around @m2\*\*\n- Say 14.2 instead of 14.3\n- Move 'steady' before @m2\n {2}Cost: re-synthesises 1 section/,
    );
    assert.match(
      reply,
      /\*\*Next steps to a new render:\*\*\n1\. Read the new voice-over draft and approve it\n2\. Generate voice, edit and a draft to watch \(asks for your Allow\)\n3\. Render a final/,
    );
    assert.ok(reply.split("\n").length <= 14, `short: ${reply.split("\n").length} lines`);
    assert.deepEqual(bullets("One. Two! Three?"), ["One.", "Two!", "Three?"]);
    assert.deepEqual(bullets("- a\n* b\n• c"), ["a", "b", "c"]);
  } finally {
    cleanup(seed.root);
  }
});

test("the path from a fix to a new render says what asks for your Allow and what a render does not do", () => {
  const vo = pathToRender("vo");
  assert.match(vo[0] ?? "", /Read the new voice-over draft and approve it/);
  assert.ok(
    vo.some((s) => /only changed sections are synthesised[\s\S]*asks for your Allow/.test(s)),
  );
  assert.match(
    vo.at(-1) ?? "",
    /Render a final[\s\S]*no synthesis or recording happens in a render/,
  );
  const sb = pathToRender("storyboard", ["vo", "annotations"]);
  assert.ok(sb.some((s) => /Record a new take: you start it, and it asks for your Allow/.test(s)));
  assert.ok(sb.some((s) => /pending annotation fixes into account/.test(s)));
  assert.deepEqual(pathToRender("annotations").length, 2, "approve the annotations, then render");
  assert.match(pathToRender("recording")[0] ?? "", /Start the new take yourself/);
  assert.match(pathToRender("discovery")[0] ?? "", /Run the discovery again/);
  for (const stage of ["discovery", "storyboard", "recording", "vo", "annotations"] as const) {
    const steps = pathToRender(stage);
    assert.ok(steps.length >= 2 && steps.length <= 7, `${stage}: ${steps.length} steps`);
    assert.ok(steps.every((s) => s.length <= 260));
  }
});

test("applying: the plan carries the steps, the Director is told the reply shape, and the stage is named", () => {
  const seed = setup();
  try {
    decided(seed.dir, ["vo", "annotations"], ["vo", "annotations"]);
    const plan = applyFixSet(seed.dir, "fs-1");
    assert.equal(plan.path[0], "Read the new voice-over draft and approve it (Voice tab)");
    assert.ok(
      plan.path.some((s) => /pending annotation fixes into account/.test(s)),
      "the accepted annotation fix is pending, and the path says it is taken into account",
    );
    assert.deepEqual(
      readFixSet(seed.dir, "fs-1")?.applying?.path,
      plan.path,
      "kept, so the panel shows it after a reload",
    );
    const msg = applyMessage(plan, "[demo-panel]");
    assert.match(msg, /STRUCTURED, at most 12 lines, in exactly this shape/);
    assert.match(msg, /\*\*Stage:\*\* Voice-over: new draft vN \(fixes from render v1\)/);
    assert.match(
      msg,
      /\*\*Next steps to a new render:\*\*\n1\. Read the new voice-over draft and approve it/,
    );
    assert.match(msg, /nothing was rendered or synthesised/);
  } finally {
    cleanup(seed.root);
  }
});

// --- Q5: the stage writers read the pending fixes and settle them -------------------------------

/** Accept a recording fix + a voice-over fix + an annotations fix: the recording is kept, so all three are pending. */
function pendingThree(dir: string) {
  askRound(dir, 1, {
    flags: ["values-1", "drift-2", "annotations-3"].map((id) => ({ id, choice: "fix" as const })),
    guidance: "",
  });
  const { round } = recordProposals(dir, "fs-1", {
    nextSteps: ["a", "b"],
    summary: "s",
    proposals: [P.recording, P.vo, P.annotations] as never,
  });
  for (const x of round.proposals ?? [])
    decideProposal(dir, "fs-1", x.id, { decision: "accepted" });
  return applyFixSet(dir, "fs-1");
}

test("settling a pending fix: applied names the draft that carries it, dropped says why, once, and the user may drop any", () => {
  const seed = setup();
  try {
    const plan = pendingThree(seed.dir);
    assert.deepEqual(
      plan.pending.map((p) => [p.id, p.stage]),
      [
        ["pf-1", "recording"],
        ["pf-2", "vo"],
        ["pf-3", "annotations"],
      ],
    );
    const vo = (voVersions(seed.dir).at(-1) ?? 1) as number;
    assert.throws(
      () => resolvePending(seed.dir, "pf-9", { status: "dropped", by: "agent", why: "x y z w" }),
      /there is no pending fix pf-9 \(open: pf-1, pf-2, pf-3\)/,
    );
    assert.throws(
      () => resolvePending(seed.dir, "pf-2", { status: "applied", by: "agent", version: vo }),
      /say in a sentence how pf-2 was applied/,
    );
    assert.throws(
      () => resolvePending(seed.dir, "pf-2", { status: "applied", by: "agent", why: "said 14.2" }),
      /applied needs the voice-over version that carries it \(version: /,
    );
    assert.throws(
      () =>
        resolvePending(seed.dir, "pf-2", {
          status: "applied",
          by: "agent",
          why: "said 14.2",
          version: 99,
        }),
      /applied needs the voice-over version/,
    );
    const done = resolvePending(seed.dir, "pf-2", {
      status: "applied",
      by: "agent",
      why: "now says 14.2",
      version: vo,
    });
    assert.deepEqual(
      [done.status, done.version, done.resolvedBy, done.resolvedWhy],
      ["applied", vo, "agent", "now says 14.2"],
    );
    assert.throws(
      () =>
        resolvePending(seed.dir, "pf-2", {
          status: "dropped",
          by: "agent",
          why: "changed my mind",
        }),
      /pf-2 is already applied: now says 14.2/,
    );
    // dropping needs a reason from the Director, not from you
    assert.throws(
      () => resolvePending(seed.dir, "pf-3", { status: "dropped", by: "agent" }),
      /left out/,
    );
    const mine = resolvePending(seed.dir, "pf-3", { status: "dropped", by: "user" });
    assert.deepEqual(
      [mine.status, mine.resolvedBy, mine.resolvedWhy],
      ["dropped", "user", "dropped by you"],
    );
    // a recording has no draft the Director writes: applied needs no version there
    assert.equal(
      resolvePending(seed.dir, "pf-1", {
        status: "applied",
        by: "agent",
        why: "new take 2 is clean",
      }).status,
      "applied",
    );
    assert.equal(openPending(seed.dir).length, 0);
    assert.match(
      formatPending(seed.dir).join("\n"),
      /Resolved:[\s\S]*pf-2[\s\S]*APPLIED: now says 14.2/,
    );
    assert.equal(pendingBlock(seed.dir, "vo").length, 0, "nothing open: nothing to read");
    assert.equal(pendingReminder(seed.dir, "vo", vo), "");
  } finally {
    cleanup(seed.root);
  }
});

test("what a stage's writer reads: its own open pending fixes, with the findings they answer and how to settle them", () => {
  const seed = setup();
  try {
    pendingThree(seed.dir);
    const block = pendingBlock(seed.dir, "vo").join("\n");
    assert.match(
      block,
      /^## Pending fixes for the voice-over \(1\): the user accepted these from a QA\n- pf-2 \(render v1, answers values-1: the narration says 14.3: it isn't on screen; drift-2: [^)]*\): Rewrite the sentence around @m2: Say 14.2/,
    );
    assert.match(
      block,
      /demo_rec_qa resolve with the id, status applied \(and the version that carries it\) or dropped \(and why/,
    );
    assert.doesNotMatch(block, /pf-1|pf-3/, "only this stage's");
    assert.match(
      pendingReminder(seed.dir, "vo", 4),
      /1 pending fix for the voice-over still open \(pf-2\): for each, call demo_rec_qa resolve with status applied \(version 4 if this draft carries it\) or dropped/,
    );
  } finally {
    cleanup(seed.root);
  }
});

test(
  "in a real session: the voice-over writer reads the pending fix, writes, settles it; a wrong version is refused",
  { timeout: 40_000 },
  async () => {
    const seed = setup();
    const cfg = path.join(seed.root, "c.json");
    fs.writeFileSync(cfg, "{}");
    const rt = new Runtime(() => ({
      ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
      root: seed.root,
      panelPort: 0,
    }));
    rt.setActiveProject(seed.slug);
    // biome-ignore lint/suspicious/noExplicitAny: pi's extension API
    const factory = (pi: any) => {
      (rt as unknown as { agent: unknown }).agent = pi;
      registerDirectorWatch(pi, rt);
      registerQaTool(pi, rt);
      registerVoTool(pi, rt);
    };
    const s = await fauxSession({ extensions: [factory] });
    try {
      pendingThree(seed.dir);
      const events: string[] = [];
      rt.bus.subscribe((e) => events.push(`${e.type}`));
      const base = voVersions(seed.dir).at(-1) as number;
      const script = fs
        .readFileSync(path.join(seed.dir, "vo", `script.v${base}.md`), "utf8")
        .replace("14.2 percent", "14.2 percent, the highest of all");
      s.faux.setResponses([
        fauxAssistantMessage([fauxToolCall("demo_rec_vo", { action: "get" })]),
        fauxAssistantMessage([
          fauxToolCall("demo_rec_vo", { action: "write", markdown: script, base }),
        ]),
        fauxAssistantMessage([
          fauxToolCall("demo_rec_qa", {
            action: "resolve",
            pendingId: "pf-2",
            status: "applied",
            why: "the sentence says 14.2 now",
            version: 99,
          }),
        ]),
        fauxAssistantMessage([
          fauxToolCall("demo_rec_qa", {
            action: "resolve",
            pendingId: "pf-2",
            status: "applied",
            why: "the sentence says 14.2 now",
            version: base + 1,
          }),
        ]),
        fauxAssistantMessage([fauxToolCall("demo_rec_qa", { action: "pending" })]),
        fauxAssistantMessage(
          "Applied pf-2 in the new voice-over draft; pf-1 and pf-3 are for other stages.",
        ),
      ]);
      await s.session.prompt("write the next voice-over draft");
      await s.settled(1, 25_000);
      const log = JSON.stringify(s.session.messages);
      assert.match(
        log,
        /## Pending fixes for the voice-over \(1\)/,
        "`get` shows what is open for this stage",
      );
      assert.match(
        log,
        /1 pending fix for the voice-over still open \(pf-2\)/,
        "the write result reminds the writer",
      );
      assert.match(
        log,
        /applied needs the voice-over version that carries it/,
        "a version that does not exist is refused",
      );
      const pf2 = listPending(seed.dir).find((x) => x.id === "pf-2");
      assert.deepEqual(
        [pf2?.status, pf2?.version, pf2?.resolvedBy],
        ["applied", base + 1, "agent"],
      );
      assert.deepEqual(
        openPending(seed.dir).map((x) => x.id),
        ["pf-1", "pf-3"],
        "the other stages' fixes wait for their writers",
      );
      assert.ok(events.includes("qa.pending"), "the panel is told");
      assert.match(log, /pf-2 is applied \(v\d+\): the sentence says 14.2 now/);
    } finally {
      s.dispose();
      await rt.shutdown();
      cleanup(seed.root);
    }
  },
);

test(
  "in the browser: the stage screen says how many fixes are pending, you can drop one, what was settled stays readable",
  { skip: !browserType && "needs Playwright Chromium", timeout: 90_000 },
  async () => {
    process.env.DEMO_REC_NO_OPEN = "1";
    const seed = setup();
    const cfg = path.join(seed.root, "c.json");
    fs.writeFileSync(cfg, "{}");
    const rt = new Runtime(
      () => ({
        ...resolveConfig({ env: { DEMO_REC_CONFIG: cfg } }),
        root: seed.root,
        panelPort: 0,
      }),
      { sendUserMessage: () => {}, sendMessage: () => {} },
    );
    rt.setActiveProject(seed.slug);
    pendingThree(seed.dir);
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
      await page.goto(`${panel.url}#/voice`);
      const box = page.locator(".pending-fixes[data-stage=vo]");
      await box.waitFor();
      assert.match(
        await box.innerText(),
        /1 pending fix for this stage\. You accepted it from a QA; the Director takes it into account when it writes the next draft/,
      );
      assert.match(
        await box.locator("li[data-pending=pf-2]").innerText(),
        /from render v1\s+Rewrite the sentence around @m2: Say 14.2/,
      );
      assert.equal(
        await page.locator(".pending-fixes[data-stage=annotations]").count(),
        0,
        "only this stage's",
      );
      if (process.env.P1A_SHOTS)
        await page.screenshot({ path: `${process.env.P1A_SHOTS}-pending.png` });
      // the Director settles one: the panel follows by itself
      resolvePending(seed.dir, "pf-2", {
        status: "applied",
        by: "agent",
        why: "now says 14.2",
        version: 1,
      });
      rt.bus.publish(
        "qa.pending",
        { id: "pf-2", stage: "vo", status: "applied", by: "agent", message: "settled" },
        seed.slug,
      );
      await box.getByText("Settled (1)").waitFor();
      assert.equal(await box.locator("li[data-pending]").count(), 0);
      await box.getByText("Settled (1)").click();
      assert.match(
        await box.locator("li[data-settled=applied]").innerText(),
        /applied in v1[\s\S]*The Director: now says 14.2/,
      );
      // annotations: drop one yourself, with a reason
      await page.goto(`${panel.url}#/annotations`);
      const ann = page.locator(".pending-fixes[data-stage=annotations]");
      await ann.waitFor();
      await ann.locator("[data-act=drop-pending]").click();
      await page
        .getByRole("textbox", { name: /Why\? \(optional\)/ })
        .fill("I moved the box myself");
      await page.getByRole("button", { name: "Drop it" }).click();
      await ann.getByText("Settled (1)").waitFor();
      assert.deepEqual(
        openPending(seed.dir).map((x) => x.id),
        ["pf-1"],
      );
      assert.equal(
        listPending(seed.dir).find((x) => x.id === "pf-3")?.resolvedWhy,
        "I moved the box myself",
      );
      await page.close();
    } finally {
      await browser.close();
      await rt.shutdown();
      cleanup(seed.root);
    }
  },
);
