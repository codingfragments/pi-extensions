// The voice picker (UX17, D131): the voices of the account as a select, with a text fallback. The list comes from
// GET /api/voices (read-only, free, cached on the server); the key never reaches the page.
import { html, useEffect, useState } from "/vendor/preact-htm.module.js";
import { api } from "./core.js";

let shared = null; // one request in flight or done, for every picker on the page

function load(refresh = false) {
  if (!shared || refresh)
    shared = api(`/api/voices${refresh ? "?refresh=1" : ""}`).catch((e) => ({
      available: false,
      reason: String(e?.message ?? e),
    }));
  return shared;
}

/** The voices, or why there are none. `undefined` while loading. */
export function useVoices() {
  const [state, setState] = useState(undefined);
  useEffect(() => {
    let live = true;
    load().then((r) => live && setState(r));
    return () => {
      live = false;
    };
  }, []);
  return [state, () => load(true).then(setState)];
}

/**
 * A voice name: pick one of yours or the library, keep what is set even if it is not in the list, or type a name or
 * voice id. Without a list (no key, no permission, offline) it is the text field it always was, with the reason.
 */
export function VoiceInput({ value, onChange, id, disabled, emptyLabel = "Not set" }) {
  const [list, refresh] = useVoices();
  const [typing, setTyping] = useState(false);
  const text = html`<input class="ds-input" id=${id} type="text" value=${value ?? ""} disabled=${disabled} placeholder="a voice name or id" onInput=${(e) => onChange(e.target.value)} />`;
  if (list === undefined)
    return html`<div class="ds-stack ds-voice-input">${text}<span class="ds-small ds-muted" role="status">loading the voices of your account…</span></div>`;
  if (!list.available)
    return html`<div class="ds-stack ds-voice-input">${text}
      <span class="ds-small ds-muted" data-voices="unavailable">The voice list is not available (${list.reason}). Type the name or the voice id.
        <button class="ds-btn ds-btn--ghost ds-btn--sm" type="button" onClick=${refresh}>Try again</button></span></div>`;
  if (typing)
    return html`<div class="ds-stack ds-voice-input">${text}<button class="ds-btn ds-btn--ghost ds-btn--sm" type="button" onClick=${() => setTyping(false)}>Pick from the list</button></div>`;
  const known = (list.voices ?? []).some((v) => v.name === value);
  const own = list.voices.filter((v) => v.own);
  const lib = list.voices.filter((v) => !v.own);
  const opt = (v) =>
    html`<option key=${v.id} value=${v.name}>${v.name}${v.category ? ` · ${v.category}` : ""}</option>`;
  return html`<div class="ds-stack ds-voice-input">
    <select class="ds-select" id=${id} value=${value ?? ""} disabled=${disabled} data-voices="list" onChange=${(e) => (e.target.value === "__type__" ? setTyping(true) : onChange(e.target.value))}>
      <option value="">${emptyLabel}</option>
      ${value && !known ? html`<option value=${value}>${value} (not in your account)</option>` : null}
      ${own.length ? html`<optgroup label="Yours">${own.map(opt)}</optgroup>` : null}
      ${lib.length ? html`<optgroup label="Library">${lib.map(opt)}</optgroup>` : null}
      <option value="__type__">Type a name or voice id…</option>
    </select>
    <span class="ds-small ds-muted">${list.voices.length} voices in your account, yours first.</span>
  </div>`;
}
