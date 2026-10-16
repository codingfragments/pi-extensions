# UX9a report: Config search and settings with their layers

Slice UX9a of the [UX pass](../UX.md) (D100, D125).

![A search, with a setting being edited](../images/ux/config/config-edit-dark-1400.jpg)

## What changed

- **Every setting shows its layers side by side.** *Effective* (the value in force and where it comes from:
  Default, Global, Project override, or Environment with the variable's name), the **Global** value and the
  **Project override**. Each layer has its own action: **Edit global** and **Reset to default**; **Add
  override for this project**, **Edit override** and **Remove override**. Editing opens in that layer's cell
  and still ends in the diff confirmation. **The page-level Global / Project switch is gone**, so a setting
  found by search can never be edited in the wrong layer.
- **The gaps are said, not hidden.** Without a project the override actions are disabled and say *Open a
  project to override this setting for it*; a global-only setting says so. An **environment value is read-only
  and wins**: the card says which variable sets it, and saving a file value shows the dialog's warning *this
  change has no effect right now: it is overridden by …* (it is stored, though shadowed).
- **Search covers the settings only:** key, label, description, the non-secret values of every layer and source
  words (global, project, env, default, overridden, changed). Every word must match, in any order. Matches are
  **highlighted**, groups with no match drop out and the groups that stay say *N matches*, the count says
  *6 of 41 settings*, and *No setting matches* is its own state with **Clear the search**; unavailable and
  loading are different states. Brands stays its own view; the raw files are shown but not searched.
- **Quick filters** next to the search: **Changed** (differs from the default), **Overridden here** (this
  project overrides the global value), **From environment** (a variable wins). They combine with each other
  and with the text.
- **Shortcuts, only inside Config:** `/` and Cmd/Ctrl+K focus the search, but never inside an editable control
  and never over a dialog; **Escape** clears the search when it has focus.
- **The search is in the address:** `#/config?q=voice&filter=changed` (and `?view=brands`), so a reload keeps
  it and a result can be linked.
- **Secrets never appear.** API keys stay *set / not set* badges (an icon and a word), are not settings and
  are not searched; a setting whose key looks like a secret has its value left out of the index and the card.
  A test puts fake keys in the environment and checks the page, the search and the raw files for them.

## Guards

`test/ux9a-config-search.test.ts` (8, pure): matching on every field and word, group collapsing and counts,
the quick filters and their combinations, secrets never indexed or shown, value formatting, highlighting, the
state in the address. `test/ux9a-config-panel.test.ts` (7): search, highlight, collapse, reload, Escape and the
no-match state; each layer's action writing the right file (global, project, removal, cancel) with the diff
dialog and no page-level scope switch; disabled override actions with the reason; the environment card and its
dialog warning; the filters; the shortcuts staying out of editors and dialogs; the secrets. They point
`DEMO_REC_CONFIG` at a temp file: the real config is never touched. `s5-config-ui` follows the new layout.

Audit: **Config has 0 serious findings in both themes and widths (it had up to 82 at 900 px)**: every editor
has a label, the API-key badges are design-system badges. The total went from 346 to 30 serious and from 408
to 396 small targets; no new literals. Baseline updated.

Regenerate the screenshots: `node extensions/demo-recording/scripts/panel-shots.ts --out /tmp/p --config`
(it uses a temp config file, so no personal path or value gets into an image).

## A fix on the way

The UX1 report images `panel/before-config-light-1400.jpg` and `panel/after-config-light-1400.jpg` showed the
author's home path in the Settings text; that text is now covered in both. `panel-shots.ts` always uses a temp
config from now on.

## Left for later

The Brands view keeps its legacy styling until UX9b, and so does the Brief form's Voice field (a text field,
not a picker of the account's voices).
