import importlib.util
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "main.py"

spec = importlib.util.spec_from_file_location("subtitle_splitter", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class MediaPickerTests(unittest.TestCase):
    def test_media_filter_matches_common_audio_and_video_extensions(self):
        filetypes = module._build_media_filetypes()
        self.assertTrue(module._path_matches_filter("song.mp3", filetypes))
        self.assertTrue(module._path_matches_filter("movie.mp4", filetypes))
        self.assertTrue(module._path_matches_filter("clip.webm", filetypes))
        self.assertFalse(module._path_matches_filter("notes.txt", filetypes))

    def test_media_validation_accepts_supported_extensions_and_rejects_unsupported_ones(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            mp3_path = Path(temp_dir) / "song.mp3"
            mp3_path.write_bytes(b"fake audio")
            mp4_path = Path(temp_dir) / "movie.mp4"
            mp4_path.write_bytes(b"fake video")

            self.assertEqual(module.detect_media_kind(str(mp3_path)), "audio")
            self.assertEqual(module.detect_media_kind(str(mp4_path)), "video")

        with tempfile.TemporaryDirectory() as temp_dir:
            txt_path = Path(temp_dir) / "notes.txt"
            txt_path.write_bytes(b"not a media file")
            with self.assertRaises(ValueError):
                module.detect_media_kind(str(txt_path))


if __name__ == "__main__":
    unittest.main()
