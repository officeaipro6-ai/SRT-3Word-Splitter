#!/usr/bin/env python3
"""Download ai4bharat/indicwav2vec-odia for LOCAL SUBMISSION MODE.

Deliberately minimal and safe:
  * Requires HF_TOKEN in the environment of the process that runs it. It is
    never read from a repo file, never printed, never written to disk by this
    script, and never committed.
  * ALL caches are pinned inside the project drive (HF_HOME etc. below), so
    nothing is written to C:\\ or Downloads or anywhere outside the project.
  * Writes ONLY the files the local worker needs into
    E:\\Odia-SRT-App\\models\\indicwav2vec-odia .
  * Refuses to run if a token is missing and refuses to continue on any error
    (no partial-download transcripts).

Usage (one shell, your own session so the token never enters this chat):
    $env:HF_TOKEN="hf_..."          # Windows PowerShell
    python E:/Odia-SRT-App/scripts/download_local_odia_model.py
The script finishes with a file list + byte count; it never echoes the token.
"""
import os
import sys

PROJECT_DIR = r"E:\Odia-SRT-App"
MODEL_ID = "ai4bharat/indicwav2vec-odia"
MODEL_DIR = os.path.join(PROJECT_DIR, "models", "indicwav2vec-odia")
CACHE_DIR = os.path.join(PROJECT_DIR, ".hf-model-cache")

# Force every Hugging Face / transformers / torch cache onto the E: project
# drive. Nothing may land on C:\ or in Downloads.
os.environ["HF_HOME"] = CACHE_DIR
os.environ["HF_HUB_CACHE"] = os.path.join(CACHE_DIR, "hub")
os.environ["HUGGINGFACE_HUB_CACHE"] = os.path.join(CACHE_DIR, "hub")
os.environ["TRANSFORMERS_CACHE"] = os.path.join(CACHE_DIR, "transformers")
os.environ["TORCH_HOME"] = os.path.join(CACHE_DIR, "torch")
os.makedirs(CACHE_DIR, exist_ok=True)

NEEDED = [
    "config.json",
    "pytorch_model.bin",
    "vocab.json",
    "dict.ltr.txt",
    "preprocessor_config.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "README.md",
]
IGNORE = ["topk-500000_lm.binary", "unigrams_500000.txt"]


def main():
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN")
    if not token:
        sys.exit(
            "FATAL: HF_TOKEN is not set in this shell. Set it (e.g. "
            "$env:HF_TOKEN=\"hf_...\") and re-run. The token is never shown or saved."
        )

    from huggingface_hub import snapshot_download

    print(f"[verify] token present, fetching metadata for {MODEL_ID} (token never shown)")
    from huggingface_hub import HfApi

    info = HfApi().model_info(MODEL_ID, token=token)
    print(f"[verify] repo         : {info.id}")
    print(f"[verify] license      : {getattr(info.cardData, 'license', '<none>')}")
    print(f"[verify] gated        : {info.gated}")
    print(f"[verify] sha          : {info.sha}")

    print(f"[download] writing ONLY into {MODEL_DIR}")
    snapshot_download(
        repo_id=MODEL_ID,
        local_dir=MODEL_DIR,
        token=token,
        allow_patterns=NEEDED,
        ignore_patterns=IGNORE,
        max_workers=4,
    )

    total = 0
    missing = [f for f in NEEDED if not os.path.isfile(os.path.join(MODEL_DIR, f))]
    if missing:
        sys.exit(f"FATAL: download incomplete, missing: {missing}. Fix before testing.")
    for f in NEEDED:
        p = os.path.join(MODEL_DIR, f)
        size = os.path.getsize(p)
        total += size
        print(f"   {size:>14}  {f}")
    print(f"[download] DONE. {len(NEEDED)} files, {total / (1024**3):.2f} GiB, in {MODEL_DIR}")
    print("You can now run the real LOCAL SUBMISSION MODE test.")


if __name__ == "__main__":
    main()