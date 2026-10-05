"""Called by ../whisper.js: send one audio file to the deployed Modal app, print JSON.

    uv run python client.py AUDIO_FILE [LANGUAGE]
"""
import json
import sys

import modal


def main() -> None:
    path, language = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "he")
    with open(path, "rb") as f:
        audio = f.read()
    whisper = modal.Cls.from_name("vidsum-whisper", "Whisper")()
    result = whisper.transcribe.remote(audio, language)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
