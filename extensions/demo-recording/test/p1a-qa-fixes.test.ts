/**
 * P1c PR 16 (Q3): flag findings, ask the Director for suggested fixes, decide on its proposals, ask it to rethink.
 * The goal of a round is ONE run at the EARLIEST stage that needs a fix, fixing as many problems as possible; nothing is applied.
 * The store and its rules, the whole loop through a REAL pi session (a scripted Director uses the real tool), and the panel.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { registerDirectorWatch } from "../src/director/watch.ts";
import {
  FIX_STAGES,
  acceptedEarliest,
  askRound,
  askedRound,
  decideProposal,
  directorBrief,
  failRound,
  flaggable,
  listFixSets,
  openFixSet,
  readFixSet,
  recordProposals,
  saveDraft,
} from "../src/qa/fixes.ts";
import { addIgnore } from "../src/qa/ignores.ts";
import { qaFile } from "../src/qa/run.ts";
import { Runtime } from "../src/runtime.ts";
import { registerQaTool } from "../src/tools/qa.ts";
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
    {
      id: "media-4",
      check: "media",
      level: "warning",
      scene: "01-dash",
      atMs: 20000,
      message: "no narration for 4.6 s",
      identity: { kind: "pause", relMs: 1000 },
    },
    {
      id: "media-5",
      check: "media",
      level: "info",
      message: "9 held frames",
      identity: { kind: "held" },
    },
    {
      id: "media-6",
      check: "media",
      level: "blocking",
      hard: "integrity",
      message: "the audio is silent",
    },
  ],
};

function setup() {
  const seed = seedPanelProject();
  fs.mkdirSync(path.dirname(qaFile(seed.dir, 1)), { recursive: true });
  fs.writeFileSync(qaFile(seed.dir, 1), JSON.stringify(REPORT));
  return seed;
}
const cleanup = (root: string) => fs.rmSync(root, { recursive: true, force: true });
const fix = (...ids: string[]) => ids.map((id) => ({ id, choice: "fix" as const }));

const P0 = {
  stage: "vo",
  title: "Rewrite two sentences of 01-dash",
  change:
    "Say 14.2 where it says 14.3, and move 'EMEA is the outlier' 1 s earlier so it starts on the bar.",
  why: "Both findings come from the sentence around @m2 and @emea-bar.",
  findings: ["values-1", "drift-2"],
  cost: "re-synthesises 1 section",
};
const P1 = {
  stage: "annotations",
  title: "Move redaction r1",
  change: "Re-place the redaction over the element's later position.",
  why: "The element moved.",
  findings: ["annotations-3"],
  cost: "nothing",
};
const PROPOSALS = [P0, P1];

// --- the store and its rules ---------------------------------------------------------------------

test("what can be flagged: not a broken file, not info, not what you ignored", () => {
  const seed = setup();
  try {
    assert.deepEqual(
      flaggable(seed.dir, 1).map((i) => i.id),
      ["values-1", "drift-2", "annotations-3", "media-4"],
    );
    addIgnore(seed.dir, {
      version: 1,
      itemId: "media-4",
      scope: "finding",
      reason: "fine",
      by: "panel",
    });
    assert.deepEqual(
      flaggable(seed.dir, 1).map((i) => i.id),
      ["values-1", "drift-2", "annotations-3"],
    );
    assert.throws(
      () => saveDraft(seed.dir, 1, { flags: fix("media-6"), guidance: "" }),
      /cannot be flagged/,
    );
    assert.throws(
      () => saveDraft(seed.dir, 1, { flags: fix("nope"), guidance: "" }),
      /cannot be flagged/,
    );
  } finally {
    cleanup(seed.root);
  }
});

test("a draft is kept; asking needs a Fix flag and one ask at a time; the round carries what you wrote", () => {
  const seed = setup();
  try {
    saveDraft(seed.dir, 1, {
      flags: [
        { id: "values-1", choice: "fix" },
        { id: "media-4", choice: "leave" },
      ],
      guidance: "keep the intro",
    });
    const set = openFixSet(seed.dir, 1);
    assert.equal(set.id, "fs-1");
    assert.deepEqual(
      set.draft.flags.map((f) => f.choice),
      ["fix", "leave"],
    );
    assert.equal(openFixSet(seed.dir, 1).id, "fs-1", "one open fix set per render");
    assert.throws(
      () => askRound(seed.dir, 1, { flags: [{ id: "media-4", choice: "leave" }], guidance: "" }),
      /flag at least one finding as Fix/,
    );
    const { round } = askRound(seed.dir, 1, {
      flags: fix("values-1", "drift-2"),
      guidance: " shorter please ",
    });
    assert.deepEqual([round.n, round.status, round.guidance], [1, "asked", "shorter please"]);
    assert.throws(
      () => askRound(seed.dir, 1, { flags: fix("values-1"), guidance: "" }),
      /has not answered the last ask yet/,
    );
    assert.equal(askedRound(readFixSet(seed.dir, "fs-1") as never)?.n, 1);
  } finally {
    cleanup(seed.root);
  }
});

test("a proposal round: one run per stage, the earliest stage computed, every finding answered", () => {
  const seed = setup();
  try {
    askRound(seed.dir, 1, { flags: fix("values-1", "drift-2", "annotations-3"), guidance: "" });
    // two proposals for one stage: refused, with what to do
    assert.throws(
      () =>
        recordProposals(seed.dir, "fs-1", {
          nextSteps: ["Approve the new draft", "Render a final"],
          summary: "x",
          proposals: [
            { ...P0, findings: ["values-1"] },
            {
              ...P0,
              title: "Another voice-over change",
              findings: ["drift-2"],
            },
            { ...P1 },
          ],
        }),
      /proposals 1 and 2 are both for vo: merge them into ONE proposal per stage/,
    );
    // a flagged finding nobody answers
    assert.throws(
      () =>
        recordProposals(seed.dir, "fs-1", {
          nextSteps: ["Approve the new draft", "Render a final"],
          summary: "x",
          proposals: [P0 as never],
        }),
      /annotations-3 is flagged but neither answered by a proposal nor named under unresolved/,
    );
    // a proposal for a finding that was not flagged, a bad stage, thin text
    assert.throws(
      () =>
        recordProposals(seed.dir, "fs-1", {
          nextSteps: ["Approve the new draft", "Render a final"],
          summary: "x",
          proposals: [
            {
              ...P0,
              findings: ["values-1", "media-4"],
              stage: "everything",
              change: "short",
            },
          ],
        }),
      /stage "everything" is not one of.*say concretely.*media-4 is not a finding the user flagged as Fix/s,
    );
    assert.equal(
      readFixSet(seed.dir, "fs-1")?.rounds[0]?.status,
      "asked",
      "nothing was stored by the refused answers",
    );

    // the answer, given in the wrong order: sorted earliest first, earliest computed
    const { round } = recordProposals(seed.dir, "fs-1", {
      nextSteps: ["Approve the new draft", "Render a final"],
      summary: "The sentence around @m2 is the cause of two findings; the redaction is separate.",
      proposals: [P1 as never, P0 as never],
    });
    assert.deepEqual(
      round.proposals?.map((p) => [p.id, p.stage, p.decision]),
      [
        ["p1", "vo", "undecided"],
        ["p2", "annotations", "undecided"],
      ],
    );
    assert.equal(round.earliest, "vo");
    assert.equal(round.status, "proposed");
    // an honest "I cannot": named under unresolved with a reason (a second ask)
    askRound(seed.dir, 1, { flags: fix("values-1", "annotations-3"), guidance: "again" });
    const second = recordProposals(seed.dir, "fs-1", {
      nextSteps: ["Approve the new draft", "Render a final"],
      summary: "only one",
      proposals: [{ ...P0, findings: ["values-1"] }],
      unresolved: [{ finding: "annotations-3", why: "needs a new annotation version first" }],
    });
    assert.equal(second.round.unresolved?.[0]?.finding, "annotations-3");
    // no ask waiting: the Director cannot propose
    assert.throws(
      () =>
        recordProposals(seed.dir, "fs-1", {
          nextSteps: ["Approve the new draft", "Render a final"],
          summary: "x",
          proposals: [P0 as never],
        }),
      /no open ask/,
    );
    assert.deepEqual(FIX_STAGES, [
      "discovery",
      "storyboard",
      "recording",
      "vo",
      "annotations",
      "render",
    ]);
  } finally {
    cleanup(seed.root);
  }
});

test("your decisions, edits and notes are kept, and the Director sees them when it is asked to rethink", () => {
  const seed = setup();
  try {
    askRound(seed.dir, 1, { flags: fix("values-1", "drift-2", "annotations-3"), guidance: "" });
    recordProposals(seed.dir, "fs-1", {
      nextSteps: ["Approve the new draft", "Render a final"],
      summary: "first answer",
      proposals: PROPOSALS as never,
    });
    const { proposal } = decideProposal(seed.dir, "fs-1", "p1", {
      decision: "accepted",
      note: "yes but keep 'steady'",
      edited: "Say 14.2 only; leave the rest.",
    });
    assert.deepEqual(
      [proposal.decision, proposal.note, proposal.edited],
      ["accepted", "yes but keep 'steady'", "Say 14.2 only; leave the rest."],
    );
    decideProposal(seed.dir, "fs-1", "p2", { decision: "rejected", note: "the redaction is fine" });
    assert.equal(acceptedEarliest(readFixSet(seed.dir, "fs-1")?.rounds[0]), "vo");
    assert.throws(
      () => decideProposal(seed.dir, "fs-1", "p9", { decision: "accepted" }),
      /no proposal p9/,
    );
    assert.throws(
      () => decideProposal(seed.dir, "fs-1", "p1", { decision: "maybe" as never }),
      /decision is/,
    );
    decideProposal(seed.dir, "fs-1", "p1", { edited: "" });
    assert.equal(
      readFixSet(seed.dir, "fs-1")?.rounds[0]?.proposals?.[0]?.edited,
      undefined,
      "an empty edit removes it",
    );

    // rethink: more context, a second ask. The Director's brief carries round 1 with the decisions and the notes
    askRound(seed.dir, 1, {
      flags: fix("values-1", "drift-2"),
      guidance: "the intro must stay; only fix the numbers",
    });
    const brief = directorBrief(seed.dir, "fs-1");
    assert.match(brief, /# Fix set fs-1, round 2 \(QA of render v1\)/);
    assert.match(brief, /the intro must stay; only fix the numbers/);
    assert.match(brief, /## Earlier rounds/);
    assert.match(
      brief,
      /p1 \[voice-over\] Rewrite two sentences of 01-dash: ACCEPTED, the user's note: "yes but keep 'steady'"/,
    );
    assert.match(
      brief,
      /p2 \[annotations\] Move redaction r1: REJECTED, the user's note: "the redaction is fine"/,
    );
    assert.match(
      brief,
      /values-1 \[needs the user's eyes\] values in 01-dash at 2.1 s: the narration says 14.3/,
    );
    assert.match(brief, /ONE proposal per stage/);
    // a note on the same stage carries over to the new proposal
    const next = recordProposals(seed.dir, "fs-1", {
      nextSteps: ["Approve the new draft", "Render a final"],
      summary: "second",
      proposals: [{ ...P0, findings: ["values-1", "drift-2"] }],
    });
    assert.equal(next.round.proposals?.[0]?.note, "yes but keep 'steady'");
    assert.equal(
      next.round.proposals?.[0]?.decision,
      "undecided",
      "you decide again on the new answer",
    );
  } finally {
    cleanup(seed.root);
  }
});

test("a flagged-to-leave finding is named so the Director leaves it; a failed or cancelled ask can be asked again", () => {
  const seed = setup();
  try {
    askRound(seed.dir, 1, {
      flags: [...fix("values-1"), { id: "media-4", choice: "leave" }],
      guidance: "",
    });
    assert.match(
      directorBrief(seed.dir, "fs-1"),
      /Flagged to leave as they are \(do not propose anything for these\): media-4/,
    );
    failRound(seed.dir, "fs-1", "you cancelled this ask");
    assert.equal(readFixSet(seed.dir, "fs-1")?.rounds[0]?.status, "failed");
    assert.equal(askRound(seed.dir, 1, { flags: fix("values-1"), guidance: "" }).round.n, 2);
    assert.match(
      projectContext(seed.dir, seed.slug),
      /## QA fixes in progress\n- fs-1 \(QA of render v1\): round 2 asked/,
    );
  } finally {
    cleanup(seed.root);
  }
});

// --- the whole loop in a real pi session ---------------------------------------------------------

async function loop(seed: { root: string; slug: string }, rt: Runtime) {
  // biome-ignore lint/suspicious/noExplicitAny: pi's extension API
  const factory = (pi: any) => {
    (rt as unknown as { agent: unknown }).agent = pi;
    registerDirectorWatch(pi, rt);
    registerQaTool(pi, rt);
  };
  void seed;
  return fauxSession({ extensions: [factory] });
}

test(
  "in a real session: the panel asks, the Director reads the brief and proposes, a bad answer is refused, nothing is applied",
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
    const s = await loop(seed, rt);
    try {
      const post = rt.routeTables().post;
      const vo = fs.readFileSync(path.join(seed.dir, "vo", "script.v1.md"), "utf8");
      // you flag and ask
      await post["qa-fix-flag"]?.({
        version: 1,
        flags: fix("values-1", "drift-2", "annotations-3"),
        guidance: "keep the intro",
      });
      const seen: string[] = [];
      s.faux.setResponses([
        fauxAssistantMessage([fauxToolCall("demo_rec_qa", { action: "context" })]),
        // a first answer with two proposals for the voice-over: refused by the tool
        fauxAssistantMessage([
          fauxToolCall("demo_rec_qa", {
            action: "propose",
            nextSteps: [
              "Read the new draft and approve it",
              "Generate voice, edit and a draft to watch (asks for your Allow)",
            ],
            summary: "two voice-over changes",
            proposals: [
              { ...P0, findings: ["values-1"] },
              { ...P0, title: "Second voice-over change", findings: ["drift-2"] },
              P1,
            ],
          }),
        ]),
        // the merged answer
        (context) => {
          seen.push(JSON.stringify(context.messages));
          return fauxAssistantMessage([
            fauxToolCall("demo_rec_qa", {
              action: "propose",
              nextSteps: [
                "Read the new draft and approve it",
                "Generate voice, edit and a draft to watch (asks for your Allow)",
              ],
              summary: "One voice-over run fixes two findings; the redaction is separate.",
              proposals: PROPOSALS,
            }),
          ]);
        },
        fauxAssistantMessage(
          "Proposed: a voice-over rewrite and a redaction move. Waiting for you.",
        ),
      ]);
      const asked = (await post["qa-fix-ask"]?.({
        version: 1,
        flags: fix("values-1", "drift-2", "annotations-3"),
        guidance: "keep the intro",
      })) as { fixset: { id: string } };
      assert.equal(asked.fixset.id, "fs-1");
      await s.settled(1, 25_000);

      // the Director was told exactly what to do, read the brief, was refused once and answered with one proposal per stage
      const log = JSON.stringify(s.session.messages);
      assert.match(
        log,
        /flagged 3 QA findings of render v1 to fix and asks for suggested fixes \(fix set fs-1, round 1\)/,
      );
      assert.match(log, /# Fix set fs-1, round 1 \(QA of render v1\)/);
      assert.match(log, /keep the intro/);
      assert.match(
        seen.join(""),
        /merge them into ONE proposal per stage/,
        "the refusal reached the Director",
      );
      const set = readFixSet(seed.dir, "fs-1");
      const round = set?.rounds[0];
      assert.equal(round?.status, "proposed");
      assert.deepEqual(
        round?.proposals?.map((p) => p.stage),
        ["vo", "annotations"],
      );
      assert.equal(round?.earliest, "vo");
      assert.deepEqual(
        round?.proposals?.[0]?.findings,
        ["values-1", "drift-2"],
        "grouped: one run, two findings",
      );
      // NOTHING was applied: no new voice-over, annotations or render version, the script is as it was
      assert.equal(fs.readFileSync(path.join(seed.dir, "vo", "script.v1.md"), "utf8"), vo);
      assert.equal(fs.existsSync(path.join(seed.dir, "vo", "script.v3.md")), false);
      assert.deepEqual(
        listFixSets(seed.dir).map((x) => x.status),
        ["open"],
      );
      // the Director's state ended and the panel got the news
      assert.equal(rt.director.snapshot().working, false);
    } finally {
      s.dispose();
      await rt.shutdown();
      cleanup(seed.root);
    }
  },
);

test(
  "in a real session: you add context and ask the Director to rethink; it sees round 1 with your decisions and notes",
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
    const s = await loop(seed, rt);
    try {
      const post = rt.routeTables().post;
      let briefSeen = "";
      s.faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("demo_rec_qa", {
            action: "propose",
            nextSteps: [
              "Read the new draft and approve it",
              "Generate voice, edit and a draft to watch (asks for your Allow)",
            ],
            summary: "round one",
            proposals: PROPOSALS,
          }),
        ]),
        fauxAssistantMessage("round one is in"),
        fauxAssistantMessage([fauxToolCall("demo_rec_qa", { action: "context" })]),
        (context) => {
          briefSeen = JSON.stringify(context.messages);
          return fauxAssistantMessage([
            fauxToolCall("demo_rec_qa", {
              action: "propose",
              nextSteps: [
                "Read the new draft and approve it",
                "Generate voice, edit and a draft to watch (asks for your Allow)",
              ],
              summary: "round two: only the numbers",
              proposals: [
                {
                  ...P0,
                  findings: ["values-1", "drift-2"],
                  change:
                    "Only the numbers: say 14.2, and move the EMEA sentence 1 s earlier. Keep the intro.",
                },
              ],
              unresolved: [{ finding: "annotations-3", why: "you said leave the redaction" }],
            }),
          ]);
        },
        fauxAssistantMessage("round two is in"),
      ]);
      await post["qa-fix-ask"]?.({
        version: 1,
        flags: fix("values-1", "drift-2", "annotations-3"),
        guidance: "",
      });
      await s.settled(1, 25_000);
      await post["qa-fix-decide"]?.({
        fixset: "fs-1",
        proposal: "p1",
        decision: "accepted",
        note: "keep 'steady'",
      });
      await post["qa-fix-decide"]?.({
        fixset: "fs-1",
        proposal: "p2",
        decision: "rejected",
        note: "the redaction is fine",
      });
      // more context, and the Director rethinks (a second ask while the first is answered)
      await post["qa-fix-ask"]?.({
        version: 1,
        flags: fix("values-1", "drift-2", "annotations-3"),
        guidance: "the intro must stay as it is",
      });
      await s.settled(2, 25_000);
      assert.match(briefSeen, /round 2/);
      assert.match(briefSeen, /the intro must stay as it is/);
      assert.match(briefSeen, /ACCEPTED, the user's note: \\"keep 'steady'\\"/);
      assert.match(briefSeen, /REJECTED, the user's note: \\"the redaction is fine\\"/);
      assert.match(
        JSON.stringify(s.session.messages),
        /ask you to rethink, so read the earlier rounds and their decisions/,
      );
      const set = readFixSet(seed.dir, "fs-1");
      assert.equal(set?.rounds.length, 2);
      assert.equal(set?.rounds[1]?.status, "proposed");
      assert.equal(set?.rounds[1]?.proposals?.length, 1);
      assert.equal(set?.rounds[1]?.unresolved?.[0]?.finding, "annotations-3");
      assert.equal(
        set?.rounds[1]?.proposals?.[0]?.note,
        "keep 'steady'",
        "your note on the same stage carries over",
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
  "in the browser: flag, give context, ask; read the proposals, decide, give more context and ask again",
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
    const panel = await rt.ensurePanel();
    const browser = await (browserType as NonNullable<typeof browserType>).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
      await page.goto(`${panel.url}#/render/v1`);
      const qa = page.locator(".ds-inspector .ds-section", { hasText: "Quality check" });
      await qa.getByText("the narration says 14.3").waitFor();
      const row = (t: string) => qa.locator("li.qa-item", { hasText: t });
      // a broken file and info cannot be flagged
      assert.equal(await row("the audio is silent").locator(".flag-chips").count(), 0);
      // flag: one by hand, the rest with the toolbar
      const open = qa.locator("[data-act=open-fixes]");
      assert.equal(await open.isDisabled(), true, "nothing flagged yet");
      await row("the narration says 14.3").locator("[data-flag=fix]").click();
      await row("no narration for 4.6 s").locator("[data-flag=leave]").click();
      await qa.locator("[data-act=flag-eyes]").click();
      await qa.getByText("3 flagged to fix").first().waitFor();
      // the loop itself is a window: it lists what you flagged, takes your context, and asks
      await open.click();
      const m = page.locator(".modal.fixes");
      await m.waitFor();
      assert.match(await m.innerText(), /3 findings to fix/);
      const ask = m.locator("[data-act=ask-fixes]");
      await m.locator("[data-field=guidance]").fill("keep the intro as it is");
      await m.locator("[data-field=guidance]").blur();
      await page.waitForTimeout(300);
      assert.equal(
        readFixSet(seed.dir, "fs-1")?.draft.guidance,
        "keep the intro as it is",
        "your context is saved as you write",
      );
      assert.equal(await ask.isDisabled(), false);
      await ask.click();
      await m.getByText(/Waiting for the Director: it is working on round 1/).waitFor();
      assert.match(
        told.at(-1) ?? "",
        /flagged 3 QA findings of render v1 to fix and asks for suggested fixes \(fix set fs-1, round 1\)/,
      );
      assert.equal(
        await ask.count(),
        0,
        "one ask at a time: the button is gone while the Director works",
      );
      assert.match(
        await qa.locator("[data-fix-where]").innerText(),
        /Round 1: waiting for the Director/,
        "the list says where it stands",
      );

      // the Director answers (here: the store, as the tool would)
      recordProposals(seed.dir, "fs-1", {
        nextSteps: ["Approve the new draft", "Render a final"],
        summary: "One voice-over run fixes two findings; the redaction is separate.",
        proposals: PROPOSALS as never,
      });
      rt.bus.publish(
        "qa.proposed",
        { message: "fixes proposed for QA of render v1: 2 proposals", by: "agent" },
        seed.slug,
      );
      await m.locator(".fix-proposal").first().waitFor();
      assert.equal(
        await page.locator(".toast").count(),
        0,
        "the window shows it in place: no toast over its buttons",
      );
      const text = await m.locator(".fixes").innerText();
      assert.match(text, /The earliest stage that needs a fix: Voice over/);
      assert.match(text, /One run there fixes 2 findings/);
      assert.match(text, /Rewrite two sentences of 01-dash/);
      assert.match(text, /Applying it costs: re-synthesises 1 section/);
      assert.match(text, /Nothing changes until you apply/);
      if (process.env.P1A_SHOTS)
        await page.screenshot({ path: `${process.env.P1A_SHOTS}-fixes.png`, fullPage: true });
      const vo = m.locator(".fix-proposal[data-stage=vo]");
      await vo.locator("[data-decision=accepted]").click();
      await m.locator(".fix-proposal[data-stage=vo][data-decision=accepted]").waitFor();
      await m
        .locator(".fix-proposal[data-stage=annotations]")
        .locator("[data-decision=rejected]")
        .click();
      await vo.locator("[data-act=edit-proposal]").click();
      await m.getByLabel("Your wording of the change").fill("Say 14.2 only.");
      await m.getByRole("button", { name: "Save my wording" }).click();
      await m.getByText("your wording").waitFor();
      await m.locator(".fix-proposal[data-stage=vo] .fix-note").fill("keep 'steady'");
      await m.locator(".fix-proposal[data-stage=vo] .fix-note").blur();
      await page.waitForTimeout(400);
      const set = readFixSet(seed.dir, "fs-1");
      const p1 = set?.rounds[0]?.proposals?.[0];
      assert.deepEqual(
        [p1?.decision, p1?.edited, p1?.note],
        ["accepted", "Say 14.2 only.", "keep 'steady'"],
      );
      assert.equal(set?.rounds[0]?.proposals?.[1]?.decision, "rejected");
      await m.getByText(/1 accepted, from Voice over on/).waitFor();

      // more context: the same button now asks the Director to rethink
      const again = m.getByRole("button", { name: /Ask the Director to rethink/ });
      await m.locator("[data-field=guidance]").fill("only fix the numbers");
      await again.click();
      await m.getByText(/working on round 2/).waitFor();
      assert.match(told.at(-1) ?? "", /round 2: they added context and ask you to rethink/);
      await page.close();
    } finally {
      await browser.close();
      await rt.shutdown();
      cleanup(seed.root);
    }
  },
);
