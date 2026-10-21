# Real-app run 3: findings and ideas (collected, not acted on)

The ideas and findings of the third real-app run (work package 13 of [RUNNING_PLAN.md](RUNNING_PLAN.md)), collected the way the first two runs' were
([REAL_RUN_FINDINGS.md](REAL_RUN_FINDINGS.md), [REAL_RUN2_FINDINGS.md](REAL_RUN2_FINDINGS.md)): **nothing here is acted on until the user says the
collecting is over**, and then the items are grouped into phases with the user. Items are numbered R3-1, R3-2, ... in the order they were given. Ideas raised
before the run started are marked "before the run".

Kinds: bug, ux, idea, design, policy, cost, praise, question. "Not acted on" means exactly that.

R3-1 [ux, idea] (**addressed by 13d, D146**) (before the run) Storyboard · the scene's picture on the LEFT of the main area, and everything written (the takeaway, the emphasis, the narration outline,
   the steps, the review buttons and the notes) on the RIGHT · wanted: on the storyboard page, the frame picture (the scene's screenshot) to the left of the main area,
   and the answers, steps and all text to the right.
   Context when noted: raised after items 1 to 12 were built. Today the storyboard page is the shared two-column layout (work package 3): a scene LIST in the left
   column (22rem) and, in the detail column, the selected scene as one stack: title and badges, the screenshot, the takeaway, the emphasis, the outline, the
   steps, then the review control and the note (`SceneInspector`, `src/panel/public/storyboard.js`). So the picture is above the text, not beside it.
   Assessment (not decided): points to settle with you. (1) Does "the main area" mean the detail column (picture and text side by side INSIDE the detail
   column, the list stays on the left), or the whole page (picture on the far left, the scene list moved)? (2) The recording review (work package 7) already
   has a player on one side and the scene's goal, findings and notes on the other: the storyboard could use the same pinned-picture pattern so the two screens
   feel alike, and the picture stays in view while a long steps list scrolls. (3) Below about 1100 px the two sides cannot both fit with the list: the picture
   would sit above the text again (900 px is the narrowest supported). (4) A scene without a screenshot ("No screenshot for this scene") leaves the left side
   empty: say so in one line or let the text use the width.

R3-2 [ux] (**addressed by 12c, D145**) (before the run) Storyboard · the selected scene must not scroll on its own: the whole page scrolls, nothing is pinned here · wanted: on the storyboard
   page the main area (the selected scene) grows with its content and the page scrolls as one; no inner scroll area, no pinned block.
   Context when noted: raised right after R3-1. Today the storyboard uses the same pinned detail as Voice over and Annotations (`.ds-detail-pin`, work package 3,
   D-R2-6): on a wide workspace (over 52rem) the scene block is sticky just under the header and is at most one window high, and the scene (`.ds-inspector`)
   scrolls INSIDE it, with the review control and notes kept at the bottom of the block. A long scene (many steps, the review note) therefore scrolls twice: the
   page and the block.
   **This reverses a decision for one screen:** D-R2-6 applied the pin to all three list screens (Voice over, Annotations, Storyboard) because the list can be
   long. Your point is that the storyboard has nothing to keep in view that justifies it (the scene list is short, scenes are few). The pin was a request for
   Voice over (R2-5) and Annotations (R2-9), not for the storyboard.
   Assessment (not decided): the change is local to the storyboard (its detail without `.ds-detail-pin`, so the scene is plain content in the page flow and the review
   control sits under the scene, no sticky action bar); Voice over and Annotations keep the pin. Points to settle with you: (1) with no pin, the review buttons are
   at the END of a long scene, so approving means scrolling to the bottom: keep them there, or repeat a compact "Approve / Needs changes" next to the title? (2) the
   scene LIST: should it stay at its natural height or also not stick? (3) together with R3-1 (the picture on the left of the text): the picture is the one thing that
   could be pinned while the steps scroll, which is the opposite of this note, so decide R3-1 and R3-2 together. (4) The test `p1c`/`ux3` layout tests that assert the
   pin on the storyboard would change.

R3-3 [ux, idea] (**addressed by 13c, D146**) (before the run) Recording tab · keys: `<` and `>` move one finding back or forward, the left and right arrow keys move the video by 10 seconds, and every key
   works on the whole tab, not only while the focus is on the player · wanted: review a take from the keyboard without first clicking into the player.
   Context when noted: raised after R3-2. Today (work package 7): `[` and `]` go to the previous / next CHAPTER and `N` or `+` starts a note, and both only fire while the
   keyboard focus is inside the review workspace (`.ds-rv`, `TakeWorkspace.onKeyDown` in `src/panel/public/recording.js`); focus on the "Request a new take" box, the take
   rows or the page itself gets nothing. The left and right arrows do nothing of ours: a focused `<video controls>` seeks by the browser's own step (about 5 seconds in Chrome),
   and only while the video itself has the focus. The "?" sheet lists `[ · ]` and `N · +` ("focus inside the review").
   Assessment (not decided): points to settle with you. (1) **What is a "finding" here?** Two readings: (a) a CHAPTER of the take (what `[` `]` do today; then `<` `>` would
   replace or duplicate them), or (b) a discovery FINDING of the current scene (the "findings of this scene" shown above the player, R2-4), which has no timestamp, so
   "move to the previous finding" would mean jump to the scene it belongs to, or to a moment in the scene: say which. (2) **Keep `[` `]`?** If `<` `>` are the new keys, do
   `[` `]` stay as chapter keys, or go? (3) **10 seconds**: a fixed step (hold the key to repeat), and what does Shift do (a smaller step, or a frame)? (4) **The whole tab**:
   the keys must still not fire while you type in a note, the "notes for the next take" box or a dialog (the same rule as the "?" sheet); and the left / right arrows are free
   elsewhere on this tab, but Up / Down and Home / End already walk lists, so they stay as they are. (5) The browser's own 5 s arrow step on a focused video would be taken
   over (prevented) so the step is one thing, 10 s, wherever the focus is. (6) The key list in the "?" sheet, the hint under the player and `shortcuts.js` change with it; and
   the same keys on the Annotations tab (where `[` `]` are previous / next annotation) should be decided in the same go so the tabs stay alike.

R3-4 [ux] (**addressed by 13b, D146**) (before the run) Recording tab · the "Request a new take" box with its notes at the BOTTOM of the page, like the review box of the Storyboard tab, not at the top ·
   wanted: read and review the takes first, then ask for the next one at the end.
   Context when noted: raised after R3-3. Today the box is the first card under the stage summary (`section.card.review-head` in `Recording`, `src/panel/public/recording.js`):
   a one-line field "notes for the next take (optional)", the primary button "Request a new take", the cost hint, "N open notes will go with it" and a paragraph about approving
   takes and "Use for next steps". The takes, the review workspace (chapters, player, notes) come after it. The Storyboard tab ends with its review card (`card review-foot
   ds-inflow`: a text box for the overall notes, "N/M scenes marked", the "Send review to agent" button), in the page flow, not pinned.
   Assessment (not decided): points to settle with you. (1) The same card shape as the storyboard's (a larger text box, the count and the button on one row under it) or
   today's one-line field moved down? (2) The paragraph about approving takes and "Use for next steps" is guidance for the takes above it: it may belong with the take rows, not
   with the request box. (3) With the notes from the review (work package 7c) the order becomes natural: write timestamped notes in the workspace, then see "N open notes will
   go with it" next to the button at the end. (4) A long page with several takes puts the button far down: fine, the same as the storyboard, or should "Request a new take" also
   be reachable from the top (a link that scrolls to it)? (5) The tests that find the box by its label or class (`recording-notes`, `recording-review`, `s5-dialogs-costs`) change
   with the move; decide together with R3-2 (no pinned blocks) since neither pins anything.

R3-5 [bug, ux] (**addressed by 12c, D145**) (before the run) Voice over tab · the scroll wheel scrolls the page only over the list at the side, not over the main area (the selected section) · wanted: the wheel
   works the same over the main area, so it scrolls the page there too.
   Context when noted: raised after R3-4. **Reproduced** in a browser (1400 x 900, a long list, the section pinned): ten wheel notches over the main area leave the page where it was (scroll 900 before and after); the same
   notches with `overscroll-behavior: auto` scroll it to 2900. Cause: on a wide workspace the selected section is the pinned block
   (`.ds-detail-pin`, work package 3). Its inspector is its own scroll area (`.ds-detail-pin > .ds-inspector { overflow: auto; overscroll-behavior: contain }` in
   `src/panel/public/ds/components.css`). `contain` stops a wheel that reaches the end of that area from carrying on to the page, so over the main area the page
   never scrolls (the area scrolls if the section is taller than the window, and does nothing if it is not), while over the list, which is plain page content, the
   wheel scrolls the page. Annotations and the Storyboard use the same block, so they have the same behaviour (R3-2 asks to take the pin off the storyboard altogether).
   Assessment (not decided): the smallest fix is to drop `overscroll-behavior: contain` so a wheel at the end of the inner area scrolls the page (the usual behaviour of a
   nested scroll area). Points to settle with you: (1) does that satisfy you, or should the main area not scroll on its own at all, on Voice over and Annotations too (R3-2 asks
   that for the storyboard only; the pin was asked for on Voice over, R2-5)? (2) with the pin kept, a wheel over the main area moves its inner scroll first, then the page:
   acceptable, or should the wheel always move the page and the inner area only be reached by dragging its bar or the keyboard? (3) A test: wheel over the main area at the end of the
   inner scroll moves the page (and over the list as it does today), on the three screens. This is the one item of the run 3 list that is a plain bug, so it could be fixed
   before the grill if you want.

R3-6 [ux] (**addressed by 13a, D146**) (before the run) Voice over · the buttons do not say what happens when you accept: there are two actions to advance, and the accept does three things ·
   wanted: names that describe what happens, or a popup, because this is the only tab that needs two actions to move on.
   Context when noted: raised after R3-5. Today the Voice over header shows **Approve & use v2** and **Approve only** (the shared version buttons, `version-ui.js`) and, next
   to them, **Generate voice, edit and a draft to watch…** (`voice.js`). Approving a voice-over script only unlocks voice synthesis (it does not start it, it costs nothing); the
   voice is made by the second button (it asks Allow / Deny first because it uses TTS credits), and it goes on by itself to the sync edit and a draft render, and after the
   edit the annotation designer may start by itself (`annotations.autoSuggest`, run-and-tell). So advancing is: approve the script, then generate. The three things you list
   (the voice, then the approval, then the annotations) are in a different order than the buttons: the approval comes first, then the voice, then the edit and the annotations.
   Assessment (not decided): points to settle with you. (1) Is the order right (approve the script, then generate) or should one button do both (approve and generate, with
   the cost shown in one dialog)? Approve is a gate for the SCRIPT; the voice costs money, so the two clicks are deliberate (P1a), but they could be one click with one
   confirmation that lists what follows. (2) Names: "Approve & use v2" says nothing about what comes next; "Approve script v2" plus "Make the voice (uses credits)…"
   would say what each does. (3) A short "What happens next" under the buttons (approve, then the voice with its cost, then the sync edit and a draft, then the annotation
   designer starts by itself), or a popup when you press Approve with the same list. (4) The same question applies to the other stages where an approval starts work (a
   storyboard approval unlocks recording and then asks Allow / Deny): Voice over is the only one with a second manual action, so it may only need a better order and names.

R3-7 [idea] (before the run) Projects · manage projects in the UI: list them, switch between them, delete them (archive into ONE zip for backup), and a `/demo archive` command ·
   **addressed by 14, D146.** Context when noted: today a project is made with `/demo new` and opened with `/demo open` in the chat; the panel shows only the active one. A
   project is a folder under `<root>/projects/<slug>` (plus its app record under `<root>/apps/`), 70 to 150 MB on the real ones here. Decided: a Projects page from the header's project name;
   delete = zip, verify, remove, with the name typed; the zip holds everything of the project and its app record minus caches, refuses over 4 GiB (the zip writer has no ZIP64);
   no restore command in this step.

R3-8 [ux] (during the run) Discovery · the session sometimes looked stuck: nothing in the log, the bar or the drawer for a minute or more · wanted: at least one message every 30 seconds, at most a minute.
   **addressed (heartbeat).** Context when noted: events were only sent on a look, an action or a plan change; between two of them the Director waits for a model call that can take a minute, and the only
   signal was "No activity for 2 min" after 90 s. Done: while a session is open and quiet it says so every 30 s (`discovery.heartbeatSec`, 0 = never): the time since the last step, what it was, the budget used,
   the area in hand and what the Director is doing (working, or stopped with the session open); the bar's detail and the drawer show the newest one; the stall note now comes after 60 s and reads in seconds.

R3-9 [ux, idea] (during the run) Login · the check should also run on the live browser, and after a valid login the Director should ask whether to start discovery · wanted: do not lose the login window when the
   saved login fails the fresh-browser check; ask (never start by itself) after a fresh login. Addressed by the login live-check change.

R3-10 [bug, ux, cost] (during the run) Discovery · a session took 31 minutes and saw 3 screens: two calls to the browser never came back (19 min and 6+ min, both a scroll on an issue-detail page), a click on something not there cost 46 s, the progress said "~1 min left" · wanted: real shortcuts.
   **addressed (PR "discovery watchdog and survey").** Analysis of session 01a15e5a: 5 min of brief before discovery, 15 s of real exploration (about 6 s a step: 3 s model, 3 s tool), then the hangs. Six reproductions (headless and with a visible window, deep logging) did not freeze the browser, so the cause is unknown; the logs show the call outliving its own session and `browser.close()` hanging, so the Chromium process itself was wedged. Done, 12 items: a deadline on every call with diagnose, kill and reopen; the 46 s stack of timeouts is one 8 s wait; the heartbeat and the panel name the call in flight; a deep browser log, a memory cap; a survey of the navigation done by the engine (2.2 s a page measured); a digest without repeated chrome; steps in one call; a fast cursor and a settle cap; the scout preset as the first look; a draft brief does not hold discovery up; a list that loads on scroll extends once. Also the Start window's switch to show the window in front and keep it open.

R3-11 [idea] (during the run) Project · Discovery · wanted: forget all earlier discovery runs and start again, to reset the memory of the project's discovery.
   **addressed (Forget discovery…).** Set aside, not deleted: a reset record with a time (`discovery-reset.json`); the project stops seeing sessions and discovery findings from before it; the report folder and the request list are moved aside; the earlier runs' history lines are marked outdated; the Director is told. Other projects of the same app keep their sessions. Refused while a session runs or a request waits.
R3-12 [bug, idea, ux] (during the run) Recording · the same safeguards as discovery; a visible browser on request; everything about a timed-out or interrupted action kept; the projected recording time on the Storyboard tab · wanted: as stated.
   **addressed (PR "recording watchdog").** A deadline on every step (three times its estimate plus 30 s; a wait its timeout plus 15 s), a frozen browser diagnosed, killed and replaced and the scene shot again without using a retry (`recording.maxStalls`), the screencast stop bounded, a process marker and a heap cap; interrupt, stall and failed scene each write `diagnostics/<kind>-N/` (README with a verdict, context, event tail, probes of what the browser still answers, page and aria, last frame, processes and stacks); the progress says when a step runs far past its estimate; the Recording tab's switch shows the browser window; the Storyboard tab shows the projected recording time against the target length, per scene and in total.

R3-13 [idea] (during the run) Hangs and stalls · the same safeguards everywhere, not only in discovery and recording.
   **addressed (PR "bounded runs").** ffmpeg/ffprobe/uv/say commands have deadlines (`media.toolTimeoutMin`) and are diagnosed and killed with their process tree (`<root>/diagnostics/process-*.txt`); the login probe, the login window, brand previews and overlay rendering launch marked browsers that close with a bound and are killed; the overlay and brand jobs have a deadline.

R3-14 [bug, ux, design] (during the run) Recording · a take that failed after its retries sets the Director going by itself, and it ends up exploring the app again (discovery) · wanted: no automatic Director turn on a failed take; instead ask, and let me add the recommendation. **Not acted on: stored for later.**
   What happened: a scene failed on its third attempt (`recording.maxRetriesPerScene` 2), the take was flagged failed, and the Director began a discovery session on its own.
   Why (read from the code, not reproduced): `demo_rec_record` ends a failed take with `rt.reportToAgent("[Operator] Recording failed: <error>. Evidence: takes/ (take.json, attempts.jsonl)")` (`src/tools/record.ts`); `reportToAgent` delivers with `triggerTurn: true`, so a Director turn starts without anyone asking. The message says what failed but not what to do, and the skill's only advice is "fix the storyboard (the user must re-approve), or ask the user" (`skills/demo-recording/SKILL.md`, Recording), so the Director investigates: it reopens the discovery browser to find a working target. That costs model tokens and browser time and changes the project's phase picture (a new discovery session, new findings) without a decision of yours. The same path exists for a failed edit (`src/tools/edit.ts`) and the other jobs that end with `reportToAgent`.
   What you want instead (your words, as understood): when a take fails after its retries, (1) nothing starts by itself; (2) the failed scene is flagged, and the Recording tab offers to **add a recommendation on that scene or step** that you complete yourself (the engine can prefill the evidence: the error, the step, the diagnosis verdict), and **sends that review back to the Director** as the next take's note; (3) alternatively it **asks whether to start the "autoheal"**, a Director-driven repair you start on purpose.
   Notes for when it is done: the quiet delivery exists (`rt.tellAgent`, as `quietReport` in `tools/tts.ts`): the Director can know about the failure without a turn starting; the question mechanism exists (`demo_rec_ask`, the engine's own questions such as "Start discovery now?" after a login, `question-flow.ts`) and is the way to ask; take notes with a scene and a moment exist (item 7: `take-note`, carried by "Request a new take"), a "recommendation" on a failed scene is one of those plus the evidence. "Autoheal" is not in the code or the docs yet: to define before building it (suggestion: a bounded Director run that may look at the failing step's target in the browser and propose a storyboard fix as a new DRAFT; it never records, approves or spends by itself, and it needs your Allow like any spend). To decide: whether the other failed jobs (edit, voice, render) get the same treatment (quiet report plus a question) or only recording.
