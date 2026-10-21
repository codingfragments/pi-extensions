// The Projects page (item 14, E; D146): every project of the working folder, switch to one, archive one (a zip, the project stays) or delete one (a verified
// zip first, the name typed). Nothing here starts a model turn or costs anything.
import { html, useState } from "/vendor/preact-htm.module.js";
import { post, useApi } from "./core.js";
import { ask, confirmAsk, errorToast, toast } from "./dialog.js";
import { canTryWithoutDrafts, deleteText, sinceWords, sizeWords } from "./projects-core.js";

export function Projects({ events }) {
  const { data, error, reload } = useApi("/api/projects", events, /^project\./);
  const [busy, setBusy] = useState(null);
  const [last, setLast] = useState(null);
  if (error) return html`<section class="card error">${error}</section>`;
  if (!data) return html`<section class="card muted">loading…</section>`;
  const run = async (slug, what, fn) => {
    setBusy(`${what}:${slug}`);
    try {
      return await fn();
    } catch (e) {
      errorToast(e, `${what} ${slug}`);
    } finally {
      setBusy(null);
      reload();
    }
  };
  const archive = (row, withoutDrafts = false) =>
    run(row.slug, "archive", async () => {
      try {
        const r = await post("/api/project-archive", { slug: row.slug, withoutDrafts });
        setLast({ slug: row.slug, ...r });
        toast(
          `archived ${row.slug}: ${r.files} files, ${sizeWords(r.bytes)}, read back and checked`,
          { kind: "ok" },
        );
      } catch (e) {
        if (
          !withoutDrafts &&
          canTryWithoutDrafts(e.message) &&
          (await confirmAsk({
            title: `Archive ${row.slug} without the draft renders?`,
            text: `${e.message}.\n\nThe records of the draft renders stay in the zip; only their video files are left out. Finals are never left out.`,
            confirmLabel: "Archive without the drafts",
          }))
        )
          return archive(row, true);
        throw e;
      }
    });
  const remove = async (row) => {
    const answer = await ask({
      title: `Delete ${row.slug}?`,
      text: deleteText(row),
      input: {
        label: "Type the project's name to delete it",
        placeholder: row.slug,
        equals: row.slug,
        required: true,
      },
      confirmLabel: "Archive and delete",
      danger: true,
    });
    if (!answer) return;
    return run(row.slug, "delete", async () => {
      const withoutDrafts = false;
      let r;
      try {
        r = await post("/api/project-delete", {
          slug: row.slug,
          confirmName: answer.value,
          withoutDrafts,
        });
      } catch (e) {
        if (
          canTryWithoutDrafts(e.message) &&
          (await confirmAsk({
            title: `Delete ${row.slug} without keeping its draft renders?`,
            text: `${e.message}.\n\nThe zip will not hold the draft renders' video files, and they are gone with the folder. Finals are kept.`,
            confirmLabel: "Archive without the drafts and delete",
            danger: true,
          }))
        )
          r = await post("/api/project-delete", {
            slug: row.slug,
            confirmName: answer.value,
            withoutDrafts: true,
          });
        else throw e;
      }
      setLast({ slug: row.slug, ...r, deleted: true });
      toast(`deleted ${row.slug}; its zip is ${r.file}`, { kind: "ok" });
    });
  };
  const rows = data.projects;
  return html`<section class="ds-projects" aria-label="Projects">
    <div class="ds-stagehead">
      <div class="ds-grow">
        <h1>Projects</h1>
        <div class="ds-stagehead-meta"><span>${rows.length} project${rows.length === 1 ? "" : "s"} in ${data.root}</span><span>archives go to ${data.archive}</span></div>
      </div>
    </div>
    ${
      rows.length === 0
        ? html`<p class="card muted">No projects yet. <code>/demo new</code> in pi starts one.</p>`
        : html`<ul class="ds-projlist" data-projlist>
      ${rows.map(
        (
          r,
        ) => html`<li class="card ds-projrow" key=${r.slug} data-project=${r.slug} data-active=${r.active ? "true" : undefined}>
          <div class="ds-grow">
            <div class="ds-row-flex"><strong>${r.slug}</strong>${r.active ? html` <span class="ds-badge" data-tone="accent"><span class="ds-badge-ico" aria-hidden="true">●</span>Active</span>` : null}</div>
            <div class="ds-small ds-muted">${r.appName} · ${r.phase} · ${sizeWords(r.bytes)} · changed ${sinceWords(r.updatedAt)}</div>
          </div>
          <div class="ds-row-flex">
            ${
              r.active
                ? null
                : html`<button class="ds-btn ds-btn--sm ds-btn--primary" type="button" data-act="switch" aria-busy=${busy === `switch:${r.slug}` ? "true" : undefined} onClick=${() =>
                    run(r.slug, "switch", async () => {
                      await post("/api/project-switch", { slug: r.slug });
                      toast(`${r.slug} is the active project`, { kind: "ok" });
                    })}>Switch to it</button>`
            }
            <button class="ds-btn ds-btn--sm" type="button" data-act="archive" aria-busy=${busy === `archive:${r.slug}` ? "true" : undefined} title="Writes a zip of the project into the archive folder and reads it back; the project stays" onClick=${() => archive(r)}>Archive…</button>
            <button class="ds-btn ds-btn--sm ds-btn--danger" type="button" data-act="delete" aria-busy=${busy === `delete:${r.slug}` ? "true" : undefined} title="Makes and checks a zip first, then removes the project" onClick=${() => remove(r)}>Delete…</button>
          </div>
        </li>`,
      )}
    </ul>`
    }
    ${last ? html`<p class="ds-notice" role="status" data-tone="ok" data-last><span class="ds-status" data-tone="ok" aria-hidden="true">✓</span><span>${last.deleted ? "Deleted" : "Archived"} <b>${last.slug}</b>: ${last.files} files, ${sizeWords(last.bytes)}, read back and checked.<br /><code>${last.file}</code>${last.left?.auth || last.left?.caches || last.left?.drafts ? html`<br /><span class="ds-muted">Left out: ${[last.left.caches ? `${last.left.caches} cache item(s)` : "", last.left.auth ? "the app's saved login" : "", last.left.drafts ? `${last.left.drafts} draft render folder(s)` : ""].filter(Boolean).join(", ")}.</span>` : null}</span></p>` : null}
    <p class="ds-small ds-muted">The zip holds the project and its app under their own paths: unzip it into ${data.root} to put it back. The same from the chat: <code>/demo archive [project] [--delete]</code>.</p>
  </section>`;
}
