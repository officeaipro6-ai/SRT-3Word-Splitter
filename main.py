import os
import re
import json
import shutil
import subprocess
import tempfile
import threading
import logging
import mimetypes
import uuid
import urllib.error
import urllib.request
from pathlib import Path
from tkinter import Canvas, filedialog, messagebox
from tkinter.ttk import Progressbar

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

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
    ".mpeg": "video",
    ".mpg": "video",
}


def _find_ffmpeg_path() -> str | None:
    candidates = []
    env_path = os.getenv("FFMPEG_PATH")
    if env_path:
        candidates.append(env_path)

    candidates.extend([
        r"C:\Program Files\ffmpeg\bin\ffmpeg.exe",
        r"C:\Program Files (x86)\ffmpeg\bin\ffmpeg.exe",
        r"C:\Users\sures\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin\ffmpeg.exe",
    ])

    for candidate in candidates:
        if not candidate:
            continue
        candidate_path = Path(candidate)
        if candidate_path.is_dir():
            candidate_path = candidate_path / "ffmpeg.exe"
        if candidate_path.exists():
            return str(candidate_path)

    system_ffmpeg = shutil.which("ffmpeg") or shutil.which("ffmpeg.exe")
    if system_ffmpeg:
        return system_ffmpeg

    try:
        import imageio_ffmpeg as ffmpeg
        return ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def _ensure_ffmpeg_path() -> str | None:
    ffmpeg_path = _find_ffmpeg_path()
    if ffmpeg_path:
        parent_dir = str(Path(ffmpeg_path).parent)
        if parent_dir not in os.environ.get("PATH", ""):
            os.environ["PATH"] = parent_dir + os.pathsep + os.environ.get("PATH", "")
    return ffmpeg_path


def _sanitize_language_code(code: str | None) -> str | None:
    """Return a safe language code or None for auto-detect.

    - Prefer auto-detect for Odia/Oriya.
    - Only allow simple two-letter codes; otherwise return None.
    """
    if not code:
        return None
    c = str(code).strip().casefold()
    if c in {"odia", "oriya", "or"}:
        return None
    # allow two-letter ASCII codes (e.g., en, hi)
    if re.fullmatch(r"[a-z]{2}", c):
        return c
    return None

DEVANAGARI_TO_ODIA = {
    # Independent vowels
    "अ": "ଅ",
    "आ": "ଆ",
    "इ": "ଇ",
    "ई": "ଈ",
    "उ": "ଉ",
    "ऊ": "ଊ",
    "ऋ": "ଋ",
    "ॠ": "ୠ",
    "ऌ": "ଳ",
    "ॡ": "ୡ",
    "ए": "ଏ",
    "ऐ": "ଐ",
    "ओ": "ଓ",
    "औ": "ଔ",
    # Dependent vowel signs
    "ा": "ା",
    "ि": "ି",
    "ी": "ୀ",
    "ु": "ୁ",
    "ू": "ୂ",
    "ृ": "ୃ",
    "ॄ": "ୄ",
    "े": "େ",
    "ै": "ୈ",
    "ो": "ୋ",
    "ौ": "ୌ",
    "्": "୍",
    "ँ": "ଁ",
    "ं": "ଂ",
    "ः": "ଃ",
    # Consonants
    "क": "କ",
    "ख": "ଖ",
    "ग": "ଗ",
    "घ": "ଘ",
    "ङ": "ଙ",
    "च": "ଚ",
    "छ": "ଛ",
    "ज": "ଜ",
    "झ": "ଝ",
    "ञ": "ଞ",
    "ट": "ଟ",
    "ठ": "ଠ",
    "ड": "ଡ",
    "ढ": "ଢ",
    "ण": "ଣ",
    "त": "ତ",
    "थ": "ଥ",
    "द": "ଦ",
    "ध": "ଧ",
    "न": "ନ",
    "प": "ପ",
    "फ": "ଫ",
    "ब": "ବ",
    "भ": "ଭ",
    "म": "ମ",
    "य": "ୟ",
    "र": "ର",
    "ल": "ଲ",
    "व": "ବ",
    "श": "ଶ",
    "ष": "ଷ",
    "स": "ସ",
    "ह": "ହ",
    "ळ": "ଳ",
    "ऩ": "ନ",
    "ऱ": "ର",
    "ड़": "ଡ୍",
    "ढ़": "ଢ୍",
}

DEVANAGARI_BLOCK = re.compile(r"[\u0900-\u097F]")


def _contains_devanagari(text: str) -> bool:
    return bool(text and DEVANAGARI_BLOCK.search(text))


def _convert_devanagari_to_odia(text: str) -> str:
    if not text:
        return text
    return "".join(DEVANAGARI_TO_ODIA.get(ch, ch) for ch in text)


def _cleanup_transcript_text(text: str, odia_selected: bool = False) -> str:
    text = (text or "").strip()
    if not text:
        return text
    text = re.sub(r"\s+", " ", text)
    if odia_selected and _contains_devanagari(text):
        text = _convert_devanagari_to_odia(text)
    text = re.sub(r"\s+([,?.!;।॥])", r"\1", text)
    return text


def _parse_srt_blocks(srt_text: str) -> list[dict]:
    blocks = []
    if not srt_text:
        return blocks
    lines = [line.rstrip() for line in srt_text.replace('\r\n', '\n').replace('\r', '\n').split('\n')]
    index = 0
    while index < len(lines):
        line = lines[index].strip()
        if not line:
            index += 1
            continue
        if not re.fullmatch(r"\d+", line):
            index += 1
            continue
        try:
            subtitle_index = int(line)
        except ValueError:
            index += 1
            continue
        index += 1
        if index >= len(lines):
            break
        timestamp_line = lines[index].strip()
        index += 1
        text_lines = []
        while index < len(lines) and lines[index].strip():
            text_lines.append(lines[index])
            index += 1
        blocks.append({
            "index": subtitle_index,
            "timestamps": timestamp_line,
            "text": "\n".join(text_lines).strip(),
        })
    return blocks


def _build_gemini_prompt_for_subtitles(blocks: list[dict], preferred_language: str | None = None) -> str:
    subtitles_json = [block["text"] for block in blocks]
    prompt_lines = [
        "You are correcting subtitle text.",
        "Return a JSON array of strings only, where each item is the corrected subtitle text for the corresponding subtitle block in the input order.",
        "Do not return timestamps, numbering, or any extra explanation.",
        "Preserve subtitle block order exactly.",
        "Remove any hallucinated English sentences if the audio is not in English.",
    ]
    if preferred_language:
        preferred_language = preferred_language.strip().casefold()
        if preferred_language in {"odia", "oriya", "or"}:
            prompt_lines.extend([
                "The subtitles should be returned in proper Odia Unicode (ଓଡ଼ିଆ), not Roman Odia.",
                "Use Odia script for all corrected text.",
            ])
        elif preferred_language in {"hindi", "hi"}:
            prompt_lines.extend([
                "The subtitles should be returned in proper Hindi Devanagari script.",
                "Use Hindi script for all corrected text.",
            ])
        elif preferred_language in {"english", "en"}:
            prompt_lines.extend([
                "The subtitles should be returned in proper English.",
            ])
        else:
            prompt_lines.extend([
                "Detect whether the text is Odia, Hindi, or English, and return it in the appropriate script.",
            ])
    else:
        prompt_lines.extend([
            "The audio may be Odia, Hindi, or English; detect the correct language and return the text in the appropriate script.",
        ])
    prompt_lines.append("Input subtitles:")
    prompt_lines.append(json.dumps(subtitles_json, ensure_ascii=False, indent=2))
    return "\n".join(prompt_lines)


def _call_gemini_api(prompt: str, timeout_seconds: int = 30) -> str:
    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("OPENAI_API_KEY")
    api_url = os.getenv("GEMINI_API_URL") or os.getenv("OPENAI_API_BASE") or "https://api.openai.com/v1/chat/completions"
    if not api_key:
        raise RuntimeError("Gemini API key not configured. Set GEMINI_API_KEY or OPENAI_API_KEY.")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
        "messages": [
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.0,
        "max_tokens": int(os.getenv("GEMINI_MAX_TOKENS", "2000")),
    }

    request_data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(api_url, data=request_data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Gemini API HTTP error: {exc.code} {exc.reason} - {body}") from exc
    except Exception as exc:
        raise RuntimeError(f"Gemini API request failed: {exc}") from exc

    try:
        response_json = json.loads(body)
    except Exception as exc:
        raise RuntimeError(f"Could not parse Gemini response as JSON: {exc} - response: {body[:1000]}") from exc

    # Support OpenAI-style responses
    content = None
    if isinstance(response_json, dict):
        if "choices" in response_json and response_json["choices"]:
            message = response_json["choices"][0].get("message")
            if isinstance(message, dict):
                content = message.get("content")
            elif isinstance(response_json["choices"][0].get("text"), str):
                content = response_json["choices"][0].get("text")
        elif "output" in response_json:
            outputs = response_json.get("output")
            if isinstance(outputs, list) and outputs:
                first = outputs[0]
                if isinstance(first, dict) and "content" in first:
                    content = first["content"]
    if content is None:
        raise RuntimeError(f"Gemini API returned an unexpected response structure: {json.dumps(response_json)[:1000]}")
    if isinstance(content, dict):
        if "text" in content:
            content = content["text"]
        else:
            content = json.dumps(content, ensure_ascii=False)
    return str(content)


def _encode_multipart_formdata(fields: dict[str, str], files: list[tuple[str, str, str, bytes]]) -> tuple[bytes, str]:
    boundary = uuid.uuid4().hex
    body_lines: list[bytes] = []
    encoder = lambda value: value.encode("utf-8") if isinstance(value, str) else value

    for name, value in fields.items():
        body_lines.append(encoder(f"--{boundary}\r\n"))
        body_lines.append(encoder(f"Content-Disposition: form-data; name=\"{name}\"\r\n\r\n"))
        body_lines.append(encoder(f"{value}\r\n"))

    for field_name, filename, content_type, file_data in files:
        body_lines.append(encoder(f"--{boundary}\r\n"))
        body_lines.append(encoder(f"Content-Disposition: form-data; name=\"{field_name}\"; filename=\"{filename}\"\r\n"))
        body_lines.append(encoder(f"Content-Type: {content_type}\r\n\r\n"))
        body_lines.append(file_data)
        body_lines.append(encoder("\r\n"))

    body_lines.append(encoder(f"--{boundary}--\r\n"))
    return b"".join(body_lines), f"multipart/form-data; boundary={boundary}"


def _parse_gemini_subtitle_array(response_text: str, expected_count: int) -> list[str]:
    try:
        parsed = json.loads(response_text)
        if isinstance(parsed, list):
            return [str(item).strip() for item in parsed][:expected_count]
    except Exception:
        pass

    lines = [line.strip() for line in response_text.strip().splitlines() if line.strip()]
    if len(lines) == expected_count and all(not line.startswith("[") for line in lines):
        return lines

    # Attempt to extract numbered list items if present.
    results = []
    current = []
    for line in lines:
        numbered = re.match(r"^\s*\d+\s*[\).:-]\s*(.*)$", line)
        if numbered:
            if current:
                results.append(" ".join(current).strip())
            current = [numbered.group(1).strip()]
        else:
            current.append(line)
    if current:
        results.append(" ".join(current).strip())
    if len(results) == expected_count:
        return results

    raise RuntimeError("Could not parse Gemini subtitle correction output into a subtitle array.")


def _correct_subtitles_with_gemini(srt_text: str, preferred_language: str | None = None) -> str:
    blocks = _parse_srt_blocks(srt_text)
    if not blocks:
        return srt_text
    prompt = _build_gemini_prompt_for_subtitles(blocks, preferred_language=preferred_language)
    logger.info("Sending %s subtitle blocks to Gemini for correction. Preferred language=%s", len(blocks), preferred_language)
    response_text = _call_gemini_api(prompt)
    logger.info("Received response from Gemini: %s", response_text[:1000])
    corrected_texts = _parse_gemini_subtitle_array(response_text, len(blocks))
    corrected_subtitles = []
    for block, corrected in zip(blocks, corrected_texts):
        corrected = corrected.strip()
        if not corrected:
            corrected = block["text"]
        corrected_subtitles.append(f"{block['index']}\n{block['timestamps']}\n{corrected}\n")
    return "\n".join(corrected_subtitles).strip() + "\n"


def _is_junk_text(text: str) -> bool:
    if not text or not text.strip():
        return True
    stripped = text.strip()
    if re.fullmatch(r"[\W_]+", stripped, flags=re.UNICODE):
        return True
    return False


def _is_model_output_junk(segments: list) -> bool:
    if not segments:
        return True
    junk_count = 0
    for segment in segments:
        segment_text = (getattr(segment, "text", "") or "").strip()
        words = [getattr(word, "word", "") or "" for word in getattr(segment, "words", []) or []]
        if _is_junk_text(segment_text) and all(_is_junk_text(word) for word in words if word.strip()):
            junk_count += 1
    return junk_count >= max(1, len(segments))


def _get_auto_batch_size(cpu_threads: int) -> int:
    if cpu_threads >= 16:
        return 32
    if cpu_threads >= 8:
        return 24
    if cpu_threads >= 4:
        return 16
    return 8


def _get_auto_chunk_seconds(duration_s: float) -> int:
    if duration_s <= 0:
        return 30
    if duration_s < 300:
        return 30
    if duration_s < 900:
        return 60
    if duration_s < 1800:
        return 90
    return 120


def _save_live_subtitles(path: Path, subtitles: list[dict], language: str) -> None:
    if not subtitles:
        return
    try:
        path.write_text(format_subtitles(subtitles, language), encoding="utf-8")
    except Exception:
        pass


def _build_fallback_subtitles(words: list[dict], max_words: int = 6) -> list[dict]:
    if not words:
        return []
    fallback = []
    current = []
    for word in words:
        current.append(word)
        if len(current) >= max_words or word["word"].endswith(('.', '?', '!', ';', ':', '।', '॥')):
            text = " ".join(w["word"] for w in current).strip()
            if text:
                fallback.append({
                    "text": text,
                    "start": current[0]["start"],
                    "end": current[-1]["end"],
                })
            current = []
    if current:
        text = " ".join(w["word"] for w in current).strip()
        if text:
            fallback.append({
                "text": text,
                "start": current[0]["start"],
                "end": current[-1]["end"],
            })
    return fallback


def _build_media_filetypes():
    extensions = ["*.mp3", "*.wav", "*.m4a", "*.flac", "*.aac", "*.ogg", "*.mp4", "*.mkv", "*.avi", "*.mov", "*.webm", "*.mpeg", "*.mpg"]
    return [
        ("Audio & Video Files", ";".join(extensions)),
        ("MP3 files", "*.mp3"),
        ("WAV files", "*.wav"),
        ("M4A files", "*.m4a"),
        ("MP4 files", "*.mp4"),
        ("MPEG files", "*.mpeg;*.mpg"),
        ("All Files", "*.*"),
    ]


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
        self.browse_button = ctk.CTkButton(button_row, text="Browse...", command=self.browse_media, width=140)
        self.browse_button.pack(side="left")
        self.generate_button = ctk.CTkButton(button_row, text="Generate Subtitles", command=self.generate_subtitles, width=150)
        self.generate_button.pack(side="left", padx=(10, 0))
        self.save_button = ctk.CTkButton(button_row, text="Save As", command=self.save_as, width=120)
        self.save_button.pack(side="left", padx=(10, 0))

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

    def _show_warning(self, title: str, message: str) -> None:
        messagebox.showwarning(title, message)

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
        file_path = filedialog.askopenfilename(filetypes=_build_media_filetypes())
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

        self._set_controls_enabled(False)
        self._set_progress(10)
        self._preview_text = ""
        self._generated_text = ""
        self._set_output_text("Generating subtitles from media...\n")
        self._set_status("Preparing media and starting transcription...")
        self._set_timeline("Live subtitle preview")

        worker = threading.Thread(target=self._generate_subtitles_background, daemon=True)
        worker.start()

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
        self._open_file(target_path)

    def _open_file(self, file_path: Path) -> None:
        try:
            if os.name == "nt":
                os.startfile(str(file_path))
            else:
                subprocess.run(["xdg-open", str(file_path)], check=False)
        except Exception:
            messagebox.showwarning("Open file", f"Could not open file automatically: {file_path}")

    def _run_in_main_thread(self, func, *args, **kwargs):
        self.after(0, lambda: func(*args, **kwargs))

    def _set_controls_enabled(self, enabled: bool) -> None:
        for widget in (self.browse_button, self.generate_button, self.save_button):
            try:
                widget.configure(state="normal" if enabled else "disabled")
            except Exception:
                pass

    def _set_progress(self, value: float) -> None:
        self.progress["value"] = max(0, min(100, value))
        self.update_idletasks()

    def _set_status(self, message: str) -> None:
        self.status_var.set(message)

    def _set_timeline(self, message: str) -> None:
        self.timeline_var.set(message)

    def _set_output_text(self, text: str) -> None:
        self.output_box.delete("0.0", "end")
        self.output_box.insert("0.0", text)
        self.update_idletasks()

    def _background_preview_update(self, content: str) -> None:
        self._run_in_main_thread(self._set_output_text, content)

    def _background_progress_update(self, percent: float | None, status_text: str | None = None) -> None:
        if percent is not None:
            self._run_in_main_thread(self._set_progress, percent)
        if status_text is not None:
            self._run_in_main_thread(self._set_status, status_text)

    def _background_warning(self, title: str, message: str) -> None:
        self._run_in_main_thread(self._show_warning, title, message)

    def _on_transcription_finished(self, generated: str, language: str) -> None:
        self._generated_text = generated
        self._language = language or "unknown"
        self._update_preview(generated)
        self._set_progress(100)
        self._set_status(f"Generated subtitles — language: {self._language}")
        self._set_timeline("Live subtitle preview")
        self._set_controls_enabled(True)

    def _on_transcription_failed(self, exc: Exception) -> None:
        messagebox.showerror("Transcription failed", f"Could not generate subtitles: {exc}")
        self._set_progress(0)
        self._set_status("Transcription failed")
        self._set_controls_enabled(True)

    def _generate_subtitles_background(self) -> None:
        try:
            audio_path = prepare_audio_path(self._media_path)
            self._audio_path = audio_path
            language_hint = _to_whisper_language(self.language_var.get())
            live_save_file = Path(tempfile.gettempdir()) / f"{audio_path.stem}_live.srt"
            generated, language = transcribe_audio(
                audio_path,
                language_hint=language_hint,
                preview_callback=self._background_preview_update,
                progress_callback=self._background_progress_update,
                warning_callback=self._background_warning,
                live_save_path=live_save_file,
                odia_selected=self.language_var.get().strip().casefold() == "odia",
            )
            self._run_in_main_thread(self._on_transcription_finished, generated, language)
        except Exception as exc:
            self._run_in_main_thread(self._on_transcription_failed, exc)

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
    mapping = {"english": "en", "hindi": "hi"}
    normalized = (value or "").strip().casefold()
    if not normalized or normalized == "auto detect":
        return None
    # For Odia/Oriya prefer auto-detect rather than passing an explicit 'or' code
    if normalized in {"odia", "oriya"}:
        return None
    return mapping.get(normalized)


def _is_unsupported_language_error(exc: Exception | None) -> bool:
    if exc is None:
        return False
    message = str(exc).strip().casefold()
    unsupported_markers = [
        "unsupported language",
        "language not supported",
        "invalid language",
        "unknown language",
    ]
    return any(marker in message for marker in unsupported_markers)


def _build_language_hints(language_hint: str | None) -> list[str | None]:
    hints: list[str | None] = []
    if language_hint is not None:
        hints.append(language_hint)
    # Try auto-detect, then English as a last resort
    hints.extend([None, "en"])
    return hints


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
    if not text:
        return False
    parts = re.findall(r"\w+", text, flags=re.UNICODE)
    if not parts:
        return False
    return all(_normalize_text(part) in FILLER_WORDS for part in parts)


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
        # Prefer converting audio to a consistent 16k mono WAV for fastest, deterministic transcription.
        ffmpeg_path = _find_ffmpeg_path()
        if not ffmpeg_path:
            return media_path
        temp_dir = Path(tempfile.gettempdir())
        output_path = temp_dir / f"{media_path.stem}_audio.wav"
        try:
            subprocess.run(
                [ffmpeg_path, "-y", "-i", str(media_path), "-vn", "-ac", "1", "-ar", "16000", str(output_path)],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return output_path
        except Exception:
            return media_path

    if suffix in {".mp4", ".mkv", ".avi", ".mov", ".mpeg", ".mpg"}:
        ffmpeg_path = _ensure_ffmpeg_path()
        if not ffmpeg_path:
            raise RuntimeError(
                "ffmpeg was not found. Please install ffmpeg or set the FFMPEG_PATH environment variable."
            )
        temp_dir = Path(tempfile.gettempdir())
        output_path = temp_dir / f"{media_path.stem}_audio.wav"
        command = [ffmpeg_path, "-y", "-i", str(media_path), "-vn", "-ac", "1", "-ar", "16000", str(output_path)]
        subprocess.run(
            command,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return output_path

    raise ValueError("Unsupported media file type.")


def _call_transcription_api(audio_path: Path, language_hint: str | None = None, timeout_seconds: int = 180) -> tuple[str, str]:
    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("Online transcription requires GEMINI_API_KEY or OPENAI_API_KEY.")

    api_base = os.getenv("OPENAI_API_BASE") or os.getenv("GEMINI_API_URL") or "https://api.openai.com"
    if api_base.endswith("/v1"):
        api_base = api_base[: -len("/v1")]
    endpoint = os.getenv("TRANSCRIPTION_URL") or f"{api_base.rstrip('/')}/v1/audio/transcriptions"
    model = os.getenv("TRANSCRIPTION_MODEL", "whisper-1")

    fields = {
        "model": model,
        "response_format": "srt",
        "temperature": "0.0",
    }
    if language_hint is not None:
        fields["language"] = language_hint

    audio_bytes = audio_path.read_bytes()
    mime_type = mimetypes.guess_type(audio_path.name)[0] or "application/octet-stream"
    body, content_type = _encode_multipart_formdata(fields, [("file", audio_path.name, mime_type, audio_bytes)])

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": content_type,
        "User-Agent": "SubtitleTranscriber/1.0",
    }
    request = urllib.request.Request(endpoint, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            response_body = response.read()
            decoded = response_body.decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Transcription API HTTP error: {exc.code} {exc.reason} - {body}") from exc
    except Exception as exc:
        raise RuntimeError(f"Transcription API request failed: {exc}") from exc

    if decoded.lstrip().startswith("{"):
        try:
            parsed = json.loads(decoded)
            if isinstance(parsed, dict) and parsed.get("error"):
                raise RuntimeError(f"Transcription API error: {parsed['error']}")
        except json.JSONDecodeError:
            pass

    return decoded, language_hint or "unknown"


def transcribe_audio(
    audio_path: Path,
    language_hint: str | None = None,
    preview_callback=None,
    progress_callback=None,
    warning_callback=None,
    live_save_path: Path | None = None,
    odia_selected: bool = False,
) -> tuple[str, str]:
    _ensure_ffmpeg_path()
    if progress_callback is not None:
        progress_callback(5, "Preparing audio for transcription...")

    srt_text, detected_language = _call_transcription_api(audio_path, language_hint=_sanitize_language_code(language_hint))

    if preview_callback is not None:
        preview_callback(srt_text)
    if progress_callback is not None:
        progress_callback(80, "Transcription complete, applying text correction...")

    preferred_language = None
    if odia_selected:
        preferred_language = "odia"
    elif language_hint:
        preferred_language = language_hint

    try:
        corrected = _correct_subtitles_with_gemini(srt_text, preferred_language=preferred_language)
        if corrected and corrected.strip():
            srt_text = corrected
            logger.info("Subtitle text corrected by Gemini.")
        else:
            logger.warning("Gemini correction returned no text; keeping original transcription.")
    except Exception as exc:
        logger.error("Subtitle correction failed: %s", exc, exc_info=True)
        logger.info("Proceeding with transcription output.")

    if progress_callback is not None:
        progress_callback(100, "Subtitle generation complete.")

    return srt_text, detected_language


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
