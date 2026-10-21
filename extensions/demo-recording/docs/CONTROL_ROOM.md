# The control room: a tour of the panel

The panel is where you look at what the Director produced and decide. It runs locally (`/demo panel` opens it; `DEMO_REC_NO_OPEN=1`
only prints the address) and is also what the Director sees: when you approve something here, the Director is told.
This page describes every part of it. For the process see [GUIDE.md](GUIDE.md); for a first run [TUTORIAL-101.md](TUTORIAL-101.md).

Contents: [the frame](#the-frame) · [Project](#project) · [Storyboard](#storyboard) · [Recording](#recording) ·
[Voice over](#voice-over) · [Annotations](#annotations) · [Render](#render) · [Versions and the production line](#versions-and-the-production-line) ·
[The map](#the-map) · [Config and Brands](#config-and-brands) · [Keyboard, themes and small windows](#keyboard-themes-and-small-windows) ·
[Safety of the panel itself](#safety-of-the-panel-itself)

---

## The frame

Every screen has the same frame around it, so you always know where you are, what needs you and what is running.

| Part | Where | What it is |
|---|---|---|
| **Top bar** | top | the project name; **Project**; the five stages as a stepper, each with a state (complete, needs you, running, blocked, not started: an icon **and** a word); **◇ Map**, **? (shortcuts)**, **⚙ Config**, the theme |
| **Next-step band** | under the bar | what needs you (a draft newer than the newest approved version, or the engine's next step) or what is blocked, with a link to go there and a menu of the other pending items. It only links: it never starts anything and never moves you. **Once you are on the page it points to it is hidden** (collapsed; Blocked, Director working and Done never hide), and the header's **Suggestions · N** menu lists what waits for you (the current suggestion, then the others; "you are here" marks the page you are on), always, with nothing stored |
| **The screen** | middle | one of the stages, Project, Config, or the Map as an overlay |
| **Status strip** | bottom | one short line: *Nothing running*, what runs (a percentage only when the job reports one), a failure in red with **Show error**, or the connection state |
| **Activity drawer** | right, on demand, **docked** beside the screen | the running jobs with progress, **what happened by itself**, what needs attention, recent jobs, the live frame (**a click opens it bigger, in a window that keeps updating**), the safety feed and the log |

![The frame while a render runs, with the Activity drawer open](images/guide/12-frame-running.jpg)

- **The address says where you are** (`#/voice`, `#/render/v2`, `#/config?q=voice`): back, forward and reload work; a bare address
  restores the last place in this project; an unknown one says so and shows Project. Moving around never changes project state.
- **The Director's work is visible** (from pi's own events, `docs/DIRECTOR_STATE.md`). While the Director works the band says
  **Director working: <what it is doing> · <the step>** instead of "Needs you" (what waits for you is a small link beside it), the strip says
  it when no job runs, the stage a step belongs to shows as running, and Activity has a **Director** row; when it ends, Activity says "Director
  finished" or "stopped" (Escape). It lasts until pi says it will not continue by itself (a retry after a failed model call does not end it);
  a long silence is said ("no news for N min"), not hidden.
- **Nothing happens in silence** (run-and-tell). What the panel does with an event is written down once (`src/panel/public/steps.js`, a test
  keeps it complete): an **ask** is the Director asking to spend; **progress** shows in the strip and the Activity rows; an **alert** (a model
  warning, a failure to reach the Director) is always a toast; your own actions say nothing; and a **result that arrived by itself** (the
  Director wrote something, the edit and its draft render finished, the QA of a final, the annotation designer) is a **new** badge on its step,
  **a toast when you are looking at that screen**, and a line under **Happened by itself** in Activity.
- **After Approve & use** the toast says what happens next ("Next: the Director asks to record it. A recording uses model calls, so it waits for
  your Allow", "Done: this is the delivered version"). **A draft made before there are annotations** (the voice step's) carries a **no annotations**
  badge so it is not mistaken for the annotated one.
- **A result that arrives** (a storyboard, a take, a voice-over, annotations, a render) puts a **new** badge on its step. It never
  switches the screen, takes the focus or touches what you are typing.
- **The Activity drawer never opens by itself**, not even on an error; it opens when you ask and is **remembered as you left it**, also after a reload (open it, and it is open next time; close it, and it stays closed). It is **docked**: the screen gets 22 rem narrower and sits beside it, while the header, the band and the strip keep the full width; Render keeps its two columns from a 1280 px window up. In a window narrower than about 76 rem (1216 px) there is no room to squeeze, so it overlays the screen instead. A failure is also in the strip
  and in the band, so it cannot be missed without taking the screen over.
- **Messages** are toasts: errors stay until dismissed and have **Copy**; information goes away after a few seconds (not while the
  pointer or the keyboard focus is on it).
- **Decisions** (approve, withdraw an approval, save a setting, delete files, discard a draft) are in-panel dialogs that say what
  changes: Escape cancels, Enter confirms, a destructive one starts on *Cancel*.

## Project

The first step. It opens on a **summary** of the brief in human terms (audience, goal, depth, length, voice, app URL) and one **Next**
line; what is missing is marked, but nothing is mandatory.

![Project: the summary, and what is next](images/guide/16-project-summary.jpg)

Below it, one group at a time (the chip that is open closes when you press it again):

| Group | What it holds |
|---|---|
| **Brief** | the facts as a form (title card preview, audience, depth, stance, target length, voice, URLs, goal). Each save shows a diff and writes a new brief version |
| **Discovery** | where discovery stands (not started, running, done, budget used, cut off) and every session with what it used against its budget and how it ended. **Start discovery** and **Enhance…** ask the Director in one window: what to keep in mind, the areas to cover, and the **budget** (quick, standard, deep or the three numbers; standard is the Config value). **Extend the budget…** appears when the last session ran out and offers twice what it had. An **Areas** table shows what the latest session actually saw in each area it declared (looks, actions, the routes it gave, why one was left out): marking an area done is a claim, only what was seen counts, and an area marked done with nothing seen says so. The Director may not write the storyboard over an area nobody saw: it explores it or leaves it out with a reason. Below it the **Report**: what the Director found about the app, what your sources added and the guidance for the storyboard (use cases, must show, risks, avoid), each claim with its evidence as a chip: a **finding** or a **screen** opens a popup first (the finding with its marks, its own picture and where the report uses it; the screen large with the findings that cite it), with **Go to this finding** (the Findings list, scrolled to it and marked, whatever its filters) or **Open full size**; a source goes straight to its file or link; versions, a notice when a session ran after it, and a coverage line the engine counts itself. The Director writes it at the end of every discovery and on request; its tool refuses a claim without evidence that exists. The storyboard screen says which report it was based on. A session that is open and quiet **says it is alive every 30 seconds** (Config: `discovery.heartbeatSec`, 0 = never): one line in the log, the bar's detail and the drawer, e.g. "⏳ still here · 45 s since the last step (look s014 “Orders” · /orders) · 14/40 screens, 6/150 actions · area in hand: Orders · the Director is working on the next step". With no look or action for 60 seconds it says "No activity for 75 s" (and when the Director has stopped with the session still open, that). A request waits until the Director picks it up and can be taken back; it costs model tokens and browser time, no money |
| **Sources & context** | what you gave the Director (notes, links, assets) |
| **Findings** | what discovery and the recordings found (strengths, weaknesses, friction, values, use cases, length), each **auto**, **use** (always in the recording and the narration) or **ignore** |
| **Project history** | the input log: every direction, review, edit and note; withdrawn ones are marked outdated, never deleted |

## Login (apps that need one)

The **Login card** on the Project page is for an app that asks for a login (a password, OAuth, an e-mail link, a one-time code). You log in **by hand, once**; the engine saves the session for
the app and reuses it for discovery and recordings. It never stores a password and never shows the session to the Director or the panel.

- **Log in…** opens a browser window on the app (the same as `/demo login`). Log in there, come back and press **I'm logged in** (or **Cancel**). The session is saved owner-only (never in a project's zip),
  then **checked in a fresh browser**; if that browser is logged out (the app keeps its login in sessionStorage, which a saved login cannot keep) nothing is saved and the earlier login stays.
- The card says where the login stands: **no saved login** (an app that needs none can ignore it), **logged in** (saved and checked when), **expired** (with the reason; discovery and recordings are refused
  until you log in again) or **could not be checked** (the app was not reachable). **Check now** looks again; **Forget…** deletes the saved session.
- **The app's own check** (optional): by default a session counts as gone when the app lands on a login-looking address (`/login`, `/sign_in`, `sso`, `auth`…) or shows a password field. If that is wrong for an app,
  give a page to open and a text or a selector that is only there when you are logged in.
- **During a recording** the page is looked at after every step. If the login has expired, the recording **pauses** (nothing is lost): a question from the Operator appears ("Login: I will log in now" / "Stop the
  recording"), you log in again (the card or `/demo login`), and the recording goes on from that scene as a new segment. A scene that legitimately shows a password field does not stop it (the saved login is
  confirmed in a fresh browser first).

## Projects

**Projects** (`#/projects`; click the project's name in the header, or "All projects" on the Project page) lists every project of the working folder: its name, app, phase, size on
disk and when it last changed, with the active one marked.

- **Switch to it** makes it the active project: the Director gets its memory and is told, the choice is remembered in the pi session. Refused while a job of the active project
  runs (its results would land in the wrong project) or a discovery session is open.
- **Archive…** writes a zip, `<working folder>/archive/<project>-<date>.zip`, **reads it back and checks every file** against its source, and shows the result. The project stays.
  The zip holds the project and its app under their own paths (`projects/<name>/…`, `apps/<app>/…`), so unzipping it into the working folder puts it back. Left out: caches
  (`previews/`), and **the app's saved login (`auth/`), which never goes into a backup**. A project of 4 GiB or more is refused with the reason (the zip writer has no ZIP64), with the
  offer to archive **without the video files of draft renders** (their records and every final stay).
- **Delete…** does the same archive, and **only after the zip has been read back and checked** removes the project's folder. The dialog says what happens and waits until you have typed the
  project's exact name. The app (its record and discovery screens) is shared and stays. Deleting the active project leaves none active until you open or create one.
- From the chat: `/demo archive [project] [--delete] [--no-drafts]`; `--delete` needs the project named.
- There is no restore command: unzip the archive into the working folder.

## Storyboard

The scenes the Director plans to record, as a list with one scene in detail: the steps, what each waits for, and the confidence of the
Director in each (the doubtful ones come first with **riskiest first**).

![Storyboard: scenes on the left, a scene in detail](images/guide/03-storyboard.jpg)

In the detail, **the scene's picture is on the left and all the text on the right** (the title, the takeaway, the emphasis, the outline, the steps, your review and the notes);
below about 64 rem of width the picture comes first. Nothing is pinned: the page scrolls as one (D145).

- **Mark reviewed**, **Needs changes**, **Re-run** and a note per scene. A decision is a **state**: the one you choose becomes a highlighted "Reviewed" / "Needs changes" / "Re-run requested" with a **Revoke**, the other two stay available to switch, and the same state is a badge beside the title and the word in the list row. One line says what each does (Re-run: the Director redoes it from the take, or for a scene from the app, not just an edit; nothing happens until you send the review); **Mark high-confidence reviewed…** shows what it will mark
  before it does.
- **Send review to agent** sends everything as one message (the button says it starts the Director); the next storyboard version comes
  back with a diff.
- **Approve & use**, **Approve only**, **Use for next steps** and **Withdraw approval** are explained under
  [Versions](#versions-and-the-production-line).

## Recording

The takes of the selected storyboard, newest first, one line each (status, duration, analysis state, **Review**, and the approve / use actions);
**Approve** each take that is good enough to build on. **Request a new take** (a card at the bottom of the page, like the storyboard's review, with an optional note) asks the Director for another one, and
shows its cost first.

Below them is the **review workspace** of one take (the one you picked with *Review*, else the one you are viewing, else the one in the
production line): the scenes as **chapters with their frames** (the start, each mark, notable moments, the end) beside a **smaller player that
stays in view** while the list scrolls. Above the video are the chapter you are in: its **goal** from the storyboard, the **findings the scene
should show** and **what this take found there** (an error shown, a fallback, dead time, a resume; each with its time, a click goes there).
Under the video a **chapter bar** marks every scene on the take's own time line. A click on a chapter, a frame, a found item or a segment goes
to that moment. **The keys work anywhere on the Recording tab** (never while you type or a dialog is open): `[` and `]` go to the previous and next chapter, `<` and `>` to the
previous and next **finding** of the take (what the storyboard meant the scene to show and what the take found; one with a time jumps to it, the others to the start of their scene),
`←` and `→` back and forward 10 seconds (with Shift, 1 second), `N` adds a note. A line under the video says where the key took you. In a narrow window the player comes first and
the chapters follow.

**Notes** (the third column from a wide window, else under the chapters): pause on a moment and press `N` (or `+`, or *Add note* under the video)
to write what you noticed; it is stamped with the time and the scene. A note's time chip goes to that moment; Edit, Delete (with Undo). Notes are
review input: nothing is sent as you write. **Request a new take** carries every open note (the take, the moment, the scene, your words) to the
Director with its own note, once; they then show as *sent* and become a record (no more editing).

![Recording: the takes of the selected storyboard](images/guide/04-recording.jpg)

## Voice over

A list of sections (an intro, one per scene, an outro) and one in detail.

![Voice over: sections, the narration and the timing at each anchor](images/guide/05-voice.jpg)

| Part | What it does |
|---|---|
| **Narration** | editable; autosaves as a working draft on the version it started from; **Save new version** makes exactly one version and approves nothing |
| **The scene's moments** | under the narration, **every frame of the scene in time order**: the start, each mark, notable moments (a toast) and the end. A mark the narration uses shows ✓ and the first words it pins; a mark it does not use says **not mentioned in the narration** (mention the moment, or leave it out on purpose) and is a button that puts its `[@mark]` into the narration **where the cursor was** (the strip follows the draft as you type; an anchor out of the take's order is flagged as before). An intro shows how the first scene opens, an outro how the last one ends |
| **Timing at each anchor** | one card per `[@mark]` the section speaks: the time and a line of what the page said, and **timing controls**: −100 / +100 ms nudges that write a timing hint `[@mark +300ms]` into the narration (a working draft until you save a version), what it says in words, Reset. The words and the voice stay the same, so it costs no audio |
| **Review** | Mark reviewed / Needs changes / Re-run as a state with **Revoke** (the others stay available), a note, and **Send review to agent** |
| **Direction** | stance, tone, length, focus and notes for the whole narrative; the Director writes a new version from the same take |
| **Confidence** | a badge per section with the reasons (a number not on the page, speech longer than the footage, changed since the version you approved) |
| **compare with v1** | the words that changed, per section |
| **Make the voice (uses credits)…** | the cost dialog, then the voice and the edit (no agent). Only for an approved version in the production line |

**The Director asks.** When the Director wants to spend (a voice synthesis, a new take) and you have not allowed it, nothing starts: a bar
appears on every screen, above the content: *Allow the Director to … ? / 1 Allow / 2 Deny*, the same question the chat shows. Allow lets that one thing go (for 15 minutes,
once); Deny tells the Director not to try again unless you ask. Answer with a button, by typing `1`, `2`, `allow` or `deny` in the chat, or with
`/demo allow [id | all]` and `/demo deny [id | all]`: whichever you use, the question is answered once and the others disappear.

**The Director asks you a question.** When it needs a decision it cannot make (which story first, whether to cut scenes), it asks with 2 to 4 options and
**stops**: the question appears in the same bar on every screen (who asks, the question, why it matters, a button per option with its number, and
Dismiss), in the next-step band ("The Director asks", before anything else that needs you) and in Suggestions. Answer with a button; your answer wakes the
Director with a message that carries the question, your choice and where you answered. A question is resolved **once**: a second answer is told who got there first.
It never approves, spends or replaces anything: those stay the actions you take in the panel. It waits for you, with no timeout. **In the chat** the question
appears as a message of its own (who asks, what, the options with their numbers). Type exactly an option's number or word (`1`, `cut`) to answer it: it counts only
when it is your own typing and fits exactly one waiting question; anything else (`hmm, what does that cost?`, a `1` when two questions both have a 1) is
normal chat and the question keeps waiting. If you stop the Director's run, the questions it asked in that run and nobody answered are cancelled.

**Who is speaking.** Every report the engine puts into the chat names its role: `[demo-recording · Cutter]` for an edit or a render, `· Operator` for a
recording, `· Voice writer` for the voice, `· QA reviewer` for the quality check, `· Annotation designer`, and `[demo-panel · You]` for what you did in the
panel. The band and Activity use the same names for what the Director is doing ("Revising the voice-over · Voice writer: Writing the voice-over"). The
Director's own text starts with its role once per block because each skill asks it to; that one is a request, not something the engine enforces.

If a newer version exists than the one a draft was started on, the draft is flagged ("v2 exists") and **Compare with v2** shows both;
a draft is never rebased or dropped for you.

## Annotations

Zooms, highlights, spotlights, callouts, chapter titles and privacy redactions, grouped by scene. **Previous** and **Next** flank the preview with "4 of 21" (disabled at the ends; they walk the list as it is filtered, and the selection follows); `[` and `]` do the same from the keyboard.

![Annotations: items by scene, one in detail](images/guide/07-annotations.jpg)

| Part | What it does |
|---|---|
| **The switch on a row** | in the render or not; a privacy redaction asks first, once per redaction |
| **The detail** | its type, start and length (with 0.5 s nudges), its target and alternatives, why it was proposed, and a still or a clip of the result |
| **A budget bar** | how busy the video is against the optimum for its length |
| **Suggest again…** | a new set on the version you are viewing, keeping your changes; says whether it runs as a separate call or an agent turn |
| **Save new version** | your working draft becomes one version; nothing is approved |

## Render

The runs (finals and drafts) as a table, the delivered final first, the drafts folded under one line.

![Render: runs, player, quality check, decision bar](images/guide/08-render.jpg)

| Part | What it does |
|---|---|
| **New render…** (header) | kind (draft or final), annotation version, brands, annotation types, subtitles, logo bug; **Render now** uses what the summary says |
| **Runs** | Run, Based on, QA, Files, Created; chips All, Finals, Drafts, QA problems |
| **Player** | a **Full video / Scenes** switch, one chip per scene and the video, about two fifths of the width, on the left of the quality check. It stays **pinned just below the header while you scroll the findings** and scrolls away only after the last one (in a narrow window the video is smaller and pinned the same way). A draft has no quality check, so its player is single and wide, and not pinned |
| **Variants** | below, full width: the table of the variants with downloads, zip, folder |
| **Quality check** | the items found (**Hard stops** first, then **Needs your eyes** and **Worth a look**, with a ▶ time link and fixes; **Fix / Leave** and **Ignore…** on any finding that is a judgement call, **Export anyway…** for a leaking redaction) and, in plain words, the checks that found nothing |
| **Fixes** | one line under the findings that says where the loop stands, and **Suggested fixes…** / **Open suggested fixes**, which opens the loop **as a window** (Esc, × and Close only close it; Cancel this ask is its own button; nothing is lost): the findings you flagged, your context, **Ask the Director**, the proposals (one per stage, the earliest first, with why, what it answers and what applying costs), Accept / Reject / Edit the wording / a note per proposal, and **Ask the Director to rethink** with more context, and **Apply N accepted proposals** (the Director writes ONE new draft at the earliest stage, nothing is rendered or synthesized; later stages become pending fixes, shown as "N pending fixes for this stage" on that stage's screen, where you can drop one) |
| **The bar** | what approving does; **Show in map**, **Download** (the video, transcript, callouts, poster, a zip of the variant, its folder), **Delete files…** and the approve / withdraw buttons. A reason is said once if two buttons are blocked for the same reason |

## Versions and the production line

Every stage has a **Versions** list next to its title. A row says what the version is based on and where it stands, and clicking
**anywhere on the row** opens it. **Looking never changes anything.** The head of the screen always says what you are looking at
("Viewing v2 · Draft version · Based on recording take-001") and, when it is not in the production line, how it differs.

![The Versions list: v1 is in the production line, v2 is an approved alternative](images/guide/06-versions.jpg)

**Advanced → Compare two versions…** (Storyboard and Voice over, once there are two versions) opens a window with the **facts** of two versions: counts with
their difference (scenes, steps and marks, or sections, words, anchors and speech against footage), and what was added, removed or changed, in words and
numbers. It is free and instant, it says nothing about which version is better, and it never changes a version. By default it compares the production
line's version with the one you are viewing; *swap* turns it round.

Below the facts, **Ask the Director for a verdict** starts a visible Director turn (model tokens only: nothing is recorded, spoken or changed; no Allow).
The Director cannot answer loosely: its tool **refuses** a verdict that is not one of *better*, *worse*, *different* or *no meaningful change*; that has
fewer than two or more than six points; that cites a scene, section or number that is not in the facts above; that says better or worse without citing a
measured fact; that leaves out **Against this recommendation** (the strongest argument against its own recommendation); or that recommends against its
own verdict. The verdict shows with its points as chips (a click jumps to the fact, and the facts it cites are marked), the argument against, and the
recommendation with **Use vN for next steps**, which is the usual Use action with its consequence dialog. One verdict is kept per pair of versions: asking
again replaces it (after asking you), you can give up on an ask the Director has not answered, and **Advanced → Past comparisons (n)** reopens a stored one.

| Action | What it does | Asks? |
|---|---|---|
| **Approve & use** (on Voice over: **Approve script vN**) | approves it and puts it in the production line; **starts the Director** | when it changes the line |
| **Approve only** | approves it as an alternative; the line stays exactly as it is | no |
| **Use for next steps** | puts an approved version in the line | when it changes the line |
| **Withdraw approval** | removes the approval; whatever was built on it is flagged **blocked by dependency** (nothing is deleted) | when something becomes blocked |

Each one shows the production line **before and after** when it changes it, and applies only if the project is still as planned. Every one
leaves an **Undo** in the confirmation toast for about 12 seconds; it restores the approvals, the line and the phase exactly, and is
refused (with the reason) if anything else changed them since. *Delete files* has no Undo: its two dialogs are its safeguard.

![Use for next steps: the line now, and after](images/guide/13-use-dialog.jpg)

![The toast that confirms it, with Undo](images/guide/14-undo-toast.jpg)

More on branching in [BRANCHING.md](BRANCHING.md).

## The map

**◇ Map** (or **Show in map** on any version) draws every version, grouped by stage, one parent per node, with the production line in bold.

![The map: two branches next to the delivered line](images/guide/09-map.jpg)

- **All paths**, **Approved paths** and **Production line** change what is shown; **Focus connections** shows a selection's parents and
  children; search finds versions; **Collapse groups** folds the draft renders; **Reset view** returns to the start.
- **Zoom:** −, **Fit**, +, the keys `+ − 0`, the mouse wheel (at the pointer) and a trackpad pinch. **Pan:** drag the background, or two
  fingers on a trackpad. **Wheel: Auto / Zooms / Scrolls** (in the foot) fixes a wrong guess about your device.
- **Open in stage** goes to the exact version. Looking never changes what the next steps use.

## Config and Brands

**Config → Settings** lists every setting that is not about the demo itself (voice engines and their order, models, capture size,
output and look, discovery budgets), grouped, with the most important first. It opens on the first group.

![Config: settings by group, with their source](images/guide/10-config.jpg)

- **Environment overrides** are listed in a warning at the top whenever a `DEMO_REC_*` variable is set: what it sets, the value it hides,
  and test switches (`DEMO_REC_NO_OPEN`, `DEMO_REC_NO_VOICE_LIST`) flagged as such, so a variable left over from a test cannot silently win.
- **Search** finds a setting by name, key, description or value (`/` or Cmd/Ctrl+K inside Config); **Changed**, **Overridden here** and
  **From environment** filter. API keys are shown only as *set* or *not set* and are never searched or displayed.
- Each row shows the **effective value and where it comes from**; **Scopes** shows each layer (environment, project, global, default)
  with its own action. An environment value is read-only; a value hidden by a higher layer is flagged. Every change ends in a diff.
- **Voice name** is a picker of your ElevenLabs voices (yours first), with a text field when the list is not available.

**Config → Brands** is a list of brands and an inspector: a preview of the title card and a sample frame, and the colours, frame,
title card and logo bug as rows with one control each. A changed field is marked, with an **Undo** per row; **Save as copy…** keeps
your tweaks (built-in brands are read-only), **Set as default** and **Default for this project** go through a diff.

![Brands: the list, the preview and the rows](images/guide/11-brands.jpg)

## Keyboard, themes and small windows

- **A list is one tab stop;** ↑ ↓ Home End move between its items and Enter opens the one in focus. **`?`** opens the sheet of every
  shortcut, which never fires while you type or over a dialog:

  | Keys | What |
  |---|---|
  | `?` | show the shortcut sheet |
  | Tab, Shift+Tab | move between controls (a list is one stop) |
  | ↑ ↓, Home, End | move between the items of a list; Enter opens the one in focus |
  | `[`, `]` | previous / next chapter in the recording review, previous / next annotation in Annotations (never in a text field) |
  | `<`, `>` | previous / next finding of the take in the recording review (anywhere on the tab) |
  | `←`, `→` | back / forward 10 seconds in the recording, with Shift 1 second (anywhere on the tab) |
  | `N`, `+` | add a note at the current moment of the recording (anywhere on the tab) |
  | Esc | close the top layer: a dialog, the Versions list, the Map, or clear a search |
  | `/`, Ctrl/Cmd+K | search the settings (in Config) |
  | arrow keys in the Map | walk the graph from node to node; Enter selects |
  | `+`, `−`, `0` in the Map | zoom in, zoom out, fit the whole graph |
  | the mouse in the Map | the wheel zooms at the pointer (Shift + wheel scrolls); drag the background to pan |
  | a trackpad in the Map | pinch zooms at the pointer; two fingers pan |

  ![The shortcut sheet](images/guide/15-shortcuts.jpg)

- **Two themes** (Catppuccin Macchiato, dark, and Latte, light); the choice is remembered. Status is always an icon and a word, never
  colour alone.

  ![The light theme](images/guide/18-light.jpg)

- **Long lists** (Voice over sections, Storyboard scenes, Annotations): the list is 22 rem wide, a row's text **wraps** (up to three lines, the whole
  text on hover) and never runs into the detail. **The page is the only scroll** (D145): the detail is plain content next to the list, nothing is pinned and nothing
  scrolls inside, so the wheel works the same over the list and over the main area. The screen's action bar (Save new version) sticks to the bottom
  of the window while the list is on screen and ends with it. The Recording review works the same, with one exception: the player (video, chapter bar, Add note) sticks just
  under the header while you read the chapters and write notes, and is released at the end; the chapters and the notes are columns of the page.
  Render keeps its pinned player.
- **Small windows:** the layout follows the width of the workspace, not the window. Below about 52 rem the list becomes a select above
  the detail, secondary columns of a table fold away, and the header drops the stepper's labels.

  ![A narrow window: the list is a select](images/guide/17-narrow.jpg)

- **Text zoom** to 200 % does not scroll the page sideways; reduced-motion settings are honoured; every control is at least 24 px and
  shows a focus ring (checked by an automatic audit in both themes at 900 and 1400 px).

## Safety of the panel itself

The panel listens on `127.0.0.1` only. Its API and its live connection need a random per-session token, and the Host header must be
loopback (a guard against DNS rebinding). Requests that change something accept only a Bearer header with a JSON body, so another page
on your machine cannot forge them. The token is removed from the address after the first load. The panel never shows, stores or
searches an API key; the voice list is read on the server with the key from the environment and only the names reach the page.
If a part of the panel cannot load, the page says so and what to try instead of staying blank.
