# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = ["faster-whisper>=1.1,<2"]
# ///
"""Word timestamps for synthesized speech — demo-recording alignment helper.

Usage: uv run align.py --audio in.wav [--model base.en] [--prompt-file script.txt]
Prints JSON: {"model": ..., "words": [{"w": "Headline", "s": 0.12, "e": 0.48}, ...]}
The script text is passed as the initial prompt (vocabulary hint); mapping the
recognized words back onto the script is done in TypeScript (src/align/align.ts).
Models are cached by huggingface_hub (~/.cache/huggingface).
"""

import argparse
import json
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--model", default="base.en")
    ap.add_argument("--prompt-file")
    args = ap.parse_args()

    from faster_whisper import WhisperModel

    model = WhisperModel(args.model, device="cpu", compute_type="int8")
    prompt = Path(args.prompt_file).read_text(encoding="utf-8")[:800] if args.prompt_file else None
    segments, _info = model.transcribe(
        args.audio,
        language="en",
        word_timestamps=True,
        vad_filter=False,
        beam_size=5,
        initial_prompt=prompt,
        # Whisper tends to loop/repeat the prompt into trailing silence; these suppress it.
        condition_on_previous_text=False,
        hallucination_silence_threshold=0.5,
    )
    words = []
    for seg in segments:
        for w in seg.words or []:
            words.append({"w": w.word.strip(), "s": round(w.start, 3), "e": round(w.end, 3)})
    print(json.dumps({"model": args.model, "words": words}))


if __name__ == "__main__":
    main()
