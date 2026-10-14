# demo-recording — future ideas

Ideas that came up while designing and are explicitly **not** in scope yet.
Each one names where it came from, so it can be picked up with its context.

| Idea | Origin | Notes |
|---|---|---|
| **Full annotation editor** | Annotation grill (D37) | Draw or move regions, add your own annotations from scratch, change the zoom factor, free timing on a timeline track. v1 keeps to toggles, text edits, ±0.5 s nudges and choosing between suggested zoom targets. |
| **Flexible stage lineage** | Annotation grill (D30) | Beyond the strict chain: render any combination of versions side by side (e.g. two narration styles with the same annotations), or a full version tree in the panel. |
| **Cursor frame-locking** | S5 grill (D28) | Only if cursor unevenness is still noticed in real takes. |
| **Background music** | S5 grill (D28) | Out of v1. |
| **Parallel discovery lanes** | User request, after S5 part 3 | **Moved into the plan as slice S6** ([IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md#s6--parallel-discovery-lanes-user-request-opt-in-discoverylanes)). |
| **Lineage map view + navigation** | Branching-stages discussion (D44–D46) | **View:** the whole project as a tree: storyboard versions → takes → voice-overs → annotation versions → renders, each node showing its state (accepted, draft, orphaned, final) and the current **working line** highlighted.<br>**Navigation:** clicking a node selects it as the working line (ancestors follow, descendants re-pick their most recently accepted child) and jumps to its stage tab. Hover shows lineage, dates and who/what produced it (input-log entries). Collapsing old or unaccepted branches keeps it readable.<br>**Actions in place:** accept/un-accept, compare two branches side by side (e.g. two voice-overs on different takes), and "render this line".<br>**Until then:** the stage tabs' input pickers list each accepted input with its lineage. |
