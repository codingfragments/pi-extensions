import { html } from "/vendor/preact-htm.module.js";
import { chapterAt, clock, frameAt } from "./chapters-core.js";
import { media } from "./core.js";

export { chapterAt, clock, frameAt };

const WORD = { start: "start", end: "end" };
// The shared chapter and frame list (item 7, R0): the scenes of a take as chapters, each with its frames (the start, each
// mark, anything notable, the end) as thumbnails. A click means "go to that moment" (`onSeek(ms)`); the playhead marks the
// chapter and the frame you are at. Recording uses it to move through a take; the voice-over uses it for the scene's
// filmstrip with `note(scene, frame)` saying which frames the narration uses and which it does not mention.

/**
 * `scenes`: [{ id, title, startMs, endMs, frames: [{ label, kind, t, file? }] }]. `time`: the playhead in ms (null when
 * there is none). `note(scene, frame)` may return { text, tone } shown under a frame.
 */
export function Chapters({ scenes, time = null, onSeek, note, label = "Chapters" }) {
  const at = time === null ? -1 : chapterAt(scenes, time);
  return html`<ol class="ds-chapters" aria-label=${label}>
    ${scenes.map((s, i) => {
      const here = i === at;
      const fi = here ? frameAt(s.frames, time) : -1;
      return html`<li class="ds-chapter" key=${s.id} data-here=${here ? "true" : undefined}>
        <button class="ds-chapter-head" type="button" data-act="chapter" data-scene=${s.id} aria-current=${here ? "true" : undefined}
          aria-label=${`Go to ${s.title}, ${clock(s.startMs)}`} disabled=${!onSeek} onClick=${() => onSeek?.(s.startMs)}>
          <span class="ds-chapter-no mono">${s.id}</span>
          <span class="ds-chapter-title">${s.title}</span>
          <span class="ds-chapter-len ds-muted ds-small">${clock(s.startMs)} · ${((s.endMs - s.startMs) / 1000).toFixed(0)} s</span>
        </button>
        ${
          s.frames.length
            ? html`<ul class="ds-frames">${s.frames.map((f, j) => {
                const n = note?.(s, f);
                return html`<li key=${`${f.label}-${f.t}`}>
                <button class="ds-frame" type="button" data-act="frame" data-kind=${f.kind} data-label=${f.label} data-t=${f.t} aria-current=${j === fi ? "true" : undefined}
                  aria-label=${`Go to ${WORD[f.kind] ?? f.label} of ${s.title}, ${clock(f.t)}${n ? `, ${n.text}` : ""}`} disabled=${!onSeek} onClick=${() => onSeek?.(f.t)}>
                  ${f.file ? html`<img loading="lazy" src=${media("project", f.file)} alt="" />` : html`<span class="ds-frame-missing" aria-hidden="true">no frame</span>`}
                  <span class="ds-frame-cap"><span class="ds-frame-label">${WORD[f.kind] ?? f.label}</span><span class="ds-muted ds-small">${clock(f.t)}</span></span>
                  ${n ? html`<span class="ds-frame-note" data-tone=${n.tone}>${n.text}</span>` : null}
                </button>
              </li>`;
              })}</ul>`
            : html`<p class="ds-small ds-muted ds-chapter-nofr">No frames for this scene.</p>`
        }
      </li>`;
    })}
  </ol>`;
}

/**
 * The frames of ONE scene as a strip (the voice-over's "the scene's moments", F16): `frames` are
 * [{ label, kind, t, file?, note?: { text, tone }, onPick?: () => void }]. A frame with `onPick` is a button, the others are plain
 * pictures with their caption. `note` says what the narration does with the moment ("used", "not mentioned").
 */
export function FrameStrip({ frames, label }) {
  return html`<ul class="ds-frames ds-frames--strip" aria-label=${label}>
    ${frames.map((f) => {
      const body = html`${f.file ? html`<img loading="lazy" src=${media("project", f.file)} alt="" />` : html`<span class="ds-frame-missing" aria-hidden="true">no frame</span>`}
        <span class="ds-frame-cap"><span class="ds-frame-label">${WORD[f.kind] ?? f.label}</span><span class="ds-muted ds-small">${clock(f.t)}</span></span>
        ${f.note ? html`<span class="ds-frame-note" data-tone=${f.note.tone}>${f.note.text}</span>` : null}`;
      const name = `${WORD[f.kind] ?? f.label}, ${clock(f.t)}${f.note ? `, ${f.note.text}` : ""}`;
      return html`<li key=${`${f.label}-${f.t}`} data-kind=${f.kind} data-label=${f.label} data-used=${f.used ? "true" : undefined}>
        ${
          f.onPick
            ? html`<button class="ds-frame" type="button" data-act="frame-pick" aria-label=${name} onClick=${f.onPick}>${body}</button>`
            : html`<div class="ds-frame ds-frame--plain" role="group" aria-label=${name}>${body}</div>`
        }
      </li>`;
    })}
  </ul>`;
}
