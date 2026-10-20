/**
 * Item 11c (P4, D144): every message the extension sends carries its role, the Director's state and the panel use the same names, and each
 * skill tells the model to label its own text once. Nothing the model said is rewritten.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { stepLabel, taskLabel } from "../src/director/labels.ts";
import { DirectorTracker } from "../src/director/state.ts";
import { allowedMessage, deniedMessage } from "../src/grants.ts";
import { approvalMessage } from "../src/panel/bridge.ts";
import { directorAs, nextBand, stepWords } from "../src/panel/public/frame-state.js";
import { answeredMessage, dismissedMessage } from "../src/questions.ts";
import { PANEL_PREFIX, PREFIX_SOURCE, SPEAKERS, reportAs, roleOfTool } from "../src/roles.ts";

const root = path.join(import.meta.dirname, "..");
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");

test("the prefixes: the machine tag stays, the role is added, both forms are recognised", () => {
  assert.equal(reportAs("Cutter"), "[demo-recording · Cutter]");
  assert.equal(PANEL_PREFIX, "[demo-panel · You]");
  const re = new RegExp(`^${PREFIX_SOURCE}\\s*(.*)$`, "s");
  assert.deepEqual(re.exec("[demo-recording · QA reviewer] QA of render v2 done")?.slice(1), [
    "demo-recording",
    "QA reviewer",
    "QA of render v2 done",
  ]);
  assert.deepEqual(re.exec("[demo-panel · You] The user APPROVED it")?.slice(1, 3), [
    "demo-panel",
    "You",
  ]);
  assert.deepEqual(
    re.exec("[demo-panel] old form")?.slice(1),
    ["demo-panel", undefined, "old form"],
    "a message without a role is still a report",
  );
  for (const s of SPEAKERS) assert.match(reportAs(s), re);
});

test("a tool belongs to a role: the cast of docs/ACTORS.md", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["demo_rec_browser", {}, "Researcher"],
    ["demo_rec_discovery", {}, "Researcher"],
    ["demo_rec_storyboard", {}, "Storyboard writer"],
    ["demo_rec_record", {}, "Operator"],
    ["demo_rec_vo", {}, "Voice writer"],
    ["demo_rec_tts", {}, "Voice writer"],
    ["demo_rec_edit", {}, "Cutter"],
    ["demo_rec_annotations", {}, "Annotation designer"],
    ["demo_rec_brand", {}, "Brand designer"],
    ["demo_rec_render", { action: "start" }, "Cutter"],
    ["demo_rec_render", { action: "qa" }, "QA reviewer"],
    ["demo_rec_qa", {}, "QA reviewer"],
    ["demo_rec_project", {}, "Director"],
    ["demo_rec_ask", {}, "Director"],
    ["something_else", {}, "Director"],
  ];
  for (const [tool, args, role] of cases)
    assert.equal(roleOfTool(tool, args), role, `${tool} ${JSON.stringify(args)}`);
});

test("every message that tells the Director what the user did names who did it; the labels still read both forms", () => {
  for (const m of [
    allowedMessage("record"),
    deniedMessage("record"),
    approvalMessage("demo", "storyboard", 2),
    answeredMessage(PANEL_PREFIX, {
      id: "q-1",
      what: "Which?",
      answer: { key: "1", label: "A", by: "panel" },
    } as never),
    dismissedMessage(PANEL_PREFIX, { id: "q-1", what: "Which?" } as never),
  ])
    assert.match(m, /^\[demo-(panel|recording) · You\] /, m.slice(0, 60));
  // the task label of a run still comes out right with a role in the prefix
  assert.equal(
    taskLabel({ input: '[demo-panel · You] Voice-over v3 review for project "p":' }).label,
    "Revising the voice-over from your review of v3",
  );
  assert.equal(
    taskLabel({ input: "[demo-panel · You] The user APPROVED storyboard v1 …" }).by,
    "panel",
  );
  assert.equal(
    taskLabel({ custom: "[demo-recording · Cutter] Edit finished: draft v2 is ready" }).label,
    "Reading the report: Edit finished: draft v2 is ready",
  );
  assert.equal(
    taskLabel({ custom: "[demo-recording] an old form" }).label,
    "Reading the report: an old form",
  );
  assert.equal(stepLabel("demo_rec_vo", { action: "write" }).label, "Writing the voice-over");
});

test("the Director's steps carry the role, in the event, the message and the state", () => {
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const d = new DirectorTracker(
    (type, data) => events.push({ type, data }),
    () => 1000,
  );
  d.onRunStart({ prompt: "go" });
  d.onToolStart({ toolCallId: "1", toolName: "demo_rec_vo", args: { action: "write" } });
  const step = events.find((e) => e.type === "director.step");
  assert.deepEqual(
    [step?.data.role, step?.data.label, step?.data.message],
    ["Voice writer", "Writing the voice-over", "Voice writer: Writing the voice-over"],
  );
  assert.equal(d.snapshot().step?.role, "Voice writer");
  d.onToolEnd({ toolCallId: "1", toolName: "demo_rec_vo" });
  d.onToolStart({ toolCallId: "2", toolName: "demo_rec_project", args: { action: "read_brief" } });
  const own = events.filter((e) => e.type === "director.step").at(-1);
  assert.deepEqual(
    [own?.data.role, own?.data.message],
    ["Director", "Director: Reading the project"],
  );
});

test("the panel says the same names: band, suggestions, step words", () => {
  const vo = {
    tool: "demo_rec_vo",
    label: "Writing the voice-over",
    role: "Voice writer",
    stage: "vo",
  };
  assert.equal(stepWords(vo), "Voice writer: Writing the voice-over");
  assert.equal(
    stepWords({ label: "Reading the project", role: "Director" }),
    "Reading the project",
    "the Director's own steps stay as they are",
  );
  assert.equal(
    stepWords({ label: "Reading the project" }),
    "Reading the project",
    "a step from before roles",
  );
  assert.equal(directorAs(vo), "The Director as Voice writer");
  assert.equal(directorAs({ role: "Director" }), "The Director");
  const stages = { project: {}, next: undefined } as never;
  const band = nextBand({
    stages,
    states: {} as never,
    jobs: [],
    director: { working: true, task: "Revising the voice-over", step: vo } as never,
  });
  assert.equal(band?.text, "Revising the voice-over · Voice writer: Writing the voice-over");
});

test("no message to the Director starts with a bare [demo-recording] or [demo-panel] any more (the hidden project context is the one exception)", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== "public" && e.name !== "vendor") walk(rel);
      } else if (e.name.endsWith(".ts"))
        read(rel)
          .split("\n")
          .forEach((line, i) => {
            if (/[`"']\[demo-(recording|panel)\]/.test(line) && !/^\s*(\/\/|\*)/.test(line))
              offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 90)}`);
          });
    }
  };
  walk("src");
  // runtime.ts: the project context is a hidden message (display: false), not something said in the chat
  assert.deepEqual(
    offenders.filter((o) => !o.startsWith("src/runtime.ts")),
    [],
  );
});

test("each skill tells the model to start a block with its role once, and nothing is written into what the model said", () => {
  for (const [skill, role] of [
    ["recording", "Director"],
    ["voiceover", "Voice writer"],
    ["annotations", "Annotation designer"],
    ["brand", "Brand designer"],
    ["brief", "Director"],
    ["config", "Director"],
  ] as const) {
    const s = read(`skills/demo-${skill}/SKILL.md`);
    assert.match(s, /Start a block of your own text with your role once/, skill);
    assert.ok(s.includes(`\`${role}:\``), `${skill} names ${role}`);
  }
  // we never rewrite the model's text: no message_end / message_update hook in the extension
  for (const f of ["index.ts", "src/question-chat.ts", "src/director/watch.ts"])
    assert.doesNotMatch(read(f), /message_end|message_update|registerMarkdownTransformer/, f);
});
