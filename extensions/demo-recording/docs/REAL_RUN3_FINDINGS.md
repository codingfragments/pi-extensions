# Real-app run 3: findings and ideas (collected, not acted on)

The ideas and findings of the third real-app run (work package 13 of [RUNNING_PLAN.md](RUNNING_PLAN.md)), collected the way the first two runs' were
([REAL_RUN_FINDINGS.md](REAL_RUN_FINDINGS.md), [REAL_RUN2_FINDINGS.md](REAL_RUN2_FINDINGS.md)): **nothing here is acted on until the user says the
collecting is over**, and then the items are grouped into phases with the user. Items are numbered R3-1, R3-2, ... in the order they were given. Ideas raised
before the run started are marked "before the run".

Kinds: bug, ux, idea, design, policy, cost, praise, question. "Not acted on" means exactly that.

R3-1 [ux, idea] (before the run) Storyboard · the scene's picture on the LEFT of the main area, and everything written (the takeaway, the emphasis, the narration outline,
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
