import { html, useLayoutEffect, useRef, useState } from "/vendor/preact-htm.module.js";
import { Chapters, chapterAt, clock } from "./chapters.js";
import { media, mmss, post, useApi, useRouteVersion } from "./core.js";
// demo-recording panel — Recording tab (S5 part 4, D44–D46; UX3): the takes of the production line's
// storyboard (a take of another storyboard can be looked at via History), approve several, put one in
// the production line, and ask for a new take of that storyboard.
import { CostHint, confirmCost } from "./cost.js";
import { errorToast, toast } from "./dialog.js";
import { stageOf } from "./stages.js";
import {
  RowBadges,
  StageSummary,
  VersionActions,
  runVersionAction,
  useHistory,
} from "./version-ui.js";

/** One line per take: its state and its actions. "Review" picks the take the workspace below shows. */
function TakeRow({ t, row, events, viewed, selected, onSelect, reload }) {
  return html`<section id=${`take-${t.version}`} aria-current=${viewed ? "true" : undefined} data-selected=${selected ? "true" : undefined} class=${`card take ${t.accepted ? "accepted" : ""} ${t.onLine ? "on-line" : ""}`}>
    <div class="row">
      <h3>${t.id}</h3>
      ${row ? html`<${RowBadges} row=${row} viewing=${viewed} />` : null}
      ${t.status ? html`<span class="ds-badge" data-tone=${t.status === "ok" ? "ok" : "err"}>${t.status === "ok" ? "complete" : t.status}</span>` : null}
      <span class="muted small-text">${t.durationMs ? `raw ${mmss(t.durationMs)}` : ""}${t.startedAt ? ` · recorded ${new Date(t.startedAt).toLocaleString()}` : ""}</span>
      <span class="grow"></span>
      ${t.analyzed ? html`<span class="muted small-text">analyzed · ${t.scenes.length} scenes</span>` : html`<span class="muted small-text">not analyzed yet</span>`}
      <span class="muted small-text" title="positions of visible elements, for annotations (S5 part 6)">${t.layoutSnapshots !== null && t.layoutSnapshots !== undefined ? `${t.layoutSnapshots} layout snapshots` : "no layout snapshots (recorded before S5 part 6)"}</span>
      <button class="ds-btn ds-btn--ghost" type="button" data-act="review-take" aria-pressed=${selected} onClick=${onSelect}>${selected ? "Reviewing" : "Review"}</button>
      <${VersionActions} stage="recording" row=${row} events=${events} eager=${false} compact label=${t.id} onDone=${reload} />
    </div>
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
  const onKeyDown = (e) => {
    if (
      e.ctrlKey ||
      e.metaKey ||
      e.altKey ||
      e.target.closest?.("input, textarea, select, [contenteditable]")
    )
      return;
    if (e.key === "[" || e.key === "]") {
      e.preventDefault();
      step(e.key === "]" ? 1 : -1);
    } else if ((e.key === "n" || e.key === "N" || e.key === "+") && t.video) {
      e.preventDefault();
      startNote();
    }
  };
  if (!scenes.length)
    return html`<section class="card muted">${t.analyzed ? "No scenes in this take's analysis." : "This take is not analyzed yet: its chapters appear once it is."}</section>`;
  return html`<div class="ds-rv-wrap"><div class="ds-rv" onKeyDown=${onKeyDown} data-take=${t.id}>
    <div class="ds-rv-chapters"><${Chapters} scenes=${scenes} time=${playing ? time : null} onSeek=${t.video ? seek : undefined} label=${`Chapters of ${t.id}`} /></div>
    <div class="ds-rv-pane">
      <${SceneContext} scene=${scenes[current]} onSeek=${t.video ? seek : () => undefined} />
      ${
        t.video
          ? html`<div class="ds-rv-player"><video class="ds-rv-video" ref=${video} controls preload="metadata" aria-label=${`Raw recording ${t.id}`} src=${media("project", t.video)} onTimeUpdate=${(e) => setTime(Math.round(e.currentTarget.currentTime * 1000))}></video>
            <${ChapterBar} scenes=${scenes} durationMs=${t.durationMs ?? 0} time=${time} current=${current} onSeek=${seek} />
            <div class="ds-row-flex"><button class="ds-btn ds-btn--sm" type="button" data-act="add-note" onClick=${startNote}>Add note at ${clock(time ?? 0)}${scenes[current] ? ` · ${scenes[current].id}` : ""}</button>
              <span class="ds-small ds-muted"><kbd class="ds-kbd">N</kbd> adds a note, <kbd class="ds-kbd">[</kbd> / <kbd class="ds-kbd">]</kbd> change chapter (focus inside)</span></div></div>`
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
  const [picked, setPicked] = useState(null);
  if (error) return html`<section class="card error">${error}</section>`;
  if (!data) return html`<section class="card muted">loading…</section>`;
  if (!data.project) return html`<section class="card muted">No active project.</section>`;
  const request = async () => {
    setBusy(true);
    try {
      if (!(await confirmCost("rerecord", { storyboard: data.storyboard }))) return;
      await post("/api/rerecord", { storyboard: data.storyboard, note });
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
  // the take the workspace shows: the one you picked, else the one you are viewing, else the one in the production line, else the newest
  const reviewed =
    data.takes.find((t) => t.id === picked) ??
    data.takes.find((t) => t.version === routeVersion) ??
    data.takes.find((t) => t.onLine) ??
    data.takes[0];
  return html`
    <${StageSummary} events=${events} stage="recording" row=${routeRow} rows=${rows} viewed=${routeVersion}
      onUse=${(v) => runVersionAction({ stage: "recording", version: v, intent: "use" }).then(reload)}
      meta=${html`<span>Takes of storyboard <strong style="color:var(--text-strong)">${sb}</strong></span><span>${data.takes.length} take(s)</span>`} />
    <p class="ds-small ds-muted ds-take-guide">Approve every take that is good enough to build on: each approved take can get its own voice-over. <b>Use for next steps</b> puts a take in the production line (the Voice over screen and the Director follow it).</p>
    ${
      data.takes.length
        ? html`${data.takes.map(
            (t) =>
              html`<${TakeRow} key=${t.id} t=${t} row=${rows.find((r) => r.version === t.version)} events=${events} viewed=${t.version === routeVersion} selected=${t.id === reviewed.id} onSelect=${() => setPicked(t.id)} reload=${reload} />`,
          )}<${TakeWorkspace} key=${reviewed.id} t=${reviewed} reload=${reload} />`
        : html`<section class="card muted">${data.storyboard !== null ? `No takes of storyboard v${data.storyboard} yet — request one, the agent records it (its progress is in the Activity drawer).` : "Accept a storyboard first; its takes show up here."}</section>`
    }
    <section class="card review-foot ds-inflow" data-request-take>
      <textarea placeholder="Notes for the next take (what to change, what to re-explore)…" aria-label="notes for the next take" value=${note} onInput=${(e) => setNote(e.target.value)}></textarea>
      <div class="row">
        ${data.openNotes ? html`<span class="muted small-text" data-open-notes>${data.openNotes} open note${data.openNotes === 1 ? "" : "s"} will go with it</span>` : html`<span class="muted small-text">No open notes on the takes</span>`}
        <span class="grow"></span>
        ${flash ? html`<span class="flash">${flash}</span>` : null}
        <button class="ds-btn ds-btn--primary" type="button" disabled=${busy || !data.storyboardUsable} title=${data.storyboardUsable ? "asks the agent to record a new take of this storyboard" : "accept a storyboard first"}
          onClick=${request}>Request a new take</button><${CostHint} />
      </div>
    </section>`;
}
