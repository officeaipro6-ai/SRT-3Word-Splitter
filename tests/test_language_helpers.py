import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "main.py"

spec = importlib.util.spec_from_file_location("subtitle_transcriber", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class LanguageHelperTests(unittest.TestCase):
    def test_to_whisper_language_maps_odia_and_oriya(self):
        self.assertIsNone(module._to_whisper_language("Odia"))
        self.assertIsNone(module._to_whisper_language("Oriya"))
        self.assertEqual(module._to_whisper_language("English"), "en")
        self.assertIsNone(module._to_whisper_language("Auto Detect"))

    def test_unsupported_language_error_detects_whisper_messages(self):
        self.assertTrue(module._is_unsupported_language_error(ValueError("Unsupported language: or")))
        # Odia-specific messages are intentionally NOT treated as 'unsupported' to allow direct processing.
        self.assertFalse(module._is_unsupported_language_error(RuntimeError("language 'or' is not supported")))
        self.assertFalse(module._is_unsupported_language_error(RuntimeError("file not found")))
        self.assertFalse(module._is_unsupported_language_error(None))


if __name__ == "__main__":
    unittest.main()
