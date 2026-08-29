#!/usr/bin/env python3
"""
Stage 2b: transcribe and translate lyrics, so a reviewer can judge content
they cannot understand by ear.

Writes lyrics into tools/work/screened.json in place, and review.py shows them
next to the audio player.

WHY THIS STAGE EXISTS
---------------------
The instrument detector cannot see the most dangerous content in this corpus.
Jihadi nasheeds are overwhelmingly UNACCOMPANIED VOCAL, so they pass every
instrumentation check looking exactly like the ideal catalog entry. Measured on
this project's own harvest, ~9% of the freely-licensed archive.org candidates
carry markers of that genre in the title alone — and titles undercount, because
plenty of them have innocuous titles.

The reviewer for this catalog does not read Arabic, which is the language of
most of the supply. Without lyrics in front of them, the honest options were to
reject every Arabic track (throwing away most of the corpus) or to approve
audio whose words nobody in the loop understood. Neither is acceptable, so:
transcribe, translate, and put the words on the screen.

Whisper's `--translate` goes straight from Arabic audio to English text in one
pass, which is exactly the shape this needs.

WHAT IT IS NOT
--------------
Machine translation of sung, poetic, heavily-reverbed Arabic is ROUGH. Treat
the output as a lead, never as a clearance: it is good enough to recognise
"praise of a fighting group" or "romance", which is what we are screening for,
and not good enough to certify a track as fine. A track whose translation is
unreadable should be rejected, not guessed at.

SETUP
    brew install whisper-cpp
    # model downloads to tools/models/ automatically on first run

USAGE
    python3 tools/transcribe.py             # everything screened, not yet done
    python3 tools/transcribe.py --limit 20
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import unicodedata
import sys
from pathlib import Path
from typing import Any

WORK = Path(__file__).parent / "work"
AUDIO = WORK / "audio"
MODELS = Path(__file__).parent / "models"
SCREENED = WORK / "screened.json"

MODEL_NAME = "ggml-small.bin"
MODEL_URL = f"https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{MODEL_NAME}"

# Whisper is slow and lyrics repeat. Two minutes is plenty to tell what a
# nasheed is about, and caps the cost of a track that turns out to be an hour
# long lecture.
MAX_SECONDS = 120

# Content that disqualifies under the rubric, phrased as things that show up in
# an English translation. Same principle as the title markers in screen.py:
# these are a REASON TO READ CAREFULLY, never an automatic verdict. A nasheed
# legitimately about patience under oppression will trip several of them.
# Production houses. This is the single strongest signal available, and it was
# found by accident: the first three transcriptions all returned an intro
# jingle naming the studio rather than lyrics, and two of those studios —
# Al-Bashair and Munasiroon — are known jihadi nasheed media outfits.
#
# A nasheed's producer identifies its politics far more reliably than its words
# do, because the words are poetry and the studio ident is a brand. Whisper
# picks the ident up precisely because it is spoken clearly at the start.
MEDIA_FOUNDATIONS = [
    "bashair", "basha'ir", "bashā'ir", "البشائر",
    "munasiroon", "munasirun", "مناصرون",
    "ajnad", "أجناد",
    "al-furqan", "furqan", "الفرقان",
    "al-hayat media", "hayat media", "الحياة",
    "al-battar", "battar", "البتار",
    "manba al-jihad", "manbaa", "منبر",
    "ashhad", "أشهد",
    "al-ghuraba", "ghuraba", "الغرباء",
    "nur al-huda", "itisam", "اعتصام",
    "amaq", "أعماق",
]

CONTENT_FLAGS = {
    "media-foundation": MEDIA_FOUNDATIONS,
    # Whisper annotates non-speech audio events in brackets, and it turns out
    # to be one of the most decisive signals available: the al-Shabaab track in
    # this corpus transcribed as "(Explosion)" before a single word. Gunfire
    # and explosions layered into a nasheed are a production choice, not an
    # accident of the recording.
    "battle-sounds": [
        "(explosion)", "(explosions)", "(gunshot", "(gunfire", "(gun shot",
        "(machine gun", "(bomb", "(blast", "(shooting", "(weapon",
        "(sound of gunfire", "(war sounds", "(marching",
    ],
    "violence": [
        "kill", "slay", "slaughter", "behead", "blood", "sword", "rifle", "gun",
        "bomb", "explode", "war", "battle", "fight", "army", "soldier", "weapon",
        "conquer", "raid", "avenge", "revenge", "destroy them", "death to",
    ],
    "martyrdom": [
        "martyr", "martyrdom", "shahid", "sacrifice my life", "die for", "paradise awaits",
    ],
    "group-praise": [
        "islamic state", "caliphate", "our state", "brigade", "battalion",
        "mujahideen", "jihad", "taliban", "al-qaeda", "shabaab",
    ],
    "romance": [
        "her lips", "his lips", "kiss", "lover", "romance", "your beauty",
        "in love with", "embrace her", "embrace him", "desire you",
    ],
}


def ensure_model() -> Path:
    MODELS.mkdir(exist_ok=True)
    path = MODELS / MODEL_NAME
    if path.exists() and path.stat().st_size > 100_000_000:
        return path
    print(f"downloading {MODEL_NAME} (~466 MB, one time) ...")
    result = subprocess.run(["curl", "-sSL", "-o", str(path), MODEL_URL])
    if result.returncode != 0 or not path.exists():
        print("model download failed", file=sys.stderr)
        raise SystemExit(1)
    return path


def to_wav16k(src: Path, dest: Path) -> bool:
    """whisper.cpp requires 16 kHz mono WAV and fails unhelpfully otherwise."""
    if dest.exists():
        return True
    result = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(src),
         "-t", str(MAX_SECONDS), "-ac", "1", "-ar", "16000", "-f", "wav", str(dest)],
        capture_output=True,
    )
    return result.returncode == 0 and dest.exists()


def run_whisper(wav: Path, model: Path, translate: bool) -> str | None:
    """
    Returns plain text, or None if whisper failed.

    `--translate` asks for English output regardless of the source language,
    which is the whole point here — the reviewer needs to know what the words
    MEAN, not what they sound like.
    """
    args = [
        "whisper-cli", "-m", str(model), "-f", str(wav),
        "--output-txt", "--no-timestamps", "--print-progress", "false",
        # Whisper falls into degenerate repetition on sung, repetitive audio —
        # the first real run returned one intro line repeated for two minutes.
        # `-mc 0` drops cross-window text conditioning, which is the standard
        # mitigation, and `-et` bails out of a window whose entropy says it has
        # stopped producing new information.
        "-mc", "0", "-et", "2.6",
        "-of", str(wav.with_suffix("")),
    ]
    if translate:
        args.append("--translate")

    result = subprocess.run(args, capture_output=True, text=True, timeout=900)
    out = wav.with_suffix(".txt")
    if result.returncode != 0 or not out.exists():
        return None
    text = out.read_text(errors="replace").strip()
    out.unlink(missing_ok=True)
    return text or None


def detect_language(wav: Path, model: Path) -> str | None:
    """whisper-cli prints the detected language to stderr as
    'auto-detected language: ar (p = 0.98)'."""
    result = subprocess.run(
        ["whisper-cli", "-m", str(model), "-f", str(wav), "--detect-language"],
        capture_output=True, text=True, timeout=300,
    )
    match = re.search(r"auto-detected language:\s*([a-z]{2})", result.stderr + result.stdout)
    return match.group(1) if match else None


def _normalise(text: str) -> str:
    """
    Fold diacritics before matching.

    Whisper romanises Arabic with macrons and apostrophes — "Al-Bashā'ir", not
    "Al-Bashair" — so a plain substring list silently misses the exact studio
    idents it was written for. This already caused one regression where a track
    produced by Al-Bashair came back clean. Normalise instead of trying to
    enumerate every spelling.
    """
    decomposed = unicodedata.normalize("NFKD", text.lower())
    stripped = "".join(c for c in decomposed if not unicodedata.combining(c))
    return stripped.replace("'", "").replace("\u2019", "").replace("-", " ")


def content_flags(english: str) -> dict[str, list[str]]:
    low = _normalise(english)
    found: dict[str, list[str]] = {}
    for category, words in CONTENT_FLAGS.items():
        hits = [w for w in words if _normalise(w) in low]
        if hits:
            found[category] = hits
    return found


LYRIC_FIELDS = ("lyrics_english", "lyrics_language", "lyrics_flags", "lyrics_model")


def save_lyrics(rows: list[dict[str, Any]]) -> None:
    """Write ONLY the lyric fields back, merged onto whatever is on disk now.

    The mirror of save_screened() in screen.py: screening may have analysed new
    tracks while whisper was running, and overwriting the file with the list we
    loaded at startup would discard them."""
    on_disk: dict[str, dict[str, Any]] = {}
    if SCREENED.exists():
        try:
            for row in json.loads(SCREENED.read_text()):
                if row.get("key"):
                    on_disk[row["key"]] = row
        except json.JSONDecodeError:
            pass

    for row in rows:
        key = row.get("key")
        if not key:
            continue
        target = on_disk.setdefault(key, row)
        for field in LYRIC_FIELDS:
            if field in row:
                target[field] = row[field]

    tmp = SCREENED.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(list(on_disk.values()), indent=1, ensure_ascii=False))
    tmp.replace(SCREENED)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--redo", action="store_true")
    args = parser.parse_args()

    if not shutil.which("whisper-cli"):
        print("whisper-cli not found. Install it with:  brew install whisper-cpp", file=sys.stderr)
        return 1
    if not SCREENED.exists():
        print("No screened.json — run screen.py first.", file=sys.stderr)
        return 1

    model = ensure_model()
    rows = json.loads(SCREENED.read_text())

    # Only tracks a reviewer might actually accept. Transcribing something the
    # detector already called instrumental is wasted minutes.
    todo = [
        r for r in rows
        if r.get("status") == "screened"
        and r.get("instrumentation_guess") in ("voice_only", "voice_duff", "unclear")
        and (args.redo or not r.get("lyrics_english"))
    ]
    if args.limit:
        todo = todo[: args.limit]

    print(f"{len(todo)} tracks to transcribe (~1-2 min each)\n")

    by_key = {r.get("key"): r for r in rows}

    for index, row in enumerate(todo, 1):
        print(f"[{index}/{len(todo)}] {row['title'][:58]}")
        src = AUDIO / (row.get("local_audio") or "")
        if not src.exists():
            print("  ! cached audio missing")
            continue

        wav = AUDIO / f"{src.stem}.whisper.wav"
        if not to_wav16k(src, wav):
            print("  ! decode failed")
            continue

        try:
            language = detect_language(wav, model)
            english = run_whisper(wav, model, translate=True)
        except subprocess.TimeoutExpired:
            print("  ! whisper timed out")
            wav.unlink(missing_ok=True)
            continue

        target = by_key.get(row.get("key"))
        if target is None:
            continue

        target["lyrics_language"] = language
        target["lyrics_english"] = english
        target["lyrics_flags"] = content_flags(english or "")
        target["lyrics_model"] = MODEL_NAME

        wav.unlink(missing_ok=True)

        flags = target["lyrics_flags"]
        preview = (english or "").replace("\n", " ")[:100]
        print(f"  [{language}] {preview}")
        if flags:
            print(f"  !! CONTENT FLAGS: {', '.join(flags)}")

        save_lyrics(rows)

    save_lyrics(rows)

    done = [r for r in rows if r.get("lyrics_english")]
    flagged = [r for r in done if r.get("lyrics_flags")]
    print(f"\n{len(done)} transcribed, {len(flagged)} carrying content flags")
    print("\nNext: python3 tools/review.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
