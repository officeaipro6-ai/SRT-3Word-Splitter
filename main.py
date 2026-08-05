import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from tkinter import Canvas, filedialog, messagebox
from tkinter.ttk import Progressbar

try:
    import customtkinter as ctk
except ImportError:  # pragma: no cover - fallback for headless test environments
    class _DummyWidget:
        def __init__(self, *args, **kwargs):
            pass

        def grid(self, *args, **kwargs):
            return None

        def pack(self, *args, **kwargs):
            return None

        def configure(self, *args, **kwargs):
            return None

        def delete(self, *args, **kwargs):
            return None

        def insert(self, *args, **kwargs):
            return None

        def get(self, *args, **kwargs):
            return ""

    class _DummyVar:
        def __init__(self, value=""):
            self.value = value

        def set(self, value):
            self.value = value

        def get(self):
            return self.value

    class _DummyCTkFont:
        def __init__(self, *args, **kwargs):
            pass

    class _DummyCTk:
        def __init__(self, *args, **kwargs):
            pass

        def grid_columnconfigure(self, *args, **kwargs):
            return None

        def grid_rowconfigure(self, *args, **kwargs):
            return None

        def configure(self, *args, **kwargs):
            return None

        def title(self, *args, **kwargs):
            return None

        def geometry(self, *args, **kwargs):
            return None

        def minsize(self, *args, **kwargs):
            return None

        def mainloop(self):
            return None

        def update_idletasks(self):
            return None

    class _DummyProgressbar(_DummyWidget):
        def __init__(self, *args, **kwargs):
            self["value"] = 0

    class _DummyCanvas(_DummyWidget):
        def __init__(self, *args, **kwargs):
            self.width = kwargs.get("width", 0)

    class _DummyTextbox(_DummyWidget):
        pass

    class _DummyButton(_DummyWidget):
        pass

    class _DummyLabel(_DummyWidget):
        pass

    class _DummyEntry(_DummyWidget):
        pass

    class _DummyFrame(_DummyWidget):
        pass

    class _DummyOptionMenu(_DummyWidget):
        pass

    class ctk:
        @staticmethod
        def set_appearance_mode(*args, **kwargs):
            return None

        @staticmethod
        def set_default_color_theme(*args, **kwargs):
            return None

        CTk = _DummyCTk
        CTkFrame = _DummyFrame
        CTkLabel = _DummyLabel
        CTkEntry = _DummyEntry
        CTkOptionMenu = _DummyOptionMenu
        CTkButton = _DummyButton
        CTkTextbox = _DummyTextbox
        CTkFont = _DummyCTkFont
        StringVar = _DummyVar

ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("dark-blue")


SUPPORTED_MEDIA_EXTENSIONS = {
    ".mp3": "audio",
    ".wav": "audio",
    ".m4a": "audio",
    ".flac": "audio",
    ".aac": "audio",
    ".ogg": "audio",
    ".mp4": "video",
    ".mkv": "video",
    ".mov": "video",
    ".avi": "video",
    ".webm": "video",
}


def _build_media_filetypes():
    return [("All Files", "*.*")]


def _path_matches_filter(path, filetypes):
    if not path:
        return False

    suffix = Path(path).suffix.lower()
    if not suffix:
        return False

    return suffix in SUPPORTED_MEDIA_EXTENSIONS


def detect_media_kind(path):
    if not path:
        raise ValueError("No file path provided.")

    candidate = Path(path)
    if not candidate.exists():
        raise FileNotFoundError(f"File not found: {candidate}")

    suffix = candidate.suffix.lower()
    if suffix not in SUPPORTED_MEDIA_EXTENSIONS:
        raise ValueError(
            f"Unsupported file type: {suffix or 'none'}. Supported formats: {', '.join(sorted(SUPPORTED_MEDIA_EXTENSIONS))}"
        )

    return SUPPORTED_MEDIA_EXTENSIONS[suffix]


class OfflineSubtitleGeneratorApp(ctk.CTk):
    def __init__(self):
        super().__init__()
        self.title("Offline Subtitle Generator")
        self.geometry("960x780")
        self.minsize(900, 700)
        self._media_path = None
        self._audio_path = None
        self._generated_text = ""
        self._language = "unknown"
        self._preview_text = ""

        self.configure(fg_color="#0f172a")
        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(2, weight=1)

        title = ctk.CTkLabel(
            self,
            text="Offline AI Subtitle Generator",
            font=ctk.CTkFont(size=24, weight="bold"),
            text_color="#f8fafc",
        )
        title.grid(row=0, column=0, padx=20, pady=(20, 10), sticky="w")

        subtitle = ctk.CTkLabel(
            self,
            text="Generate subtitles directly from audio or video files using Whisper and word-level timestamps.",
            font=ctk.CTkFont(size=13),
            text_color="#cbd5e1",
        )
        subtitle.grid(row=1, column=0, padx=20, pady=(0, 16), sticky="w")

        card = ctk.CTkFrame(self, corner_radius=18, fg_color="#111827")
        card.grid(row=2, column=0, padx=20, pady=(0, 20), sticky="nsew")
        card.grid_columnconfigure(0, weight=1)
        card.grid_rowconfigure(8, weight=1)

        self.file_var = ctk.StringVar(value="No media selected")
        self.status_var = ctk.StringVar(value="Ready")
        self.timeline_var = ctk.StringVar(value="Live subtitle preview")
        self.language_var = ctk.StringVar(value="Auto Detect")
        self.export_format_var = ctk.StringVar(value="SRT")

        ctk.CTkLabel(card, text="Selected media", font=ctk.CTkFont(size=13, weight="bold"), text_color="#e2e8f0").grid(row=0, column=0, padx=18, pady=(18, 4), sticky="w")
        ctk.CTkEntry(card, textvariable=self.file_var, state="readonly", fg_color="#0f172a", border_color="#334155").grid(row=1, column=0, padx=18, pady=(0, 10), sticky="ew")

        option_row = ctk.CTkFrame(card, fg_color="transparent")
        option_row.grid(row=2, column=0, padx=18, pady=(0, 10), sticky="w")
        ctk.CTkLabel(option_row, text="Language", text_color="#e2e8f0").pack(side="left")
        ctk.CTkOptionMenu(option_row, values=["Auto Detect", "English", "Hindi", "Odia"], variable=self.language_var, width=130).pack(side="left", padx=(8, 12))
        ctk.CTkLabel(option_row, text="Export", text_color="#e2e8f0").pack(side="left")
        ctk.CTkOptionMenu(option_row, values=["SRT", "VTT", "TXT"], variable=self.export_format_var, width=100).pack(side="left", padx=(8, 0))

        button_row = ctk.CTkFrame(card, fg_color="transparent")
        button_row.grid(row=3, column=0, padx=18, pady=(0, 10), sticky="w")
        ctk.CTkButton(button_row, text="Browse...", command=self.browse_media, width=140).pack(side="left")
        ctk.CTkButton(button_row, text="Generate Subtitles", command=self.generate_subtitles, width=150).pack(side="left", padx=(10, 0))
        ctk.CTkButton(button_row, text="Save As", command=self.save_as, width=120).pack(side="left", padx=(10, 0))

        ctk.CTkLabel(card, textvariable=self.status_var, font=ctk.CTkFont(size=12), text_color="#94a3b8").grid(row=4, column=0, padx=18, pady=(0, 6), sticky="w")
        ctk.CTkLabel(card, textvariable=self.timeline_var, font=ctk.CTkFont(size=12), text_color="#cbd5e1", wraplength=760).grid(row=5, column=0, padx=18, pady=(0, 10), sticky="w")

        self.waveform_canvas = Canvas(card, height=100, bg="#020617", highlightthickness=0)
        self.waveform_canvas.grid(row=6, column=0, padx=18, pady=(0, 10), sticky="ew")

        self.progress = Progressbar(card, mode="determinate", length=400, maximum=100)
        self.progress.grid(row=7, column=0, padx=18, pady=(0, 10), sticky="w")

        self.output_box = ctk.CTkTextbox(card, height=260, fg_color="#020617", border_color="#334155", text_color="#f8fafc")
        self.output_box.grid(row=8, column=0, padx=18, pady=(0, 18), sticky="nsew")
        self.output_box.insert("0.0", "Drag and drop a media file here, or use Browse...\n")

        self.drop_target = ctk.CTkFrame(card, fg_color="#0f172a", border_width=1, border_color="#475569")
        self.drop_target.grid(row=9, column=0, padx=18, pady=(0, 18), sticky="ew")
        self.drop_target.grid_columnconfigure(0, weight=1)
        self.drop_target.grid_rowconfigure(0, weight=1)
        self.drop_target.bind("<Button-1>", lambda event: self.browse_media())
        self.drop_target.bind("<Enter>", lambda event: self.drop_target.configure(border_color="#38bdf8"))
        self.drop_target.bind("<Leave>", lambda event: self.drop_target.configure(border_color="#475569"))
        if hasattr(self.drop_target, "drop_target_register"):
            self.drop_target.drop_target_register("DND_Files")
            self.drop_target.bind("<<Drop>>", self._handle_drop)
        self.drop_target_label = ctk.CTkLabel(self.drop_target, text="Drop media file here\n(or click to Browse...)", text_color="#cbd5e1", anchor="center")
        self.drop_target_label.grid(row=0, column=0, padx=20, pady=20, sticky="nsew")

        self.bind("<Configure>", self._on_window_configure)
        self.bind("<Control-v>", self._handle_paste_path)

    def _on_window_configure(self, event=None):
        if hasattr(self, "drop_target"):
            self.drop_target.configure(width=max(300, self.winfo_width() - 80))

    def _handle_paste_path(self, event=None):
        try:
            import tkinter as tk

            clipboard_text = self.clipboard_get()
        except Exception:
            clipboard_text = ""
        if clipboard_text:
            self.load_media_from_path(clipboard_text)

    def _handle_drop(self, event):
        dropped = event.data or ""
        paths = []
        for item in dropped.split():
            fixed = item.strip().strip("{}")
            if fixed:
                paths.append(fixed)
        if paths:
            self.load_media_from_path(paths[0])
        return "break"

    def browse_media(self):
        file_path = filedialog.askopenfilename(filetypes=[("All Files", "*.*")])
        if file_path:
            self.load_media_from_path(file_path)

    def load_media_from_path(self, file_path):
        if not file_path:
            self.output_box.delete("0.0", "end")
            self.output_box.insert("0.0", "No file selected.\n")
            self.status_var.set("No file selected.")
            return

        selected_path = Path(file_path).expanduser().resolve()
        try:
            media_kind = detect_media_kind(str(selected_path))
        except (FileNotFoundError, ValueError) as exc:
            self.output_box.delete("0.0", "end")
            self.output_box.insert("0.0", f"Error: {exc}\n")
            self.status_var.set("Unsupported or missing file.")
            messagebox.showerror("Unsupported media", str(exc))
            return

        self._media_path = selected_path
        self.file_var.set(str(self._media_path))
        self._audio_path = None
        self._generated_text = ""
        self._preview_text = ""
        self._language = "unknown"
        self._draw_waveform_preview(self._media_path)

        self.output_box.delete("0.0", "end")
        self.output_box.insert("0.0", f"Selected file: {self._media_path}\nMedia type: {media_kind}\n")
        self.status_var.set("Media loaded. Generating subtitles...")
        self.timeline_var.set("Live subtitle preview")
        self.progress["value"] = 0
        self.generate_subtitles()

    def load_media(self):
        self.browse_media()

    def generate_subtitles(self):
        if not self._media_path or not self._media_path.exists():
            messagebox.showerror("Error", "Please open a valid audio or video file first.")
            return

        self.progress["value"] = 10
        self.update_idletasks()
        self._preview_text = ""
        self.output_box.delete("0.0", "end")
        self.output_box.insert("0.0", "Generating subtitles from media...\n")
        self.status_var.set("Transcribing audio and creating subtitle phrases...")

        try:
            audio_path = prepare_audio_path(self._media_path)
            self._audio_path = audio_path
            language_hint = _to_whisper_language(self.language_var.get())
            generated, language = transcribe_audio(audio_path, language_hint=language_hint, preview_callback=self._update_preview)
        except Exception as exc:
            messagebox.showerror("Transcription failed", f"Could not generate subtitles: {exc}")
            self.progress["value"] = 0
            return

        self.progress["value"] = 90
        self.update_idletasks()
        self._generated_text = generated
        self._language = language or "unknown"
        self._update_preview(generated)
        self.progress["value"] = 100
        self.status_var.set(f"Generated subtitles — language: {self._language}")
        self.timeline_var.set("Live subtitle preview")

    def save_as(self):
        if not self._generated_text:
            messagebox.showwarning("Warning", "Generate subtitles first.")
            return

        edited_text = self.output_box.get("0.0", "end").strip() + "\n"
        self._generated_text = edited_text

        export_format = self.export_format_var.get().lower()
        default_extension = ".srt"
        if export_format == "vtt":
            default_extension = ".vtt"
        elif export_format == "txt":
            default_extension = ".txt"

        save_path = filedialog.asksaveasfilename(
            title="Save generated subtitles",
            defaultextension=default_extension,
            filetypes=[("SRT files", "*.srt"), ("VTT files", "*.vtt"), ("Text files", "*.txt"), ("All files", "*.*")],
        )
        if not save_path:
            return

        target_path = Path(save_path)
        content = self._generated_text
        if export_format == "vtt":
            content = export_as_vtt(self._generated_text)
        elif export_format == "txt":
            content = export_as_txt(self._generated_text)
        target_path.write_text(content, encoding="utf-8")
        messagebox.showinfo("Saved", f"Generated subtitles saved to:\n{target_path}")

    def _update_preview(self, content: str) -> None:
        self._preview_text = content
        self.output_box.delete("0.0", "end")
        self.output_box.insert("0.0", content)
        self.update_idletasks()

    def _draw_waveform_preview(self, media_path: Path) -> None:
        self.waveform_canvas.delete("all")
        if not media_path or not media_path.exists():
            return

        width = 760
        height = 100
        self.waveform_canvas.configure(width=width)
        try:
            import wave

            with wave.open(str(media_path), "rb") as wav_file:
                frames = wav_file.getnframes()
                raw_frames = wav_file.readframes(frames)
                values = []
                step = max(1, len(raw_frames) // 220)
                for index in range(0, len(raw_frames), step):
                    chunk = raw_frames[index:index + 2]
                    if not chunk:
                        break
                    sample = int.from_bytes(chunk[:2], byteorder="little", signed=True) if len(chunk) >= 2 else 0
                    values.append(abs(sample))
                if values:
                    self._draw_waveform_values(values, width, height)
                    return
        except Exception:
            pass

        bars = [3 + ((index * 17) % 19) for index in range(width // 10)]
        for index, bar_height in enumerate(bars):
            x0 = index * 10 + 4
            x1 = x0 + 6
            y = height // 2
            self.waveform_canvas.create_rectangle(x0, y - bar_height, x1, y + bar_height, fill="#38bdf8", outline="")

    def _draw_waveform_values(self, values, width: int, height: int) -> None:
        if not values:
            return
        max_value = max(values) or 1
        step = max(1, len(values) // max(1, width // 10))
        bars = []
        for index in range(0, len(values), step):
            chunk = values[index:index + step]
            if not chunk:
                continue
            peak = max(chunk) / max_value
            bars.append(int(max(4, peak * (height // 2 - 6))))
        for index, bar_height in enumerate(bars[: width // 10]):
            x0 = index * 10 + 4
            x1 = x0 + 6
            y = height // 2
            self.waveform_canvas.create_rectangle(x0, y - bar_height, x1, y + bar_height, fill="#38bdf8", outline="")


def parse_time_to_millis(value: str) -> int:
    match = re.fullmatch(r"(\d{2}):(\d{2}):(\d{2}),(\d{3})", value.strip())
    if not match:
        raise ValueError("Invalid timestamp format encountered.")
    hours, minutes, seconds, millis = match.groups()
    return int(hours) * 3600000 + int(minutes) * 60000 + int(seconds) * 1000 + int(millis)


def millis_to_time(value: int) -> str:
    hours, remainder = divmod(value, 3600000)
    minutes, remainder = divmod(remainder, 60000)
    seconds, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"


def millis_to_vtt_time(value: int) -> str:
    hours, remainder = divmod(value, 3600000)
    minutes, remainder = divmod(remainder, 60000)
    seconds, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}.{millis:03d}"


def _normalize_text(value: str) -> str:
    return re.sub(r"[^\w]+", "", value, flags=re.UNICODE).casefold()


def _count_words(text: str) -> int:
    return len(re.findall(r"\w+", text, flags=re.UNICODE))


def _to_whisper_language(value: str) -> str | None:
    mapping = {"english": "en", "hindi": "hi", "odia": "or"}
    normalized = (value or "").strip().casefold()
    if not normalized or normalized == "auto detect":
        return None
    return mapping.get(normalized)


TAG_PATTERN = re.compile(r"<(NOISE|MUSIC|LAUGH|APPLAUSE|SILENCE|BREATH)>.*?</\1>", re.IGNORECASE)
FILLER_WORDS = {"hmm", "hmmm", "hnn", "hnnn", "uh", "um", "ah", "oh", "eh"}
NON_SPEECH_MARKERS = {
    "[music]": (True, "<MUSIC>music</MUSIC>"),
    "[applause]": (True, "<APPLAUSE>applause</APPLAUSE>"),
    "[laugh]": (True, "<LAUGH>laugh</LAUGH>"),
    "[laughter]": (True, "<LAUGH>laugh</LAUGH>"),
    "[noise]": (True, "<NOISE>noise</NOISE>"),
    "[silence]": (True, "<SILENCE>silence</SILENCE>"),
    "[breath]": (True, "<BREATH>breath</BREATH>"),
    "[breathing]": (True, "<BREATH>breath</BREATH>"),
}


def _is_filler_only(text: str) -> bool:
    stripped = re.sub(r"\s+", " ", text).strip()
    if not stripped:
        return True
    parts = re.split(r"\s+", stripped)
    if not parts:
        return True
    return all(_normalize_text(part) in FILLER_WORDS for part in parts)


def _looks_like_non_speech(text: str, word_items: list[dict] | None = None) -> tuple[bool, str]:
    normalized = re.sub(r"\s+", " ", text).strip().lower()
    if not normalized:
        return False, ""

    for marker, candidate in NON_SPEECH_MARKERS.items():
        if marker in normalized:
            return True, candidate[1]

    if word_items and len(word_items) <= 2 and any(_normalize_text(item["word"]) in FILLER_WORDS for item in word_items):
        return True, f"<BREATH>{text.strip()}</BREATH>"

    return False, ""


def _flush_chunk(chunks: list[dict], current_chunk: list[dict]) -> None:
    if not current_chunk:
        return
    text = " ".join(item["word"] for item in current_chunk).strip()
    if _is_filler_only(text):
        text = f"<BREATH>{text}</BREATH>"
    chunks.append({
        "words": current_chunk,
        "text": text,
        "start": current_chunk[0]["start"],
        "end": current_chunk[-1]["end"],
    })


def build_subtitle_segments(words: list[dict], max_words: int = 3, pause_threshold_ms: int = 700) -> list[dict]:
    chunks = []
    current_chunk = []

    for index, word_item in enumerate(words):
        word_text = (word_item.get("word") or "").strip()
        if not word_text:
            continue

        normalized_word = _normalize_text(word_text)
        marker = NON_SPEECH_MARKERS.get(word_text.casefold())
        if marker:
            _flush_chunk(chunks, current_chunk)
            current_chunk = []
            chunks.append({
                "words": [word_item],
                "text": marker[1],
                "start": word_item["start"],
                "end": word_item["end"],
            })
            continue

        if current_chunk and _should_break(current_chunk, word_item, max_words=max_words, pause_threshold_ms=pause_threshold_ms):
            _flush_chunk(chunks, current_chunk)
            current_chunk = []

        current_chunk.append(word_item)

        if word_text.endswith((",", ".", "?", "!", ";", ":", "।", "॥")):
            _flush_chunk(chunks, current_chunk)
            current_chunk = []

        if index == len(words) - 1:
            _flush_chunk(chunks, current_chunk)

    if len(chunks) >= 2:
        merged = False
        for index in range(len(chunks) - 1, 0, -1):
            if _count_words(chunks[index]["text"]) == 1 and _count_words(chunks[index - 1]["text"]) + 1 <= max_words:
                merged_text = f"{chunks[index - 1]['text']} {chunks[index]['text']}".strip()
                chunks[index - 1]["text"] = merged_text
                chunks[index - 1]["end"] = chunks[index]["end"]
                chunks.pop(index)
                merged = True
                break
        if not merged:
            for index in range(len(chunks) - 1, 0, -1):
                if _count_words(chunks[index]["text"]) <= 2 and _count_words(chunks[index - 1]["text"]) + _count_words(chunks[index]["text"]) <= max_words:
                    merged_text = f"{chunks[index - 1]['text']} {chunks[index]['text']}".strip()
                    chunks[index - 1]["text"] = merged_text
                    chunks[index - 1]["end"] = chunks[index]["end"]
                    chunks.pop(index)
                    break

    return chunks


def _should_break(current_chunk: list[dict], next_word: dict, max_words: int = 3, pause_threshold_ms: int = 700) -> bool:
    if not current_chunk:
        return False

    if len(current_chunk) >= max_words:
        return True

    word_text = (next_word.get("word") or "").strip()
    if word_text.endswith((",", ".", "?", "!", ";", ":", "।", "॥")):
        return True

    gap = int(next_word.get("start", 0) - current_chunk[-1].get("end", 0))
    if gap > pause_threshold_ms:
        return True

    return False


def prepare_audio_path(media_path: Path) -> Path:
    if not media_path or not media_path.exists():
        raise FileNotFoundError("Media file does not exist.")

    suffix = media_path.suffix.lower()
    if suffix in {".mp3", ".wav", ".m4a", ".flac"}:
        return media_path

    if suffix in {".mp4", ".mkv", ".avi", ".mov"}:
        ffmpeg_path = shutil.which("ffmpeg") or shutil.which("ffmpeg.exe")
        if not ffmpeg_path:
            raise RuntimeError("ffmpeg was not found on PATH. Please install ffmpeg to extract audio from video files.")
        temp_dir = Path(tempfile.gettempdir())
        output_path = temp_dir / f"{media_path.stem}_audio.wav"
        subprocess.run(
            [ffmpeg_path, "-y", "-i", str(media_path), "-vn", "-ac", "1", "-ar", "16000", str(output_path)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return output_path

    raise ValueError("Unsupported media file type.")


def transcribe_audio(audio_path: Path, language_hint: str | None = None, preview_callback=None) -> tuple[str, str]:
    model_size = os.getenv("WHISPER_MODEL", "large-v3")

    try:
        from faster_whisper import WhisperModel

        model = WhisperModel(model_size, device="cpu", compute_type="int8")
        segments, info = model.transcribe(str(audio_path), word_timestamps=True, beam_size=5, vad_filter=True, language=language_hint)
        language = getattr(info, "language", None) or "unknown"
        subtitles = []
        all_words = []
        for segment in segments:
            for word in getattr(segment, "words", []) or []:
                word_text = getattr(word, "word", "") or ""
                if not word_text.strip():
                    continue
                all_words.append({
                    "word": word_text.strip(),
                    "start": int(getattr(word, "start", 0) * 1000),
                    "end": int(getattr(word, "end", 0) * 1000),
                })

        for chunk in build_subtitle_segments(all_words, max_words=3, pause_threshold_ms=800):
            text = (chunk.get("text") or "").strip()
            if not text:
                continue
            subtitles.append({"text": text, "start": int(chunk["start"]), "end": int(chunk["end"])})
            if preview_callback is not None:
                preview_callback(format_subtitles(subtitles, language))

        return format_subtitles(subtitles, language), language
    except Exception:
        pass

    try:
        import whisper

        model = whisper.load_model(model_size)
        result = model.transcribe(str(audio_path), word_timestamps=True, fp16=False, language=language_hint)
        language = result.get("language", "unknown")
        subtitles = []
        all_words = []
        for segment in result.get("segments", []):
            for word in segment.get("words", []) or []:
                word_text = word.get("word", "") or ""
                if not word_text.strip():
                    continue
                all_words.append({
                    "word": word_text.strip(),
                    "start": int(word.get("start", 0) * 1000),
                    "end": int(word.get("end", 0) * 1000),
                })

        for chunk in build_subtitle_segments(all_words, max_words=3, pause_threshold_ms=800):
            text = (chunk.get("text") or "").strip()
            if not text:
                continue
            subtitles.append({"text": text, "start": int(chunk["start"]), "end": int(chunk["end"])})
            if preview_callback is not None:
                preview_callback(format_subtitles(subtitles, language))

        return format_subtitles(subtitles, language), language
    except Exception as exc:
        raise RuntimeError(f"Whisper transcription failed: {exc}") from exc


def format_subtitles(subtitles: list[dict], language: str) -> str:
    output_parts = []
    subtitle_number = 1
    for subtitle in subtitles:
        text = (subtitle.get("text") or "").strip()
        if not text:
            continue
        start_ms = int(subtitle.get("start", 0))
        end_ms = int(subtitle.get("end", 0))
        output_parts.append(f"{subtitle_number}\n{millis_to_time(start_ms)} --> {millis_to_time(end_ms)}\n{text}\n")
        subtitle_number += 1

    if not output_parts:
        return f"1\n00:00:00,000 --> 00:00:00,000\n<NOISE>no speech detected</NOISE>\n"

    return "\n".join(output_parts).strip() + "\n"


def export_as_vtt(srt_text: str) -> str:
    lines = [line.rstrip() for line in srt_text.splitlines() if line.strip()]
    if not lines:
        return "WEBVTT\n\n"
    output = ["WEBVTT", "", ""]
    index = 0
    while index < len(lines):
        if re.fullmatch(r"\d+", lines[index]):
            index += 1
            timing_line = lines[index]
            index += 1
            text_lines = []
            while index < len(lines) and not re.fullmatch(r"\d+", lines[index]):
                text_lines.append(lines[index])
                index += 1
            block_text = "\n".join(text_lines)
            start_text, end_text = [part.strip() for part in timing_line.split("-->")]
            output.append(f"{millis_to_vtt_time(parse_time_to_millis(start_text))} --> {millis_to_vtt_time(parse_time_to_millis(end_text))}")
            output.append(block_text)
            output.append("")
        else:
            index += 1
    return "\n".join(output).strip() + "\n"


def export_as_txt(srt_text: str) -> str:
    lines = [line.rstrip() for line in srt_text.splitlines() if line.strip()]
    output = []
    index = 0
    while index < len(lines):
        if re.fullmatch(r"\d+", lines[index]):
            index += 1
            timing_line = lines[index]
            index += 1
            text_lines = []
            while index < len(lines) and not re.fullmatch(r"\d+", lines[index]):
                text_lines.append(lines[index])
                index += 1
            output.append(f"{timing_line}: {' '.join(text_lines)}")
        else:
            index += 1
    return "\n".join(output).strip() + "\n"


if __name__ == "__main__":
    app = OfflineSubtitleGeneratorApp()
    app.mainloop()
