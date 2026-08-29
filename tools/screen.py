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
import time
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

# Thresholds.
#
# These started much higher and were lowered after the first real run, which
# labelled a track `voice_only` while "piano", "electric piano" and "keyboard"
# all sat in its own top labels. That is the exact failure this stage exists
# to prevent, so the numbers are now set where a false alarm is cheap and a
# miss is not.
#
# The reason the first numbers failed is worth recording: YAMNet's generic
# "Music" class swamps everything (0.74 on a solo vocal nasheed) while the
# specific classes it should imply — "Singing", "Chant" — stay near 0.02. So
# any rule phrased as "a specific class must be confident" under-fires on
# every axis at once. Absolute per-frame confidence is the wrong instrument
# for this; presence is what matters.
MELODIC_FRAME_THRESHOLD = 0.08

# Calibrated against the first real batch rather than guessed. Measured on
# eleven analysed tracks, `melodic_ratio` separates cleanly by an order of
# magnitude and the other signals do not:
#
#   Bach piano performance       0.703      Navy Band brass     0.772
#   Kuwait anthem (instrumental) 0.611      chiptune            0.773
#   genuine vocal-only nasheed   0.071      other plausibles    0.028-0.099
#
# The earlier 0.015 flagged all eleven, which made the verdict worthless —
# a reviewer facing an unbroken wall of red learns to ignore it, which is
# worse than no signal at all.
MELODIC_TRACK_RATIO = 0.20

# Mean melodic energy across the track. Same batch: instrumentals 0.085-0.274,
# plausible candidates 0.0145-0.0296. Catches a quiet instrumental bed that
# is present throughout but never dominates a frame.
MELODIC_MEAN_THRESHOLD = 0.05

# Peak is deliberately NOT a disqualifier. It was one, and the data says it
# cannot be: peak ran 0.39-0.96 on plausible tracks and 0.49-0.96 on obvious
# instrumentals — the two populations overlap almost completely, so any cut
# either passes a Bach minuet or rejects a solo vocal. It is still recorded
# and shown to the reviewer as evidence.
MELODIC_PEAK_REPORT_ONLY = True

PERCUSSION_FRAME_THRESHOLD = 0.15
PERCUSSION_TRACK_RATIO = 0.02

# Voice is scored generously in the other direction: we are not trying to
# prove voice is present, only to describe what is there for the reviewer.
VOICE_FRAME_THRESHOLD = 0.08
VOICE_TRACK_RATIO = 0.05

DETECTOR_VERSION = "yamnet-1/v2-conservative"


# Wikimedia Commons full-text search ignores the query terms far more often
# than its API suggests — a search for "duff" returned a 1920 dance-orchestra
# recording, and "dhikr" returned a US presidential address. Downloading and
# analysing those costs minutes each for a guaranteed reject, so candidates
# are gated on their own text before any bytes are fetched.
RELEVANT = [
    "nasheed", "anasheed", "nashid", "naat", "hamd", "qasida", "madih", "burda",
    "mawlid", "salawat", "salawaat", "takbir", "tahmid", "tasbih", "adhan", "azan",
    "dhikr", "zikr", "islam", "muslim", "quran", "qur'an", "allah", "muhammad",
    "arabic", "sufi", "chant", "chanting", "a cappella", "acapella", "vocal",
    "voice", "singing", "hymn", "prayer", "recitation", "duff", "daf", "bendir",
    "frame drum", "tambour", "percussion", "drum",
]

# Words that mean "this is speech, not music" — pronunciation clips, lectures
# and interviews dominate Commons audio and none of them are background music.
IRRELEVANT = [
    "pronunciation", "interview", "lecture", "speech by", "address", "podcast",
    "audiobook", "wikipedia article", "spoken wikipedia", "ll-q",  # Lingua Libre
    "voice of america", "radio broadcast", "news", "birdsong", "xc",  # xeno-canto
]


# Phrases conventionally used in jihadi nasheeds. This genre is a large,
# freely-reuploaded presence on public archives, and it defeats every other
# check this pipeline has: it is overwhelmingly unaccompanied vocal, so it
# sails through the instrumentation test looking like exactly what we want.
#
# These are a REASON TO LOOK, never a verdict. Every one of them also appears
# innocently — "lions" is ordinary classical imagery, "ummah" and "fath" are
# everyday religious vocabulary. The flag exists so a reviewer who does not
# read Arabic is told to get the lyrics translated before accepting, rather
# than approving a clean-sounding vocal track on the strength of its waveform.
EXTREMIST_MARKERS = [
    "أسود الله", "دولة الإسلام", "صليل الصوارم", "جهاد", "استشهاد", "مجاهد",
    "قاعدة", "داعش", "كتائب", "غزوة", "شهداء",
    "lions of", "islamic state", "clashing of the swords", "clanging of the swords",
    "jihad", "mujahid", "mujahideen", "martyrdom", "caliphate", "khilafah",
    "al-qaeda", "isis", "taliban", "shabaab", "ansar", "battalion", "raid on",
]


def extremism_flags(candidate: dict[str, Any]) -> list[str]:
    """Marker phrases found in a candidate's own metadata, for the reviewer."""
    haystack = " ".join(
        str(candidate.get(f) or "") for f in ("title", "artist", "description", "uploader")
    ).lower()
    return [m for m in EXTREMIST_MARKERS if m.lower() in haystack]


def is_relevant(candidate: dict[str, Any]) -> bool:
    """Cheap text gate applied before download. Deliberately generous: it is
    here to skip the obviously-wrong, not to make an editorial judgement."""
    haystack = " ".join(
        str(candidate.get(field) or "")
        for field in ("title", "artist", "description", "matched_term")
    ).lower()
    tags = candidate.get("tags") or []
    subjects = candidate.get("subjects") or []
    for extra in (tags, subjects):
        if isinstance(extra, list):
            haystack += " " + " ".join(str(x) for x in extra).lower()
        elif extra:
            haystack += " " + str(extra).lower()

    if any(word in haystack for word in IRRELEVANT):
        return False
    return any(word in haystack for word in RELEVANT)


# Fields owned by OTHER pipeline stages. screen.py must never clobber them.
FOREIGN_FIELDS = ("lyrics_english", "lyrics_language", "lyrics_flags", "lyrics_model")


def save_screened(done: dict[str, dict[str, Any]]) -> None:
    """
    Merge into screened.json rather than overwriting it.

    This function exists because of a real data loss. screen.py used to write
    its whole in-memory dict over the file. transcribe.py writes lyrics into
    the SAME file. Running both — which is the obvious thing to do, since
    screening is slow and transcription is independent — meant the screener's
    next write silently reverted twenty transcriptions that had cost half an
    hour of whisper time. No error, no warning; the lyrics were simply gone.

    Each stage owns its own fields. On write we re-read what is on disk and
    carry over anything we do not own, so concurrent stages compose instead of
    racing.
    """
    on_disk: dict[str, dict[str, Any]] = {}
    if SCREENED.exists():
        try:
            for row in json.loads(SCREENED.read_text()):
                if row.get("key"):
                    on_disk[row["key"]] = row
        except json.JSONDecodeError:
            pass

    merged = dict(on_disk)
    for key, row in done.items():
        previous = on_disk.get(key, {})
        combined = {**row}
        for field in FOREIGN_FIELDS:
            if field in previous and field not in combined:
                combined[field] = previous[field]
        merged[key] = combined

    tmp = SCREENED.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(list(merged.values()), indent=1, ensure_ascii=False))
    tmp.replace(SCREENED)


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


class MetadataUnavailable(Exception):
    """The source refused to tell us about this item. Retryable, NOT a verdict
    that the item has no audio — conflating the two silently discards good
    candidates and never looks at them again."""


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

    # Retry: archive.org throttles, and a throttled metadata call returns an
    # HTML page rather than JSON. A single attempt recorded that as
    # "no_audio_url" — a permanent verdict — for items that in fact hold 87
    # MP3s. 23 of the first 51 candidates were lost to this, which is the same
    # mistake as the Wikimedia 429: a refusal read as an absence.
    meta = None
    for attempt in range(4):
        result = subprocess.run(
            ["curl", "-sS", "-L", "-m", "90",
             "-H", f"User-Agent: {USER_AGENT}", f"https://archive.org/metadata/{ident}"],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            try:
                meta = json.loads(result.stdout)
                break
            except json.JSONDecodeError:
                pass
        if attempt < 3:
            time.sleep(5 * (attempt + 1))

    if meta is None:
        # Distinct from "this item has no audio". Raised so the caller can
        # record it as retryable rather than caching it as a final answer.
        raise MetadataUnavailable(ident)

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


# Wikimedia's upload servers answer 429 to a request with no User-Agent, and
# curl sends none by default. The first screening run failed to download 113
# of 126 candidates for exactly this reason — and because the failure was a
# rejected HTTP status rather than an exception, it looked like "these files
# are gone" rather than "we are being refused". Wikimedia's User-Agent policy
# asks for a contact address, so give a real one.
USER_AGENT = (
    "nasheed-directory/0.1 (https://github.com/lomeyollc/nasheed-directory; zakir@lomeyo.com)"
)


def download(url: str, dest: Path) -> bool:
    if dest.exists() and dest.stat().st_size > 10_000:
        return True
    result = subprocess.run(
        ["curl", "-sS", "-L", "-m", "180", "--max-filesize", "80000000",
         "--retry", "2", "--retry-delay", "3",
         "-H", f"User-Agent: {USER_AGENT}", "-o", str(dest), url],
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
    melodic_peak = float(melodic.max()) if len(melodic) else 0.0
    melodic_mean = float(melodic.mean()) if len(melodic) else 0.0
    percussion_ratio = float(percussion_frames.mean()) if len(percussion_frames) else 0.0
    voice_ratio = float((voice > VOICE_FRAME_THRESHOLD).mean()) if len(voice) else 0.0

    mean_scores = scores.mean(axis=0)
    top = sorted(enumerate(mean_scores), key=lambda kv: -kv[1])[:12]

    # Three independent ways to fail. Any one is enough: a sustained bed, a
    # scattering of flagged frames, or one unambiguous moment.
    # Two tiers, on purpose. `melodic_reasons` disqualifies. `melodic_warnings`
    # does not, but is shown to the reviewer anyway — the point is that a
    # track can look clean on the numbers and still deserve a careful listen,
    # and hiding that from a human is how a mistake gets made quietly.
    melodic_reasons = []
    melodic_warnings = []

    if melodic_ratio > MELODIC_TRACK_RATIO:
        melodic_reasons.append(f"melodic content in {melodic_ratio:.1%} of frames")
    elif melodic_ratio > MELODIC_TRACK_RATIO / 4:
        melodic_warnings.append(f"some melodic content ({melodic_ratio:.1%} of frames)")

    if melodic_mean > MELODIC_MEAN_THRESHOLD:
        melodic_reasons.append(f"mean melodic energy {melodic_mean:.4f} across the whole track")
    elif melodic_mean > MELODIC_MEAN_THRESHOLD / 4:
        melodic_warnings.append(f"low but steady melodic energy ({melodic_mean:.4f})")

    if melodic_peak > 0.6:
        melodic_warnings.append(
            f"a moment scored {melodic_peak:.2f} for an instrument — check the flagged timestamps"
        )

    # Belt and braces: if a melodic class appears in the track's own top
    # labels at all, say so. The first run produced a `voice_only` verdict on
    # a track whose top labels listed piano, electric piano and keyboard —
    # every ratio was under threshold while the answer was sitting in plain
    # sight in the label list.
    melodic_names = {buckets["_names"][i] for i in buckets["melodic"]}
    top_melodic = [
        [buckets["_names"][i], round(float(s), 4)]
        for i, s in top
        if buckets["_names"][i] in melodic_names and float(s) > 0.01
    ]
    if top_melodic:
        names = ", ".join(f"{n} {v}" for n, v in top_melodic)
        # Only disqualifying when a melodic class is genuinely prominent.
        # Below that it is a warning: nearly any recording has some instrument
        # class in its top twelve at a trivial score.
        if any(v > 0.05 for _, v in top_melodic):
            melodic_reasons.append(f"prominent melodic classes: {names}")
        else:
            melodic_warnings.append(f"melodic classes present in top labels: {names}")

    has_melodic = bool(melodic_reasons)
    has_percussion = percussion_ratio > PERCUSSION_TRACK_RATIO

    if has_melodic:
        guess = "has_melodic"
    elif has_percussion and voice_ratio > VOICE_TRACK_RATIO:
        # Voice plus percussion. Could be voice+duff (fine) or voice+drum kit
        # (not fine) — the detector cannot tell, so this is a question for a
        # human, flagged as such rather than guessed.
        guess = "voice_duff"
    elif has_percussion:
        guess = "duff_only"
    elif voice_ratio > VOICE_TRACK_RATIO:
        guess = "voice_only"
    else:
        # Neither voice nor percussion above threshold: usually near-silence,
        # field recording, or something the classifier had no opinion on.
        guess = "unclear"

    # `clean_score`: higher means more likely to be genuinely instrument-free.
    # review.py sorts on this so a human meets the best candidates first,
    # rather than the detector deciding alone what a human ever sees.
    clean_score = round(
        max(0.0, 1.0 - (melodic_ratio * 3) - (melodic_peak * 0.5) - (melodic_mean * 20))
        + min(voice_ratio, 0.5),
        4,
    )

    return {
        "instrumentation_guess": guess,
        "clean_score": clean_score,
        "needs_human_percussion_check": bool(has_percussion),
        "melodic_reasons": melodic_reasons,
        "melodic_warnings": melodic_warnings,
        "melodic_peak": round(melodic_peak, 4),
        "melodic_mean": round(melodic_mean, 5),
        "top_melodic_labels": top_melodic,
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
            "melodic_mean": MELODIC_MEAN_THRESHOLD,
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
    parser.add_argument("--no-filter", action="store_true", help="Skip the relevance gate")
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

    if not args.no_filter:
        before = len(todo)
        todo = [c for c in todo if is_relevant(c)]
        print(f"relevance gate: {before} -> {len(todo)} ({before - len(todo)} skipped as off-topic)")

    # archive.org first: its hit rate for actual recitation and nasheed is far
    # higher than a generic Commons audio search, so a partial run still
    # produces a usable review queue.
    todo.sort(key=lambda c: 0 if c["source_platform"] == "archive.org" else 1)

    if args.limit:
        todo = todo[: args.limit]

    print(f"{len(done)} already screened, {len(todo)} to go\n")

    for index, candidate in enumerate(todo, 1):
        key = f"{candidate['source_platform']}:{candidate['source_id']}"
        label = candidate["title"][:60]
        print(f"[{index}/{len(todo)}] {label}")

        try:
            url = resolve_download_url(candidate)
        except MetadataUnavailable:
            # Deliberately NOT recorded in `done`: leaving it out means the
            # next run retries it instead of treating a throttle as a verdict.
            print("  ! metadata unavailable (will retry on next run)")
            continue

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
            "extremism_flags": extremism_flags(candidate),
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

        save_screened(done)

    save_screened(done)

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
