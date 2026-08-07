import os
from pathlib import Path
from faster_whisper import WhisperModel

path = Path(r"C:\Users\sures\Downloads\ODIA_MP3-1.mpeg")
print('audio path', path)
print('exists', path.exists())
print('size', path.stat().st_size if path.exists() else 'n/a')

for model_size in ['tiny', 'small']:
    for language_option in [None, 'or']:
        print('\n===== MODEL', model_size, 'LANGUAGE', language_option, '=====')
        model = WhisperModel(model_size, device='cpu', compute_type='int8', cpu_threads=os.cpu_count() or 12, num_workers=1)
        segments, info = model.transcribe(str(path), word_timestamps=True, language=language_option)
        segments = list(segments)
        print('info.language', getattr(info, 'language', None))
        print('num segments', len(segments))
        for i, segment in enumerate(segments):
            print('segment', i, 'start', getattr(segment, 'start', None), 'end', getattr(segment, 'end', None), 'text', repr(getattr(segment, 'text', None)))
            words = getattr(segment, 'words', []) or []
            print(' word count', len(words))
            for w in words:
                print('  word', repr(getattr(w, 'word', None)), 'start', getattr(w, 'start', None), 'end', getattr(w, 'end', None))
