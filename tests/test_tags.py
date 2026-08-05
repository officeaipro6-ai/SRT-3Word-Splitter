import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "main.py"

spec = importlib.util.spec_from_file_location("subtitle_splitter", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class TagHandlingTests(unittest.TestCase):
    def test_non_speech_tokens_become_tagged_subtitles(self):
        words = [{"word": "[music]", "start": 0, "end": 1000}]
        chunks = module.build_subtitle_segments(words, max_words=3, pause_threshold_ms=700)
        self.assertEqual(len(chunks), 1)
        self.assertIn("<MUSIC>", chunks[0]["text"])

    def test_tags_are_preserved_while_splitting_spoken_text(self):
        words = [
            {"word": "Hello", "start": 0, "end": 300},
            {"word": "there", "start": 300, "end": 600},
            {"word": "[laugh]", "start": 600, "end": 900},
            {"word": "nice", "start": 900, "end": 1200},
            {"word": "day", "start": 1200, "end": 1500},
        ]
        chunks = module.build_subtitle_segments(words, max_words=3, pause_threshold_ms=700)
        self.assertTrue(any("<LAUGH>" in chunk["text"] for chunk in chunks))
        self.assertTrue(any("Hello there" in chunk["text"] for chunk in chunks))
        self.assertTrue(any("nice day" in chunk["text"] for chunk in chunks))


if __name__ == "__main__":
    unittest.main()