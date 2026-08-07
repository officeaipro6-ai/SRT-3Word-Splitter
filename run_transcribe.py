import os
import sys
from pathlib import Path

# Candidate paths for the ODIA test file.
CANDIDATES = [
    Path(r"C:\Users\sures\Downloads\ODIA_MP3-1.mp3"),
    Path(r"C:\Users\sures\Downloads\ODIA_MP3-1.mpeg"),
    Path(r"C:\Users\sures\Videos\ODIA_MP3-1.mp3"),
]

INPUT = None
for candidate in CANDIDATES:
    if candidate.exists():
        INPUT = candidate
        break

if INPUT is None:
    print("No test input file found in expected locations.")
    for candidate in CANDIDATES:
        print("  checked:", candidate)
    sys.exit(2)

# Prefer local workspace module
sys.path.insert(0, str(Path(__file__).resolve().parent))

import main

print("Preparing audio...")
try:
    audio_path = main.prepare_audio_path(Path(INPUT))
    print("Audio prepared:", audio_path)
except Exception as exc:
    print("prepare_audio_path failed:", exc)
    raise

print("Transcribing (this may download model weights if needed)...")
try:
    # Force Odia to auto-detect by passing None
    generated, language = main.transcribe_audio(Path(audio_path), language_hint=None, preview_callback=print)
    print("Transcription finished. Detected language:", language)
except Exception as exc:
    print("transcribe_audio failed:", exc)
    raise

# Save SRT next to input
srt_path = Path(INPUT).with_suffix('.srt')
try:
    with open(srt_path, 'w', encoding='utf-8') as f:
        f.write(generated)
    print("SRT saved to:", srt_path)
except Exception as exc:
    print("Failed to save SRT:", exc)
    raise
