# Confidence-guided review and voice direction

Two review aids (S5 part 11, D76–D84):

- **Confidence** tells you which storyboard scenes, voice-over sections and
  annotations need your eyes, and why.
- **Voice direction** lets you steer the whole narrative and pay only for what
  changed.

---

## Confidence (D76–D81)

Every review item gets a level, **high**, **medium** or **low**, with the
reasons listed on the card. The level comes from **measured signals**, and the
worst signal wins:

| Item | low | medium |
|---|---|---|
| **Storyboard scene** | a target never seen in discovery · a `css` target · the scene failed or was retried in a take · an improvised input without a fallback | new or changed since the previous version · an improvised input · no `deep_link` (a failure can't be re-shot safely) · no screen thumbnail |
| **Voice-over section** | a validation error · a number the page never shows in that scene · speech vs footage > 1.15 or < 0.5 | a warning · new or changed vs the base version · speech a bit longer than the footage (ratio 1.0–1.15) · a name not on the page · a scene section without any `[@mark]` |
| **Annotation** | a redaction (privacy always needs your eyes) · a fixed box target · it can't be placed | found by its text (no layout ref) · callout or chapter wording · new since the base version |

An item with none of these signals is **high**.

**The agent's view.** The agent can add its own doubt to an item:
- in a storyboard scene: `confidence: {score: 2, why: …}`;
- in a VO section: `<!-- confidence: 2 — why -->`;
- on an annotation suggestion: `confidence`.

It shows as a reason ("the agent rates it 2/5: …"). It can only **lower** the
level: 1–2 → low, 3 → at most medium. A 5/5 never makes a risky item high.

**Carry-over (D79).** An item unchanged since a version where you approved it
is high, with the reason "unchanged since vN, where you approved it". It is
shown as one line, but it stays unmarked in the new version's review.

"Unchanged" ignores the agent's own confidence field and whitespace.

### In the panel

The **Storyboard**, **Voice over** and **Annotations** tabs show:

- **a badge per card** (`● low`) with the reasons as a tooltip. The reasons
  for medium and low items are also listed on the card;
- **"N need your eyes"** in the header, with a chip per item, lowest first. A
  click jumps to the item;
- **riskiest first**: sorts the cards lowest first. Story order is the default;
- **collapse high**: shows high items as one line. Carried-over items are
  always one line; "show ▾" opens one.

**Approve high-confidence…** (Storyboard and Voice over only, D80):

- A popup lists what it approves (every unmarked high item), what it skips
  (medium/low, with the first reason) and your own marks, which stay as they
  are.
- One click applies it: the items are marked **approved** in the review.
- Accepting the version stays a separate click.

Annotations have no per-item review, so they get badges, the chips and the
sort, but no bulk action.

### For the agent

- `demo_rec_storyboard write|get` and `demo_rec_vo write|get` print the
  confidence lowest first, so the agent can fix low items before you read
  them.
- Review messages from the panel append the items that need eyes.
- The storyboard's "never seen in discovery" check runs when the storyboard
  is written, while discovery is open, and is stored in
  `storyboard/vN.checks.json`.

---

## Voice direction (D82–D84)

The **Direction** box in the Voice over tab steers the whole narrative:

- **Stance:** champion · evaluator · teacher (prefilled from the brief);
- **Tone:** calm · energetic · conversational · crisp;
- **Length:** −20 % · same · +20 % · fit footage;
- **Focus** and **Notes:** free text.

**Draft new version:**

- The panel stores the direction as pending (`vo/direction.pending.json`) and
  records it as an input (kind `nudge`).
- The agent gets a message to rewrite the version as a **new complete
  version from the same take**.
- The agent's next version consumes the pending direction and records its
  **base** (`vo/script.vN.meta.json`).
- "Save as the project's default direction" writes the brief's
  **Voice direction** field (a new brief version). The box is prefilled from
  it next time.

An inline section edit in the panel is based on the version it edits. It
never consumes a pending direction.

### What changed (D83)

A version with a base, or any other version picked with **compare with**,
shows:
- **"re-directed from v1: changed N of M sections"**;
- an **inline word diff** per section (green insertions, struck-through
  deletions).

Unchanged high-confidence sections collapse to one line. Untick
**show changes** for the plain script.

### Generate voice, edit and a draft to watch (D84)

On the **accepted** voice-over that is on the working line, **Generate voice, edit and a draft to watch…** opens a cost estimate first. It is free: it only checks the engine,
nothing is synthesized. The estimate shows:

- the engine, voice and model;
- sections **to synthesize** vs **cached** (cached audio is free);
- characters, and for ElevenLabs **credits** (flash/turbo models bill 0.5
  credit per character);
- money: credits (or characters) / 1000 × `tts.pricePer1kChars.<engine>`, in
  `tts.currency`.

**Generate** then runs the voice, the sync edit and a draft render as engine
jobs. There is no agent turn, and progress shows in Live. The agent gets a
quiet note, then the usual edit report, and continues with annotations.

Default prices are list prices; check your plan and set your own in ⚙ Config:

| Key | Default | Unit |
|---|---|---|
| `tts.pricePer1kChars.elevenlabs` | 0.22 | per 1,000 credits (≈ Creator plan) |
| `tts.pricePer1kChars.openai` | 0.015 | per 1,000 characters |
| `tts.pricePer1kChars.kokoro` / `.say` | 0 | free, local |
| `tts.currency` | `$` | symbol |
