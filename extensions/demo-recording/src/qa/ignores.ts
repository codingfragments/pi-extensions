/**
 * Ignores: what you decided to leave alone in the QA (P1a Q2, D-QA-3 and D-QA-4).
 *
 * An ignore has a SCOPE: this finding (found again by what it is, see identity.ts), this kind of finding in this
 * scene, or this kind of finding in the whole project (a rule, e.g. "redactions: this is test data"). It carries a
 * reason, is kept in the project (`state.json`, so the Director reads it), covers a finding in every later render,
 * and ENDS when the content it was true for changes (the scene's narration, or the take). A broken file
 * (an integrity hard stop) is never ignorable: render again.
 */

import fs from "node:fs";
import type { RenderRecord } from "../render/store.ts";
import { readRender, saveRecord } from "../render/store.ts";
import { readState, updateState } from "../workdir/state.ts";
import { contentKey, sameFinding } from "./identity.ts";
import { qaFile } from "./run.ts";
import { summarize } from "./summary.ts";
import type { IgnoreScope, QaIgnore, QaItem, QaReport, QaSummary } from "./types.ts";

export const listIgnores = (projectDir: string): QaIgnore[] =>
  readState(projectDir)?.qaIgnores ?? [];

export const activeIgnores = (projectDir: string): QaIgnore[] =>
  listIgnores(projectDir).filter((i) => !i.endedAt);

const kindOf = (it: Pick<QaItem, "identity">) => it.identity?.kind;

/** Does an ignore's kind (check, hard stop, media kind) match this finding's? */
function sameKind(ig: QaIgnore, it: QaItem): boolean {
  return ig.check === it.check && ig.hard === it.hard && ig.kind === kindOf(it);
}

/** Which ignore covers a finding, if any. `keyOf` is what the finding is true for now. */
export function coveringIgnore(
  ignores: QaIgnore[],
  it: QaItem,
  keyOf: (it: QaItem) => string,
): QaIgnore | undefined {
  if (it.hard === "integrity") return undefined;
  return ignores.find((ig) => {
    if (ig.endedAt || !sameKind(ig, it)) return false;
    if (ig.scope === "project") return true;
    if (ig.contentKey !== keyOf(it)) return false;
    if (ig.scope === "scene") return ig.scene === it.scene;
    return !!ig.finding && ig.scene === it.scene && sameFinding({ ...ig, ...ig.finding }, it);
  });
}

function clearApplied(items: QaItem[]): void {
  for (const it of items) {
    if (it.ignored) Reflect.deleteProperty(it, "ignored");
    if (it.confirmed?.reason.startsWith("ignored (")) Reflect.deleteProperty(it, "confirmed");
  }
}

/**
 * Apply the project's ignores to a report's findings, end the ignores whose content changed, and say what happened.
 * A hard stop (a leaking redaction) that an ignore covers counts as confirmed, visibly, with the ignore's reason.
 */
export function applyIgnores(
  projectDir: string,
  rec: Pick<RenderRecord, "version" | "voVersion" | "take">,
  items: QaItem[],
  now = new Date(),
): { ended: QaIgnore[] } {
  clearApplied(items);
  const ignores = activeIgnores(projectDir);
  if (!ignores.length) return { ended: [] };
  const keyOf = (it: QaItem) => contentKey(projectDir, rec, it.check, it.scene);
  // an ignore whose content changed has ended, whether or not its finding shows up again
  const ended: QaIgnore[] = [];
  for (const ig of ignores) {
    if (ig.scope === "project" || ig.contentKey === undefined) continue;
    const key = contentKey(projectDir, rec, ig.check, ig.scene);
    if (key !== ig.contentKey) {
      ig.endedAt = now.toISOString();
      ig.endedWhy =
        ig.check === "footage"
          ? `the take changed (render v${rec.version})`
          : `the narration of ${ig.scene ?? "its scene"} changed (render v${rec.version})`;
      ended.push(ig);
    }
  }
  if (ended.length)
    updateState(
      projectDir,
      "qa-ignores-ended",
      (s) => {
        for (const e of ended) {
          const own = s.qaIgnores?.find((i) => i.id === e.id);
          if (own) Object.assign(own, { endedAt: e.endedAt, endedWhy: e.endedWhy });
        }
      },
      { ids: ended.map((e) => e.id) },
      now,
    );
  const live = ignores.filter((i) => !i.endedAt);
  for (const it of items) {
    const ig = coveringIgnore(live, it, keyOf);
    if (!ig) continue;
    it.ignored = { id: ig.id, scope: ig.scope, reason: ig.reason, since: ig.renderVersion };
    if (it.level === "blocking" && !it.confirmed)
      it.confirmed = {
        at: now.toISOString(),
        reason: `ignored (${ig.scope}): ${ig.reason}`,
      };
  }
  return { ended };
}

function nextId(all: QaIgnore[]): string {
  const n = all.reduce((m, i) => Math.max(m, Number(/^ig-(\d+)$/.exec(i.id)?.[1] ?? 0)), 0);
  return `ig-${n + 1}`;
}

/** Re-read a render's report, apply the ignores again, and write the report and the record's summary. */
export function refreshQa(
  projectDir: string,
  version: number,
  now = new Date(),
): { report: QaReport; summary: QaSummary } {
  const rec = readRender(projectDir, version);
  const file = qaFile(projectDir, version);
  if (!rec || !fs.existsSync(file)) throw new Error(`render v${version} has no QA report`);
  const report = JSON.parse(fs.readFileSync(file, "utf8")) as QaReport;
  applyIgnores(projectDir, rec, report.items, now);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  const summary = summarize(report.items, report.createdAt);
  rec.qa = summary;
  saveRecord(projectDir, rec);
  return { report, summary };
}

/** Ignore a finding of a render's report with a scope and a reason. */
export function addIgnore(
  projectDir: string,
  o: {
    version: number;
    itemId: string;
    scope: IgnoreScope;
    reason: string;
    by: QaIgnore["by"];
    now?: Date;
  },
): { ignore: QaIgnore; summary: QaSummary } {
  const now = o.now ?? new Date();
  const rec = readRender(projectDir, o.version);
  const file = qaFile(projectDir, o.version);
  if (!rec || !fs.existsSync(file)) throw new Error(`render v${o.version} has no QA report`);
  const report = JSON.parse(fs.readFileSync(file, "utf8")) as QaReport;
  const it = report.items.find((x) => x.id === o.itemId);
  if (!it) throw new Error(`QA item ${o.itemId} is not in the report of render v${o.version}`);
  if (it.hard === "integrity")
    throw new Error(
      `${o.itemId} is a broken file, not a judgement call: it cannot be ignored, render again`,
    );
  if (!["finding", "scene", "project"].includes(o.scope))
    throw new Error('scope is "finding", "scene" or "project"');
  if (o.reason.trim().length < 3)
    throw new Error("a reason is required: why is it fine to leave this alone?");
  if (o.scope !== "project" && !it.scene)
    throw new Error(`${o.itemId} belongs to no scene: ignore it for the whole project`);
  if (o.scope === "finding" && !it.identity)
    throw new Error(`${o.itemId} has no identity (an older report): re-run QA first`);
  let created: QaIgnore | undefined;
  updateState(
    projectDir,
    "qa-ignore",
    (s) => {
      const all = s.qaIgnores ?? [];
      const ig: QaIgnore = {
        id: nextId(all),
        scope: o.scope,
        check: it.check,
        ...(it.hard ? { hard: it.hard } : {}),
        ...(it.identity?.kind ? { kind: it.identity.kind } : {}),
        ...(o.scope !== "project" && it.scene ? { scene: it.scene } : {}),
        ...(o.scope === "finding" && it.identity
          ? { finding: { identity: it.identity, message: it.message.slice(0, 200) } }
          : {}),
        ...(o.scope !== "project"
          ? { contentKey: contentKey(projectDir, rec, it.check, it.scene) }
          : {}),
        reason: o.reason.trim().slice(0, 500),
        createdAt: now.toISOString(),
        renderVersion: o.version,
        by: o.by,
      };
      s.qaIgnores = [...all, ig];
      created = ig;
    },
    { render: o.version, item: o.itemId, scope: o.scope },
    now,
  );
  const { summary } = refreshQa(projectDir, o.version, now);
  return { ignore: created as QaIgnore, summary };
}

/** Stop ignoring: the ignore is removed and the render's report is refreshed. */
export function removeIgnore(
  projectDir: string,
  id: string,
  version?: number,
  now = new Date(),
): { removed: QaIgnore; summary?: QaSummary } {
  const had = listIgnores(projectDir).find((i) => i.id === id);
  if (!had) throw new Error(`there is no ignore ${id}`);
  updateState(
    projectDir,
    "qa-unignore",
    (s) => {
      s.qaIgnores = (s.qaIgnores ?? []).filter((i) => i.id !== id);
    },
    { id },
    now,
  );
  const v = version ?? had.renderVersion;
  const refreshed = readRender(projectDir, v) && fs.existsSync(qaFile(projectDir, v));
  return { removed: had, ...(refreshed ? { summary: refreshQa(projectDir, v, now).summary } : {}) };
}

/** The ignores as text for the Director and the context. */
export function formatIgnores(projectDir: string): string[] {
  const all = listIgnores(projectDir);
  if (!all.length) return [];
  const line = (i: QaIgnore) =>
    `- ${i.id} [${i.scope}${i.scene ? `, ${i.scene}` : ""}] ${i.check}${i.kind ? `/${i.kind}` : ""}${i.hard ? ` (${i.hard})` : ""}: ${i.reason}${i.finding ? ` — "${i.finding.message.slice(0, 90)}"` : ""} (render v${i.renderVersion})${i.endedAt ? ` — ENDED: ${i.endedWhy}` : ""}`;
  const on = all.filter((i) => !i.endedAt);
  const off = all.filter((i) => i.endedAt).slice(-3);
  return [
    ...(on.length
      ? ["Active (do not raise these again, do not ask about them):", ...on.map(line)]
      : []),
    ...(off.length
      ? ["Ended (the content changed, raise them again if they show up):", ...off.map(line)]
      : []),
  ];
}
