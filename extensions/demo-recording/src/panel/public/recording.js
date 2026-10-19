import { html, useEffect, useRef, useState } from "/vendor/preact-htm.module.js";
import { Chapters, chapterAt, clock } from "./chapters.js";
import { media, mmss, post, useApi, useRouteVersion } from "./core.js";
// demo-recording panel — Recording tab (S5 part 4, D44–D46; UX3): the takes of the production line's
// storyboard (a take of another storyboard can be looked at via History), approve several, put one in
// the production line, and ask for a new take of that storyboard.
import { CostHint, confirmCost } from "./cost.js";
import { errorToast } from "./dialog.js";
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

/**
 * The review workspace of one take: the chapters with their frames beside a smaller player that stays in view, the scene's
 * goal and findings above it, chapter marks under it. `[` and `]` go to the previous / next chapter while focus is inside.
 */
function TakeWorkspace({ t }) {
  const [time, setTime] = useState(null);
  const [focus, setFocus] = useState(0);
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
          ? html`<video class="ds-rv-video" ref=${video} controls preload="metadata" aria-label=${`Raw recording ${t.id}`} src=${media("project", t.video)} onTimeUpdate=${(e) => setTime(Math.round(e.currentTarget.currentTime * 1000))}></video>
            <${ChapterBar} scenes=${scenes} durationMs=${t.durationMs ?? 0} time=${time} current=${current} onSeek=${seek} />
            <p class="ds-small ds-muted">Focus here, then <kbd class="ds-kbd">[</kbd> / <kbd class="ds-kbd">]</kbd> go to the previous / next chapter.</p>`
          : html`<p class="ds-notice" role="note">This take has no raw video on disk, so the chapters cannot play.</p>`
      }
    </div>
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
    <section class="card review-head">
      <div class="row">
        <input class="ds-input ds-input--wide" placeholder="notes for the next take (optional)" aria-label="notes for the next take" value=${note} onInput=${(e) => setNote(e.target.value)} />
        <button class="ds-btn ds-btn--primary" type="button" disabled=${busy || !data.storyboardUsable} title=${data.storyboardUsable ? "asks the agent to record a new take of this storyboard" : "accept a storyboard first"}
          onClick=${request}>Request a new take</button>
        <${CostHint} />
        ${flash ? html`<span class="flash">${flash}</span>` : null}
      </div>
      <p class="muted small-text">Approve every take that is good enough to build on — each approved take can get its own voice-over. <b>Use for next steps</b> puts a take in the production line (the Voice over screen and the Director follow it).</p>
    </section>
    ${
      data.takes.length
        ? html`${data.takes.map(
            (t) =>
              html`<${TakeRow} key=${t.id} t=${t} row=${rows.find((r) => r.version === t.version)} events=${events} viewed=${t.version === routeVersion} selected=${t.id === reviewed.id} onSelect=${() => setPicked(t.id)} reload=${reload} />`,
          )}<${TakeWorkspace} key=${reviewed.id} t=${reviewed} />`
        : html`<section class="card muted">${data.storyboard !== null ? `No takes of storyboard v${data.storyboard} yet — request one, the agent records it (its progress is in the Activity drawer).` : "Accept a storyboard first; its takes show up here."}</section>`
    }`;
}
