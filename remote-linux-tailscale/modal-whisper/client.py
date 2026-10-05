"""Called by ../whisper.js: transcribe one audio file on the deployed Modal app, print JSON.

    python client.py AUDIO_FILE [LANGUAGE]

The audio is cut into 5-minute pieces that run in parallel, one container each (see app.py).
"""
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import modal

PIECE_SECONDS = 300


def split(audio: str, out: Path) -> list[bytes]:
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y", "-i", audio, "-vn", "-ar", "16000", "-ac", "1",
         "-c:a", "libopus", "-b:a", "24k", "-f", "segment", "-segment_time", str(PIECE_SECONDS),
         str(out / "piece-%04d.ogg")],
        check=True,
    )
    return [p.read_bytes() for p in sorted(out.glob("piece-*.ogg"))]


def main() -> None:
    audio, language = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "he")
    start = time.time()
    with tempfile.TemporaryDirectory() as tmp:
        pieces = split(audio, Path(tmp))
    whisper = modal.Cls.from_name("vidsum-whisper", "Whisper")()
    results = list(whisper.transcribe.map(pieces, kwargs={"language": language}))  # keeps order
    print(json.dumps({
        "text": " ".join(r["text"] for r in results if r["text"]),
        "duration": sum(r["duration"] for r in results),
        "seconds": round(time.time() - start, 1),
        "pieces": len(pieces),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
