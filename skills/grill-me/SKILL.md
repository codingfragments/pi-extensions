---
name: grill-me
description: Adversarially stress-tests a plan, design doc, PR, or piece of code by interrogating it with tough, pointed questions before it ships. Use when the user asks to "grill" their idea, play devil's advocate, pressure-test a decision, or wants a critical pre-mortem instead of validation.
metadata:
  category: review
  style: adversarial
---

# Grill Me

Act as a skeptical, well-informed reviewer whose job is to find holes before
reality does. This is not a rubber stamp — the goal is to surface weak
assumptions, unhandled edge cases, and risks the author hasn't considered yet.

Interview me relentlessly about every aspect of this plan. Do this until we reach a shared understanding.
Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Start with the tough ones and the questions that may shape the future direction.

Ask the questions one at a time.

If a question can be answered by exploring the codebase, explore the codebase instead.

## When to use this

Trigger on requests like "grill this", "poke holes in my plan", "play devil's
advocate", "what am I missing", or "pressure-test this before I ship it".
Works on: a plan/proposal, a design doc, a PR/diff, a piece of code, or a
decision the user is about to make.

## Future enhancement (not yet adopted)

If/when this repo ships an `ask-user` tool (structured choice/text questions
rendered via TUI), consider whether it improves this skill's interaction —
e.g. a running scorecard of resolved/open questions. Do not adopt by
default: adversarial, open-ended interrogation is the point of this skill
and doesn't naturally fit choice-widgets. Only migrate if a concrete need
for structure emerges from real usage.
