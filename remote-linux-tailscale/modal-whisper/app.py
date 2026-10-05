"""Whisper on a Modal GPU, for vidsum videos with no captions (see ../whisper.js).

The GPU container exists only while a call runs (plus a short idle window), so this costs
nothing when unused; Modal's free Starter credit covers it. Deploy (once, and after edits):

    uv run modal deploy app.py

Hebrew uses ivrit-ai's fine-tune of large-v3-turbo (much better on Hebrew lectures); any other
language uses the standard large-v3-turbo. Both are baked into the image, so a cold start
does not download them.
"""
import modal

HEBREW_MODEL = "ivrit-ai/whisper-large-v3-turbo-ct2"
OTHER_MODEL = "mobiuslabsgmbh/faster-whisper-large-v3-turbo"
MODEL_DIR = "/models"


def _download():
    from huggingface_hub import snapshot_download
    for repo in (HEBREW_MODEL, OTHER_MODEL):
        snapshot_download(repo, local_dir=f"{MODEL_DIR}/{repo.replace('/', '--')}")


image = (
    modal.Image.from_registry("nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04", add_python="3.11")
    .apt_install("ffmpeg")
    .pip_install("faster-whisper==1.1.1", "huggingface_hub[hf_transfer]")
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1"})
    .run_function(_download)
)

app = modal.App("vidsum-whisper", image=image)


@app.cls(gpu="T4", timeout=3600, scaledown_window=60, max_containers=1)
class Whisper:
    @modal.enter()
    def load(self):
        from faster_whisper import WhisperModel
        self.models = {
            repo: WhisperModel(f"{MODEL_DIR}/{repo.replace('/', '--')}", device="cuda", compute_type="float16")
            for repo in (HEBREW_MODEL, OTHER_MODEL)
        }

    @modal.method()
    def transcribe(self, audio: bytes, language: str = "he") -> dict:
        import tempfile
        import time
        start = time.time()
        model = self.models[HEBREW_MODEL if language == "he" else OTHER_MODEL]
        with tempfile.NamedTemporaryFile(suffix=".audio") as f:
            f.write(audio)
            f.flush()
            segments, info = model.transcribe(
                f.name, language=language or None, beam_size=5, vad_filter=True,
                condition_on_previous_text=False,  # long lectures: stops one bad segment repeating
            )
            text = " ".join(s.text.strip() for s in segments)
        return {"text": text, "language": info.language, "duration": info.duration,
                "seconds": round(time.time() - start, 1)}
