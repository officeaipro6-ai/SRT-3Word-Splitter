import os
import tempfile
import wave
from pathlib import Path
from faster_whisper import WhisperModel

path = Path(tempfile.gettempdir()) / 'debug_silent.wav'
with wave.open(str(path), 'wb') as wf:
    wf.setnchannels(1)
    wf.setsampwidth(2)
    wf.setframerate(16000)
    wf.writeframes(b'\x00\x00' * 16000)

print('audio file:', path)

model = WhisperModel('tiny', device='cpu', compute_type='int8', cpu_threads=os.cpu_count() or 12, num_workers=1)
segments, info = model.transcribe(str(path), word_timestamps=True, language=None)
segments = list(segments)
print('info.language', getattr(info, 'language', None))
print('num segments', len(segments))
for i, segment in enumerate(segments):
    print('segment', i, 'start', getattr(segment, 'start', None), 'end', getattr(segment, 'end', None), 'text', repr(getattr(segment, 'text', None)))
    for word in getattr(segment, 'words', []) or []:
        print('  word', repr(getattr(word, 'word', None)), 'start', getattr(word, 'start', None), 'end', getattr(word, 'end', None))
