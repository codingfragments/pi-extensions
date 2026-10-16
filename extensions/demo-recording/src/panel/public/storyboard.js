// The Storyboard screen (UX5c, D100): a scene list and one inspector for the selected scene. The storyboard
// is written by the Director, so there is nothing to draft here: you review it (mark scenes, add notes) and
// send the review. Reviewing is a separate act from approving the version (the stage summary above).
import { html, useEffect, useState } from "/vendor/preact-htm.module.js";
import { ApproveHighModal, ConfReasons, NeedsEyes, byRisk, confOf } from "./confidence.js";
import { post, screenUrl, useApi, useHashRoute, useRouteVersion } from "./core.js";
import { CostHint } from "./cost.js";
import { ConfPill, ListRow, NarrowSelect, STATUS_LABEL } from "./inspector.js";
import { StageSummary, VersionActions, runVersionAction, useHistory } from "./version-ui.js";

function targetLabel(t) {
  if (!t) return "";
  if (t.role) return `${t.role}${t.name ? ` “${t.name}”` : ""}`;
  if (t.text) return `text “${t.text}”`;
  if (t.label) return `label “${t.label}”`;
  return `css ${t.css}`;
}

function stepLabel(s) {
  switch (s.do) {
    case "goto":
      return `go to ${s.url}`;
    case "type":
      return `type “${s.text}”${s.target ? ` into ${targetLabel(s.target)}` : ""}`;
    case "press":
      return `press ${s.key}`;
    case "wait":
      return s.for.ms !== undefined ? `wait ${s.for.ms} ms` : `wait for ${targetLabel(s.for)}`;
    case "pause":
      return `pause ${s.ms} ms`;
    case "scroll":
      return s.target ? `scroll to ${targetLabel(s.target)}` : `scroll ${s.dy}px`;
    case "improvise":
      return `improvise input in ${targetLabel(s.target)}: ${s.prompt}`;
    default:
      return `${s.do} ${targetLabel(s.target)}`;
  }
}

/** The selected scene: what it shows, what it says, what will be recorded, and its review. */
function SceneInspector({ scene, index, review, diffKind, readOnly, onReview, conf }) {
  const r = review?.scenes?.[scene.id];
  const [note, setNote] = useState(r?.note ?? "");
  useEffect(() => setNote(r?.note ?? ""), [r?.note]);
  const set = (status) => onReview(scene.id, r?.status === status ? null : status, note);
  return html`<div class="ds-stack ds-inspector">
    <div class="ds-row-flex">
      <h2>${index + 1}. ${scene.title}</h2>
      <span class="ds-badge ds-mono" data-tone="neutral">${scene.id}</span>
      ${diffKind ? html`<span class="ds-badge" data-tone="info"><span class="ds-badge-ico" aria-hidden="true">${diffKind === "new" ? "+" : "~"}</span>${diffKind === "new" ? "New" : "Changed"}</span>` : null}
      <${ConfPill} c=${conf} long />
    </div>
    <${ConfReasons} c=${conf} />
    ${conf?.approvedIn !== undefined ? html`<p class="ds-small ds-muted carried">Unchanged since v${conf.approvedIn}, where you approved it.</p>` : null}
    <div class="ds-shot">${scene.screen ? html`<img src=${screenUrl(scene.screen)} alt=${`Screenshot of ${scene.title}`} loading="lazy" />` : html`<p class="ds-muted ds-small">No screenshot for this scene.</p>`}</div>
    ${scene.takeaway ? html`<p class="takeaway">${scene.takeaway}</p>` : null}
    ${scene.emphasis ? html`<p class="emphasis" title="the director's intent — annotations are chosen later, in the Annotations stage">✦ ${scene.emphasis}</p>` : null}
    ${scene.narration_outline?.length ? html`<ul class="outline">${scene.narration_outline.map((o) => html`<li>${o}</li>`)}</ul>` : null}
    <details open class="ds-small">
      <summary><strong>${scene.steps.length} step${scene.steps.length === 1 ? "" : "s"}</strong> that will be recorded</summary>
      <ol class="steps">
        ${scene.steps.map(
          (s) => html`<li>
            ${stepLabel(s)}
            ${s.mark ? html` <span class="mark">@${s.mark}</span>` : null}
            ${s.emphasis ? html` <span class="flag emphasis" title="emphasis — a hint for the annotation designer">✦ ${s.emphasis}</span>` : null}
          </li>`,
        )}
      </ol>
    </details>
    ${
      readOnly
        ? html`<p class="ds-small ds-muted">An older version: the review is read-only.</p>`
        : html`<div class="ds-stack">
          <span class="ds-label">Review</span>
          <div class="ds-row-flex">
            ${Object.entries(STATUS_LABEL).map(([st, label]) => html`<button class="ds-btn ds-btn--sm" type="button" aria-pressed=${r?.status === st} data-status=${st} onClick=${() => set(st)}>${label}</button>`)}
          </div>
          <textarea class="ds-textarea ds-textarea--compact" aria-label="Notes for this scene" placeholder="Notes for this scene (what to change, what to re-explore)…" value=${note} onInput=${(e) => setNote(e.target.value)}
            onBlur=${() => r && note !== (r.note ?? "") && onReview(scene.id, r.status, note)}></textarea>
        </div>`
    }
  </div>`;
}

export function Review({ events }) {
  const version = useRouteVersion("storyboard");
  const hist = useHistory("storyboard", events);
  const [route, go] = useHashRoute();
  const path = version ? `/api/storyboard?version=${version}` : "/api/storyboard";
  const { data, error, reload } = useApi(path, events, /^(storyboard\.|review\.|project\.)/);
  const [overall, setOverall] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const [riskFirst, setRiskFirst] = useState(false);
  const [approveOpen, setApproveOpen] = useState(false);
  useEffect(() => setOverall(data?.review?.note ?? ""), [data?.version, data?.review?.note]);

  if (error) return html`<section class="card error">${error}</section>`;
  if (!data) return html`<section class="card muted">loading…</section>`;
  if (!data.project) return html`<section class="card muted">No active project.</section>`;
  if (!data.storyboard && version !== null)
    return html`<${StageSummary} stage="storyboard" rows=${hist.data?.rows} viewed=${version} />`;
  if (!data.storyboard) {
    return html`<section class="card muted">No storyboard yet. Run <code>/demo discover</code> in pi; it appears here as soon as the agent writes one.</section>`;
  }

  const latest = data.versions.at(-1);
  const readOnly = data.version !== latest;
  const diffKind = (id) => {
    if (!data.diff) return null;
    if (data.diff.added.includes(id)) return "new";
    if (data.diff.changed.includes(id)) return "changed";
    return null;
  };
  const run = async (fn, ok) => {
    setBusy(true);
    try {
      await fn();
      if (ok) setFlash(ok);
      reload();
    } catch (e) {
      setFlash(`⚠ ${e.message}`);
    } finally {
      setBusy(false);
      setTimeout(() => setFlash(null), 4000);
    }
  };
  const onReview = (scene, status, note) =>
    run(() => post("/api/review", { version: data.version, scene, status, note }));
  const marked = Object.keys(data.review?.scenes ?? {}).length;
  const scenes = data.storyboard.scenes;
  const ordered = riskFirst ? byRisk(scenes, data.confidence, (s) => s.id) : scenes;
  const scene = ordered.find((s) => s.id === route?.query?.scene) ?? ordered[0];
  const select = (id) =>
    go(
      { screen: "storyboard", ...(version ? { version } : {}), query: { scene: id } },
      { replace: true },
    );
  const row = hist.data?.rows?.find((r) => r.version === data.version);

  return html`
    <${StageSummary} stage="storyboard" row=${row} rows=${hist.data?.rows}
      viewed=${data.version} onUse=${(v) => runVersionAction({ stage: "storyboard", version: v, intent: "use" }).then(reload)}
      meta=${readOnly ? html`<span>older version: read-only</span>` : null} />
    <section class="card review-head">
      <div class="row">
        <${VersionActions} stage="storyboard" row=${row} events=${events} onDone=${reload} />
      </div>
      ${data.storyboard.summary ? html`<p>${data.storyboard.summary}</p>` : null}
      ${
        data.diff
          ? html`<p class="muted small-text">since v${data.diff.from}:
            ${data.diff.added.length ? ` added ${data.diff.added.join(", ")};` : ""}
            ${data.diff.changed.length ? ` changed ${data.diff.changed.join(", ")};` : ""}
            ${data.diff.removed.length ? ` removed ${data.diff.removed.join(", ")};` : ""}
            ${data.diff.reordered ? " reordered;" : ""}</p>`
          : null
      }
      <${NeedsEyes} summary=${data.confidence} riskFirst=${riskFirst} setRiskFirst=${setRiskFirst} onJump=${select}>
        ${readOnly || !data.confidence ? null : html`<button class="ds-btn ds-btn--ghost" title="mark every unmarked high-confidence scene reviewed — you see the list first" onClick=${() => setApproveOpen(true)}>Mark high-confidence reviewed…</button>`}
      </${NeedsEyes}>
    </section>
    <div class="ds-root ds-workspace">
      <div class="ds-split">
        <${NarrowSelect} label="Scene" value=${scene?.id} onChange=${select}
          options=${ordered.map((s) => [s.id, `${scenes.indexOf(s) + 1}. ${s.title}`])} />
        <section class="ds-split-list" aria-label="Scenes">
          <div class="ds-list-head"><span><strong style="color: var(--text-strong)">${scenes.length} scenes</strong> · ${marked} marked</span></div>
          <ul class="ds-list">
            ${ordered.map((s) => {
              const rv = data.review?.scenes?.[s.id];
              const c = confOf(data.confidence, s.id);
              const dk = diffKind(s.id);
              return html`<${ListRow} key=${s.id} itemKey=${s.id} title=${`${scenes.indexOf(s) + 1}. ${s.title}`} review=${rv} current=${scene?.id === s.id} onSelect=${select}
                meta=${`${s.id} · ${rv ? STATUS_LABEL[rv.status] : "not reviewed"}${c?.approvedIn !== undefined ? ` · unchanged since v${c.approvedIn}` : ""}`}
                badges=${html`${dk ? html`<span class="ds-badge" data-tone="info"><span class="ds-badge-ico" aria-hidden="true">${dk === "new" ? "+" : "~"}</span>${dk === "new" ? "New" : "Changed"}</span>` : null}${c && c.level !== "high" ? html`<${ConfPill} c=${c} />` : null}`} />`;
            })}
          </ul>
        </section>
        <section class="ds-split-detail" aria-label="Selected scene">
          ${
            scene
              ? html`<${SceneInspector} key=${`${data.version}-${scene.id}`} scene=${scene} index=${scenes.indexOf(scene)} review=${data.review}
                  diffKind=${diffKind(scene.id)} readOnly=${readOnly} onReview=${onReview} conf=${confOf(data.confidence, scene.id)} />`
              : null
          }
        </section>
      </div>
    </div>
    ${
      approveOpen
        ? html`<${ApproveHighModal} artifact="storyboard" version=${data.version} onClose=${() => setApproveOpen(false)} onDone=${(
            r,
          ) => {
            setApproveOpen(false);
            setFlash(`${r.approved.length} scene(s) approved · ${r.skip.length} left for you`);
            setTimeout(() => setFlash(null), 5000);
            reload();
          }} />`
        : null
    }
    ${
      readOnly
        ? null
        : html`<section class="card review-foot ds-inflow">
          <textarea
            placeholder="Overall notes (ordering, tone, scenes to add or drop)…"
            aria-label="Overall notes"
            value=${overall}
            onInput=${(e) => setOverall(e.target.value)}
            onBlur=${() => overall !== (data.review?.note ?? "") && run(() => post("/api/review-note", { version: data.version, note: overall }))}
          ></textarea>
          <div class="row">
            <span class="muted small-text">${marked}/${scenes.length} scenes marked${data.review?.submittedAt ? ` · last sent ${new Date(data.review.submittedAt).toLocaleTimeString()}` : ""}</span>
            <span class="grow"></span>
            ${flash ? html`<span class="flash">${flash}</span>` : null}
            <button disabled=${busy} onClick=${() =>
              run(async () => {
                if (overall !== (data.review?.note ?? ""))
                  await post("/api/review-note", { version: data.version, note: overall });
                await post("/api/review-submit", { version: data.version });
              }, "review sent to the agent")}>Send review to agent</button><${CostHint} />
          </div>
        </section>`
    }`;
}
