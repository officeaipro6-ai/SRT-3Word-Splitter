import os
import sys
import subprocess
import tempfile
import math
import wave
import struct
from pathlib import Path

import main
from main import OfflineSubtitleGeneratorApp

base_dir = Path(tempfile.gettempdir()) / "srt_3word_gui_test"
base_dir.mkdir(exist_ok=True)

wav_path = base_dir / "tone.wav"
mp3_path = base_dir / "tone.mp3"
m4a_path = base_dir / "tone.m4a"
mp4_path = base_dir / "tone.mp4"

ffmpeg_path = main._find_ffmpeg_path()
if not ffmpeg_path:
    raise RuntimeError("ffmpeg executable not found in PATH or known locations. Please install ffmpeg and make sure it is available.")
shutil_which = ffmpeg_path

if not wav_path.exists():
    fr = 16000
    duration = 2.0
    with wave.open(str(wav_path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(fr)
        frames = []
        for i in range(int(fr * duration)):
            sample = int(32767 * 0.3 * math.sin(2 * math.pi * 440 * i / fr))
            frames.append(struct.pack("<h", sample))
        wf.writeframes(b"".join(frames))

if not mp3_path.exists():
    subprocess.run([shutil_which, "-y", "-i", str(wav_path), str(mp3_path)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

if not m4a_path.exists():
    subprocess.run([shutil_which, "-y", "-i", str(wav_path), "-c:a", "aac", str(m4a_path)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

inputs = [
    (mp3_path, base_dir / "output_mp3.srt"),
    (wav_path, base_dir / "output_wav.srt"),
    (m4a_path, base_dir / "output_m4a.srt"),
]

orig_askopen = None
orig_asksave = None
orig_showinfo = None
orig_showwarning = None
orig_showerror = None
orig_startfile = None

def no_op(*args, **kwargs):
    return None


def main_test():
    global orig_askopen, orig_asksave, orig_showinfo, orig_showwarning, orig_showerror, orig_startfile

    from tkinter import filedialog, messagebox

    orig_askopen = filedialog.askopenfilename
    orig_asksave = filedialog.asksaveasfilename
    orig_showinfo = messagebox.showinfo
    orig_showwarning = messagebox.showwarning
    orig_showerror = messagebox.showerror
    orig_startfile = getattr(main.os, "startfile", None)

    opened_files = []

    try:
        filedialog.askopenfilename = lambda filetypes=None: str(current_input)
        filedialog.asksaveasfilename = lambda title=None, defaultextension=None, filetypes=None: str(output_path)
        messagebox.showinfo = no_op
        messagebox.showwarning = no_op
        messagebox.showerror = no_op

        if hasattr(main.os, "startfile"):
            main.os.startfile = lambda path: opened_files.append(Path(path))

        app = OfflineSubtitleGeneratorApp()

        for current_input, output_path in inputs:
            print(f"Testing selection: {current_input.suffix} -> {output_path.name}")
            app.file_var.set("No media selected")
            app._generated_text = ""
            app._media_path = None
            app._audio_path = None
            app._language = "unknown"
            app.browse_media()

            if not app._generated_text:
                raise RuntimeError(f"No subtitles generated for {current_input}")
            if not output_path.exists():
                app.save_as()
            if not output_path.exists():
                raise RuntimeError(f"Output file was not created for {current_input}")
            print(f"Generated: {output_path}")

        if not opened_files:
            raise RuntimeError("Auto-open was not triggered for saved subtitle files.")
        print("AUTO_OPEN_FILES", opened_files)
        print("GUI_INTEGRATION_TEST_SUCCESS")
    finally:
        from tkinter import filedialog, messagebox
        filedialog.askopenfilename = orig_askopen
        filedialog.asksaveasfilename = orig_asksave
        messagebox.showinfo = orig_showinfo
        messagebox.showwarning = orig_showwarning
        messagebox.showerror = orig_showerror
        if orig_startfile is not None:
            main.os.startfile = orig_startfile

if __name__ == "__main__":
    main_test()
