"""Whisper on Modal, for vidsum videos with no captions (see ../whisper.js).

CPU, not GPU: Modal only runs GPU functions for accounts with a payment method, and this one
stays free (Starter credit, no card). One 8-core container is about real time, so client.py cuts
the audio into 5-minute pieces and they all run at once, each in its own container. Containers
exist only while a call runs (plus a short idle window), so nothing is spent when unused.
Deploy (once, and after edits):

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
    .pip_install("faster-whisper==1.1.1", "requests", "huggingface_hub")
    .run_function(_download)
)

app = modal.App("vidsum-whisper", image=image)


@app.cls(cpu=8, memory=4096, timeout=1800, scaledown_window=30, max_containers=30)
class Whisper:
    models: dict = {}

    def model(self, repo: str):
        if repo not in self.models:  # load only the model this language needs
            from faster_whisper import WhisperModel
            self.models[repo] = WhisperModel(f"{MODEL_DIR}/{repo.replace('/', '--')}", device="cpu",
                                             compute_type="int8", cpu_threads=8)
        return self.models[repo]

    @modal.method()
    def transcribe(self, audio: bytes, language: str = "he") -> dict:
        import tempfile
        import time
        start = time.time()
        model = self.model(HEBREW_MODEL if language == "he" else OTHER_MODEL)
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
