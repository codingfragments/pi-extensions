#!/usr/bin/env fish
# demo-recording — a guided run of the whole pipeline on the bundled Acme Pulse
# fixture, ending in the panel. A local end-to-end check (not for CI: it needs
# Playwright Chromium, ffmpeg and the macOS `say` voice).
#
#   recording → voice-over (say) → sync edit + its draft → annotations (stub
#   designer, no model) → draft with annotations → final refused → accept →
#   final with burned-in subtitles → QA + accept the deliverable → callouts-only
#   cut → reuse → tests → panel
#
# Usage (from anywhere; runs on the branch you have checked out):
#   fish extensions/demo-recording/scripts/fixture-walkthrough.fish [--no-pi] [--keep]
#     --no-pi   skip the interactive pi/panel step at the end
#     --keep    keep the temp workspace (its path is printed) instead of deleting it
#
# Uses a temp workspace: ~/DemoRecordings and your config are never touched.

function step
    echo
    set_color --bold cyan
    echo "=== $argv"
    set_color normal
end

# The repo root, from this script's location (…/extensions/demo-recording/scripts/).
set -g SCRIPT_DIR (path dirname (path resolve (status filename)))
set -g REPO (path resolve "$SCRIPT_DIR/../../..")
cd "$REPO"; or bail $argv
echo "repo: $REPO ($(git branch --show-current 2>/dev/null))"

set -gx DEMO_REC_ROOT (mktemp -d)
echo '{}' >"$DEMO_REC_ROOT/none.json"
set -gx DEMO_REC_CONFIG "$DEMO_REC_ROOT/none.json"
set -gx DEMO_REC_NO_OPEN 1
set -gx DEMO_REC_TTS_CHAIN say

set -g CLI extensions/demo-recording/cli.ts
set -g STUB extensions/demo-recording/fixtures/annotations/stub-designer.json
set -g PROJ fixture-demo
set -g TESTS extensions/demo-recording/test
set -g OUT "$DEMO_REC_ROOT/projects/$PROJ/render"

function cleanup
    if contains -- --keep $argv
        echo
        echo "workspace kept: $DEMO_REC_ROOT"
        echo "  (set -gx DEMO_REC_ROOT $DEMO_REC_ROOT; set -gx DEMO_REC_CONFIG $DEMO_REC_CONFIG — to keep using it)"
    else
        rm -rf "$DEMO_REC_ROOT"
        echo
        echo "temp workspace removed"
    end
end

function bail
    set_color red
    echo "✖ step failed"
    set_color normal
    cleanup $argv
    exit 1
end

echo "temp workspace: $DEMO_REC_ROOT"

step "1/9  fixture project: record, voice-over, edit + its draft render v1 (~1 min)"
node "$CLI" fixture-demo; or bail $argv

step "2/9  stub designer -> annotations v1 (expect: 12 placed, 6 enabled, balanced)"
node "$CLI" annotate suggest --project "$PROJ" --file "$STUB"; or bail $argv

step "3/9  draft render v2 with annotations v1 (960x540, DRAFT tag, ~8 s)"
node "$CLI" render --project "$PROJ" --annotations 1; or bail $argv

step "4/9  a final is refused until annotations are accepted"
node "$CLI" render --project "$PROJ" --kind final
echo "(expected: 'a final render needs an accepted annotation version')"

step "5/9  accept annotations v1, then final render v3 with burned-in subtitles (~25 s)"
node "$CLI" accept --project "$PROJ" --stage annotations --version 1; or bail $argv
node "$CLI" render --project "$PROJ" --kind final --subtitles; or bail $argv
ls "$OUT/v3/neutral" "$OUT/v3/neutral/scenes"

step "6/9  QA of final v3 (automatic after every final) — then accept it as the deliverable"
node "$CLI" qa --project "$PROJ" --version 3
node "$CLI" accept --project "$PROJ" --stage render --version 3; or echo "(QA blocks — fix with: qa --version 3 --fix all, or confirm items)"

step "7/9  final v4: callouts only (another cut of the same annotations); v5: same as v3 -> reused"
node "$CLI" render --project "$PROJ" --kind final --types callout; or bail $argv
node "$CLI" render --project "$PROJ" --kind final --subtitles | grep -E "reused|Final"

step "8/9  watch: draft v2, final v3 (subtitled), callouts-only v4"
if test (uname) = Darwin
    open "$OUT/v2/neutral/$PROJ"_draft-v2_neutral.mp4
    open "$OUT/v3/neutral/$PROJ"_final-v3_neutral_subtitled.mp4
    open "$OUT/v4/neutral_callouts-only/$PROJ"_final-v4_neutral_callouts-only.mp4
else
    echo "videos: $OUT/v2/neutral/ $OUT/v3/neutral/ $OUT/v4/neutral_callouts-only/"
end
echo "transcript: $OUT/v3/neutral/$PROJ"_final-v3_neutral_transcript.vtt

step "9/9  automated tests (~1 min, expect 42 pass)"
env DEMO_REC_E2E=1 node --test "$TESTS/s5-qa.test.ts" "$TESTS/s5-render.test.ts" "$TESTS/s5-annotations.test.ts" "$TESTS/s5-annotations-stage.test.ts" "$TESTS/s5-annotations-panel.test.ts" 2>&1 | grep -E '^ℹ (tests|pass|fail)'

if contains -- --no-pi $argv
    echo
    echo "skipped pi (--no-pi)"
else
    step "panel: in pi run /demo open fixture-demo, then /demo panel; quit pi to finish"
    # DEMO_REC_NO_OPEN keeps the CLI steps from opening windows; pi must not inherit it,
    # or /demo panel won't open the browser.
    env -u DEMO_REC_NO_OPEN pi
end

cleanup $argv
