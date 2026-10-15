#!/usr/bin/env fish
# demo-recording — a guided run of the whole pipeline on the bundled Acme Pulse
# fixture, ending in the panel. A local end-to-end check (not for CI: it needs
# Playwright Chromium, ffmpeg and the macOS `say` voice).
#
#   recording → voice-over (say) → sync edit + its draft → annotations (stub
#   designer, no model) → draft with annotations → final refused → accept →
#   final with burned-in subtitles → callouts-only cut → reuse → tests → panel
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

step "1/8  fixture project: record, voice-over, edit + its draft render v1 (~1 min)"
node "$CLI" fixture-demo; or bail $argv

step "2/8  stub designer -> annotations v1 (expect: 12 placed, 6 enabled, balanced)"
node "$CLI" annotate suggest --project "$PROJ" --file "$STUB"; or bail $argv

step "3/8  draft render v2 with annotations v1 (960x540, DRAFT tag, ~8 s)"
node "$CLI" render --project "$PROJ" --annotations 1; or bail $argv

step "4/8  a final is refused until annotations are accepted"
node "$CLI" render --project "$PROJ" --kind final
echo "(expected: 'a final render needs an accepted annotation version')"

step "5/8  accept annotations v1, then final render v3 with burned-in subtitles (~25 s)"
node "$CLI" accept --project "$PROJ" --stage annotations --version 1; or bail $argv
node "$CLI" render --project "$PROJ" --kind final --subtitles; or bail $argv
ls "$OUT/v3/neutral" "$OUT/v3/neutral/scenes"

step "6/8  final v4: callouts only (another cut of the same annotations); v5: same as v3 -> reused"
node "$CLI" render --project "$PROJ" --kind final --types callout; or bail $argv
node "$CLI" render --project "$PROJ" --kind final --subtitles | grep -E "reused|Final"

step "7/8  watch: draft v2, final v3 (subtitled), callouts-only v4"
if test (uname) = Darwin
    open "$OUT/v2/neutral/full.mp4"
    open "$OUT/v3/neutral/full.subtitled.mp4"
    open "$OUT/v4/neutral+a-callout/full.mp4"
else
    echo "videos: $OUT/v2/neutral/full.mp4  $OUT/v3/neutral/full.subtitled.mp4  $OUT/v4/neutral+a-callout/full.mp4"
end
echo "transcript: $OUT/v3/neutral/full.vtt"

step "8/8  automated tests (~1 min, expect 34 pass)"
env DEMO_REC_E2E=1 node --test "$TESTS/s5-render.test.ts" "$TESTS/s5-annotations.test.ts" "$TESTS/s5-annotations-stage.test.ts" "$TESTS/s5-annotations-panel.test.ts" 2>&1 | grep -E '^ℹ (tests|pass|fail)'

if contains -- --no-pi $argv
    echo
    echo "skipped pi (--no-pi)"
else
    step "panel: in pi run /demo open fixture-demo, then /demo panel; quit pi to finish"
    pi
end

cleanup $argv
