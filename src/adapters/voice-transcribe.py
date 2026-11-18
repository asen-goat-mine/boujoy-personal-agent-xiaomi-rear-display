"""Trusted local-only inference entry point; input is already decoded PCM WAV."""
import json
import os
import sys
import wave
import numpy as np

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
from faster_whisper import WhisperModel

request = json.load(sys.stdin)
model = WhisperModel(request["model"], device="cpu", compute_type="int8",
                     cpu_threads=4, num_workers=1, local_files_only=True)
with wave.open(request["file"], "rb") as source:
    if source.getnchannels() != 1 or source.getsampwidth() != 2 or source.getframerate() != 16000:
        raise ValueError("Expected decoded 16 kHz mono PCM")
    audio = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
segments, info = model.transcribe(audio, language=request.get("language") or None,
                                 beam_size=1, condition_on_previous_text=False,
                                 vad_filter=True, word_timestamps=False)
rows = [{"start": round(segment.start, 3), "end": round(segment.end, 3), "text": segment.text.strip()}
        for segment in segments]
print(json.dumps({"text": "".join(row["text"] for row in rows), "language": info.language,
                  "duration": round(info.duration, 3), "segments": rows,
                  "localOnly": True, "method": "faster-whisper-small-int8"}, ensure_ascii=False))
