// The Projects page's words and rules (item 14, E): pure, so a test can import them without the panel's modules.

/** "142.6 MB", "3.1 GB": what a project weighs. */
export function sizeWords(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/** "3 min ago", "2 h ago", "5 days ago", else the date. */
export function sinceWords(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  if (s < 14 * 86400) return `${Math.round(s / 86400)} days ago`;
  return new Date(t).toISOString().slice(0, 10);
}

/** What the delete dialog says: the zip is made and checked first, then the folder goes; the app stays; the saved login is never in the zip. */
export function deleteText(row) {
  return [
    `This makes a zip of "${row.slug}" (${sizeWords(row.bytes)} on disk), reads it back to check it, and only then removes the project's folder.`,
    "The zip is kept in the archive folder. The app's record and discovery screens are shared with other projects and stay; the app's saved login is not put into the zip.",
    row.active
      ? "This is the active project: there will be none until you open or create one."
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The archive failed for size: offer the lean way (without the video files of draft renders) when that is what the error says. */
export const canTryWithoutDrafts = (message) =>
  /try again without the draft renders/.test(String(message));
