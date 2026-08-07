import os
import sys
import tempfile
import wave
import math
import struct
import subprocess
from pathlib import Path

base_dir = Path(tempfile.gettempdir()) / 'srt_3word_debug'
base_dir.mkdir(exist_ok=True)
wav_path = base_dir / 'tone.wav'
mp3_path = base_dir / 'tone.mp3'

if not wav_path.exists():
    fr = 16000
    duration = 2.0
    with wave.open(str(wav_path), 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(fr)
        frames = [struct.pack('<h', int(32767 * 0.3 * math.sin(2 * math.pi * 440 * i / fr))) for i in range(int(fr * duration))]
        wf.writeframes(b''.join(frames))

ffmpeg_candidate = Path(r'C:\Users\sures\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin\ffmpeg.exe')
if ffmpeg_candidate.exists() and not mp3_path.exists():
    subprocess.run([str(ffmpeg_candidate), '-y', '-i', str(wav_path), str(mp3_path)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

print('ffmpeg candidate exists:', ffmpeg_candidate.exists(), ffmpeg_candidate)
print('mp3 path exists:', mp3_path.exists())

try:
    import main
    print('Imported main successfully')
    print('os PATH contains ffmpeg:', 'ffmpeg' in os.environ.get('PATH', ''))
    if ffmpeg_candidate.exists():
        os.environ['PATH'] = str(ffmpeg_candidate.parent) + os.pathsep + os.environ.get('PATH', '')
        print('Prepended ffmpeg to PATH:', ffmpeg_candidate.parent)
    print('Now ffmpeg discoverable:', __import__('shutil').which('ffmpeg'))
    print('Calling transcribe_audio...')
    text, lang = main.transcribe_audio(mp3_path, None)
    print('Transcription success, language:', lang)
    print('Output text:', text[:300])
except Exception as exc:
    import traceback
    traceback.print_exc()
    sys.exit(1)
