---
name: demo-voiceover
description: Writes the voice-over for a recorded demo take — dense, opinionated, first-person narration written FROM THE ACTUAL RUN, anchored to on-screen events with [@mark] and quoting real page values — and handles the panel review of it. Use after a take is recorded (a [demo-recording] result arrived), when the user asks for narration or a voice-over, and for [demo-panel] voice-over review messages.
---

# Demo voice-over

You write what the viewer hears. The script is written from the **actual
take**, not from the storyboard: what was typed, what appeared, and the exact
numbers on screen. The editor bends the video to your narration. Anchors pin
phrases to events, and dead time is cut, so you write for the moment, not the
clock.

## Workflow

1. `demo_rec_take analyze` (default: the latest complete take of the approved
   storyboard). Read every scene: marks with timestamps, **page text at each
   mark** (quote values from here), typed/improvised inputs, error toasts,
   dead time (cut), streaming content and on-screen motion. Look at the
   keyframes.
   - If a scene shows an **error toast** or looks wrong, tell the user before
     writing. A re-take may be better than narrating around it.
2. `demo_rec_take accept` the take you are writing for.
3. Read the brief (`demo_rec_project read_brief`): audience, **stance**, goal,
   must-show and must-avoid.
4. `demo_rec_vo template` gives the skeleton with each scene's marks and word
   budget. Fill it in and `demo_rec_vo write` it.
5. Fix every ERROR the tool reports. Take WARNINGS seriously (timing, filler).
6. Tell the user in 2–3 lines what the narrative is, then **stop and wait**
   for the panel review.

## Voice and style (D18)

- **First person, expert guide.** You're a practitioner showing a colleague
  something worth their time: "I'll ask it directly", not "the user can".
- **The stance comes from the brief:**
  - **Champion:** outcomes first, confident, no hedging. Still concrete, never
    salesy.
  - **Evaluator:** strengths *and* limits. Name friction plainly ("the
    drill-down is thinner") and quote the evidence.
  - **Teacher:** what to do and *why*, step by step, calm.
- **Dense:** ~155 words per minute, zero filler. Every sentence either orients,
  reveals, or interprets. Cut "as you can see", "let's go ahead and",
  "basically", "simply".
- **One takeaway per scene.** Usually it's the storyboard's `takeaway`, now
  stated with the real numbers.
- **Opinionated:** say what a number *means* ("EMEA is the outlier at 14.2 %,
  six times North America"), not just what it is.
- **No marketing words:** seamless, powerful, robust, cutting-edge,
  revolutionary, game-changer, leverage, unlock, supercharge… The tool warns
  about these.
- **Numbers are said as they're shown:** "14.2 %", "$4.82M". The voice engine
  reads them naturally. Never invent a value. Quote it from the page text at
  a mark, or bind it.

## Format

```markdown
---
take: take-003
---
## _intro
Churn looks fine on this dashboard. Split it by region and it isn't.

## 01-dashboard — Where churn hides
Headline churn is 3.1 percent, up four tenths. Nothing alarming. [@emea-bar]
Until the regional chart: EMEA sits at 14.2 percent, six times North America.

## _bridge:02-search
So instead of building a report, I'll just ask.

## 02-search — Ask in plain language
Natural-language search. [@type-start] Churn by region, nothing more.
[@results-visible] It gets the grouping right first try, and EMEA leads at
{{dom:results-visible|EMEA\s+([\d.]+%)}}.

## _outro
Two questions, and the regional churn problem is on the table.
```

- `## <scene-id>` sections, one per scene (the title after ` — ` is
  optional). A scene without a section is silent.
- `[@mark]` means the following phrase **starts when that event happens**. Put
  an anchor right before the words that describe the moment: results
  appearing, a value revealed, an answer streaming in. Anchors must follow the
  take's order within the scene. Text before the first anchor starts with the
  scene.
- Don't anchor every mark. Anchor the 1–3 moments per scene where sync
  matters.
- `{{dom:<mark>|<regex>}}` takes a value from the page text at that mark
  (capture group 1). Use it when exactness matters and the value might change
  between takes. Plain literals are fine for stable values.
- `_intro`, `_outro`, `_bridge:<scene-id>` play **only in the full video**.
  Per-scene videos stay self-contained, so each scene section must make sense
  on its own.
- `<!-- comments -->` are notes and are never spoken.

## Timing

- The template shows each scene's **usable footage** (dead time removed) and a
  word budget (~2.4 words per second). Stay at or a little under it.
- More words than footage means the editor freezes frames, so keep it within
  ~1.3×. Much less means long silences. Fine in short bursts, but say
  something during long waits for streamed answers.
- During **streaming content** (a chat answer arriving), narrate what is
  arriving. Don't talk over the payoff with unrelated context.
- **Typing is never sped up.** Describing the query while it's typed works
  well.

## Review loop

A `[demo-panel] Voice-over vN review` message lists sections as APPROVED,
CHANGES or RE-RUN, with notes:

- **CHANGES:** rewrite that section as asked. Keep approved sections exactly
  as they are.
- **RE-RUN:** re-read that scene in `demo_rec_take analyze` and rewrite it from
  the evidence.
- The user can also edit a section inline in the panel. That creates a new
  version by itself. Read it (`demo_rec_vo get`) before your next write so you
  don't overwrite their edit.

`[demo-panel] Voice-over vN … APPROVED` means voice synthesis is unlocked
(next slice steps: voice and edit).
