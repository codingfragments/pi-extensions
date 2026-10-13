/**
 * Discovery & recording safety net (D6): agent judgment backed by
 *   - a hard keyword DENYLIST (blocked before the action happens),
 *   - a MUTATION classifier (allowed, but written to the audit log and shown
 *     live in the panel),
 *   - an optional per-app `policy.json` that overrides both.
 *
 * Classification is a pure function over a small element description, so it is
 * unit-testable without a browser.
 */

import fs from "node:fs";
import path from "node:path";

export type SafetyLevel = "safe" | "mutating" | "blocked";

export interface ActionContext {
  action: "click" | "press" | "type" | "goto" | "hover" | "scroll" | "back";
  /** Accessible role (explicit or implicit), e.g. button, link, textbox. */
  role?: string;
  /** Accessible name / visible label of the target. */
  name?: string;
  /** `type` attribute for inputs/buttons (submit, search, …). */
  inputType?: string;
  /** Target (or focused element for `press`) sits inside a <form>. */
  inForm?: boolean;
  /** That form is a search form (role=search or contains a search input). */
  searchForm?: boolean;
  /** The focused element for `press` is a <textarea> / contenteditable. */
  multiline?: boolean;
  key?: string;
  /** For goto: whether the URL stays on the app's origin. */
  sameOrigin?: boolean;
  /** For type: whether the text is submitted (Enter) afterwards. */
  submit?: boolean;
}

export interface SafetyVerdict {
  level: SafetyLevel;
  reason: string;
}

export interface Policy {
  /** Patterns (substring, case-insensitive, or /regex/flags) always allowed. */
  allow: string[];
  /** Extra patterns always blocked (in addition to the built-in denylist). */
  deny: string[];
  /** Allow navigation to these extra origins. */
  allowOrigins: string[];
}

export const EMPTY_POLICY: Policy = { allow: [], deny: [], allowOrigins: [] };

/** Destructive, financial, sharing, or session-ending verbs: never clicked. */
export const DENYLIST =
  /\b(delete|remove|destroy|erase|purge|drop|wipe|deactivate|disable|archive|terminate|revoke|cancel (subscription|plan|account)|unsubscribe|pay|purchase|buy|checkout|order now|subscribe|upgrade|downgrade|invite|share|publish|deploy|release|transfer|refund|billing|payment|reset password|change password|sign ?out|log ?out|leave (workspace|team|organization))\b/i;

/** Verbs that usually persist state: allowed, but audited. */
export const MUTATING =
  /\b(send|save|submit|create|add|new|update|apply|confirm|post|upload|import|export|generate|run|start|stop|approve|accept|reject|enable|edit|rename|move|copy|duplicate|schedule|book|request|assign|follow|like|star|pin|comment|reply|vote|connect|install)\b/i;

function matches(pattern: string, text: string): boolean {
  const re = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  if (re) {
    try {
      return new RegExp(re[1] as string, re[2]).test(text);
    } catch {
      return false;
    }
  }
  return text.toLowerCase().includes(pattern.toLowerCase());
}

export function classify(ctx: ActionContext, policy: Policy = EMPTY_POLICY): SafetyVerdict {
  const name = (ctx.name ?? "").trim();
  const label = name ? `"${name}"` : (ctx.role ?? "element");

  if (ctx.action === "goto") {
    return ctx.sameOrigin === false
      ? { level: "blocked", reason: "navigation leaves the app's origin" }
      : { level: "safe", reason: "same-origin navigation" };
  }
  if (ctx.action === "hover" || ctx.action === "scroll" || ctx.action === "back") {
    return { level: "safe", reason: `${ctx.action} is read-only` };
  }

  if (name && policy.allow.some((p) => matches(p, name)))
    return { level: "safe", reason: `allowed by policy: ${label}` };
  if (name && policy.deny.some((p) => matches(p, name)))
    return { level: "blocked", reason: `denied by policy: ${label}` };

  if (ctx.action === "click") {
    if (name && DENYLIST.test(name))
      return { level: "blocked", reason: `denylisted action ${label}` };
    if (name && MUTATING.test(name) && ctx.role !== "link")
      return { level: "mutating", reason: `${label} likely changes state` };
    if ((ctx.inputType === "submit" || (ctx.role === "button" && ctx.inForm)) && !ctx.searchForm) {
      return { level: "mutating", reason: `${label} submits a form` };
    }
    return { level: "safe", reason: `${label} looks read-only` };
  }

  // press / type(+submit): Enter submits forms and sends chat messages.
  const submits =
    ctx.action === "press" ? /^(Enter|NumpadEnter)$/i.test(ctx.key ?? "") : ctx.submit === true;
  if (!submits)
    return {
      level: "safe",
      reason: ctx.action === "type" ? "typing without submitting" : `key ${ctx.key ?? "?"}`,
    };
  if (ctx.multiline) return { level: "safe", reason: "Enter in a multi-line field adds a line" };
  if (ctx.searchForm || ctx.inputType === "search" || ctx.role === "searchbox")
    return { level: "safe", reason: "submits a search" };
  if (ctx.inForm || ctx.role === "textbox" || ctx.role === "combobox") {
    return { level: "mutating", reason: `Enter submits ${label} (form or chat message)` };
  }
  return { level: "safe", reason: "Enter outside a form" };
}

export function loadPolicy(appDir: string): Policy {
  const file = path.join(appDir, "policy.json");
  if (!fs.existsSync(file)) return EMPTY_POLICY;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file}: invalid JSON (${(err as Error).message})`);
  }
  const obj = (raw ?? {}) as Record<string, unknown>;
  const list = (key: string): string[] => {
    const v = obj[key];
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
      throw new Error(`${file}: "${key}" must be a list of strings`);
    return v as string[];
  };
  return { allow: list("allow"), deny: list("deny"), allowOrigins: list("allowOrigins") };
}
