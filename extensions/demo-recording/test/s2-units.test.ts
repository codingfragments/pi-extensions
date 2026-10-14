import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { type ActionContext, EMPTY_POLICY, classify, loadPolicy } from "../src/browser/safety.ts";
import { ariaTargets } from "../src/discovery/session.ts";
import { approvalMessage, reviewMessage } from "../src/panel/bridge.ts";
import { diffStoryboards, formatDiff, storyboardTargets } from "../src/storyboard/diff.ts";
import { parseStoryboard } from "../src/storyboard/parse.ts";
import {
  readStoryboard,
  storyboardVersions,
  withVersion,
  writeStoryboard,
} from "../src/storyboard/store.ts";
import { ensureProject } from "../src/workdir/layout.ts";
import {
  getReview,
  readState,
  setReviewNote,
  setSceneReview,
  submitReview,
} from "../src/workdir/state.ts";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "demo-rec-s2-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------- safety (D6) ----------

const c = (ctx: ActionContext) => classify(ctx).level;

test("safety: denylisted actions are blocked, regardless of role", () => {
  for (const name of [
    "Delete workspace",
    "Remove member",
    "Share dashboard",
    "Invite users",
    "Upgrade plan",
    "Sign out",
    "Log out",
    "Pay now",
    "Publish",
  ]) {
    assert.equal(c({ action: "click", role: "button", name }), "blocked", name);
  }
  assert.equal(c({ action: "goto", sameOrigin: false }), "blocked");
});

test("safety: state-changing actions are allowed but flagged", () => {
  assert.equal(c({ action: "click", role: "button", name: "Save view" }), "mutating");
  assert.equal(c({ action: "click", role: "button", name: "Send" }), "mutating");
  assert.equal(
    c({ action: "click", role: "button", name: "Go", inForm: true }),
    "mutating",
    "form submit button",
  );
  assert.equal(
    c({ action: "press", key: "Enter", role: "textbox", name: "Ask a question", inForm: true }),
    "mutating",
    "chat send",
  );
  assert.equal(c({ action: "type", submit: true, role: "textbox", name: "Message" }), "mutating");
});

test("safety: read-only interactions are safe", () => {
  assert.equal(c({ action: "click", role: "link", name: "Search" }), "safe");
  assert.equal(
    c({ action: "click", role: "link", name: "Add-ons" }),
    "safe",
    "links with mutating words navigate, not mutate",
  );
  assert.equal(
    c({ action: "click", role: "button", name: "Search", inForm: true, searchForm: true }),
    "safe",
  );
  assert.equal(
    c({
      action: "press",
      key: "Enter",
      role: "searchbox",
      name: "Search",
      inForm: true,
      searchForm: true,
    }),
    "safe",
  );
  assert.equal(c({ action: "press", key: "Enter", role: "textbox", multiline: true }), "safe");
  assert.equal(c({ action: "press", key: "Escape", role: "textbox", inForm: true }), "safe");
  assert.equal(c({ action: "type", submit: false, role: "textbox", inForm: true }), "safe");
  for (const action of ["hover", "scroll", "back"] as const) assert.equal(c({ action }), "safe");
  assert.equal(c({ action: "goto", sameOrigin: true }), "safe");
});

test("safety: policy allow overrides the denylist; deny adds blocks; regex patterns", () => {
  const policy = { ...EMPTY_POLICY, allow: ["Delete draft"], deny: ["/^export/i"] };
  assert.equal(
    classify({ action: "click", role: "button", name: "Delete draft" }, policy).level,
    "safe",
  );
  assert.equal(
    classify({ action: "click", role: "button", name: "Delete workspace" }, policy).level,
    "blocked",
  );
  assert.equal(
    classify({ action: "click", role: "button", name: "Export CSV" }, policy).level,
    "blocked",
  );
  assert.match(
    classify({ action: "click", role: "button", name: "Export CSV" }, policy).reason,
    /policy/,
  );
});

test("loadPolicy: optional file, validated", () => {
  assert.deepEqual(loadPolicy(root), EMPTY_POLICY);
  fs.writeFileSync(path.join(root, "policy.json"), JSON.stringify({ allow: ["Send"] }));
  assert.deepEqual(loadPolicy(root), { allow: ["Send"], deny: [], allowOrigins: [] });
  fs.writeFileSync(path.join(root, "policy.json"), JSON.stringify({ allow: "Send" }));
  assert.throws(() => loadPolicy(root), /"allow" must be a list of strings/);
  fs.writeFileSync(path.join(root, "policy.json"), "{");
  assert.throws(() => loadPolicy(root), /invalid JSON/);
});

// ---------- storyboard: new fields, store, diff ----------

const SB = (scenes: string) => `start_url: /\nscenes:\n${scenes}`;
const SCENE_A = `  - id: 01-a
    title: A
    takeaway: claim A
    screen: 20260612-101233/s001
    narration_outline: [one, two]
    steps:
      - { do: hover, target: { role: link, name: Search }, zoom: true, callout: Key step }
      - { do: scroll, dy: 400 }
      - { do: improvise, kind: type, target: { role: textbox, name: Ask }, prompt: a follow-up question }
`;
const SCENE_B = `  - id: 02-b
    title: B
    steps:
      - { do: click, target: { role: link, name: Assistant } }
      - { do: wait, for: { text: Answer }, mark: answer }
`;

test("parse: S2 authoring fields and step kinds", () => {
  const sb = parseStoryboard(`summary: The pitch\n${SB(SCENE_A)}`, { version: 3 });
  assert.equal(sb.version, 3, "version injected when omitted");
  assert.equal(sb.summary, "The pitch");
  const scene = sb.scenes[0];
  assert.equal(scene?.screen, "20260612-101233/s001");
  assert.deepEqual(scene?.narration_outline, ["one", "two"]);
  assert.deepEqual(scene?.steps[0], {
    do: "hover",
    target: { role: "link", name: "Search" },
    zoom: true,
    callout: "Key step",
    emphasis: 'suggest a zoom here; suggested callout: "Key step"',
  });
  assert.deepEqual(scene?.steps[1], { do: "scroll", dy: 400 });
  assert.deepEqual(scene?.steps[2], {
    do: "improvise",
    kind: "type",
    target: { role: "textbox", name: "Ask" },
    prompt: "a follow-up question",
    max_chars: 80,
    submit: true,
  });
});

test("parse: S2 validation errors", () => {
  const bad = (yaml: string, re: RegExp) =>
    assert.throws(() => parseStoryboard(yaml, { version: 1 }), re);
  const one = (step: string) => SB(`  - id: a\n    title: t\n    steps:\n      - ${step}\n`);
  bad(one("{ do: scroll }"), /scroll needs a target/);
  bad(
    one("{ do: improvise, kind: click, target: { text: x }, prompt: p }"),
    /only "type" is supported/,
  );
  bad(
    one("{ do: improvise, kind: type, target: { text: x }, prompt: p, max_chars: 2 }"),
    /max_chars/,
  );
  bad(
    one(`{ do: hover, target: { text: x }, callout: "${"x".repeat(61)}" }`),
    /keep callouts short/,
  );
  bad(one("{ do: hover, target: { text: x }, zoom: yes please }"), /zoom: must be true or false/);
  bad(
    SB("  - id: a\n    title: t\n    screen: s001\n    steps: [{ do: pause, ms: 1 }]\n"),
    /screen: must be a discovery screen id/,
  );
  bad(
    SB(
      "  - id: a\n    title: t\n    narration_outline: [ok, '']\n    steps: [{ do: pause, ms: 1 }]\n",
    ),
    /narration_outline/,
  );
});

test("store: versions injected, comments kept, invalid YAML never consumes a version", () => {
  const p = ensureProject(root, { project: "p", appName: "a", appUrl: "https://a.test" });
  assert.throws(
    () =>
      writeStoryboard(
        p.dir,
        SB("  - id: BAD id\n    title: t\n    steps: [{ do: pause, ms: 1 }]\n"),
      ),
    /kebab-case/,
  );
  assert.deepEqual(storyboardVersions(p.dir), [], "failed write allocates nothing");

  const v1 = writeStoryboard(p.dir, `# keep this comment\n${SB(SCENE_A)}`);
  assert.equal(v1.version, 1);
  assert.equal(v1.diff, undefined);
  assert.match(v1.text, /# keep this comment/);
  assert.match(v1.text, /^version: 1$/m);

  const v2 = writeStoryboard(p.dir, `version: 99\n${SB(SCENE_A + SCENE_B)}`);
  assert.equal(v2.version, 2);
  assert.match(v2.text, /^version: 2$/m, "author-supplied version is overwritten");
  assert.deepEqual(
    v2.diff && { added: v2.diff.added, changed: v2.diff.changed, reordered: v2.diff.reordered },
    {
      added: ["02-b"],
      changed: [],
      reordered: false,
    },
  );
  assert.equal(readStoryboard(p.dir)?.version, 2);
  assert.equal(readStoryboard(p.dir, 1)?.storyboard.scenes.length, 1);
  assert.equal(withVersion("a: 1\n", 7), "a: 1\nversion: 7\n");
});

test("diff: added/removed/changed/reordered + formatting + targets", () => {
  const a = parseStoryboard(SB(SCENE_A + SCENE_B), { version: 1 });
  const b = parseStoryboard(SB(SCENE_B + SCENE_A.replace("claim A", "claim A2")), { version: 2 });
  const d = diffStoryboards(a, b);
  assert.deepEqual(d.changed, ["01-a"]);
  assert.deepEqual(d.unchanged, ["02-b"]);
  assert.equal(d.reordered, true);
  assert.equal(formatDiff(d), "v1 → v2: changed 01-a; reordered");
  const c2 = parseStoryboard(SB(SCENE_A), { version: 3 });
  assert.equal(formatDiff(diffStoryboards(b, c2)), "v2 → v3: removed 02-b; changed 01-a");
  assert.deepEqual(
    storyboardTargets(a).map((t) => `${t.scene}:${t.step}`),
    ["01-a:0", "01-a:2", "02-b:0", "02-b:1"],
    "hover, improvise, click and wait-for targets (scroll by dy has none)",
  );
});

test("ariaTargets extracts role/name pairs from an aria snapshot", () => {
  const snap = `- navigation "Main":\n  - link "Search":\n    - /url: /search\n- textbox "Ask a question"\n- row "EMEA 14.2% 341"\n- text: plain`;
  assert.deepEqual(
    [...ariaTargets(snap)],
    ["navigation|Main", "link|Search", "textbox|Ask a question", "row|EMEA 14.2% 341"],
  );
});

// ---------- review state + bridge ----------

test("review: per-scene drafts, notes, submit, messages", () => {
  const p = ensureProject(root, { project: "Churn PoC", appName: "a", appUrl: "https://a.test" });
  const sb = writeStoryboard(p.dir, SB(SCENE_A + SCENE_B)).storyboard;
  assert.throws(() => submitReview(p.dir, 1), /nothing to submit/);

  setSceneReview(p.dir, 1, "01-a", "approved");
  setSceneReview(p.dir, 1, "02-b", "changes", "  type slower  ");
  setSceneReview(p.dir, 1, "02-b", "rerun", "the answer was cut off");
  setReviewNote(p.dir, 1, "swap the order");
  let review = getReview(readState(p.dir) ?? p.state, 1);
  assert.deepEqual(
    Object.fromEntries(Object.entries(review.scenes).map(([k, v]) => [k, [v.status, v.note]])),
    { "01-a": ["approved", undefined], "02-b": ["rerun", "the answer was cut off"] },
  );
  setSceneReview(p.dir, 1, "01-a", null);
  review = getReview(readState(p.dir) ?? p.state, 1);
  assert.deepEqual(Object.keys(review.scenes), ["02-b"], "null clears a mark");

  const { review: submitted } = submitReview(p.dir, 1);
  assert.ok(submitted.submittedAt);
  const msg = reviewMessage(p.slug, sb, submitted);
  assert.match(msg, /^\[demo-panel\] Storyboard v1 review for project "churn-poc":/);
  assert.match(msg, /- 02-b \(B\): RE-RUN — "the answer was cut off"/);
  assert.match(msg, /not reviewed: 01-a/);
  assert.match(msg, /Overall note: "swap the order"/);
  assert.match(msg, /write v2 with demo_rec_storyboard/);

  const allOk = reviewMessage(p.slug, sb, {
    scenes: { "01-a": { status: "approved", at: "" }, "02-b": { status: "approved", at: "" } },
  });
  assert.match(allOk, /approve the storyboard as a whole in the panel/);
  assert.match(
    approvalMessage("p", "storyboard", 3),
    /Storyboard v3 for project "p" is APPROVED.*demo_rec_record/,
  );
});
