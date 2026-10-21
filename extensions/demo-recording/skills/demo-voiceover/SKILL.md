---
name: demo-voiceover
description: Writes the voice-over for a recorded demo take — dense, opinionated, first-person narration written FROM THE ACTUAL RUN, anchored to on-screen events with [@mark] and quoting real page values — and handles the panel review of it. Use after a take is recorded (a [demo-recording] result arrived), when the user asks for narration or a voice-over, and for [demo-panel] voice-over review messages.
---

# Demo voice-over

**Say who is speaking (D144).** Start a block of your own text with your role once, e.g. `Voice writer:`, so the user can tell the
cast apart in the chat. Once per block, not on every line, and never inside an artifact you write (a storyboard, a script, a brief).
Messages from the engine arrive already labelled: `[demo-recording · Cutter]` is a report, `[demo-panel · You]` is the user acting in the panel.

You write what the viewer hears. The script is written from the **actual
take**, not from the storyboard: what was typed, what appeared, and the exact
numbers on screen. The editor bends the video to your narration. Anchors pin
phrases to events, and dead time is cut, so you write for the moment, not the
clock.

## Workflow

0. **Pending QA fixes.** The template (`demo_rec_vo template`) and `get` start with "Pending fixes for the voice-over" when the user accepted fixes
   from a QA for this stage. Take each into account in the draft; after `write`, settle each with `demo_rec_qa resolve` (`applied` + the
   version, or `dropped` + why) and say which in your reply.
1. `demo_rec_take analyze` (default: the latest complete take of the approved
   storyboard). Read every scene: marks with timestamps, **page text at each
   mark** (quote values from here), typed/improvised inputs, error toasts,
   dead time (cut), streaming content and on-screen motion. Look at the
   keyframes.
   - If a scene shows an **error toast** or looks wrong, tell the user before
     writing. A re-take may be better than narrating around it.
2. `demo_rec_take propose` the take you are writing for. **You cannot approve it:** only the user approves a recording, in the panel
   (Recording tab, "Approve & use"). Tell them so; the voice-over can only be approved after the recording is.
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
- **Depth sets the register** (brief `Depth:`; see the demo-brief skill):
  - **poc:** facts, numbers, honest limits.
  - **showcase:** feature-forward, neutral.
  - **sales:** the persona's pain → outcome, a call to action in `_outro`.

  **USE findings** (see `demo_rec_project context`) must be said in the
  narration of the scene that covers them. **IGNORE findings** are never
  mentioned.
- **The stance comes from the brief** (or the depth default):
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
- `<!-- confidence: 2 — why -->` inside a section is your own doubt about it
  (D77): a number you couldn't confirm on the page, a claim about an answer
  that may vary. 1–2 marks it low in the panel, 3 at most medium. Use it only
  where you doubt; it never raises a level.

## Timing hints

`[@mark +300ms]` / `[@mark -300ms]` (a sign, a number, `ms` or `s`; at most ±3000 ms) says the narration after the mark starts that long **after
(+) or before (−)** the mark's event. It is never spoken and changes no audio, so it costs no credits: only the edit and the render run again.
A hint states where you WANT the narration relative to the moment (a beat before the picture, a beat after); the QA compares what it hears with
the moment plus the hint. It does NOT correct a measured deviation: a QA finding "starts 400 ms after its moment" is not fixed by `-400ms` (the
finding would come back, now against a moved target). Fix it where the cause is: shorten the words before it, move the anchor to where the
words really land, or, if the offset is fine, accept it by writing it (`+400ms`). A bare `[@mark]` means on the moment. Anything else that looks like an anchor (`[@mark 300ms]`, `[@Mark]`) is an error: it would be spoken as words. The user also nudges
hints in the panel (the Voice over screen, under each anchor's picture).

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

The panel rates every section high / medium / low from measured signals: a
number not on the page, speech vs footage, missing `[@mark]`s, changes since
the base version, validation issues. Review messages and `demo_rec_vo`
results list the low ones first: fix those before the user has to.

**Voice direction (D82):** a `[demo-panel] … VOICE DIRECTION` message asks
you to rewrite version N as a **new complete version from the same take**,
with a stance, tone, length, focus and notes:

1. `demo_rec_vo get version=N`. It also shows the pending direction.
2. Rewrite the whole script in that direction:
   - **Length** "about 20 % shorter/longer": change the word count per
     section accordingly.
   - **"fit the footage"**: get each scene's speech close to its usable
     footage.
   - Keep every `[@mark]` valid and every quoted value real.
3. `demo_rec_vo write`. The version is stored as **based on vN**. The user sees
   a word diff in the Voice tab and approves it. In 2 lines, say what you
   changed.

`[demo-panel] Voice-over vN … APPROVED` means voice synthesis is unlocked, **not started**: `demo_rec_tts start` asks the
user to allow it (the estimate is in the request) and is refused until they do. Say what you wait for in one line and stop.

## Voice and edit (after approval)

1. `demo_rec_tts check` (free) shows which engine and voice will be used, and what the production line's
   voice-over would cost (cached vs billed characters, credits, money): your
   ElevenLabs voice by name, else OpenAI, else local Kokoro. If the user expects
   their own voice and the check says otherwise, tell them why (e.g. key not
   set, voice name not found) **before** synthesizing.
   The panel's **"Make the voice"** (the edit and a draft to watch follow by themselves) runs TTS, the edit and a draft
   render itself, after showing the user the cost. When you get a note that
   it started, **don't start them yourself**; wait for the edit report.
2. `demo_rec_tts start` (after the user's **Allow**; without it the tool answers NOT STARTED and files the request) synthesizes every section in the background. One
   engine is used for the whole video, and unchanged sections come from the
   cache. Wait for the `[demo-recording]` message; don't poll.
3. `demo_rec_edit start` runs the audio-led edit and renders per-scene videos
   plus the full video. The result message has sync stats per scene:
   - **"narrator waits"** means the video couldn't be shortened (typing,
     in-app video), so the narrator pauses. That's fine in small doses.
   - **"off-sync @mark +N ms"** means the narration before that anchor is too
     long for the footage. Shorten the text before the anchor (new VO version
     → re-approval → re-render; only changed sections are re-synthesized).
4. Report the output paths and anything off-sync to the user.
5. When the edit report says **"Next — Annotations"**, continue with the
   **demo-annotations** skill (suggest annotations for this edit) — unless it
   says the separate Annotation designer is already suggesting them.
