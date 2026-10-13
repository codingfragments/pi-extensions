# demo-recording skills

Skills ship inside the extension and are registered via `resources_discover`
in `../index.ts`. They are added slice by slice (see
[../docs/IMPLEMENTATION_PLAN.md](../docs/IMPLEMENTATION_PLAN.md)):

| Skill | Purpose | Slice |
|---|---|---|
| [`demo-brief/`](demo-brief/SKILL.md) | Draft `brief.md` from free-form input, ask for gaps, web search only on request | S2 ✅ |
| [`demo-recording/`](demo-recording/SKILL.md) | Director's playbook: discovery, demo-worthiness, human-like flow, storyboard format, review loop, recording | S2 ✅ |
| [`demo-voiceover/`](demo-voiceover/SKILL.md) | VO from the actual take: stance/density/style rules, `[@mark]` anchors, `{{dom:…}}` value bindings, full-video intro/bridges/outro, review loop | S4 ✅ |
