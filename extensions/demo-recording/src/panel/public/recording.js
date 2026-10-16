import { html, useEffect, useRef, useState } from "/vendor/preact-htm.module.js";
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

function TakeCard({ t, row, events, viewed, reload }) {
  const [showVideo, setShowVideo] = useState(false);
  const card = useRef(null);
  useEffect(() => {
    if (viewed) card.current?.scrollIntoView({ block: "nearest" });
  }, [viewed]);
  return html`<section ref=${card} id=${`take-${t.version}`} aria-current=${viewed ? "true" : undefined} class=${`card take ${t.accepted ? "accepted" : ""} ${t.onLine ? "on-line" : ""}`}>
    <div class="row">
      <h3>${t.id}</h3>
      ${row ? html`<${RowBadges} row=${row} viewing=${viewed} />` : null}
      <span class=${`pill ${t.status === "ok" ? "" : "fail-pill"}`}>${t.status === "ok" ? "complete" : t.status}</span>
      <span class="muted small-text">${t.durationMs ? `raw ${mmss(t.durationMs)}` : ""}${t.startedAt ? ` · recorded ${new Date(t.startedAt).toLocaleString()}` : ""}</span>
      <span class="grow"></span>
      ${t.analyzed ? html`<span class="muted small-text">analyzed · ${t.scenes.length} scenes</span>` : html`<span class="muted small-text">not analyzed yet</span>`}
      <span class="muted small-text" title="positions of visible elements, for annotations (S5 part 6)">${t.layoutSnapshots !== null && t.layoutSnapshots !== undefined ? `${t.layoutSnapshots} layout snapshots` : "no layout snapshots (recorded before S5 part 6)"}</span>
      ${t.video ? html`<button class="ghost" onClick=${() => setShowVideo(!showVideo)}>${showVideo ? "hide video" : "play raw take"}</button>` : null}
      <${VersionActions} stage="recording" row=${row} events=${events} eager=${false} compact label=${t.id} onDone=${reload} />
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
  return html`
    <${StageSummary} stage="recording" row=${routeRow} rows=${rows} viewed=${routeVersion}
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
        ? data.takes.map(
            (t) =>
              html`<${TakeCard} key=${t.id} t=${t} row=${rows.find((r) => r.version === t.version)} events=${events} viewed=${t.version === routeVersion} reload=${reload} />`,
          )
        : html`<section class="card muted">${data.storyboard !== null ? `No takes of storyboard v${data.storyboard} yet — request one, the agent records it (its progress is in the Activity drawer).` : "Accept a storyboard first; its takes show up here."}</section>`
    }`;
}
