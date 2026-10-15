/**
 * Privacy scan (S5 part 8, D54): deterministic detection of sensitive texts in
 * the take's layout snapshots — emails, phone numbers, API keys / tokens / JWTs,
 * IBAN- and card-like numbers (Luhn), long IDs. Every hit becomes a DISABLED
 * redact suggestion with a reason; the user confirms (the designer adds names).
 */

import type { LayoutElement, LayoutSnapshot } from "../recorder/layout.ts";

export type PrivacyKind = "email" | "phone" | "token" | "jwt" | "iban" | "card" | "id";

export interface PrivacyHit {
  kind: PrivacyKind;
  scene: string;
  /** First snapshot (take time) the text is on screen. */
  t: number;
  /** Layout ref `t<ms>#e<n>`. */
  ref: string;
  /** The matched text, masked for display (never the full secret). */
  masked: string;
  box: LayoutElement["box"];
  reason: string;
}

const REASON: Record<PrivacyKind, string> = {
  email: "looks like an email address",
  phone: "looks like a phone number",
  token: "looks like an API key or access token",
  jwt: "looks like a session token (JWT)",
  iban: "looks like a bank account number (IBAN)",
  card: "looks like a payment card number",
  id: "looks like a long personal or account ID",
};

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Mask all but the first 2 and last 2 visible characters. */
export const mask = (s: string) =>
  s.length <= 6
    ? "•".repeat(s.length)
    : `${s.slice(0, 2)}${"•".repeat(Math.min(12, s.length - 4))}${s.slice(-2)}`;

/** Classify one text. Order matters: the most specific first. */
export function detect(text: string): { kind: PrivacyKind; match: string } | undefined {
  const t = text.trim();
  const jwt = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\b/.exec(t);
  if (jwt) return { kind: "jwt", match: jwt[0] };
  const key =
    /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b|\bsk-[A-Za-z0-9_-]{16,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bxox[abpr]-[A-Za-z0-9-]{10,}\b|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}\b/.exec(
      t,
    );
  if (key) return { kind: "token", match: key[0] };
  const email = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.exec(t);
  if (email) return { kind: "email", match: email[0] };
  const iban = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/.exec(t);
  if (iban && iban[0].replace(/ /g, "").length >= 15) return { kind: "iban", match: iban[0] };
  const card = /\b(?:\d[ -]?){13,19}\b/.exec(t);
  const cardDigits = card ? card[0].replace(/\D/g, "") : "";
  const cardLike = cardDigits.length >= 13 && cardDigits.length <= 19;
  if (card && cardLike && luhn(cardDigits)) return { kind: "card", match: card[0].trim() };
  // A card-shaped number that fails Luhn is not a phone number either.
  const phone = cardLike
    ? null
    : /(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?)?\d{2,4}[ .-]\d{3,4}[ .-]\d{3,4}\b/.exec(t);
  if (phone && phone[0].replace(/\D/g, "").length >= 9) return { kind: "phone", match: phone[0] };
  // A long opaque token: ≥ 24 chars of mixed letters+digits without spaces (hashes, secrets).
  const opaque = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/.exec(t);
  if (opaque) return { kind: "token", match: opaque[0] };
  // A long ID: ≥ 9 digits in a row that isn't an amount/date (personal / account numbers).
  const id = /(?<![\d.,$€£])\d{9,}(?![\d.,%])/.exec(t);
  if (id) return { kind: "id", match: id[0] };
  return undefined;
}

/**
 * Scan all snapshots. One hit per (scene, text), at its first appearance; the
 * smallest element carrying the text wins (a cell, not its row).
 */
export function scanPrivacy(snaps: LayoutSnapshot[]): PrivacyHit[] {
  const out = new Map<string, PrivacyHit>();
  for (const s of snaps) {
    const scene = s.scene ?? "";
    for (const e of [...s.els].sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h)) {
      const text = [e.text, e.value].filter(Boolean).join(" ");
      if (!text) continue;
      const d = detect(text);
      if (!d) continue;
      const key = `${scene}\u0000${d.match}`;
      if (out.has(key)) continue;
      out.set(key, {
        kind: d.kind,
        scene,
        t: s.t,
        ref: `t${s.t}#${e.id}`,
        masked: mask(d.match),
        box: e.box,
        reason: REASON[d.kind],
      });
    }
  }
  return [...out.values()];
}
