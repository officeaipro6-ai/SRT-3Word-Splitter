import os, sys, subprocess, tempfile, math, wave, struct
os.environ['WHISPER_MODEL'] = 'base'
from pathlib import Path
from tkinter import filedialog, messagebox
from main import OfflineSubtitleGeneratorApp

base_dir = Path(tempfile.gettempdir()) / 'srt_3word_test'
base_dir.mkdir(exist_ok=True)
wav_path = base_dir / 'tone.wav'
mp3_path = base_dir / 'tone.mp3'
output_srt = base_dir / 'output.srt'
if not wav_path.exists():
    fr = 16000
    duration = 2.0
    with wave.open(str(wav_path), 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(fr)
        frames = []
        for i in range(int(fr * duration)):
            sample = int(32767 * 0.3 * math.sin(2 * math.pi * 440 * i / fr))
            frames.append(struct.pack('<h', sample))
        wf.writeframes(b''.join(frames))
if not mp3_path.exists():
    subprocess.run(['ffmpeg', '-y', '-i', str(wav_path), str(mp3_path)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
orig_askopen = filedialog.askopenfilename
orig_asksave = filedialog.asksaveasfilename
orig_showinfo = messagebox.showinfo
orig_showwarning = messagebox.showwarning
orig_showerror = messagebox.showerror
try:
    filedialog.askopenfilename = lambda filetypes=None: str(mp3_path)
    filedialog.asksaveasfilename = lambda title=None, defaultextension=None, filetypes=None: str(output_srt)
    messagebox.showinfo = lambda *args, **kwargs: None
    messagebox.showwarning = lambda *args, **kwargs: None
    messagebox.showerror = lambda *args, **kwargs: None
    app = OfflineSubtitleGeneratorApp()
    app.load_media_from_path(str(mp3_path))
    if not app._generated_text:
        raise RuntimeError('No generated subtitles returned from app')
    app.save_as()
    if not output_srt.exists():
        raise RuntimeError('Output SRT file was not created')
    print('TEST_SUCCESS')
    print('MP3_PATH', mp3_path)
    print('SRT_PATH', output_srt)
    print('SUBTITLE_PREVIEW', app._generated_text[:400])
except Exception as exc:
    import traceback; traceback.print_exc()
    sys.exit(1)
finally:
    filedialog.askopenfilename = orig_askopen
    filedialog.asksaveasfilename = orig_asksave
    messagebox.showinfo = orig_showinfo
    messagebox.showwarning = orig_showwarning
    messagebox.showerror = orig_showerror