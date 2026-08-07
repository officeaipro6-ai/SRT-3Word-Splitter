import math
import subprocess
import tempfile
import wave
import struct
from pathlib import Path

import main

base_dir = Path(tempfile.gettempdir()) / "srt_3word_mpeg_test"
base_dir.mkdir(exist_ok=True)

wav_path = base_dir / "tone.wav"
mp3_path = base_dir / "tone.mp3"
mp4_path = base_dir / "tone.mp4"
mpeg_path = base_dir / "tone.mpeg"
mpg_path = base_dir / "tone.mpg"

if not wav_path.exists():
    fr = 16000
    duration = 1.0
    with wave.open(str(wav_path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(fr)
        frames = [struct.pack("<h", int(32767 * 0.3 * math.sin(2 * math.pi * 440 * i / fr))) for i in range(int(fr * duration))]
        wf.writeframes(b"".join(frames))

ffmpeg_path = main._find_ffmpeg_path()
if not ffmpeg_path:
    raise RuntimeError("ffmpeg not found")

if not mp3_path.exists():
    subprocess.run([ffmpeg_path, "-y", "-i", str(wav_path), str(mp3_path)], check=True)
if not mp4_path.exists():
    subprocess.run([
        ffmpeg_path,
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=320x240:d=1",
        "-i",
        str(wav_path),
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        "-shortest",
        str(mp4_path),
    ], check=True)
if not mpeg_path.exists():
    subprocess.run([
        ffmpeg_path,
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=320x240:d=1",
        "-i",
        str(wav_path),
        "-c:v",
        "mpeg2video",
        "-qscale:v",
        "5",
        "-c:a",
        "mp2",
        str(mpeg_path),
    ], check=True)
if not mpg_path.exists():
    subprocess.run([
        ffmpeg_path,
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=320x240:d=1",
        "-i",
        str(wav_path),
        "-c:v",
        "mpeg2video",
        "-qscale:v",
        "5",
        "-c:a",
        "mp2",
        str(mpg_path),
    ], check=True)

for path in [mp3_path, mp4_path, mpeg_path, mpg_path]:
    kind = main.detect_media_kind(str(path))
    print(f"{path.name}: kind={kind}")
    audio = main.prepare_audio_path(path)
    print(f"{path.name}: prepares to {audio}")
print('TEST_COMPLETE')
