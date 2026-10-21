// What happens on the Voice over screen, in order (D146, R3-6): approving the script is free (the Director then asks to make the voice); the voice is its own step and uses
// credits; the edit and a draft follow by themselves; the annotations are suggested by themselves. Pure, so a test can import it without the panel's modules.

/**
 * The steps of the voice-over, each with a state: "done", "next" (the first one not done) or "later".
 * `approved`: the script is approved. `voiced`: a voice exists for it. `autoSuggest`: the designer starts by itself after the edit.
 */
export function voiceSteps({ approved, voiced, autoSuggest = true }) {
  const steps = [
    {
      key: "approve",
      title: "Approve the script",
      detail: "free; the Director then asks to make the voice",
      done: !!approved,
    },
    {
      key: "voice",
      title: "Make the voice",
      detail: "uses voice credits: you see the cost and press Allow",
      done: !!voiced,
    },
    {
      key: "edit",
      title: "The sync edit and a draft to watch",
      detail: "follows by itself; local, no model, no credits",
      done: false,
    },
    {
      key: "annotations",
      title: "Annotations are suggested",
      detail: autoSuggest
        ? "by themselves, after the edit (a model call; turn it off with annotations.autoSuggest)"
        : "you ask for them in the Annotations tab (annotations.autoSuggest is off)",
      done: false,
    },
  ];
  // the first two are decided by what exists; the last two follow the voice, so they are "next" only once the voice is there
  const firstOpen = steps.findIndex((s) => !s.done);
  return steps.map((s, i) => ({
    ...s,
    state: s.done ? "done" : i === firstOpen ? "next" : "later",
  }));
}
