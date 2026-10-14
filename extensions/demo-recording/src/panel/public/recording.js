// demo-recording panel — Recording tab (S5 part 4): takes per storyboard
// version, analysis state, keyframe strip, accept (chain-checked, with the
// cascade warning) and "request a new take" (an agent job).
import { html, useState } from "/vendor/preact-htm.module.js";
import { media, mmss, post, useApi } from "./core.js";
import { confirmApproval } from "./stages.js";

function TakeCard({ t, approvedStoryboard, busy, onAccept }) {
  const [showVideo, setShowVideo] = useState(false);
  return html`<section class=${`card take ${t.accepted ? "accepted" : ""}`}>
    <div class="row">
      <h3>${t.id}</h3>
      ${t.accepted ? html`<span class="badge approved">accepted</span>` : null}
      <span class=${`pill ${t.status === "ok" ? "" : "fail-pill"}`}>${t.status}</span>
      <span class="muted small-text">storyboard v${t.storyboardVersion}${t.onApprovedStoryboard ? "" : " (not the approved storyboard)"}
        ${t.durationMs ? ` · ${mmss(t.durationMs)}` : ""}${t.startedAt ? ` · ${new Date(t.startedAt).toLocaleString()}` : ""}</span>
      <span class="grow"></span>
      ${t.analyzed ? html`<span class="muted small-text">analyzed · ${t.scenes.length} scenes</span>` : html`<span class="muted small-text">not analyzed yet</span>`}
      ${t.video ? html`<button class="ghost" onClick=${() => setShowVideo(!showVideo)}>${showVideo ? "hide video" : "play raw take"}</button>` : null}
      <button class="primary" disabled=${busy || t.accepted || t.status !== "ok" || t.storyboardVersion !== approvedStoryboard}
        title=${t.storyboardVersion !== approvedStoryboard ? "only takes of the approved storyboard can be accepted" : t.status !== "ok" ? "this take did not complete" : ""}
        onClick=${() => onAccept(t)}>${t.accepted ? "Accepted" : "Accept take"}</button>
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

export function Recording({ events }) {
  const { data, error, reload } = useApi(
    "/api/recordings",
    events,
    /^(take|recording|storyboard|project)\./,
  );
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const [note, setNote] = useState("");
  if (error) return html`<section class="card error">${error}</section>`;
  if (!data) return html`<section class="card muted">loading…</section>`;
  if (!data.project) return html`<section class="card muted">No active project.</section>`;
  const say = (m) => {
    setFlash(m);
    setTimeout(() => setFlash(null), 6000);
  };
  const run = async (fn, ok) => {
    setBusy(true);
    try {
      await fn();
      if (ok) say(ok);
      reload();
    } catch (e) {
      say(`⚠ ${e.message}`);
    } finally {
      setBusy(false);
    }
  };
  const onAccept = async (t) => {
    if (
      !(await confirmApproval(
        "recording",
        t.version,
        t.id,
        "The voice-over is written for this take.",
      ))
    )
      return;
    run(async () => {
      const r = await post("/api/approve", { artifact: "recording", version: t.version });
      if (r.resets?.length)
        say(
          `${t.id} accepted — reset ${r.resets.map((x) => `${x.stage} ${x.version}`).join(", ")}`,
        );
    }, `${t.id} accepted`);
  };
  const groups = [...new Set(data.takes.map((t) => t.storyboardVersion))];
  return html`
    <section class="card review-head">
      <div class="row">
        <h2>Recording</h2>
        <span class="muted small-text">${data.takes.length} take(s) · approved storyboard ${data.approvedStoryboard ? `v${data.approvedStoryboard}` : "—"}</span>
        <span class="grow"></span>
        ${flash ? html`<span class="flash">${flash}</span>` : null}
        <input class="note" placeholder="notes for the next take (optional)" value=${note} onInput=${(e) => setNote(e.target.value)} />
        <button disabled=${busy || !data.approvedStoryboard} title=${data.approvedStoryboard ? "asks the agent to record a new take" : "approve a storyboard first"}
          onClick=${() =>
            run(async () => {
              await post("/api/rerecord", { note });
              setNote("");
            }, "new take requested — the agent records it")}>Request a new take</button>
      </div>
      <p class="muted small-text">A take is always based on the approved storyboard. Accept the take the voice-over should be written for; accepting another one later resets the voice-over approval built on the old take.</p>
    </section>
    ${
      data.takes.length
        ? groups.map(
            (
              g,
            ) => html`<h3 class="group-head">Storyboard v${g}${g === data.approvedStoryboard ? " (approved)" : ""}</h3>
              ${data.takes
                .filter((t) => t.storyboardVersion === g)
                .map(
                  (t) =>
                    html`<${TakeCard} key=${t.id} t=${t} approvedStoryboard=${data.approvedStoryboard} busy=${busy} onAccept=${onAccept} />`,
                )}`,
          )
        : html`<section class="card muted">No takes yet. Once the storyboard is approved, the agent records a take (it streams in the Live panel).</section>`
    }`;
}
