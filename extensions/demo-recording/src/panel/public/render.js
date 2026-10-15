import { html, useEffect, useRef, useState } from "/vendor/preact-htm.module.js";
import { api, media, post, useApi } from "./core.js";
// demo-recording panel — Render tab (S5 part 9, D59–D68): a form for a new
// render (draft or final, annotation version and types, brands, subtitles,
// logo bug) that starts a background engine job, and the render history:
// players with the transcript, subtitled versions, scenes, downloads, open
// folder, accept (finals), delete (files go, the record stays), legacy renders.
import { confirmAsk, errorToast } from "./dialog.js";
import { StageHeader, VersionActions } from "./stages.js";

const TYPES = ["zoom", "highlight", "spotlight", "callout", "chapter", "redact"];
const TYPE_LABEL = {
  zoom: "Zooms",
  highlight: "Highlights",
  spotlight: "Spotlights",
  callout: "Callouts",
  chapter: "Chapters",
  redact: "Redactions",
};
const mb = (b) => `${(b / 1e6).toFixed(b >= 1e8 ? 0 : 1)} MB`;
const when = (iso) => (iso ? new Date(iso).toLocaleString() : "");
const join = (...p) => p.filter(Boolean).join("/");

function NewRender({ data, events, onStarted }) {
  const [kind, setKind] = useState("draft");
  const [ann, setAnn] = useState(
    data.defaults.annotations !== null
      ? String(data.defaults.annotations)
      : data.annotationVersions[0]
        ? String(data.annotationVersions[0].version)
        : "none",
  );
  const [types, setTypes] = useState(null); // null = all
  const [brands, setBrands] = useState([data.defaults.brand]);
  const [subtitles, setSubtitles] = useState(false);
  const [logoBug, setLogoBug] = useState(true);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const progress = events.filter((e) => e.type === "render.progress").at(-1);
  const running = data.job?.status === "running";
  const versions = data.annotationVersions;
  const chosen = ann === "draft" ? null : versions.find((v) => String(v.version) === ann);
  const available =
    ann === "draft" ? TYPES : chosen ? TYPES.filter((t) => chosen.types.includes(t)) : [];
  const selected = types ?? available;
  const finalOk = kind !== "final" || (chosen?.accepted && chosen.usable);
  useEffect(() => {
    if (kind === "final" && (ann === "draft" || ann === "none")) {
      const acc = versions.find((v) => v.accepted && v.usable);
      setAnn(acc ? String(acc.version) : ann);
    }
  }, [kind]);
  const toggleType = (t) => {
    const cur = new Set(selected);
    cur.has(t) ? cur.delete(t) : cur.add(t);
    setTypes(available.filter((x) => cur.has(x)));
  };
  const toggleBrand = (b) =>
    setBrands(brands.includes(b) ? brands.filter((x) => x !== b) : [...brands, b]);
  const start = async () => {
    const all = types === null || selected.length === available.length;
    const leavesRedactions = !all && chosen?.redactions && !selected.includes("redact");
    if (
      leavesRedactions &&
      !(await confirmAsk({
        title: "Render without the redactions?",
        text: `This render leaves out ${chosen.redactions} enabled redaction(s) — it shows what was redacted.`,
        confirmLabel: "Render anyway",
        danger: true,
      }))
    )
      return;
    setBusy(true);
    try {
      await post("/api/render", {
        kind,
        ...(ann === "draft"
          ? { fromDraft: true }
          : ann === "none"
            ? { annotations: null }
            : { annotations: Number(ann) }),
        brands,
        options: { annotationTypes: all ? "all" : selected, subtitles, logoBug },
        ...(leavesRedactions ? { confirmUnredacted: true } : {}),
      });
      setFlash(`${kind} render started — progress below and in the Live panel`);
      onStarted?.();
    } catch (e) {
      setFlash(`⚠ ${e.message}`);
    } finally {
      setBusy(false);
      setTimeout(() => setFlash(null), 8000);
    }
  };
  return html`<section class="card render-new">
    <div class="row"><h2>New render</h2><span class="grow"></span>${flash ? html`<span class="flash">${flash}</span>` : null}</div>
    <div class="render-form">
      <fieldset>
        <legend>Kind</legend>
        <label class="radio"><input type="radio" name="kind" checked=${kind === "draft"} onChange=${() => setKind("draft")} /> <b>Draft</b> <span class="muted small-text">full video, 960×540, DRAFT tag, fast — any annotations</span></label>
        <label class="radio"><input type="radio" name="kind" checked=${kind === "final"} onChange=${() => setKind("final")} /> <b>Final</b> <span class="muted small-text">full quality, scenes, transcripts, poster — needs accepted annotations</span></label>
        ${kind === "final" && data.finalBlocker && !finalOk ? html`<p class="small-text warn-text">⚠ ${data.finalBlocker}</p>` : null}
      </fieldset>
      <fieldset>
        <legend>Annotations</legend>
        <select value=${ann} onChange=${(e) => {
          setAnn(e.target.value);
          setTypes(null);
        }}>
          ${versions.map(
            (v) =>
              html`<option value=${String(v.version)} disabled=${kind === "final" && !(v.accepted && v.usable)}>v${v.version}${v.accepted ? " ✔ accepted" : ""}${v.onLine ? " · working line" : ""} · ${v.enabled} on${kind === "final" && !(v.accepted && v.usable) ? " (not accepted)" : ""}</option>`,
          )}
          ${kind === "draft" && data.draft ? html`<option value="draft">unsaved changes on v${data.draft.base} (${data.draft.changes})</option>` : null}
          ${kind === "draft" ? html`<option value="none">none</option>` : null}
        </select>
        ${
          available.length
            ? html`<div class="type-chips">
              <span class="muted small-text">include:</span>
              ${available.map((t) => html`<label class=${`chip ${selected.includes(t) ? "on" : ""}`}><input type="checkbox" checked=${selected.includes(t)} onChange=${() => toggleType(t)} /> ${TYPE_LABEL[t]}</label>`)}
              <button class="ghost tiny" onClick=${() => setTypes(null)}>all</button>
              <button class="ghost tiny" onClick=${() => setTypes([])}>none</button>
            </div>
            <p class="muted small-text">The annotation version stays as approved — this only chooses what this render shows.</p>`
            : null
        }
      </fieldset>
      <fieldset>
        <legend>Look</legend>
        <div class="type-chips">${data.brands.map((b) => html`<label class=${`chip ${brands.includes(b.name) ? "on" : ""}`}><input type="checkbox" checked=${brands.includes(b.name)} onChange=${() => toggleBrand(b.name)} /> ${b.name}</label>`)}</div>
        <label class="check"><input type="checkbox" checked=${subtitles} onChange=${(e) => setSubtitles(e.target.checked)} /> Burn in subtitles</label>
        <p class="muted small-text hint">Writes extra *.subtitled.mp4 files; the clean ones stay. Transcripts (VTT) are always written.</p>
        <label class="check"><input type="checkbox" checked=${logoBug} onChange=${(e) => setLogoBug(e.target.checked)} /> Logo bug</label>
      </fieldset>
    </div>
    <div class="row">
      <button class="primary" disabled=${busy || running || !brands.length || !data.hasEdit || !finalOk} title=${!data.hasEdit ? "no edit yet" : !finalOk ? (data.finalBlocker ?? "") : "a background engine job — no agent turn, no LLM, no TTS"} onClick=${start}>Render ${kind}${brands.length > 1 ? ` · ${brands.length} brands` : ""}</button>
      ${running ? html`<span class="small-text">🎞 ${progress?.data?.label ?? "rendering…"}</span><button class="ghost" onClick=${() => post("/api/render-cancel", {})}>Cancel</button>` : null}
      ${data.job?.status === "failed" ? html`<span class="small-text error">last render failed: ${data.job.error}</span>` : null}
    </div>
  </section>`;
}

/** "neutral_callouts-only_nobug" → { brand: "neutral", tags: ["callouts only", "no logo"] } */
function flavorParts(key) {
  const [brand, ...rest] = key.split("_");
  const tags = rest.map((t) =>
    t === "plain"
      ? "no annotations"
      : t === "nobug"
        ? "no logo"
        : t.replace(/-only$/, " only").replace(/-/g, " + "),
  );
  return { brand, tags };
}

/** Rows of a render's flavor table: per variant the clean video, then the subtitled one. */
function flavorRows(r) {
  const rows = [];
  for (const v of r.variants) {
    const f = v.files;
    const { brand, tags } = flavorParts(v.key);
    const scenes = (sub) =>
      (f.scenes ?? [])
        .map((s, i) => ({
          id: s.replace(/^scenes\//, "").replace(/\.mp4$/, ""),
          label: (s.match(/_(\d+-[^_/]+?)(?:_subtitled)?\.mp4$/)?.[1] ?? s).replace(/\.mp4$/, ""),
          file: sub ? f.scenesSubtitled?.[i] : s,
          vtt: sub ? undefined : f.scenesVtt?.[i],
        }))
        .filter((x) => x.file);
    rows.push({
      key: v.key,
      v,
      brand,
      tags,
      file: f.full,
      vtt: f.vtt,
      poster: f.poster,
      extras: [
        ["transcript", f.vtt],
        ["callouts", f.callouts],
        ["poster", f.poster],
      ],
      scenes: scenes(false),
    });
    if (f.fullSubtitled)
      rows.push({
        key: `${v.key}#sub`,
        v,
        brand,
        tags: [...tags, "subtitled"],
        file: f.fullSubtitled,
        poster: f.poster,
        extras: [["transcript", f.vtt]],
        scenes: scenes(true),
      });
  }
  return rows;
}

const fileName = (rel) => rel.split("/").at(-1);

/** ⬇ zip (all): everything of a variant in one archive — built on first click, then cached. */
function ZipButton({ r, v }) {
  const [busy, setBusy] = useState(false);
  const go = async (e) => {
    e.stopPropagation();
    setBusy(true);
    try {
      const z = await post("/api/render-zip", { version: r.version, variant: v.key });
      const a = document.createElement("a");
      a.href = media("project", z.zip);
      a.download = fileName(z.zip);
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      errorToast(err);
    } finally {
      setBusy(false);
    }
  };
  return html`<button class="ghost tiny zip" disabled=${busy} title="download everything of this flavor as one zip: videos (clean + subtitled), scenes, transcripts, callouts, poster" onClick=${go}>${busy ? "zipping…" : "⬇ zip (all)"}</button>`;
}

function FlavorTable({ r, seek }) {
  const rows = flavorRows(r);
  const [sel, setSel] = useState(null);
  const video = useRef(null);
  // A QA time link: show the main flavor (not a scene clip) and jump there.
  useEffect(() => {
    if (!seek) return;
    const main = rows.find((x) => x.v.present && !x.key.endsWith("#sub"));
    if (main && (sel?.file ?? "") !== main.file && sel !== null) setSel(null);
    const go = () => {
      if (!video.current) return;
      video.current.currentTime = Math.max(0, seek.t / 1000 - 1);
      video.current.play?.().catch(() => {});
    };
    if (video.current?.readyState >= 1) go();
    else video.current?.addEventListener("loadedmetadata", go, { once: true });
  }, [seek?.n]);
  const [open, setOpen] = useState({});
  const first = rows.find((x) => x.v.present);
  const cur =
    sel ??
    (first
      ? {
          row: first.key,
          v: first.v,
          file: first.file,
          vtt: first.vtt,
          poster: first.poster,
          label: [first.brand, ...first.tags].join(" · "),
        }
      : null);
  const pick = (row, file, vtt, label) =>
    setSel({ row: row.key, v: row.v, file, vtt, poster: row.poster, label });
  const size = (v, rel) => (v.sizes?.[rel] !== undefined ? mb(v.sizes[rel]) : "");
  const dl = (v, rel, label) =>
    rel
      ? html`<a href=${media("project", join(v.dir, rel))} download=${fileName(rel)} title=${fileName(rel)} onClick=${(e) => e.stopPropagation()}>${label}</a>`
      : null;
  return html`<div class="flavor-view">
    <div class="flavor-player">
      ${
        cur
          ? html`<video ref=${video} key=${cur.file} class="render-video" controls preload="metadata" src=${media("project", join(cur.v.dir, cur.file))} poster=${cur.poster ? media("project", join(cur.v.dir, cur.poster)) : undefined}>
              ${cur.vtt ? html`<track kind="subtitles" srclang="en" label="Transcript" src=${media("project", join(cur.v.dir, cur.vtt))} />` : null}
            </video>
            <div class="small-text muted">▶ ${cur.label} · <span class="mono">${fileName(cur.file)}</span>${cur.vtt ? " · transcript track available (CC)" : ""}</div>`
          : html`<div class="render-video gone-player">files ${r.deleted ? "deleted" : r.pruned ? "pruned" : "missing"} — render again to watch</div>`
      }
    </div>
    <table class="flavor-table">
      <thead><tr><th></th><th>Flavor</th><th>Length</th><th>Size</th><th>Video</th><th>Extras</th></tr></thead>
      <tbody>
        ${rows.map((row) => {
          const v = row.v;
          const label = [row.brand, ...row.tags].join(" · ");
          const on = cur?.file === row.file && cur?.v === v;
          return html`
            <tr class=${`fv-row ${on ? "on" : ""} ${v.present ? "" : "gone"}`} onClick=${() => v.present && pick(row, row.file, row.vtt, label)}>
              <td>${v.present ? html`<button class="ghost tiny play" title="preview" aria-label=${`preview ${label}`}>${on ? "●" : "▶"}</button>` : null}</td>
              <td><b>${row.brand}</b>${row.tags.map((t) => html` <span class="tag">${t}</span>`)}${v.reusedFrom && !row.key.endsWith("#sub") ? html` <span class="muted small-text">reused from v${v.reusedFrom}</span>` : null}</td>
              <td>${v.durationSec.toFixed(1)} s</td>
              <td>${v.present ? size(v, row.file) : ""}</td>
              <td>${v.present ? html`<span class="extras">${dl(v, row.file, "⬇ mp4")}${row.key.endsWith("#sub") ? null : html`<${ZipButton} r=${r} v=${v} />`}</span>` : html`<span class="muted small-text">${r.deleted ? "deleted" : "pruned"}</span>`}</td>
              <td><span class="extras">${v.present ? row.extras.map(([l, rel]) => dl(v, rel, l)) : null}
                ${
                  v.present && !row.key.endsWith("#sub")
                    ? html`<button class="ghost tiny" title="open this variant's folder" onClick=${(
                        e,
                      ) => {
                        e.stopPropagation();
                        post("/api/render-open", { version: r.version, variant: v.key }).catch(
                          (err) => errorToast(err),
                        );
                      }}>folder</button>`
                    : null
                }</span></td>
            </tr>
            ${
              row.scenes.length && v.present
                ? html`<tr class="fv-toggle"><td></td><td colspan="5"><button class="ghost tiny" onClick=${() => setOpen({ ...open, [row.key]: !open[row.key] })}>${open[row.key] ? "▾" : "▸"} scenes (${row.scenes.length})</button></td></tr>
                  ${
                    open[row.key]
                      ? row.scenes.map((sc) => {
                          const on2 = cur?.file === sc.file && cur?.v === v;
                          return html`<tr class=${`fv-scene ${on2 ? "on" : ""}`} onClick=${() => pick(row, sc.file, sc.vtt, `${label} · ${sc.label}`)}>
                            <td><button class="ghost tiny play" aria-label=${`preview ${sc.label}`}>${on2 ? "●" : "▶"}</button></td>
                            <td class="fv-scene-name">${sc.label}</td>
                            <td></td>
                            <td>${size(v, sc.file)}</td>
                            <td>${dl(v, sc.file, "⬇ mp4")}</td>
                            <td><span class="extras">${dl(v, sc.vtt, "transcript")}</span></td>
                          </tr>`;
                        })
                      : null
                  }`
                : null
            }`;
        })}
      </tbody>
    </table>
  </div>`;
}

const fmt = (ms) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
const QA_LABEL = {
  pass: "QA passed",
  blocked: "QA blocked",
  confirmed: "QA passed (confirmed)",
  error: "QA failed to run",
};

function QaItemRow({ r, it, picked, togglePick, onSeek, reload }) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState(null);
  const confirmIt = async () => {
    try {
      await post("/api/render-qa-confirm", { version: r.version, id: it.id, reason });
      setConfirming(false);
      reload();
    } catch (e) {
      setErr(e.message);
    }
  };
  return html`<li class=${`qa-item ${it.level} ${it.confirmed ? "confirmed" : ""}`}>
    <div class="row">
      ${it.atMs !== undefined ? html`<button class="ghost tiny time" title="play from here" onClick=${() => onSeek(it.atMs)}>▶ ${fmt(it.atMs)}</button>` : null}
      <span class="qa-msg">${it.message}</span>
    </div>
    ${it.fix ? html`<label class="check small-text qa-fix"><input type="checkbox" checked=${picked} onChange=${togglePick} /> fix: ${it.fix.label}</label>` : null}
    ${it.confirmed ? html`<p class="small-text muted">✔ confirmed: “${it.confirmed.reason}”</p>` : null}
    ${
      it.level === "blocking" && !it.confirmed
        ? confirming
          ? html`<div class="row qa-confirm"><input class="note" placeholder="why is it fine to export anyway? (required)" value=${reason} onInput=${(e) => setReason(e.target.value)} /><button class="primary" disabled=${reason.trim().length < 3} onClick=${confirmIt}>Confirm</button><button class="ghost" onClick=${() => setConfirming(false)}>Cancel</button>${err ? html`<span class="error small-text">${err}</span>` : null}</div>`
          : html`<button class="ghost tiny" onClick=${() => setConfirming(true)}>Confirm & export anyway…</button>`
        : null
    }
  </li>`;
}

function QaSection({ r, onSeek, reload }) {
  const [rep, setRep] = useState(null);
  const [picked, setPicked] = useState(null);
  const [busy, setBusy] = useState(false);
  const stamp = r.qa?.ranAt ?? "";
  useEffect(() => {
    if (!r.qa) return;
    api(`/api/render-qa?version=${r.version}`).then(setRep, () => setRep(null));
  }, [stamp, r.qa?.confirmed]);
  const rerun = async () => {
    setBusy(true);
    try {
      await post("/api/render-qa-run", { version: r.version });
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };
  const items = rep?.report?.items ?? [];
  const fixable = items.filter((i) => i.fix);
  const chosen = picked ?? new Set(fixable.map((i) => i.id));
  const apply = async () => {
    setBusy(true);
    try {
      await post("/api/render-qa-fix", { version: r.version, ids: [...chosen] });
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };
  const status = r.qa?.status;
  const by = (lvl) => items.filter((i) => i.level === lvl);
  const row = (it) =>
    html`<${QaItemRow} key=${it.id} r=${r} it=${it} picked=${chosen.has(it.id)} togglePick=${() => {
      const n = new Set(chosen);
      n.has(it.id) ? n.delete(it.id) : n.add(it.id);
      setPicked(n);
    }} onSeek=${onSeek} reload=${reload} />`;
  return html`<div class=${`qa-section ${status ?? "none"}`}>
    <div class="row">
      <b>${status ? QA_LABEL[status] : "QA not run"}</b>
      ${r.qa && status !== "error" ? html`<span class="muted small-text">${r.qa.blocking} blocking${r.qa.confirmed ? ` (${r.qa.confirmed} confirmed)` : ""} · ${r.qa.warnings} warning(s) · ${r.qa.info} info${rep?.report && !rep.report.whisper ? " · sync not checked (no Whisper)" : ""}</span>` : null}
      ${status === "error" ? html`<span class="small-text error">${r.qa.error}</span>` : null}
      <span class="grow"></span>
      ${fixable.length ? html`<button class="primary" disabled=${busy || !chosen.size} title="a new final render with these mechanical fixes (the approved script, audio and annotations stay untouched); it gets its own QA" onClick=${apply}>Apply ${chosen.size} fix${chosen.size === 1 ? "" : "es"}</button>` : null}
      <button class="ghost" disabled=${busy} onClick=${rerun}>${r.qa ? "Re-run QA" : "Run QA"}</button>
    </div>
    ${by("blocking").length ? html`<ul class="qa-list">${by("blocking").map(row)}</ul>` : null}
    ${by("warning").length ? html`<details open=${by("blocking").length === 0}><summary class="small-text">${by("warning").length} warning(s)</summary><ul class="qa-list">${by("warning").map(row)}</ul></details>` : null}
    ${by("info").length ? html`<details><summary class="small-text muted">${by("info").length} info</summary><ul class="qa-list">${by("info").map(row)}</ul></details>` : null}
  </div>`;
}

function RenderCard({ r, stages, open, reload }) {
  const [seek, setSeek] = useState(null);
  const del = async () => {
    const size = mb(r.variants.reduce((n, v) => n + (v.present ? v.bytes : 0), 0));
    if (
      !(await confirmAsk({
        title: `Delete the files of ${r.kind} render v${r.version}?`,
        text: `${size} will be removed. The record stays in the history.`,
        confirmLabel: "Delete files",
        danger: true,
      }))
    )
      return;
    let confirmAccepted = false;
    if (r.accepted) {
      if (
        !(await confirmAsk({
          title: "Delete the accepted deliverable?",
          text: `Render v${r.version} is the ACCEPTED deliverable. Delete its files anyway?`,
          confirmLabel: "Delete anyway",
          danger: true,
        }))
      )
        return;
      confirmAccepted = true;
    }
    try {
      await post("/api/render-delete", { version: r.version, confirmAccepted });
      reload();
    } catch (e) {
      errorToast(e);
    }
  };
  const o = r.options;
  const types =
    o.annotationTypes === "all"
      ? "all annotations"
      : o.annotationTypes.length
        ? `only ${o.annotationTypes.join(", ")}`
        : "none included";
  const gone = r.deleted || r.pruned;
  return html`<details class=${`card render-card ${r.kind} ${r.accepted ? "accepted" : ""}`} open=${open}>
    <summary class="row">
      <h3>${r.kind === "final" ? "Final" : "Draft"} v${r.version}</h3>
      ${r.accepted ? html`<span class="badge approved">accepted · deliverable</span>` : null}
      <span class=${`pill ${r.status === "done" ? "" : r.status === "running" ? "" : "fail-pill"}`}>${r.status}</span>
      ${r.kind === "final" && r.status === "done" ? html`<span class=${`pill qa-pill ${r.qa?.status ?? "none"}`} title=${r.qaBlocker ?? "QA passed"}>${r.qa ? (r.qa.status === "blocked" ? `QA: ${r.qa.blocking - r.qa.confirmed} blocking` : r.qa.status === "pass" ? "QA ✓" : r.qa.status === "confirmed" ? "QA ✓ (confirmed)" : "QA error") : "QA not run"}</span>` : null}
      ${gone ? html`<span class="badge old">${r.deleted ? `deleted ${when(r.deleted)}` : "files pruned"}</span>` : null}
      <span class="muted small-text">${r.basedOn.annotations !== undefined ? `annotations v${r.basedOn.annotations}${r.fromDraft ? " (unsaved changes)" : ""}` : "no annotations"} · ${types}${o.subtitles ? " · subtitles" : ""}${o.logoBug ? "" : " · no logo"} · edit v${r.timeline} · ${r.size.width}×${r.size.height} · ${when(r.createdAt)} · by ${r.by}</span>
    </summary>
    <div class="row render-actions">
      ${r.kind === "final" && r.status === "done" && !gone ? html`<${VersionActions} stages=${stages} stage="render" version=${r.version} label=${`final render v${r.version}`} unlocks="It becomes the deliverable." disabled=${!!r.qaBlocker && !r.accepted} disabledWhy=${r.qaBlocker ?? ""} onDone=${reload} />` : null}
      ${r.kind === "final" && r.qaBlocker && !r.accepted ? html`<span class="small-text warn-text">${r.qaBlocker}</span>` : null}
      ${r.overrides ? html`<span class="muted small-text">${r.overrides.shifts} fix(es) on render v${r.overrides.fromRender}</span>` : null}
      <span class="grow"></span>
      ${!gone && r.status !== "running" ? html`<button class="ghost" onClick=${del}>Delete files</button>` : null}
    </div>
    ${r.error ? html`<p class="small-text error">${r.error}</p>` : null}
    ${r.kind === "final" && r.status === "done" && !gone ? html`<${QaSection} r=${r} onSeek=${(t) => setSeek({ t, n: Date.now() })} reload=${reload} />` : null}
    ${r.variants.length ? html`<${FlavorTable} r=${r} seek=${seek} />` : null}
    ${r.variants.flatMap((v) => (v.warnings ?? []).map((w) => `${v.key}: ${w}`)).length ? html`<details class="small-text"><summary>warnings</summary><ul>${r.variants.flatMap((v) => (v.warnings ?? []).map((w) => html`<li>${v.key}: ${w}</li>`))}</ul></details>` : null}
  </details>`;
}

export function Render({ events, stages }) {
  const { data, error, reload } = useApi(
    "/api/renders",
    events,
    /^(render|edit|annotations|stage|line|project|brand)\./,
  );
  if (error) return html`<section class="card error">${error}</section>`;
  if (!data) return html`<section class="card muted">loading…</section>`;
  if (!data.project) return html`<section class="card muted">No active project.</section>`;
  const finals = data.renders.filter((r) => r.kind === "final");
  const drafts = data.renders.filter((r) => r.kind === "draft");
  const ordered = [
    ...data.renders.filter((r) => r.accepted),
    ...data.renders.filter((r) => !r.accepted),
  ];
  return html`
    <${StageHeader} stages=${stages} stage="render" />
    <${NewRender} data=${data} events=${events} onStarted=${reload} />
    <section class="card review-head">
      <div class="row">
        <h2>Renders</h2>
        <span class="muted small-text">${finals.length} final · ${drafts.length} draft — drafts keep their files for the newest ${data.defaults.keepDrafts} (Config → render.keepDrafts); finals are kept</span>
      </div>
      ${data.renders.length ? null : html`<p class="muted">No renders yet. Every sync edit makes a draft; finals come from here once annotations are accepted.</p>`}
    </section>
    ${ordered.map((r, i) => html`<${RenderCard} key=${r.version} r=${r} stages=${stages} open=${i === 0 || r.status === "running"} reload=${reload} />`)}
    ${
      data.legacy.length
        ? html`<details class="card legacy">
          <summary><h3>Legacy renders</h3> <span class="muted small-text">from before the Render stage (out/edit-vN/)</span></summary>
          ${data.legacy.map(
            (l) => html`<div class="variant">
              <div class="row"><b>edit v${l.edit} · ${l.variant}</b><span class="muted small-text">${mb(l.bytes)}</span><span class="grow"></span>
                <button class="ghost" onClick=${() => post("/api/render-open", { dir: l.dir }).catch((e) => errorToast(e))}>Open folder</button></div>
              <video class="render-video" controls preload="none" src=${media("project", join(l.dir, l.full))}></video>
            </div>`,
          )}
        </details>`
        : null
    }`;
}
