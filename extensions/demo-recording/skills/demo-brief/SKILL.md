---
name: demo-brief
description: Drafts and refines the brief (brief.md) for a demo-recording project — audience, stance, goal, length, must-show/must-avoid, voice — from whatever the user provides, asking only for what is missing. Use right after /demo new, when the user wants to change the brief, or before discovery if brief.md still has TODOs.
---

# Demo brief

The brief drives everything downstream: which use cases discovery hunts for,
the order and length of scenes, and the stance and density of the
voice-over. A vague brief produces a generic demo. Your job is to get to a
sharp brief quickly, without interrogating the user about things they already
told you.

## Process

1. **Read what exists.** Call `demo_rec_project` with `action: read_brief` and
   look at any files the user attached under the project's `context/` folder.
   Reuse everything the user has already said in this conversation.
2. **Draft first, then ask.** Fill every field you reasonably can and mark
   your guesses. Then ask only for the gaps and the guesses that matter most
   (audience, stance, goal, length). If a structured question tool is
   available (e.g. `ask_user_question`), use it with concrete options and a
   recommended choice. Ask at most 4 questions per round.
3. **Research only on request.** Use web search for the product or company
   only when the user explicitly asks for it. Never put private details from
   the app or brief into a search query.
4. **Save** the complete brief with `demo_rec_project` (`action: write_brief`)
   using the template below. Every save is versioned.
5. **Hand off:** summarize the brief in 3 lines and suggest running
   `/demo discover` (or ask whether to start discovery now).

## Template (keep the headings; tests and later slices read them)

```markdown
# Demo brief: <project>

- **App:** <name>
- **URL:** <base url>
- **Extra URLs:** <other entry points, e.g. admin or docs — space-separated, or "none">
- **Title:** <short demo title for the video's title card, ≤ 60 chars; ask for one, or propose one from the goal>
- **Subtitle:** <optional second line on the title card, ≤ 90 chars>
- **Persona:** <who watches, what they already know>
- **Depth:** poc | showcase | sales
- **Stance:** champion | evaluator | teacher (omit to use the depth default)
- **Goal / key message:** <the one thing the viewer should believe afterwards>
- **Target length:** <min–max, e.g. 3–4 min; omit to use the depth default>
- **Must show:** <features/flows that are non-negotiable>
- **Must avoid:** <areas, data, or claims to keep out>
- **Language:** English
- **Voice:** <ElevenLabs voice name, or "default">

## Background

<Product context, why this demo exists, competitive angle, known strengths
and weaknesses. For the evaluator stance, list what to scrutinize.>

## Notes for discovery

<Hints on where the interesting parts are, test accounts/data to use, things
that are slow or flaky.>
```

## Depth cheat-sheet

Depth is the kind of demo. It sets defaults the brief can override:

| Depth | Discovery & storyboard | Narration | Default stance | Default length | Annotations & findings |
|---|---|---|---|---|---|
| **poc** | depth over breadth, real edge cases, weaknesses become scenes | facts, numbers, honest limits | evaluator | 3–5 min | more callouts on evidence; weakness findings stay *auto* |
| **showcase** | the broadest tour of polished features | feature-forward, confident, neutral | teacher | 2–3 min | calm, few annotations |
| **sales** | few flows tied to outcomes, a before/after story, a closing value scene | benefits, the persona's pain → outcome, a call to action in the outro | champion | 60–90 s | chapter titles + callouts on outcomes; weakness findings default to *ignore* |

`Audience:` from older briefs is read as **Persona**. The panel's **Project**
tab edits these fields as a form; each save is a new brief version.

## Stance cheat-sheet

- **Champion:** customer-facing and persuasive. Lead with outcomes, show the
  best paths, no gaps.
- **Evaluator:** an honest POC. Show strengths *and* limits, quote real
  numbers, call out friction.
- **Teacher:** how-to. Show steps clearly and explain why each matters.
