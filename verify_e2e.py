"""End-to-end verification for Gemini correction pipeline (no real API calls)."""
import importlib.util
import json
import tempfile
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("main", ROOT / "main.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def check(name: str, condition: bool, detail: str = "") -> None:
    status = "PASS" if condition else "FAIL"
    print(f"{status}: {name}" + (f" — {detail}" if detail else ""))
    if not condition:
        raise AssertionError(name)


def test_parse_gemini_formats() -> None:
    cases = [
        ("json array", json.dumps(["Hello world", "Second line"]), 2, ["Hello world", "Second line"]),
        ("numbered list", "1. Hello world\n2. Second line", 2, ["Hello world", "Second line"]),
    ]
    for label, response, count, expected in cases:
        result = module._parse_gemini_subtitle_array(response, count)
        check(f"parse {label}", result == expected, str(result))

    # Markdown-fenced JSON is a common Gemini response shape.
    fenced = "```json\n" + json.dumps(["A", "B"]) + "\n```"
    result = module._parse_gemini_subtitle_array(fenced, 2)
    check("parse markdown fenced json", result == ["A", "B"], str(result))


def test_correction_preserves_timestamps() -> None:
    srt_in = (
        "1\n00:00:00,000 --> 00:00:01,000\nHello wrld\n\n"
        "2\n00:00:01,000 --> 00:00:02,000\nSecnd line\n"
    )
    module._call_gemini_api = lambda prompt, timeout_seconds=30: json.dumps(
        ["Hello world", "Second line"]
    )
    out = module._correct_subtitles_with_gemini(srt_in, preferred_language="english")
    check("timestamps preserved", "00:00:00,000 --> 00:00:01,000" in out)
    check("corrected text applied", "Hello world" in out and "Second line" in out)
    check("original typos replaced", "wrld" not in out and "Secnd" not in out)


class MockWord:
    def __init__(self, word, start, end):
        self.word = word
        self.start = start
        self.end = end


class MockSegment:
    def __init__(self, words):
        self.words = words


class MockInfo:
    def __init__(self, language):
        self.language = language


class MockModel:
    def transcribe(self, filepath, word_timestamps=True, language=None, **kwargs):
        words = [MockWord("Hello", 0.0, 0.5), MockWord("world", 0.6, 1.0)]
        return [MockSegment(words)], MockInfo("en")


def _make_silent_wav(path: Path) -> None:
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(b"\x00\x00" * 16000)


def test_live_save_and_fallback() -> None:
    module._get_faster_whisper_model = lambda *args: MockModel()

    tmpdir = Path(tempfile.mkdtemp())
    wav = tmpdir / "test.wav"
    _make_silent_wav(wav)

    module._call_gemini_api = lambda prompt, timeout_seconds=30: json.dumps(
        ["Corrected hello", "Corrected world"]
    )
    live = tmpdir / "live.srt"
    generated, _ = module.transcribe_audio(wav, language_hint="en", live_save_path=live)
    content = live.read_text(encoding="utf-8") if live.exists() else ""
    check("live save file exists", live.exists())
    check("live save has corrected text", "Corrected hello" in content, content[:200])
    check("live save has timestamps", "00:00:00,000" in content)
    check("returned text is corrected", "Corrected hello" in generated)

    module._call_gemini_api = lambda *args, **kwargs: (_ for _ in ()).throw(
        RuntimeError("API down")
    )
    fallback, _ = module.transcribe_audio(wav, language_hint="en")
    check("gemini failure fallback", "Hello" in fallback)

    module._call_gemini_api = lambda *args, **kwargs: json.dumps(["", ""])
    empty_fix, _ = module.transcribe_audio(wav, language_hint="en")
    check("empty gemini keeps original", "Hello" in empty_fix)


def test_prompt_building() -> None:
    blocks = [{"index": 1, "timestamps": "00:00:00,000 --> 00:00:01,000", "text": "test"}]
    prompt = module._build_gemini_prompt_for_subtitles(blocks, preferred_language="odia")
    check("odia prompt mentions Odia script", "Odia" in prompt or "odia" in prompt.lower())
    check("prompt includes input subtitles", "test" in prompt)
    check("prompt forbids timestamps in output", "Do NOT return timestamps" in prompt)


def test_partial_gemini_response_preserves_all_blocks() -> None:
    srt_in = (
        "1\n00:00:00,000 --> 00:00:01,000\nOne\n\n"
        "2\n00:00:01,000 --> 00:00:02,000\nTwo\n\n"
        "3\n00:00:02,000 --> 00:00:03,000\nThree\n"
    )
    module._call_gemini_api = lambda prompt, timeout_seconds=30: json.dumps(["Corrected one"])
    out = module._correct_subtitles_with_gemini(srt_in)
    check("partial response keeps block count", out.count("-->") == 3)
    check("partial response applies first correction", "Corrected one" in out)
    check("partial response keeps missing originals", "Two" in out and "Three" in out)


def main() -> None:
    print("=== E2E Verification ===")
    test_parse_gemini_formats()
    test_correction_preserves_timestamps()
    test_partial_gemini_response_preserves_all_blocks()
    test_live_save_and_fallback()
    test_prompt_building()
    print("\nAll verification checks passed.")


if __name__ == "__main__":
    main()
