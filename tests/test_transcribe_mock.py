import importlib.util
import unittest
import wave
import os
from pathlib import Path
from unittest.mock import MagicMock

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "main.py"

spec = importlib.util.spec_from_file_location("subtitle_transcriber", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


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
        # Simulate detection: if language is None, pretend it's Odia ('or')
        detected = "or" if language is None else language
        words = [MockWord("Hello", 0.0, 0.5), MockWord("world", 0.6, 1.0)]
        segments = [MockSegment(words)]
        info = MockInfo(detected)
        return segments, info


class TranscriptionIntegrationTests(unittest.TestCase):
    def test_transcribe_with_mock_model_generates_srt(self):
        # Prepare 1s silent WAV at 16k
        temp_dir = Path(os.getcwd()) / "tests" / "tmp"
        temp_dir.mkdir(parents=True, exist_ok=True)
        wav_path = temp_dir / "silent_16k.wav"
        with wave.open(str(wav_path), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(16000)
            wf.writeframes(b"\x00\x00" * 16000)

        # Patch model loader to return mock
        module._get_faster_whisper_model = lambda model_size, cpu_threads, num_workers: MockModel()

        # Ensure Odia selection maps to auto-detect (None)
        language_hint = module._to_whisper_language("Odia")
        self.assertIsNone(language_hint)

        generated, language = module.transcribe_audio(wav_path, language_hint=language_hint, preview_callback=None)
        self.assertIn("Hello", generated)
        self.assertIn("world", generated)
        self.assertTrue(isinstance(generated, str))
        self.assertTrue(language in ("or", "unknown", None))

    def test_transcribe_mp3_file_pipeline(self):
        # Create a file named .mp3 but with WAV content for the pipeline
        temp_dir = Path(os.getcwd()) / "tests" / "tmp"
        temp_dir.mkdir(parents=True, exist_ok=True)
        mp3_path = temp_dir / "silent_fake.mp3"
        with wave.open(str(mp3_path), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(16000)
            wf.writeframes(b"\x00\x00" * 16000)

        # Patch model loader to return mock and ensure ffmpeg is not used
        module._get_faster_whisper_model = lambda model_size, cpu_threads, num_workers: MockModel()
        module._find_ffmpeg_path = lambda: None

        progress_calls = []
        def progress_callback(percent, status):
            progress_calls.append((percent, status))

        generated, language = module.transcribe_audio(mp3_path, language_hint=None, preview_callback=None, progress_callback=progress_callback)
        self.assertIn("Hello", generated)
        self.assertIn("world", generated)
        self.assertTrue(any(isinstance(percent, int) for percent, _ in progress_calls))

    def test_no_segments_does_not_write_srt(self):
        temp_dir = Path(os.getcwd()) / "tests" / "tmp"
        temp_dir.mkdir(parents=True, exist_ok=True)
        wav_path = temp_dir / "silent_16k.wav"
        with wave.open(str(wav_path), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(16000)
            wf.writeframes(b"\x00\x00" * 16000)

        module._get_faster_whisper_model = lambda model_size, cpu_threads, num_workers: MockModelEmpty()
        module._find_ffmpeg_path = lambda: None

        class MockModelEmpty:
            def transcribe(self, filepath, word_timestamps=True, language=None, **kwargs):
                return [], MockInfo("en")

        live_path = temp_dir / "silent_16k_live.srt"
        if live_path.exists():
            live_path.unlink()

        generated, language = module.transcribe_audio(wav_path, language_hint=None, preview_callback=None, progress_callback=None, live_save_path=live_path)
        self.assertEqual(generated, "")
        self.assertFalse(live_path.exists())


if __name__ == "__main__":
    unittest.main()
