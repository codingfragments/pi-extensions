---
name: gdrive-publish
description: >
  Publishes a folder of markdown, CSV, and Excel files to Google Drive as
  native Google Docs and Sheets, rewriting relative links between the files
  into real Google Doc URLs. Use when the user wants docs "in Drive", "as a
  Google Doc", shared with non-technical colleagues, or asks to update/
  re-publish a previously published folder.
---

# gdrive-publish

Turns a local documentation folder into native Google Docs/Sheets where
`[details](./details.md)` becomes a link that opens the *details* Google Doc.
Re-publishing updates the same Drive files, so URLs already shared with people
keep working.

## Before you touch the tool

The `gdrive_publish` tool only exists when the project is set up. If you cannot
see it:

1. Run `/gdrive-publish-status` to see what is missing.
2. Missing auth → the user must run `gdrive-publish login` in a **terminal**
   (it opens a browser; never try to do this through a tool call).
3. Missing manifest → `/gdrive-publish-init <folder name>` creates the Drive
   folder and `.gdrive-manifest.json`, then `/reload` registers the tool.

## Normal workflow

1. **Always plan first.** `gdrive_publish { mode: "plan" }` is read-only and
   writes nothing. Show the user what would change, especially the warnings.
2. **Then publish.** `gdrive_publish { mode: "publish" }` prompts the user for
   confirmation in interactive sessions. Do not pass `assumeYes: true` unless
   the user has *already* approved this specific publish in the conversation.
3. **Tell the user to commit the manifest.** `.gdrive-manifest.json` is the
   map from source files to Drive fileIds. If it is not committed, the next
   person to publish creates duplicate Docs with different URLs. The tool
   never touches git on its own.

## Reading the warnings

Warnings are normal, not failures. The ones that matter to a user:

| Warning | What to tell the user |
|---|---|
| `ANCHOR_DROPPED` | The link works but lands at the top of the Doc, not the section. Google Docs headings have no stable anchors we can target yet. |
| `LINK_OUTSIDE_ROOT` | The link points outside the published folder, so it was left as-is and will be broken in Drive. Either move the file into the folder or change the link. |
| `LINK_TARGET_MISSING` | Broken link in the source, left verbatim. Worth fixing locally. |
| `FRONTMATTER_STRIPPED` | Expected. Drive mangles YAML front matter, so it is removed; `title:` became the Doc name. |
| `IMAGE_LARGE` | Images are embedded as base64, which inflates the upload by ~33%. Consider shrinking it. |
| `DOC_PAYLOAD_TOO_LARGE` | An **error**, not a warning: the document will be skipped until images shrink. |
| `CSV_NORMALISED` | The CSV was not UTF-8 comma-delimited (typically a German Excel export); it was normalised so Drive parses the columns correctly. |
| `XLSX_LOSSY` | The workbook became a Sheet; macros and some formatting are lost. |
| `DRIVE_MODIFIED` | Someone edited the Doc in Drive. Local content overwrote it; their version is still in Drive's revision history. Mention who and when. |
| `ORPHAN` | A local file was deleted but its Doc still exists. Nothing was removed. Only run with `prune: true` if the user explicitly wants it trashed. |
| `PENDING_RESUMED` | A previous run died midway; this run filled the reserved Doc. No action needed. |

## Rules

- **Never** pass `prune: true` unless the user asked to remove deleted files.
  It moves Drive files to trash (recoverable, but it is still deletion).
- **Never** pass `assumeYes: true` to bypass a prompt the user has not seen.
- Do not try to run the OAuth login flow yourself; it needs a browser and the
  token must be written by the user's own terminal session.
- Images are inlined into the Doc; do not suggest uploading them separately
  and linking with `drive.google.com/uc?...` URLs — that provably does not
  work on Workspaces that block anyone-with-link sharing.
- If the user wants the Drive folder somewhere specific, tell them to move it
  in Drive after `init`; access survives the move, and the manifest keeps
  working.

## Verifying the result

If the user doubts the output, the trustworthy check is to open the Doc. For
images specifically, an exported `<img>` tag or a `word/media/` part in a docx
export is **not** proof — Drive emits those even for an image it failed to
fetch. Render the Doc (export PDF, rasterise) or just look at it.
