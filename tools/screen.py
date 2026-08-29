#!/usr/bin/env python3
"""
Stage 2: download each candidate and decide, by signal analysis, whether it
contains a melodic instrument.

Writes tools/work/screened.json and caches audio in tools/work/audio/.

WHAT THIS STAGE IS AND IS NOT
-----------------------------
This is a FILTER, not a verdict. Its job is to throw away the obvious
failures so a human does not have to sit through eighty tracks with a guitar
in them. Everything it passes still goes to review.py for a person to listen
to. Nothing reaches the catalog on a machine's say-so — that is the whole
reason `verification_status` exists in the schema.

It is deliberately biased toward FALSE POSITIVES (flagging clean audio as
having instruments). A clean track wrongly flagged costs one human listen. An
instrumental track wrongly passed, if a reviewer is tired, ends up in a
catalog that promises it is not there. Those errors are not symmetric, so the
thresholds are not either.

HOW IT WORKS
------------
YAMNet, Google's AudioSet classifier, over 0.96-second frames. AudioSet has
exactly the classes this problem needs — "Singing", "Choir", "Chant",
"A capella", "Drum", "Guitar", "Violin, fiddle", "Synthesizer" and ~500 more.
We group its 521 labels into three buckets (see LABELS below) and ask a
simple question per frame: is there melodic-instrument energy here?

The duff problem: AudioSet has no "duff" or "frame drum" class. A duff
registers as "Drum", "Drum kit", "Tabla" or "Hand clapping" — the same labels
a haram drum machine produces. So percussion is NEVER auto-cleared: any track
with meaningful percussion energy is routed to a human with the timestamps
marked. Distinguishing a frame drum from a drum kit is a listening job, and
pretending otherwise would be the one place this pipeline could quietly put
something wrong in the catalog.

SETUP
    python3.12 -m venv tools/.venv
    tools/.venv/bin/pip install tensorflow tensorflow-hub soundfile numpy resampy
    tools/.venv/bin/python tools/screen.py
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

WORK = Path(__file__).parent / "work"
AUDIO = WORK / "audio"
AUDIO.mkdir(parents=True, exist_ok=True)
CANDIDATES = WORK / "candidates.json"
SCREENED = WORK / "screened.json"

# YAMNet class names grouped by what they mean for the rubric. Matched as
# substrings against AudioSet display names, lowercased.
LABELS = {
    # Disqualifying on sight: a pitched instrument.
    "melodic": [
        "guitar", "piano", "keyboard (musical)", "organ", "violin", "fiddle", "cello",
        "double bass", "harp", "banjo", "mandolin", "ukulele", "sitar", "zither",
        "plucked string instrument", "bowed string instrument", "string section",
        "orchestra", "brass instrument", "trumpet", "trombone", "french horn", "tuba",
        "saxophone", "clarinet", "flute", "oboe", "bassoon", "wind instrument",
        "woodwind instrument", "harmonica", "accordion", "bagpipes", "synthesizer",
        "electronic organ", "sampler", "theremin", "bass guitar", "electric piano",
        "steel guitar", "slide guitar", "harpsichord", "vibraphone", "marimba",
        "xylophone", "glockenspiel", "steelpan", "mallet percussion", "bell",
        "chime", "tubular bells", "cowbell", "gong", "singing bowl",
    ],
    # Voice. Presence is expected and good.
    "voice": [
        "singing", "choir", "chant", "mantra", "a capella", "male singing",
        "female singing", "child singing", "humming", "yodeling", "speech",
        "male speech", "female speech", "narration", "vocal music",
    ],
    # Percussion. Never auto-cleared — see the duff problem above.
    "percussion": [
        "drum", "drum kit", "bass drum", "snare drum", "tabla", "tambourine",
        "hand clapping", "percussion", "timpani", "cymbal", "hi-hat", "rimshot",
        "drum machine", "drum roll", "wood block", "maracas", "rattle",
    ],
}

# A frame counts as containing an instrument at this score. Set low on
# purpose: see the false-positive note in the docstring.
MELODIC_FRAME_THRESHOLD = 0.20
# Share of frames that must be flagged before the whole track is called
# instrumental. A stray 1-second flag on an otherwise clean recording is
# usually a detector artefact, not an oud.
MELODIC_TRACK_RATIO = 0.06
PERCUSSION_FRAME_THRESHOLD = 0.25
PERCUSSION_TRACK_RATIO = 0.04

DETECTOR_VERSION = "yamnet-1/threshold-0.20"


def load_yamnet():
    try:
        import tensorflow_hub as hub  # noqa: PLC0415
    except ImportError:
        print(
            "tensorflow-hub is not installed. Run:\n"
            "  python3.12 -m venv tools/.venv\n"
            "  tools/.venv/bin/pip install tensorflow tensorflow-hub soundfile numpy resampy\n"
            "  tools/.venv/bin/python tools/screen.py",
            file=sys.stderr,
        )
        raise SystemExit(2)
    print("loading YAMNet ...")
    model = hub.load("https://tfhub.dev/google/yamnet/1")
    import csv  # noqa: PLC0415

    path = model.class_map_path().numpy().decode("utf-8")
    with open(path) as handle:
        names = [row["display_name"].lower() for row in csv.DictReader(handle)]
    return model, names


def bucket_indices(class_names: list[str]) -> dict[str, list[int]]:
    out: dict[str, list[int]] = {}
    for bucket, needles in LABELS.items():
        out[bucket] = [
            i for i, name in enumerate(class_names) if any(needle in name for needle in needles)
        ]
    return out


def resolve_download_url(candidate: dict[str, Any]) -> str | None:
    """
    Candidates from Commons and Openverse already carry a direct file URL.
    archive.org items do not — they are containers that may hold many files,
    so ask its metadata API for the first playable audio file.
    """
    if candidate.get("download_url"):
        return candidate["download_url"]
    if candidate["source_platform"] != "archive.org":
        return None

    ident = candidate["source_id"]
    result = subprocess.run(
        ["curl", "-sS", "-L", "-m", "60", f"https://archive.org/metadata/{ident}"],
        capture_output=True,
        text=True,
    )
    try:
        meta = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None

    # Prefer a lossy derivative: it is what we would serve anyway, and the
    # original is often a 300 MB FLAC we would only transcode down.
    preferred = ["VBR MP3", "MP3", "128Kbps MP3", "Ogg Vorbis", "Flac", "WAVE"]
    files = meta.get("files") or []
    for want in preferred:
        for entry in files:
            if entry.get("format") == want and entry.get("name"):
                server = meta.get("server") or "archive.org"
                directory = meta.get("dir", "")
                return f"https://{server}{directory}/{entry['name'].replace(' ', '%20')}"
    return None


def download(url: str, dest: Path) -> bool:
    if dest.exists() and dest.stat().st_size > 10_000:
        return True
    result = subprocess.run(
        ["curl", "-sS", "-L", "-m", "180", "--max-filesize", "80000000", "-o", str(dest), url],
        capture_output=True,
        text=True,
    )
    ok = result.returncode == 0 and dest.exists() and dest.stat().st_size > 10_000
    if not ok and dest.exists():
        dest.unlink()
    return ok


def to_wav_16k_mono(src: Path, dest: Path) -> bool:
    """YAMNet wants 16 kHz mono float. ffmpeg handles every input format we
    might have downloaded, so there is no per-format decoding to maintain."""
    if dest.exists():
        return True
    result = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(src),
         "-ac", "1", "-ar", "16000", "-f", "wav", str(dest)],
        capture_output=True,
    )
    return result.returncode == 0 and dest.exists()


def probe(path: Path) -> dict[str, Any]:
    result = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True,
        text=True,
    )
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return {}
    stream = next((s for s in data.get("streams", []) if s.get("codec_type") == "audio"), {})
    fmt = data.get("format", {})
    return {
        "duration_seconds": float(fmt.get("duration", 0) or 0),
        "sample_rate": int(stream.get("sample_rate", 0) or 0),
        "channels": int(stream.get("channels", 0) or 0),
        "file_size_bytes": int(fmt.get("size", 0) or 0),
    }


def measure_loudness(path: Path) -> float | None:
    """Integrated LUFS via ffmpeg's EBU R128 filter. Background audio wants to
    sit quietly under a voice, so this is a genuinely useful sort key."""
    result = subprocess.run(
        ["ffmpeg", "-nostdin", "-i", str(path), "-af", "ebur128", "-f", "null", "-"],
        capture_output=True, text=True,
    )
    for line in reversed(result.stderr.splitlines()):
        if "I:" in line and "LUFS" in line:
            try:
                return float(line.split("I:")[1].split("LUFS")[0].strip())
            except (ValueError, IndexError):
                return None
    return None


def analyse(wav: Path, model, buckets: dict[str, list[int]]) -> dict[str, Any]:
    import numpy as np  # noqa: PLC0415
    import soundfile as sf  # noqa: PLC0415

    waveform, rate = sf.read(str(wav), dtype="float32")
    if waveform.ndim > 1:
        waveform = waveform.mean(axis=1)
    if rate != 16000:
        import resampy  # noqa: PLC0415

        waveform = resampy.resample(waveform, rate, 16000)

    # Cap at 10 minutes. Beyond that the classification is already decided and
    # we would just be burning CPU on hour-long lecture uploads.
    waveform = waveform[: 16000 * 600]

    scores, _, _ = model(waveform)
    scores = scores.numpy()  # (frames, 521)

    frame_seconds = 0.48  # YAMNet hop
    melodic = scores[:, buckets["melodic"]].max(axis=1) if buckets["melodic"] else np.zeros(len(scores))
    percussion = scores[:, buckets["percussion"]].max(axis=1) if buckets["percussion"] else np.zeros(len(scores))
    voice = scores[:, buckets["voice"]].max(axis=1) if buckets["voice"] else np.zeros(len(scores))

    melodic_frames = melodic > MELODIC_FRAME_THRESHOLD
    percussion_frames = percussion > PERCUSSION_FRAME_THRESHOLD

    melodic_ratio = float(melodic_frames.mean()) if len(melodic_frames) else 0.0
    percussion_ratio = float(percussion_frames.mean()) if len(percussion_frames) else 0.0
    voice_ratio = float((voice > 0.20).mean()) if len(voice) else 0.0

    mean_scores = scores.mean(axis=0)
    top = sorted(enumerate(mean_scores), key=lambda kv: -kv[1])[:12]

    has_melodic = melodic_ratio > MELODIC_TRACK_RATIO
    has_percussion = percussion_ratio > PERCUSSION_TRACK_RATIO

    if has_melodic:
        guess = "has_melodic"
    elif has_percussion and voice_ratio > 0.10:
        # Voice plus percussion. Could be voice+duff (fine) or voice+drum kit
        # (not fine) — the detector cannot tell, so this is a question for a
        # human, flagged as such rather than guessed.
        guess = "voice_duff"
    elif has_percussion:
        guess = "duff_only"
    elif voice_ratio > 0.10:
        guess = "voice_only"
    else:
        # Neither voice nor percussion above threshold: usually near-silence,
        # field recording, or something the classifier had no opinion on.
        guess = "unclear"

    return {
        "instrumentation_guess": guess,
        "needs_human_percussion_check": bool(has_percussion),
        "melodic_ratio": round(melodic_ratio, 4),
        "percussion_ratio": round(percussion_ratio, 4),
        "voice_ratio": round(voice_ratio, 4),
        "melodic_segments": to_segments(melodic_frames, frame_seconds),
        "percussion_segments": to_segments(percussion_frames, frame_seconds)[:12],
        "top_labels": [[buckets["_names"][i], round(float(s), 3)] for i, s in top],
        "detector_version": DETECTOR_VERSION,
        "thresholds": {
            "melodic_frame": MELODIC_FRAME_THRESHOLD,
            "melodic_track_ratio": MELODIC_TRACK_RATIO,
            "percussion_frame": PERCUSSION_FRAME_THRESHOLD,
            "percussion_track_ratio": PERCUSSION_TRACK_RATIO,
        },
    }


def to_segments(flags, frame_seconds: float) -> list[list[float]]:
    """Turns a boolean frame mask into [start, end] second pairs, so a
    reviewer can jump straight to the moment the detector objected instead of
    scrubbing the whole track."""
    segments: list[list[float]] = []
    start = None
    for i, flag in enumerate(flags):
        if flag and start is None:
            start = i
        elif not flag and start is not None:
            segments.append([round(start * frame_seconds, 2), round(i * frame_seconds, 2)])
            start = None
    if start is not None:
        segments.append([round(start * frame_seconds, 2), round(len(flags) * frame_seconds, 2)])
    return [s for s in segments if s[1] - s[0] >= 0.5][:20]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0, help="0 = all")
    parser.add_argument("--redo", action="store_true", help="Re-analyse already-screened items")
    args = parser.parse_args()

    if not CANDIDATES.exists():
        print("No candidates.json — run tools/harvest.py first.", file=sys.stderr)
        return 1

    candidates = json.loads(CANDIDATES.read_text())
    done: dict[str, dict[str, Any]] = {}
    if SCREENED.exists() and not args.redo:
        done = {r["key"]: r for r in json.loads(SCREENED.read_text())}

    model, class_names = load_yamnet()
    buckets = bucket_indices(class_names)
    buckets["_names"] = class_names  # type: ignore[assignment]

    todo = [c for c in candidates if f"{c['source_platform']}:{c['source_id']}" not in done]
    if args.limit:
        todo = todo[: args.limit]

    print(f"{len(done)} already screened, {len(todo)} to go\n")

    for index, candidate in enumerate(todo, 1):
        key = f"{candidate['source_platform']}:{candidate['source_id']}"
        label = candidate["title"][:60]
        print(f"[{index}/{len(todo)}] {label}")

        url = resolve_download_url(candidate)
        if not url:
            done[key] = {**candidate, "key": key, "status": "no_audio_url"}
            continue

        digest = hashlib.sha256(key.encode()).hexdigest()[:16]
        raw = AUDIO / f"{digest}.src"
        wav = AUDIO / f"{digest}.16k.wav"

        if not download(url, raw):
            print("  ! download failed")
            done[key] = {**candidate, "key": key, "status": "download_failed"}
            continue
        if not to_wav_16k_mono(raw, wav):
            print("  ! decode failed")
            done[key] = {**candidate, "key": key, "status": "decode_failed"}
            continue

        info = probe(raw)
        if info.get("duration_seconds", 0) < 5:
            done[key] = {**candidate, "key": key, "status": "too_short", **info}
            continue

        try:
            analysis = analyse(wav, model, buckets)
        except Exception as exc:  # noqa: BLE001
            print(f"  ! analysis failed: {exc}")
            done[key] = {**candidate, "key": key, "status": "analysis_failed"}
            continue

        record = {
            **candidate,
            "key": key,
            "status": "screened",
            "download_url": url,
            "local_audio": str(raw.name),
            "loudness_lufs": measure_loudness(raw),
            **info,
            **analysis,
        }
        done[key] = record

        verdict = analysis["instrumentation_guess"]
        flag = " (percussion — needs ear)" if analysis["needs_human_percussion_check"] else ""
        print(f"  -> {verdict}{flag}  melodic={analysis['melodic_ratio']:.3f} voice={analysis['voice_ratio']:.3f}")

        SCREENED.write_text(json.dumps(list(done.values()), indent=1, ensure_ascii=False))

    SCREENED.write_text(json.dumps(list(done.values()), indent=1, ensure_ascii=False))

    tally: dict[str, int] = {}
    for row in done.values():
        k = row.get("instrumentation_guess", row.get("status", "?"))
        tally[k] = tally.get(k, 0) + 1
    print(f"\n{len(done)} screened -> {SCREENED}")
    for k, v in sorted(tally.items(), key=lambda kv: -kv[1]):
        print(f"  {k:22} {v}")
    print("\nNext: python3 tools/review.py   (listen and decide)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
