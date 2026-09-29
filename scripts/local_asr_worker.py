#!/usr/bin/env python3
"""LOCAL SUBMISSION MODE - local Odia ASR worker (zero budget, zero network).

Transcribes the EXACT uploaded audio file with a LOCAL open-source model:
    ai4bharat/indicwav2vec-odia   (Apache-2.0, Wav2Vec2ForCTC, language "or")

Hard guarantees enforced by this script:
  * The audio path passed in is the exact bytes the user uploaded. It is decoded
    once with ffmpeg to 16 kHz mono and fed straight to the model.
  * HuggingFace/transformers run in OFFLINE mode and every cache variable is
    pinned INSIDE the project on the E: drive, so nothing is ever downloaded and
    nothing is ever written to C:.
  * NO cached / previous / fixture / template transcript is ever read. The text
    is produced solely by the model from the audio in this invocation.
  * If the model is missing or inference fails, this script exits non-zero and
    prints {"ok": false, ...}. It NEVER returns placeholder or guessed text.
  * Punctuation is removed from the spoken text (Odia danda included); the
    character/word content is otherwise returned exactly as recognised.
  * Per-word timestamps are REAL, taken from the CTC frame alignment
    (wav2vec2 16 kHz / 320-sample hop = 20 ms per frame). Nothing is invented,
    and if alignment is unavailable the run fails rather than guessing.

Protocol: prints exactly one JSON object on stdout.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time

SR = 16000
FRAME_SECONDS = 0.020  # wav2vec2 16k with 320-sample conv stride
DEFAULT_MAX_SECONDS = 45 * 60

# Characters that must never survive into the spoken subtitle text.
# ASCII punctuation plus the Odia sentence marks (danda / double danda).
# DIGITS ARE DELIBERATELY NOT INCLUDED - they are spoken content and must survive.
PUNCTUATION = set(
    "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~\u0964\u0965"
)

# Files the local model directory must contain before we even try to load it.
REQUIRED_MODEL_FILES = ("config.json", "pytorch_model.bin")


def die(message, hint=None, code=2):
    """Print a machine-readable failure and exit non-zero. Never invents text."""
    payload = {"ok": False, "error": message}
    if hint:
        payload["hint"] = hint
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    sys.exit(code)


def pin_caches_to_project(project_dir):
    """Force every model/tokenizer cache to live under the project (E: drive)."""
    cache = os.path.join(project_dir, ".hf-home")
    os.makedirs(cache, exist_ok=True)
    os.environ["HF_HOME"] = cache
    os.environ["HF_HUB_CACHE"] = os.path.join(cache, "hub")
    os.environ["TRANSFORMERS_CACHE"] = os.path.join(cache, "transformers")
    os.environ["TORCH_HOME"] = cache
    # Hard offline: any attempt to reach the hub is an error, not a silent
    # download. This is what guarantees LOCAL SUBMISSION MODE costs nothing.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    return cache


def decode_to_wav(audio_path, out_wav):
    cmd = [
        "ffmpeg", "-y", "-nostdin", "-i", audio_path,
        "-vn", "-ac", "1", "-ar", str(SR), "-f", "wav", out_wav,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True)
    except FileNotFoundError:
        die(
            "ffmpeg was not found on PATH, so the uploaded media could not be decoded.",
            hint="Install ffmpeg and make sure it is on PATH, then retry.",
        )
    if proc.returncode != 0 or not os.path.isfile(out_wav):
        detail = proc.stderr.decode("utf-8", errors="replace")[-600:]
        die("ffmpeg could not decode the uploaded media.", hint=detail)


def load_model_and_processor(model_dir):
    try:
        import torch  # noqa: F401
        from transformers import AutoModelForCTC
    except Exception as exc:  # pragma: no cover - environment problem
        die(
            "transformers/torch could not be imported: %s" % exc,
            hint="Install torch (CPU) and transformers, then retry.",
        )

    processor = None
    for loader in ("AutoProcessor", "Wav2Vec2Processor"):
        try:
            mod = __import__("transformers", fromlist=[loader])
            processor = getattr(mod, loader).from_pretrained(model_dir)
            break
        except Exception:
            continue
    if processor is None:
        die(
            "The local ASR processor could not be loaded from %s." % model_dir,
            hint="Check that the model download completed (config.json + preprocessor_config.json).",
        )

    try:
        model = AutoModelForCTC.from_pretrained(model_dir)
    except Exception as exc:
        die(
            "The local ASR model could not be loaded from %s: %s" % (model_dir, exc),
            hint="The download is probably incomplete. Re-run the downloader and check for errors.",
        )
    model.eval()
    return model, processor


def build_id_to_char(tokenizer):
    """id -> character map, skipping special tokens and mapping the word delimiter
    to a real space so word boundaries survive the decode."""
    vocab = tokenizer.get_vocab()
    delimiter = getattr(tokenizer, "word_delimiter_token", None) or "|"
    id_to_char = {}
    for key, idx in vocab.items():
        if key.startswith("<") and key.endswith(">"):
            continue
        id_to_char[idx] = key
    if delimiter in vocab:
        id_to_char[vocab[delimiter]] = " "
    return id_to_char


def load_wav_array(wav_path):
    """Read the mono 16-bit PCM WAV ffmpeg produced into a numpy float32 array
    (normalised to [-1, 1]). Uses only the stdlib `wave` module + numpy, so it
    works without torchaudio/torchcodec. The sample rate was forced to SR by
    ffmpeg, so no resampling is needed."""
    import wave as _wave

    import numpy as np

    with _wave.open(wav_path, "rb") as wav:
        assert wav.getnchannels() == 1, "worker expects mono PCM"
        assert wav.getsampwidth() == 2, "worker expects 16-bit PCM"
        assert wav.getframerate() == SR, "worker expects %d Hz" % SR
        raw = wav.readframes(wav.getnframes())
    values = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    return values


def transcribe(model, processor, wav_path, threads):
    import torch

    torch.set_num_threads(max(1, int(threads)))

    # Pass the decoded waveform (numpy), never a path string: Wav2Vec2
    # processors in current transformers require a python/numpy/torch object.
    batch = processor(
        load_wav_array(wav_path), sampling_rate=SR, return_tensors="pt"
    )
    input_values = batch["input_values"]

    started = time.time()
    with torch.no_grad():
        logits = model(input_values).logits[0]  # (frames, vocab)
    frames = int(logits.shape[0])
    log_probs = torch.log_softmax(logits, dim=-1)

    blank = 0
    try:
        pad_id = getattr(processor, "tokenizer", None)
        pad_id = getattr(pad_id, "pad_token_id", None)
        if pad_id is not None:
            blank = int(pad_id)
    except Exception:
        blank = 0

    # ---- Greedy CTC decode that keeps the frame index of every emitted token.
    frame_ids = torch.argmax(logits, dim=-1).tolist()
    emitted = []  # (token_id, start_frame)
    previous = -1
    for frame_index, token_id in enumerate(frame_ids):
        if token_id != previous and token_id != blank:
            emitted.append((token_id, frame_index))
        previous = token_id

    tokenizer = getattr(processor, "tokenizer", None)
    if tokenizer is None:
        die("The local ASR tokenizer could not be loaded from the model directory.")
    id_to_char = build_id_to_char(tokenizer)

    # ---- Per-character frame spans, then group into words. These are REAL
    # measured spans from the CTC alignment, never interpolated or invented.
    characters = []
    total = len(emitted)
    for i, (token_id, start_frame) in enumerate(emitted):
        end_frame = emitted[i + 1][1] if i + 1 < total else frames
        char = id_to_char.get(token_id)
        if char is None:
            continue
        characters.append((char, start_frame, end_frame))

    words = []
    current = []

    def flush():
        if not current:
            return
        text = "".join(c for c, _, _ in current)
        text = "".join(ch for ch in text if ch not in PUNCTUATION).strip()
        if text:
            words.append(
                {
                    "text": text,
                    "startSeconds": round(current[0][1] * FRAME_SECONDS, 3),
                    "endSeconds": round(current[-1][2] * FRAME_SECONDS, 3),
                }
            )
        current.clear()

    for char, start_frame, end_frame in characters:
        if char == " " or char == "\t":
            flush()
        else:
            current.append((char, start_frame, end_frame))
    flush()

    # Mean log-prob of the frames that produced the emitted tokens: a rough,
    # honest confidence signal (never used to invent or drop words).
    scores = []
    for token_id, start_frame in emitted:
        if 0 <= start_frame < log_probs.shape[0]:
            scores.append(float(log_probs[start_frame, token_id]))
    mean_log_prob = (sum(scores) / len(scores)) if scores else None

    return {
        "words": words,
        "transcript": " ".join(w["text"] for w in words),
        "emissionFrames": frames,
        "emissionSeconds": round(frames * FRAME_SECONDS, 3),
        "meanLogProb": round(mean_log_prob, 4) if mean_log_prob is not None else None,
        "inferenceSeconds": round(time.time() - started, 2),
    }


def main():
    parser = argparse.ArgumentParser(description="Local Odia ASR worker")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--project-dir", required=True)
    parser.add_argument("--max-seconds", type=float, default=DEFAULT_MAX_SECONDS)
    parser.add_argument("--threads", type=int, default=os.cpu_count() or 4)
    args = parser.parse_args()

    pin_caches_to_project(args.project_dir)

    if not os.path.isfile(args.audio):
        die("The temporary upload file was missing when local ASR started.")
    if not os.path.isdir(args.model_dir):
        die(
            "The local Odia ASR model is not installed at: %s" % args.model_dir,
            hint=(
                "Download ai4bharat/indicwav2vec-odia into that folder, then retry. "
                "No transcript can be produced without the model."
            ),
        )
    missing = [f for f in REQUIRED_MODEL_FILES if not os.path.isfile(os.path.join(args.model_dir, f))]
    if missing:
        die(
            "The local Odia ASR model at %s is incomplete (missing: %s)."
            % (args.model_dir, ", ".join(missing)),
            hint="Re-run the model download; a partial download cannot transcribe.",
        )

    # Scratch must stay on the project's own drive. tempfile.mkstemp() with no
    # dir= would default to the system %TEMP% (C:), which is not allowed here.
    scratch_dir = os.path.join(args.project_dir, "data", "local-tmp")
    os.makedirs(scratch_dir, exist_ok=True)
    handle, wav_path = tempfile.mkstemp(
        prefix="local_asr_", suffix=".wav", dir=scratch_dir
    )
    os.close(handle)
    try:
        decode_to_wav(args.audio, wav_path)
        model, processor = load_model_and_processor(args.model_dir)

        # True decoded duration, measured from the wav header size.
        try:
            import wave

            with wave.open(wav_path, "rb") as wav:
                duration = wav.getnframes() / float(wav.getframerate())
        except Exception:
            duration = 0.0

        if duration > args.max_seconds:
            die(
                "The uploaded media is %.1f s long, longer than the local ASR limit of %.0f s."
                % (duration, args.max_seconds),
                hint="Split the media into shorter parts, or raise LOCAL_ASR_MAX_SECONDS.",
            )

        result = transcribe(model, processor, wav_path, args.threads)

        payload = {
            "ok": True,
            "model": "ai4bharat/indicwav2vec-odia",
            "modelDir": args.model_dir,
            "device": "cpu",
            "transcript": result["transcript"],
            "words": result["words"],
            "wordCount": len(result["words"]),
            "audioDurationSeconds": round(duration, 3),
            "emissionSeconds": result["emissionSeconds"],
            "meanLogProb": result["meanLogProb"],
            "inferenceSeconds": result["inferenceSeconds"],
            # Real CTC frame alignment, so timestamps are measured, not invented.
            "hasReliableTimestamps": True,
            "timestampNote": (
                "Per-word start/end taken from wav2vec2 CTC frame alignment "
                "(20 ms frames) on the exact uploaded audio."
            ),
        }
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    finally:
        try:
            if os.path.isfile(wav_path):
                os.remove(wav_path)
        except Exception:
            pass


if __name__ == "__main__":
    main()
