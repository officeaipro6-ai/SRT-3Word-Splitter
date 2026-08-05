import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "main.py"

spec = importlib.util.spec_from_file_location("subtitle_splitter", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_punctuation_boundaries_are_preferred():
    words = [
        {"word": "Hello", "start": 0, "end": 400},
        {"word": "world,", "start": 400, "end": 800},
        {"word": "this", "start": 900, "end": 1400},
        {"word": "is", "start": 1400, "end": 1800},
        {"word": "a", "start": 2000, "end": 2400},
        {"word": "natural", "start": 2400, "end": 3000},
        {"word": "pause!", "start": 3300, "end": 3700},
        {"word": "Keep", "start": 4000, "end": 4500},
        {"word": "going.", "start": 4500, "end": 5000},
    ]
    chunks = module.build_subtitle_segments(words, max_words=3, pause_threshold_ms=700)
    assert [chunk["text"] for chunk in chunks[:2]] == ["Hello world,", "this is a"]


def test_no_chunk_exceeds_the_word_limit():
    words = [
        {"word": "one", "start": 0, "end": 300},
        {"word": "two", "start": 300, "end": 600},
        {"word": "three", "start": 600, "end": 900},
        {"word": "four", "start": 900, "end": 1200},
        {"word": "five", "start": 1200, "end": 1500},
        {"word": "six", "start": 1500, "end": 1800},
    ]
    chunks = module.build_subtitle_segments(words, max_words=3, pause_threshold_ms=700)
    assert all(module._count_words(chunk["text"]) <= 3 for chunk in chunks)


def test_media_filter_matches_common_audio_and_video_extensions():
    filetypes = module._build_media_filetypes()
    assert module._path_matches_filter("song.mp3", filetypes)
    assert module._path_matches_filter("movie.mp4", filetypes)
    assert module._path_matches_filter("clip.webm", filetypes)
    assert not module._path_matches_filter("notes.txt", filetypes)
