/**
 * The running plan (docs/RUNNING_PLAN.md) is the one place that says where we are. This cannot tell whether a status is TRUE (that is the rule
 * "every PR updates it"), but it keeps what can be checked honest: the numbering, the day arithmetic, the statuses, the links, and that the
 * other plan documents point to it.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const DOCS = path.join(import.meta.dirname, "..", "docs");
const read = (f: string) => fs.readFileSync(path.join(DOCS, f), "utf8");
const plan = read("RUNNING_PLAN.md");

const STATUSES = ["done", "next", "planned", "later", "you"];
const rows = plan
  .split("\n")
  .filter((l) => /^\| \d+ \|/.test(l))
  .map((l) => l.split("|").map((c) => c.trim()))
  // ["", "#", "package", "what", "from", "status", "days", "Σ", ""]
  .map((c) => ({
    n: Number(c[1]),
    status: (c[5] ?? "").replace(/\*/g, ""),
    days: c[6] ?? "",
    sum: c[7] ?? "",
  }));

test("the work table is numbered 1..N, every row has a known status", () => {
  assert.ok(rows.length >= 16, `the plan has ${rows.length} rows`);
  assert.deepEqual(
    rows.map((r) => r.n),
    rows.map((_, i) => i + 1),
  );
  for (const r of rows) assert.ok(STATUSES.includes(r.status), `row ${r.n}: status "${r.status}"`);
});

test("the days add up: every sum is the running total of the days above it", () => {
  let total = 0;
  for (const r of rows) {
    if (!/^\d+$/.test(r.days)) {
      assert.equal(r.sum, "", `row ${r.n} has no days, so no sum`);
      continue;
    }
    total += Number(r.days);
    assert.equal(Number(r.sum), total, `row ${r.n}: sum ${r.sum}, running total ${total}`);
  }
  assert.ok(total >= 60, `a plan of ${total} days`);
});

test("exactly one item is 'next', and nothing 'planned' comes before a 'later'", () => {
  assert.equal(rows.filter((r) => r.status === "next").length, 1);
  const seenLater = rows.findIndex((r) => r.status === "later");
  const plannedAfter = rows.slice(seenLater).some((r) => r.status === "planned");
  assert.equal(plannedAfter, false, "planned work must come before work that has to wait");
});

test("every relative link of the plan resolves to a file", () => {
  const links = [...plan.matchAll(/\]\(([^)#]+)(#[^)]*)?\)/g)]
    .map((m) => m[1] as string)
    .filter((l) => !/^https?:/.test(l));
  assert.ok(links.length > 10);
  for (const l of links)
    assert.ok(
      fs.existsSync(path.join(DOCS, l)),
      `RUNNING_PLAN.md links to ${l}, which does not exist`,
    );
});

test("the other plan documents point to the running plan", () => {
  for (const f of [
    "ROADMAP.md",
    "IMPLEMENTATION_PLAN.md",
    "REAL_RUN2_FINDINGS.md",
    "FUTURE_IDEAS.md",
  ])
    assert.match(read(f), /RUNNING_PLAN\.md/, `${f} must link to RUNNING_PLAN.md`);
  assert.match(
    fs.readFileSync(path.join(DOCS, "..", "README.md"), "utf8"),
    /docs\/RUNNING_PLAN\.md/,
  );
});
