# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = ["kokoro-onnx>=0.4,<0.6", "soundfile>=0.12"]
# ///
"""Local TTS via Kokoro (kokoro-onnx, Apache-2.0) — demo-recording offline fallback.

Usage: uv run kokoro_tts.py --text-file in.txt --out out.wav [--voice am_michael] [--speed 1.0]
Models are downloaded once to $DEMO_REC_CACHE/kokoro (default ~/.cache/demo-recording/kokoro).
Prints one JSON line: {"duration": seconds, "sample_rate": 24000, "voice": ...}
"""

import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path

BASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
FILES = {"model": "kokoro-v1.0.int8.onnx", "voices": "voices-v1.0.bin"}


def cache_dir() -> Path:
    root = os.environ.get("DEMO_REC_CACHE") or os.path.join(Path.home(), ".cache", "demo-recording")
    d = Path(root) / "kokoro"
    d.mkdir(parents=True, exist_ok=True)
    return d


def ensure(name: str) -> Path:
    target = cache_dir() / name
    if not target.exists():
        tmp = target.with_suffix(target.suffix + ".part")
        print(f"downloading {name} …", file=sys.stderr)
        urllib.request.urlretrieve(f"{BASE}/{name}", tmp)
        tmp.rename(target)
    return target


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--text-file", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--voice", default="am_michael")
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--lang", default="en-us")
    args = ap.parse_args()

    import soundfile as sf
    from kokoro_onnx import Kokoro

    kokoro = Kokoro(str(ensure(FILES["model"])), str(ensure(FILES["voices"])))
    text = Path(args.text_file).read_text(encoding="utf-8")
    samples, sr = kokoro.create(text, voice=args.voice, speed=args.speed, lang=args.lang)
    sf.write(args.out, samples, sr, subtype="PCM_16")
    print(json.dumps({"duration": round(len(samples) / sr, 3), "sample_rate": sr, "voice": args.voice}))


if __name__ == "__main__":
    main()
