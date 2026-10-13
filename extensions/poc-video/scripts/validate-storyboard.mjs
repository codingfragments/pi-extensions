#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
/**
 * validate-storyboard.mjs — check storyboard.yaml (+ optional vo.yaml)
 * against the v0.1 schema invariants (references/storyboard-schema.md).
 *
 * Usage:
 *   node scripts/validate-storyboard.mjs <storyboard.yaml> [vo.yaml]
 * Exit codes: 0 valid · 1 invalid · 2 usage/IO error
 */
import { parse } from "yaml";

export const STEP_TYPES = {
  navigate: ["url"],
  click: ["selector"],
  type: ["selector", "text"],
  press: ["key"],
  scroll: ["dy"],
  hover: ["selector"],
  assert: ["selector"],
  wait: ["ms"],
};

export const VO_STATUS = new Set(["draft", "approved", "synthesized", "retake"]);
export const FIT_VERDICTS = new Set(["fits", "tight", "over"]);
export const RUNNER_MANAGED = ["retake", "skip", "status"];

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class Report {
  constructor() {
    this.errors = [];
    this.warnings = [];
  }
  err(scope, msg) {
    this.errors.push(`${scope}: ${msg}`);
  }
  warn(scope, msg) {
    this.warnings.push(`${scope}: ${msg}`);
  }
  get ok() {
    return this.errors.length === 0;
  }
}

const isPosInt = (v) => Number.isInteger(v) && v > 0;

/** Validate a parsed storyboard document. Returns the set of scene ids. */
export function validateStoryboard(sb, report) {
  if (!sb || typeof sb !== "object") {
    report.err("storyboard", "document must be a mapping");
    return new Set();
  }
  const meta = sb.meta;
  if (!meta || typeof meta !== "object") {
    report.err("meta", "missing");
  } else {
    for (const f of ["target", "title", "target_duration_s"]) {
      if (meta[f] === undefined) report.err("meta", `missing required field '${f}'`);
    }
    if (!meta.voice?.name)
      report.err("meta.voice", "missing 'name' (resolved to voice_id at runtime)");
    if (meta.target_duration_s !== undefined && !isPosInt(meta.target_duration_s)) {
      report.err("meta", "target_duration_s must be a positive integer");
    }
    if (meta.settle_default_ms !== undefined && !isPosInt(meta.settle_default_ms)) {
      report.err("meta", "settle_default_ms must be a positive integer");
    }
  }

  const scenes = sb.scenes;
  if (!Array.isArray(scenes) || scenes.length === 0) {
    report.err("scenes", "must be a non-empty list");
    return new Set();
  }

  const ids = new Set();
  const budgets = [];
  for (let i = 0; i < scenes.length; i++) {
    const sc = scenes[i] ?? {};
    const scope = `scene[${i}]${sc.id ? ` '${sc.id}'` : ""}`;

    if (!sc.id) {
      report.err(scope, "missing id");
    } else {
      if (!KEBAB.test(sc.id)) report.err(scope, `id '${sc.id}' must be kebab-case`);
      if (ids.has(sc.id)) report.err(scope, `duplicate id '${sc.id}'`);
      ids.add(sc.id);
    }
    if (!sc.title) report.err(scope, "missing title");
    if (!sc.intent)
      report.err(scope, "missing intent — drives live narration and the VO generator");
    if (!Array.isArray(sc.steps) || sc.steps.length === 0) {
      report.err(scope, "must have a non-empty steps list");
    } else {
      for (let j = 0; j < sc.steps.length; j++) {
        const st = sc.steps[j] ?? {};
        const ss = `${scope} step[${j}]`;
        if (!st.type) {
          report.err(ss, "missing type");
          continue;
        }
        const need = STEP_TYPES[st.type];
        if (!need) {
          report.err(
            ss,
            `unknown step type '${st.type}' (known: ${Object.keys(STEP_TYPES).join(", ")})`,
          );
          continue;
        }
        for (const f of need) {
          if (st[f] === undefined || st[f] === "")
            report.err(ss, `type '${st.type}' requires '${f}'`);
        }
      }
    }
    for (const f of ["budget_s", "settle_ms", "hold_ms"]) {
      if (sc[f] !== undefined && !isPosInt(sc[f]))
        report.err(scope, `${f} must be a positive integer`);
    }
    if (sc.budget_s !== undefined) budgets.push(sc.budget_s);
    if (sc.reference_screenshot !== undefined && typeof sc.reference_screenshot !== "string") {
      report.err(scope, "reference_screenshot must be a path string");
    }
    for (const f of RUNNER_MANAGED) {
      if (sc[f] !== undefined)
        report.warn(
          scope,
          `runner-managed field '${f}' is ignored/overwritten (authored value dropped)`,
        );
    }
  }

  const total = meta?.target_duration_s;
  if (isPosInt(total) && budgets.length === scenes.length) {
    const sum = budgets.reduce((a, b) => a + b, 0);
    if (sum > total) {
      report.err("scenes", `sum of budget_s (${sum}s) exceeds target_duration_s (${total}s)`);
    } else if (sum < total * 0.5) {
      report.warn(
        "scenes",
        `sum of budget_s (${sum}s) is under half of target_duration_s (${total}s) — add scenes or lower the target`,
      );
    }
  } else if (budgets.length > 0 && budgets.length < scenes.length) {
    report.warn(
      "scenes",
      "some scenes have budget_s and others don't — the budget-sum check needs all or none",
    );
  }

  return ids;
}

/** Validate a parsed vo.yaml document against the storyboard scene ids. */
export function validateVo(vo, report, sbIds) {
  if (!vo || typeof vo !== "object") {
    report.err("vo", "document must be a mapping");
    return;
  }
  const meta = vo.meta;
  if (!meta || typeof meta !== "object") {
    report.err("vo.meta", "missing");
  } else {
    if (!meta.voice?.name) report.err("vo.meta.voice", "missing 'name'");
    const pace = meta.pace_words_per_sec;
    if (pace !== undefined && pace !== null) {
      if (typeof pace !== "number" || pace <= 0 || pace > 10) {
        report.err("vo.meta", `pace_words_per_sec must be a number in (0, 10], got ${pace}`);
      }
    }
  }

  const scenes = vo.scenes;
  if (!Array.isArray(scenes) || scenes.length === 0) {
    report.err("vo.scenes", "must be a non-empty list");
    return;
  }
  const ids = new Set();
  for (let i = 0; i < scenes.length; i++) {
    const sc = scenes[i] ?? {};
    const scope = `vo.scene[${i}]${sc.id ? ` '${sc.id}'` : ""}`;
    if (!sc.id) {
      report.err(scope, "missing id");
    } else {
      if (sbIds && !sbIds.has(sc.id))
        report.err(scope, `id '${sc.id}' has no matching storyboard scene`);
      if (ids.has(sc.id)) report.err(scope, `duplicate id '${sc.id}'`);
      ids.add(sc.id);
    }
    if (!sc.text || !String(sc.text).trim()) report.err(scope, "missing text");
    if (sc.status !== undefined && !VO_STATUS.has(sc.status)) {
      report.err(scope, `status '${sc.status}' invalid (known: ${[...VO_STATUS].join(", ")})`);
    }
    const fit = sc.fit;
    if (fit !== undefined) {
      for (const k of ["spoken_s", "budget_s"]) {
        if (typeof fit?.[k] !== "number") report.err(scope, `fit.${k} must be a number`);
      }
      if (fit?.verdict !== undefined && !FIT_VERDICTS.has(fit.verdict)) {
        report.err(
          scope,
          `fit.verdict '${fit.verdict}' invalid (${[...FIT_VERDICTS].join(" | ")})`,
        );
      }
    }
  }
  if (sbIds) {
    for (const id of sbIds) {
      if (!ids.has(id)) report.warn("vo.scenes", `storyboard scene '${id}' has no vo entry yet`);
    }
  }
}

async function main() {
  const [sbPath, voPath] = process.argv.slice(2);
  if (!sbPath) {
    console.error("usage: validate-storyboard.mjs <storyboard.yaml> [vo.yaml]");
    return 2;
  }
  const report = new Report();
  const read = async (p) => {
    try {
      return parse(await readFile(p, "utf8"));
    } catch (e) {
      report.err(p, `cannot read/parse: ${e.message}`);
      return null;
    }
  };

  const sb = await read(sbPath);
  const sbIds = sb ? validateStoryboard(sb, report) : new Set();
  if (voPath) {
    const vo = await read(voPath);
    if (vo) validateVo(vo, report, sbIds);
  }

  for (const w of report.warnings) console.log(`  ⚠ ${w}`);
  if (!report.ok) {
    console.log(`✖ ${sbPath}${voPath ? " (+vo)" : ""}: ${report.errors.length} error(s)`);
    for (const e of report.errors) console.log(`  ✖ ${e}`);
    return 1;
  }
  const n = Array.isArray(sb?.scenes) ? sb.scenes.length : 0;
  console.log(`✔ ${sbPath}: valid — ${n} scene(s)${voPath ? ", vo.yaml consistent" : ""}`);
  return 0;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
