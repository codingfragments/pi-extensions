// demo-recording panel — Recording tab (S5 part 4, D44–D46): pick an accepted
// storyboard (the input), see its takes, accept several, put one on the
// working line, and ask for a new take of that storyboard.
import { html, useState } from "/vendor/preact-htm.module.js";
import { media, mmss, post, useApi } from "./core.js";
import { StageHeader, VersionActions, stageOf } from "./stages.js";

function TakeCard({ t, stages, reload }) {
  const [showVideo, setShowVideo] = useState(false);
  return html`<section class=${`card take ${t.accepted ? "accepted" : ""} ${t.onLine ? "on-line" : ""}`}>
    <div class="row">
      <h3>${t.id}</h3>
      <span class=${`pill ${t.status === "ok" ? "" : "fail-pill"}`}>${t.status === "ok" ? "complete" : t.status}</span>
      <span class="muted small-text">${t.durationMs ? `raw ${mmss(t.durationMs)}` : ""}${t.startedAt ? ` · recorded ${new Date(t.startedAt).toLocaleString()}` : ""}</span>
      <span class="grow"></span>
      ${t.analyzed ? html`<span class="muted small-text">analyzed · ${t.scenes.length} scenes</span>` : html`<span class="muted small-text">not analyzed yet</span>`}
      <span class="muted small-text" title="positions of visible elements, for annotations (S5 part 6)">${t.layoutSnapshots !== null && t.layoutSnapshots !== undefined ? `${t.layoutSnapshots} layout snapshots` : "no layout snapshots (recorded before S5 part 6)"}</span>
      ${t.video ? html`<button class="ghost" onClick=${() => setShowVideo(!showVideo)}>${showVideo ? "hide video" : "play raw take"}</button>` : null}
      <${VersionActions} stages=${stages} stage="recording" version=${t.version} label=${t.id}
        disabled=${t.status !== "ok"} disabledWhy=${t.status !== "ok" ? "this take did not complete" : ""}
        unlocks="Voice-overs can be written for this take." onDone=${reload} />
    </div>
    ${showVideo && t.video ? html`<video class="take-video" controls preload="metadata" src=${media("project", t.video)}></video>` : null}
    ${
      t.scenes.length
        ? html`<div class="keyframes">${t.scenes.map(
            (s) => html`<figure title=${s.title}>
              ${s.keyframe ? html`<img loading="lazy" src=${media("project", s.keyframe)} alt=${s.title} />` : html`<div class="kf-missing">no keyframe</div>`}
              <figcaption><span class="mono">${s.id}</span> · ${mmss(s.durationMs)}</figcaption>
            </figure>`,
          )}</div>`
        : null
    }
  </section>`;
}

export function Recording({ events, stages }) {
  const input = stageOf(stages, "recording")?.input;
  const path = input !== undefined ? `/api/recordings?storyboard=${input}` : "/api/recordings";
  const { data, error, reload } = useApi(
    path,
    events,
    /^(take|recording|storyboard|project|stage|line)\./,
  );
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const [note, setNote] = useState("");
  if (error) return html`<section class="card error">${error}</section>`;
  if (!data) return html`<section class="card muted">loading…</section>`;
  if (!data.project) return html`<section class="card muted">No active project.</section>`;
  const request = async () => {
    setBusy(true);
    try {
      await post("/api/rerecord", { storyboard: data.storyboard, note });
      setNote("");
      setFlash(`new take of storyboard v${data.storyboard} requested — the agent records it`);
    } catch (e) {
      setFlash(`⚠ ${e.message}`);
    } finally {
      setBusy(false);
      setTimeout(() => setFlash(null), 6000);
    }
  };
  return html`
    <${StageHeader} stages=${stages} stage="recording" />
    <section class="card review-head">
      <div class="row">
        <h2>Takes of storyboard ${data.storyboard !== null ? `v${data.storyboard}` : "—"}</h2>
        <span class="muted small-text">${data.takes.length} take(s)</span>
        <span class="grow"></span>
        ${flash ? html`<span class="flash">${flash}</span>` : null}
        <input class="note" placeholder="notes for the next take (optional)" value=${note} onInput=${(e) => setNote(e.target.value)} />
        <button disabled=${busy || !data.storyboardUsable} title=${data.storyboardUsable ? "asks the agent to record a new take of this storyboard" : "accept a storyboard first"}
          onClick=${request}>Request a new take</button>
      </div>
      <p class="muted small-text">Accept every take that is good enough to build on — each accepted take can get its own voice-over. <b>Work on this</b> makes a take the working line (the Voice over tab and the agent follow it).</p>
    </section>
    ${
      data.takes.length
        ? data.takes.map(
            (t) => html`<${TakeCard} key=${t.id} t=${t} stages=${stages} reload=${reload} />`,
          )
        : html`<section class="card muted">${data.storyboard !== null ? `No takes of storyboard v${data.storyboard} yet — request one, the agent records it (it streams in the Live panel).` : "Accept a storyboard first; its takes show up here."}</section>`
    }`;
}
