import { html, useEffect, useLayoutEffect, useRef, useState } from "/vendor/preact-htm.module.js";
import { Chapters, chapterAt, clock } from "./chapters.js";
import { media, mmss, post, useApi, useHashRoute, useRouteVersion } from "./core.js";
// demo-recording panel — Recording tab (S5 part 4, D44–D46; UX3): the takes of the production line's
// storyboard (a take of another storyboard can be looked at via History), approve several, put one in
// the production line, and ask for a new take of that storyboard.
import { CostHint, confirmCost } from "./cost.js";
import { errorToast, toast } from "./dialog.js";
import { clampSeek, findingStops, keyAction, stopFrom } from "./recording-keys-core.js";
import { stageOf } from "./stages.js";
import {
  RowBadges,
  StageSummary,
  VersionActions,
  runVersionAction,
  useHistory,
} from "./version-ui.js";

/** One line per take: its state and its actions. "Review" picks the take the workspace below shows. */
/** One vocabulary for what happened to a take (R3-16): a word, a tone, a mark. */
const RUN_STATE = {
  complete: ["ok", "✓", "Complete"],
  recording: ["info", "◔", "Recording now"],
  interrupted: ["warn", "!", "Interrupted"],
  failed: ["err", "!", "Failed"],
  cancelled: ["neutral", "■", "Cancelled"],
};
const finished = (t) => (t.state ?? "complete") === "complete";

function RunState({ state }) {
  const [tone, ico, word] = RUN_STATE[state ?? "complete"] ?? RUN_STATE.complete;
  return html`<span class="ds-badge" data-tone=${tone} data-run-state=${state ?? "complete"}><span class="ds-badge-ico" aria-hidden="true">${ico}</span>${word}</span>`;
}

/**
 * One take: what happened to it (the run state), where it stands (approved, in the production line: only for a complete take), and whether it is the one shown below.
 * A take that did not complete has no approve buttons (the server refuses it too) and says why instead.
 */
function TakeRow({ t, row, events, shown, onShow, reload }) {
  const done = finished(t);
  return html`<section id=${`take-${t.version}`} aria-current=${shown ? "true" : undefined} data-selected=${shown ? "true" : undefined} data-run-state=${t.state ?? "complete"} class=${`card take ${t.accepted ? "accepted" : ""} ${t.onLine ? "on-line" : ""} ${shown ? "shown" : ""}`}>
    <div class="row">
      <h3>${t.id}</h3>
      <${RunState} state=${t.state} />
      ${done && row ? html`<${RowBadges} row=${row} viewing=${false} />` : null}
      ${shown ? html`<span class="ds-badge" data-tone="accent" data-shown><span class="ds-badge-ico" aria-hidden="true">▼</span>Shown below</span>` : null}
      <span class="muted small-text">${t.durationMs ? `raw ${mmss(t.durationMs)}` : ""}${t.startedAt ? `${t.durationMs ? " · " : ""}recorded ${new Date(t.startedAt).toLocaleString()}` : ""}</span>
      <span class="grow"></span>
      ${
        done
          ? html`${t.analyzed ? html`<span class="muted small-text">analyzed · ${t.scenes.length} scenes</span>` : html`<span class="muted small-text">not analyzed yet</span>`}
      <span class="muted small-text" title="positions of visible elements, for annotations (S5 part 6)">${t.layoutSnapshots !== null && t.layoutSnapshots !== undefined ? `${t.layoutSnapshots} layout snapshots` : "no layout snapshots (recorded before S5 part 6)"}</span>`
          : html`<span class="muted small-text">${t.state === "recording" ? "its progress is in the Activity drawer" : "it cannot be approved: it did not complete"}</span>`
      }
      <button class="ds-btn ds-btn--ghost" type="button" data-act="review-take" aria-pressed=${shown} onClick=${onShow}>${shown ? "Shown below" : "Show"}</button>
      ${done ? html`<${VersionActions} stage="recording" row=${row} events=${events} eager=${false} compact label=${t.id} onDone=${reload} />` : null}
    </div>
  </section>`;
}

/** A take that never finished and that nothing records any more (pi was closed, or the browser hung): it says so, and where its traces are. */
function InterruptedTake({ t }) {
  return html`<section class="card ds-failed-take" data-interrupted-take=${t.id} aria-label=${`${t.id} was interrupted`}>
    <div class="ds-row-flex"><span class="ds-status" data-tone="warn" aria-hidden="true">!</span><h2>${t.id} was interrupted</h2></div>
    <p>It started${t.startedAt ? ` on ${new Date(t.startedAt).toLocaleString()}` : ""} and never finished: nothing records it any more (pi was closed, or the browser stopped answering). ${t.video ? "Its raw video is on disk, but it was not analyzed." : "No video was kept."} It cannot be approved.</p>
    <p class="ds-small ds-muted">What it left is in <code>takes/${t.id}/</code> (take.json, attempts.jsonl${t.diagnostics?.length ? `, ${t.diagnostics.at(-1)}/README.txt` : ""}). Request a new take below; your notes on this storyboard go with it.</p>
  </section>`;
}

/** The line above the workspace: which take it shows, what happened to it, where it stands, and what the production line has (R3-16). */
function ShownLine({ t, takes }) {
  const line = takes.find((x) => x.onLine);
  const [, , word] = RUN_STATE[t.state ?? "complete"] ?? RUN_STATE.complete;
  const standing = !finished(t)
    ? "it cannot be approved"
    : t.onLine
      ? "approved, in the production line"
      : t.accepted
        ? "approved, not in the production line"
        : "not approved";
  return html`<p class="ds-rv-shown" data-shown-line><b>Shown below: ${t.id}</b> · ${word.toLowerCase()} · ${standing}${t.onLine ? "" : ` · the production line has ${line ? line.id : "no recording yet"}`}</p>`;
}

/**
 * A take that did not finish: what failed, in words, the diagnosis, and a box for YOUR recommendation on the scene it failed in. Nothing starts by itself: the
 * recommendation is kept as a note for the next take, or sent to the Director now (it then proposes a storyboard fix as a new draft; it does not record).
 */
function FailedTake({ t, reload }) {
  const f = t.failure;
  const [text, setText] = useState(f.draft);
  const [busy, setBusy] = useState(null);
  // (the card is keyed by the take: another take is another card, with its own draft)
  const go = async (kind) => {
    setBusy(kind);
    try {
      await post(kind === "heal" ? "/api/take-heal" : `/api/take-recommend-${kind}`, {
        take: t.id,
        text,
      });
      toast(
        kind === "heal"
          ? "Asked the Director to look and repair: follow it in the Activity drawer."
          : kind === "send"
            ? "Sent to the Director: it proposes a storyboard fix as a new draft."
            : "Saved: it goes with the next take you request.",
        { kind: "ok" },
      );
      reload();
    } catch (e) {
      errorToast(e, "recommendation");
    } finally {
      setBusy(null);
    }
  };
  const mine = t.notes.filter((n) => !n.sent).length;
  return html`<section class="card ds-failed-take" data-failed-take=${t.id} aria-label=${`${t.id} did not finish`}>
    <div class="ds-row-flex"><span class="ds-status" data-tone="err" aria-hidden="true">!</span><h2>${t.id} did not finish</h2></div>
    <p data-failure-words>${f.words}.</p>
    ${f.verdict ? html`<p class="ds-small" data-verdict><b>The diagnosis:</b> ${f.verdict}</p>` : null}
    ${f.diagnostics.length ? html`<p class="ds-small ds-muted">Everything about it is in <code>takes/${t.id}/${f.diagnostics.at(-1)}/</code> (README.txt first).</p>` : null}
    <label class="ds-field"><span class="ds-label">Your recommendation${f.failure.scene ? html` for scene <code>${f.failure.scene}</code>` : null}</span>
      <textarea class="ds-textarea" rows="5" maxlength="1000" data-field="recommendation" value=${text} onInput=${(e) => setText(e.target.value)}></textarea>
      <span class="ds-hint-text">The evidence is filled in: add what you would change (another target, a deep link, a wait, drop the step).</span></label>
    <div class="ds-row-flex">
      <button class="ds-btn" type="button" data-act="recommend-save" disabled=${!!busy} onClick=${() => go("save")}>Save for the next take</button>
      <button class="ds-btn" type="button" data-act="heal" disabled=${!!busy} onClick=${() => go("heal")}>Heal it: let the Director look</button>
      <button class="ds-btn ds-btn--primary" type="button" data-act="recommend-send" disabled=${!!busy} onClick=${() => go("send")}>Send to the Director now</button><${CostHint} />
    </div>
    <p class="ds-small ds-muted">Nothing starts by itself. Saved, it is a note on this scene that “Request a new take” carries${mine ? ` (${mine} open note${mine === 1 ? "" : "s"} now)` : ""}. Sent, the Director proposes a storyboard fix as a new draft: it does not record or approve anything.</p>
  </section>`;
}

/** The chapter marks under the video: one segment per scene on the take's own time line, the playhead on top. */
function ChapterBar({ scenes, durationMs, time, current, onSeek }) {
  const total = Math.max(durationMs, scenes.at(-1)?.endMs ?? 0, 1);
  return html`<div class="ds-cbar" role="group" aria-label="Chapter marks">
    ${scenes.map(
      (
        s,
        i,
      ) => html`<button type="button" class="ds-cbar-seg" key=${s.id} data-act="chapter-mark" data-scene=${s.id} aria-current=${i === current ? "true" : undefined}
        style=${`inset-inline-start: ${(s.startMs / total) * 100}%; inline-size: ${((s.endMs - s.startMs) / total) * 100}%`}
        title=${`${s.id} · ${s.title}`} aria-label=${`Go to ${s.title}, ${clock(s.startMs)}`} onClick=${() => onSeek(s.startMs)}></button>`,
    )}
    ${time === null ? null : html`<span class="ds-cbar-head" aria-hidden="true" style=${`inset-inline-start: ${Math.min(100, (time / total) * 100)}%`}></span>`}
  </div>`;
}

const STATE_WORD = { use: "use", ignore: "ignored", auto: "" };

/** What the chapter is for and what the take found in it: the storyboard's goal, the findings it names, the engine's findings. */
function SceneContext({ scene, onSeek }) {
  if (!scene) return null;
  return html`<div class="ds-rv-context" role="region" aria-label=${`About ${scene.title}`} data-scene=${scene.id}>
    <h3><span class="mono ds-muted">${scene.id}</span> ${scene.title}</h3>
    ${
      scene.goal || scene.emphasis
        ? html`<p><strong>Goal</strong> ${scene.goal ?? ""}${scene.goal && scene.emphasis ? " · " : ""}${scene.emphasis ? html`<em>${scene.emphasis}</em>` : null}</p>`
        : html`<p class="ds-muted ds-small">The storyboard gives this scene no goal.</p>`
    }
    ${
      scene.planned.length
        ? html`<div><strong class="ds-small">Findings this scene should show</strong><ul class="ds-rv-list">${scene.planned.map((f) => html`<li key=${f.id}><span class="ds-badge" data-tone=${f.state === "use" ? "accent" : "neutral"}>${f.kind}${STATE_WORD[f.state] ? ` · ${STATE_WORD[f.state]}` : ""}</span> ${f.text}</li>`)}</ul></div>`
        : null
    }
    <div><strong class="ds-small">What this take found here</strong>
      ${
        scene.found.length
          ? html`<ul class="ds-rv-list">${scene.found.map((f) => html`<li key=${f.id}><button class="ds-btn ds-btn--ghost ds-btn--sm" type="button" data-act="found" disabled=${f.t === undefined} onClick=${() => onSeek(f.t)} aria-label=${`Go to ${clock(f.t ?? 0)}: ${f.text}`}>${clock(f.t ?? 0)}</button> <span class="ds-badge" data-tone="warn">${f.kind}</span> ${f.text}</li>`)}</ul>`
          : html`<p class="ds-muted ds-small">Nothing notable: no error, fallback, dead time or resume.</p>`
      }
    </div>
  </div>`;
}

/** The note being written or edited: a text box, saved with the button or Ctrl/Cmd+Enter, left with Escape. */
function NoteBox({ initial = "", label, onSave, onCancel }) {
  const [text, setText] = useState(initial);
  const box = useRef(null);
  // focus before the browser paints, so the first letter you type after pressing N already lands in the box
  useLayoutEffect(() => box.current?.focus(), []);
  const save = () => text.trim() && onSave(text.trim());
  return html`<div class="ds-note-box">
    <label class="ds-label ds-small" for=${`nb-${label}`}>${label}</label>
    <textarea class="ds-textarea ds-textarea--compact" id=${`nb-${label}`} ref=${box} rows="3" maxlength="1000" value=${text} onInput=${(e) => setText(e.target.value)}
      onKeyDown=${(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          save();
        }
      }}></textarea>
    <div class="ds-row-flex"><button class="ds-btn ds-btn--primary ds-btn--sm" type="button" data-act="note-save" disabled=${!text.trim()} onClick=${save}>Save note</button><button class="ds-btn ds-btn--sm" type="button" data-act="note-cancel" onClick=${onCancel}>Cancel</button><span class="ds-small ds-muted">Ctrl/Cmd+Enter saves, Esc cancels</span></div>
  </div>`;
}

/** The notes of a take (item 7c): review input, listed by moment; a time chip goes there. Nothing is sent until a take is requested. */
function NotesPanel({ take, notes, draft, onDraft, onSeek, onSaved }) {
  const [editing, setEditing] = useState(null);
  const call = async (route, body) => {
    try {
      return await post(`/api/${route}`, { take, ...body });
    } catch (e) {
      errorToast(e, "note");
      return null;
    }
  };
  const create = async (text) => {
    if (await call("take-note-add", { t: draft.t, scene: draft.scene, text })) {
      onDraft(null);
      onSaved();
    }
  };
  const edit = async (n, text) => {
    if (await call("take-note-edit", { id: n.id, text })) {
      setEditing(null);
      onSaved();
    }
  };
  const remove = async (n) => {
    const r = await call("take-note-delete", { id: n.id });
    if (!r) return;
    onSaved();
    toast(`Note at ${clock(n.t)} removed`, {
      kind: "info",
      action: {
        label: "Undo",
        onClick: async () => (await call("take-note-restore", { note: r.note })) && onSaved(),
      },
    });
  };
  const open = notes.filter((n) => !n.sent).length;
  return html`<section class="ds-rv-notes" aria-label=${`Notes on ${take}`}>
    <h3>Notes ${notes.length ? html`<span class="ds-badge" data-tone=${open ? "accent" : "neutral"}>${open ? `${open} open` : "all sent"}</span>` : null}</h3>
    ${draft ? html`<${NoteBox} label=${`New note at ${clock(draft.t)}${draft.scene ? ` · ${draft.scene}` : ""}`} onSave=${create} onCancel=${() => onDraft(null)} />` : null}
    ${
      notes.length
        ? html`<ul class="ds-notes">${notes.map(
            (
              n,
            ) => html`<li class="ds-note" key=${n.id} data-note=${n.id} data-sent=${n.sent ? "true" : undefined}>
              <div class="ds-note-meta"><button class="ds-btn ds-btn--ghost ds-btn--sm" type="button" data-act="note-seek" aria-label=${`Go to ${clock(n.t)}`} onClick=${() => onSeek(n.t)}>${clock(n.t)}</button>${n.scene ? html`<span class="mono ds-small ds-muted">${n.scene}</span>` : null}${n.sent ? html`<span class="ds-badge" data-tone="neutral" title=${`Carried by the request for a new take of storyboard v${n.sent.storyboard}`}>sent</span>` : null}</div>
              ${
                editing === n.id
                  ? html`<${NoteBox} initial=${n.text} label=${`Edit the note at ${clock(n.t)}`} onSave=${(text) => edit(n, text)} onCancel=${() => setEditing(null)} />`
                  : html`<p class="ds-note-text">${n.text}</p>
                    <div class="ds-row-flex">${n.sent ? null : html`<button class="ds-btn ds-btn--ghost ds-btn--sm" type="button" data-act="note-edit" onClick=${() => setEditing(n.id)}>Edit</button>`}<button class="ds-btn ds-btn--ghost ds-btn--sm" type="button" data-act="note-delete" onClick=${() => remove(n)}>Delete</button></div>`
              }
            </li>`,
          )}</ul>`
        : draft
          ? null
          : html`<p class="ds-small ds-muted">No notes yet. Pause on a moment and press <kbd class="ds-kbd">N</kbd>, or use Add note under the video.</p>`
    }
    <p class="ds-small ds-muted">Notes are not sent as you write. <strong>Request a new take</strong> at the bottom of the page carries the open ones to the Director, once.</p>
  </section>`;
}

/**
 * The review workspace of one take: the chapters with their frames beside a smaller player that stays in view, the scene's
 * goal and findings above it, chapter marks under it. `[` and `]` go to the previous / next chapter while focus is inside.
 */
function TakeWorkspace({ t, reload }) {
  const [time, setTime] = useState(null);
  const [focus, setFocus] = useState(0);
  const [draft, setDraft] = useState(null);
  const video = useRef(null);
  const pending = useRef(null);
  const scenes = t.review ?? [];
  const playing = time !== null;
  const current = playing ? Math.max(0, chapterAt(scenes, time)) : focus;
  const seek = (ms) => {
    const v = video.current;
    const to = () => {
      v.currentTime = ms / 1000;
      setTime(ms);
    };
    setFocus(Math.max(0, chapterAt(scenes, ms)));
    if (!v) return;
    if (v.readyState >= 1) to();
    else {
      pending.current = ms;
      v.addEventListener("loadedmetadata", () => pending.current === ms && to(), { once: true });
    }
  };
  const step = (d) => {
    const i = Math.min(scenes.length - 1, Math.max(0, current + d));
    if (scenes[i]) seek(scenes[i].startMs);
  };
  /** A note at the moment the video is at (the video pauses: you are about to type). Its time is fixed when you start it. */
  const startNote = () => {
    const v = video.current;
    if (!v) return;
    v.pause();
    const at = Math.round(v.currentTime * 1000);
    const sc = scenes[chapterAt(scenes, at)];
    setTime(at);
    setDraft({ t: at, ...(sc ? { scene: sc.id } : {}) });
  };
  const [keyNote, setKeyNote] = useState("");
  const stops = findingStops(scenes);
  /** Where the video is now (ms): the player's own clock, which is ahead of the last time update. */
  const nowMs = () => Math.round((video.current?.currentTime ?? 0) * 1000);
  const act = (a) => {
    if (!t.video) return;
    if (a.kind === "note") return startNote();
    if (a.kind === "chapter") return step(a.d);
    if (a.kind === "seekBy") {
      const v = video.current;
      const to = clampSeek(nowMs(), a.ms, (v?.duration ?? 0) * 1000 || (t.durationMs ?? 0));
      seek(to);
      return setKeyNote(
        `${a.ms < 0 ? "Back" : "Forward"} ${Math.abs(a.ms) / 1000} s · ${clock(to)}`,
      );
    }
    const stop = stopFrom(stops, nowMs(), a.d);
    if (!stop)
      return setKeyNote(
        stops.length
          ? `No ${a.d > 0 ? "further" : "earlier"} finding`
          : "This take has no findings to move between",
      );
    seek(stop.ms);
    setKeyNote(
      `Finding ${stops.indexOf(stop) + 1} of ${stops.length} · ${clock(stop.ms)} · ${stop.scene}: ${stop.text.length > 70 ? `${stop.text.slice(0, 69)}…` : stop.text}`,
    );
  };
  // the keys work anywhere on the tab, not only while the player has the focus; never while you type, in a dialog, or with a modifier
  const handler = useRef(null);
  handler.current = (e) => {
    if (
      e.defaultPrevented ||
      e.ctrlKey ||
      e.metaKey ||
      e.altKey ||
      e.target?.closest?.("input, textarea, select, [contenteditable]") ||
      document.querySelector(".modal-backdrop")
    )
      return;
    const a = keyAction(e.key, e.shiftKey);
    if (!a) return;
    e.preventDefault(); // also takes the arrows from a focused <video> (it would seek 5 s by itself)
    act(a);
  };
  useEffect(() => {
    const on = (e) => handler.current?.(e);
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, []);
  if (!scenes.length)
    return html`<section class="card muted">${t.analyzed ? "No scenes in this take's analysis." : "This take is not analyzed yet: its chapters appear once it is."}</section>`;
  return html`<div class="ds-rv-wrap"><div class="ds-rv" data-take=${t.id}>
    <div class="ds-rv-chapters"><${Chapters} scenes=${scenes} time=${playing ? time : null} onSeek=${t.video ? seek : undefined} label=${`Chapters of ${t.id}`} /></div>
    <div class="ds-rv-pane">
      <${SceneContext} scene=${scenes[current]} onSeek=${t.video ? seek : () => undefined} />
      ${
        t.video
          ? html`<div class="ds-rv-player">
            <div class="ds-rv-now" data-rv-now aria-live="off"><span class="ds-rv-now-scene"><span class="mono ds-muted">${scenes[current]?.id ?? ""}</span> ${scenes[current]?.title ?? ""}</span><span class="ds-small ds-muted mono">${clock(time ?? 0)} / ${clock(t.durationMs ?? 0)} · ${t.id}</span></div>
            <video class="ds-rv-video" ref=${video} controls preload="metadata" aria-label=${`Raw recording ${t.id}`} src=${media("project", t.video)} onTimeUpdate=${(e) => setTime(Math.round(e.currentTarget.currentTime * 1000))}></video>
            <${ChapterBar} scenes=${scenes} durationMs=${t.durationMs ?? 0} time=${time} current=${current} onSeek=${seek} />
            <div class="ds-row-flex"><button class="ds-btn ds-btn--sm" type="button" data-act="add-note" onClick=${startNote}>Add note at ${clock(time ?? 0)}${scenes[current] ? ` · ${scenes[current].id}` : ""}</button>
              <span class="ds-small ds-muted">On this whole tab: <kbd class="ds-kbd">N</kbd> adds a note · <kbd class="ds-kbd">[</kbd> <kbd class="ds-kbd">]</kbd> chapter · <kbd class="ds-kbd">&lt;</kbd> <kbd class="ds-kbd">&gt;</kbd> finding · <kbd class="ds-kbd">←</kbd> <kbd class="ds-kbd">→</kbd> 10 s (Shift: 1 s)</span></div>
            <p class="ds-small" role="status" data-keystatus>${keyNote}</p></div>`
          : html`<p class="ds-notice" role="note">This take has no raw video on disk, so the chapters cannot play.</p>`
      }
    </div>
    ${t.video ? html`<${NotesPanel} take=${t.id} notes=${t.notes ?? []} draft=${draft} onDraft=${setDraft} onSeek=${seek} onSaved=${reload} />` : null}
  </div></div>`;
}

export function Recording({ events, stages }) {
  const hist = useHistory("recording", events);
  const routeVersion = useRouteVersion("recording");
  const rows = hist.data?.rows ?? [];
  const routeRow = routeVersion !== null ? rows.find((r) => r.version === routeVersion) : null;
  // a take of another storyboard can be looked at (read-only); otherwise the takes of the production line's storyboard
  const input = routeRow?.basedOn?.version ?? stageOf(stages, "recording")?.input;
  const path = input !== undefined ? `/api/recordings?storyboard=${input}` : "/api/recordings";
  const { data, error, reload } = useApi(
    path,
    events,
    /^(take|recording|storyboard|project|stage|line)\./,
  );
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const [note, setNote] = useState("");
  const [headed, setHeaded] = useState(false);
  const [, go] = useHashRoute();
  if (error) return html`<section class="card error">${error}</section>`;
  if (!data) return html`<section class="card muted">loading…</section>`;
  if (!data.project) return html`<section class="card muted">No active project.</section>`;
  const request = async () => {
    setBusy(true);
    try {
      if (!(await confirmCost("rerecord", { storyboard: data.storyboard }))) return;
      await post("/api/rerecord", { storyboard: data.storyboard, note, headed });
      setNote("");
      setFlash(`new take of storyboard v${data.storyboard} requested — the agent records it`);
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
      setTimeout(() => setFlash(null), 6000);
    }
  };
  const sb = data.storyboard !== null ? `v${data.storyboard}` : "—";
  // the take the workspace shows: the one in the address (Show puts it there, so the header, the row and the workspace name the same take), else the one in the
  // production line, else the newest
  const show = (t) => go({ screen: "recording", version: t.version }, { replace: true });
  const reviewed =
    data.takes.find((t) => t.version === routeVersion) ??
    data.takes.find((t) => t.onLine) ??
    data.takes[0];
  return html`
    <${StageSummary} events=${events} stage="recording" row=${routeRow ?? (reviewed ? rows.find((r) => r.version === reviewed.version) : undefined)} rows=${rows} viewed=${routeVersion}
      onUse=${(v) => runVersionAction({ stage: "recording", version: v, intent: "use" }).then(reload)}
      meta=${html`<span>Takes of storyboard <strong style="color:var(--text-strong)">${sb}</strong></span><span>${data.takes.length} take(s)</span>`} />
    <p class="ds-small ds-muted ds-take-guide">Approve every take that is good enough to build on: each approved take can get its own voice-over. <b>Use for next steps</b> puts a take in the production line (the Voice over screen and the Director follow it).</p>
    ${
      data.takes.length
        ? html`${data.takes.map(
            (t) =>
              html`<${TakeRow} key=${t.id} t=${t} row=${rows.find((r) => r.version === t.version)} events=${events} shown=${t.id === reviewed.id} onShow=${() => show(t)} reload=${reload} />`,
          )}<${ShownLine} t=${reviewed} takes=${data.takes} />${reviewed.failure ? html`<${FailedTake} key=${reviewed.id} t=${reviewed} reload=${reload} />` : reviewed.state === "interrupted" ? html`<${InterruptedTake} key=${reviewed.id} t=${reviewed} />` : reviewed.state === "recording" ? html`<section class="card muted" data-recording-now>${reviewed.id} is being recorded: its progress is in the Activity drawer, and it shows here when it is done.</section>` : html`<${TakeWorkspace} key=${reviewed.id} t=${reviewed} reload=${reload} />`}`
        : html`<section class="card muted">${data.storyboard !== null ? `No takes of storyboard v${data.storyboard} yet — request one, the agent records it (its progress is in the Activity drawer).` : "Accept a storyboard first; its takes show up here."}</section>`
    }
    <section class="card review-foot ds-inflow" data-request-take>
      <textarea placeholder="Notes for the next take (what to change, what to re-explore)…" aria-label="notes for the next take" value=${note} onInput=${(e) => setNote(e.target.value)}></textarea>
      <label class="ds-check ds-small" data-headed-label title="A real browser window sometimes shows what a hidden one hides. The take is recorded the same way either way."><input type="checkbox" data-field="headed" checked=${headed} onChange=${(e) => setHeaded(e.target.checked)} /> Show the browser window while recording</label>
      <div class="row">
        ${data.openNotes ? html`<span class="muted small-text" data-open-notes>${data.openNotes} open note${data.openNotes === 1 ? "" : "s"} will go with it</span>` : html`<span class="muted small-text">No open notes on the takes</span>`}
        <span class="grow"></span>
        ${flash ? html`<span class="flash">${flash}</span>` : null}
        <button class="ds-btn ds-btn--primary" type="button" disabled=${busy || !data.storyboardUsable} title=${data.storyboardUsable ? "asks the agent to record a new take of this storyboard" : "accept a storyboard first"}
          onClick=${request}>Request a new take</button><${CostHint} />
      </div>
    </section>`;
}
