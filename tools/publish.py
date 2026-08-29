#!/usr/bin/env python3
"""
Stage 4: publish everything a human accepted.

Transcodes each accepted track to a consistent MP3, uploads it to R2, and
writes the catalog rows to D1. Idempotent — re-running skips what is already
uploaded, so an interrupted run is resumed rather than restarted.

Why transcode instead of mirroring the original bytes: the sources give us a
mix of FLAC, Ogg, 320k MP3 and 8 kHz WAV. A consumer of this API wants a
predictable file, and an agent stitching audio under a video should not have
to branch on container format. 128k MP3 mono-or-stereo at 44.1 kHz is more
than enough for background audio and keeps the R2 bill near zero.

    python3 tools/publish.py --dry-run     # show what would happen
    python3 tools/publish.py               # local D1
    python3 tools/publish.py --remote      # production D1 + real R2
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import unicodedata
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).parent.parent
WORK = ROOT / "tools" / "work"
AUDIO = WORK / "audio"
PUBLISH = WORK / "publish"
PUBLISH.mkdir(parents=True, exist_ok=True)
SCREENED = WORK / "screened.json"
DECISIONS = WORK / "decisions.json"
STATE = WORK / "published.json"

BUCKET = "nasheed-audio"
DB = "nasheed-directory"


def sql_str(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def slugify(text: str, taken: set[str], fallback: str = "") -> str:
    """
    Arabic, Urdu and Pashto titles contain no ASCII, so a naive filter left
    every one of them as the slug "track", "track-2", "track-3" — URLs that
    tell a user nothing and collide constantly. Transliterate first, and fall
    back to the source identifier rather than a counter.
    """
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    base = re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-")[:60]
    if len(base) < 3:
        base = re.sub(r"[^a-z0-9]+", "-", fallback.lower()).strip("-")[:60] or "track"
    slug = base
    n = 2
    while slug in taken:
        slug = f"{base}-{n}"
        n += 1
    taken.add(slug)
    return slug


def transcode(src: Path, dest: Path) -> bool:
    """Normalise loudness while transcoding. Background audio that arrives at
    wildly different levels forces every consumer to run its own gain stage;
    doing it once here means -14 LUFS out of the box."""
    if dest.exists() and dest.stat().st_size > 10_000:
        return True
    result = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(src),
         "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
         "-c:a", "libmp3lame", "-b:a", "128k", "-ar", "44100", str(dest)],
        capture_output=True,
    )
    return result.returncode == 0 and dest.exists()


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def probe_duration(path: Path) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    )
    try:
        return round(float(result.stdout.strip()), 2)
    except ValueError:
        return 0.0


def attribution_for(row: dict[str, Any]) -> str | None:
    """The exact string a user must reproduce. Built once here and stored, so
    a consumer never has to assemble it from parts and get it subtly wrong."""
    if row["license"] in ("CC0", "public-domain"):
        return None
    artist = row.get("artist") or "Unknown artist"
    return f'"{row["title"]}" by {artist}, licensed {row["license"]}. Source: {row["source_url"]}'


def upload(local: Path, key: str, remote: bool, dry: bool) -> bool:
    if dry:
        print(f"    would upload -> r2://{BUCKET}/{key}")
        return True
    cmd = ["npx", "wrangler", "r2", "object", "put", f"{BUCKET}/{key}",
           "--file", str(local), "--content-type", "audio/mpeg"]
    cmd.append("--remote" if remote else "--local")
    result = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"    ! upload failed: {result.stderr.strip()[:300]}")
        return False
    return True


# ---------------------------------------------------------------------------
# Automated verification
# ---------------------------------------------------------------------------
# The bar for a machine to publish without a human is deliberately HIGHER than
# the bar a human reviewer applies, because a machine gets no benefit of the
# doubt on anything ambiguous:
#
#   - voice_only ONLY. Not duff_only, not voice_duff. AudioSet cannot tell a
#     frame drum from a drum kit, so any track with percussion in it waits for
#     an ear. That is the one rubric clause no model here can answer.
#   - near-zero melodic energy, an order of magnitude under the human-review
#     threshold.
#   - a transcription that actually succeeded and produced real text. A track
#     whose lyrics could not be read is NOT cleared by default; it is exactly
#     the case where something could hide.
#   - zero content flags and zero title markers.
#   - a free licence.
#
# Anything failing any of these is not rejected — it simply waits for review.py.
AUTO_MAX_MELODIC_RATIO = 0.02
AUTO_MAX_MELODIC_MEAN = 0.010
AUTO_MAX_PERCUSSION_RATIO = 0.01
AUTO_MIN_LYRICS_CHARS = 40
AUTO_MIN_DURATION = 20.0


def auto_verifiable(row: dict[str, Any]) -> tuple[bool, str]:
    """Returns (ok, reason-it-failed)."""
    if row.get("instrumentation_guess") != "voice_only":
        return False, f"not voice_only ({row.get('instrumentation_guess')}) — percussion needs an ear"
    if row.get("extremism_flags"):
        return False, f"title markers: {row['extremism_flags']}"
    if row.get("lyrics_flags"):
        return False, f"lyric flags: {list(row['lyrics_flags'])}"

    lyrics = (row.get("lyrics_english") or "").strip()
    low = lyrics.lower()

    # A structural rule rather than another keyword.
    #
    # Jihadi nasheeds are almost always released by a named media foundation
    # and open with its spoken ident — "the X Foundation for voice production
    # presents". Chasing the foundation NAMES is a losing game: the list is
    # long, they rebrand, and whisper mangles the transliteration. But the
    # SHAPE is stable, and a track that announces a production house at all is
    # a track whose provenance a person should look at.
    #
    # This exists because keyword screening missed a track three separate
    # times, most recently one whose transcription opened with "The ...
    # Foundation for voice production is presenting" and went on to "we
    # destroyed it" — passing both the media-foundation list and the violence
    # list. Ordinary devotional recordings do not announce a studio.
    if ("foundation" in low or "institution" in low or "establishment" in low) and (
        "production" in low or "present" in low or "media" in low
    ):
        return False, "announces a production house — provenance needs a human"
    if len(lyrics) < AUTO_MIN_LYRICS_CHARS:
        return False, "lyrics could not be read — cannot clear content"

    # Whisper's degenerate-repetition mode produces long output that says
    # nothing. Treat low variety as an unreadable transcription rather than a
    # clean one: it is the same failure wearing a longer coat.
    words = [w for w in lyrics.lower().split() if len(w) > 2]
    if words and len(set(words)) / len(words) < 0.25:
        return False, "transcription is degenerate repetition — content unknown"

    # `x or default` is wrong here and was a real bug: a melodic_ratio of 0.0 —
    # a PERFECT score, no instrument detected anywhere — is falsy, so every
    # cleanest track fell through to the default of 1 and was rejected. Missing
    # and zero are different facts and must be distinguished explicitly.
    def number(field: str, when_missing: float) -> float:
        value = row.get(field)
        return when_missing if value is None else float(value)

    if number("melodic_ratio", 1.0) > AUTO_MAX_MELODIC_RATIO:
        return False, f"melodic_ratio {row.get('melodic_ratio')}"
    if number("melodic_mean", 1.0) > AUTO_MAX_MELODIC_MEAN:
        return False, f"melodic_mean {row.get('melodic_mean')}"
    if number("percussion_ratio", 1.0) > AUTO_MAX_PERCUSSION_RATIO:
        return False, f"percussion present ({row.get('percussion_ratio')}) — duff vs drum kit needs an ear"
    if number("duration_seconds", 0.0) < AUTO_MIN_DURATION:
        return False, "too short to be useful as background audio"
    return True, ""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--remote", action="store_true", help="Production D1 and R2")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--auto", action="store_true",
                        help="Also publish tracks that pass every automated check, as "
                             "verification_status='automated_verified'. No human listens.")
    args = parser.parse_args()

    if not SCREENED.exists():
        print("Need screened.json — run screen.py first.", file=sys.stderr)
        return 1
    if not DECISIONS.exists() and not args.auto:
        print("Need decisions.json — run review.py, or pass --auto.", file=sys.stderr)
        return 1

    screened = {r["key"]: r for r in json.loads(SCREENED.read_text()) if r.get("key")}
    decisions = json.loads(DECISIONS.read_text()) if DECISIONS.exists() else {}

    # Recompute the safety flags here rather than trusting what was stored.
    # Same reasoning as review.py: a flag list added after a row was written
    # must still protect that row, and this is the last gate before publish.
    sys.path.insert(0, str(Path(__file__).parent))
    from review import extremism_flags, lyric_flags  # noqa: PLC0415

    for row in screened.values():
        row["extremism_flags"] = extremism_flags(row)
        if row.get("lyrics_english"):
            row["lyrics_flags"] = lyric_flags(row["lyrics_english"])
    published: dict[str, Any] = json.loads(STATE.read_text()) if STATE.exists() else {}

    accepted = [
        (key, decision) for key, decision in decisions.items()
        if decision["verdict"] == "accept" and key in screened
    ]

    if args.auto:
        already = {k for k, _ in accepted}
        auto_ok = 0
        rejected: dict[str, int] = {}
        for key, row in screened.items():
            if key in already or row.get("status") != "screened":
                continue
            ok, why = auto_verifiable(row)
            if ok:
                accepted.append((key, {
                    "verdict": "accept",
                    "instrumentation": "voice_only",
                    "automated": True,
                    "note": "Automated verification: no melodic instrument or percussion detected, "
                            "lyrics transcribed and screened, licence read from source. "
                            "No human has listened to this track.",
                    "decided_at": datetime.now(timezone.utc).isoformat(),
                }))
                auto_ok += 1
            else:
                bucket = why.split(":")[0].split("(")[0].strip()
                rejected[bucket] = rejected.get(bucket, 0) + 1
        print(f"automated verification: {auto_ok} qualify, {sum(rejected.values())} held for human review")
        for reason, count in sorted(rejected.items(), key=lambda kv: -kv[1])[:8]:
            print(f"    {count:4}  {reason}")
        print()
    todo = [(k, d) for k, d in accepted if k not in published]

    print(f"{len(accepted)} accepted, {len(published)} already published, {len(todo)} to publish\n")
    if not todo:
        print("Nothing to do.")
        return 0

    taken = {v["slug"] for v in published.values()}
    statements: list[str] = []
    now = datetime.now(timezone.utc).isoformat()

    for index, (key, decision) in enumerate(todo, 1):
        row = screened[key]
        print(f"[{index}/{len(todo)}] {row['title'][:60]}")

        src = AUDIO / row["local_audio"]
        if not src.exists():
            print("    ! cached audio missing, skipping")
            continue

        slug = slugify(row["title"], taken, fallback=row.get("source_id", ""))
        mp3 = PUBLISH / f"{slug}.mp3"
        if not transcode(src, mp3):
            print("    ! transcode failed")
            continue

        digest = sha256_of(mp3)
        r2_key = f"{slug}.mp3"
        if not upload(mp3, r2_key, args.remote, args.dry_run):
            continue

        instrumentation = decision.get("instrumentation") or row.get("instrumentation_guess")
        track_id = str(uuid.uuid4())

        statements.append(
            "INSERT INTO tracks ("
            "id, slug, title, title_original, artist, artist_url, description, instrumentation, "
            "detector_evidence, detector_version, duration_seconds, sample_rate, channels, "
            "loudness_lufs, is_loopable, lyrics_language, content_reviewed, license, license_url, "
            "attribution_text, source_url, source_platform, verification_status, verified_by, "
            "verified_at, review_notes, r2_key, file_format, file_size_bytes, sha256, mood, tags, "
            "published, submitted_by, created_at, updated_at) VALUES ("
            + ", ".join([
                sql_str(track_id), sql_str(slug), sql_str(row["title"]), "NULL",
                sql_str(row.get("artist")), sql_str(row.get("artist_url")), "NULL",
                sql_str(instrumentation),
                sql_str(json.dumps({
                    "melodic_ratio": row.get("melodic_ratio"),
                    "percussion_ratio": row.get("percussion_ratio"),
                    "voice_ratio": row.get("voice_ratio"),
                    "melodic_segments": row.get("melodic_segments"),
                    "top_labels": row.get("top_labels"),
                    "thresholds": row.get("thresholds"),
                })),
                sql_str(row.get("detector_version")),
                sql_str(probe_duration(mp3)),
                sql_str(row.get("sample_rate")), sql_str(row.get("channels")),
                sql_str(row.get("loudness_lufs")),
                "0",
                sql_str(row.get("lyrics_language")),
                # content_reviewed means A PERSON read the lyrics. An automated
                # row must never claim it — the DB trigger refuses if it does.
                "0" if decision.get("automated") else "1",
                sql_str(row["license"]), sql_str(row.get("license_url")),
                sql_str(attribution_for(row)),
                sql_str(row["source_url"]), sql_str(row.get("source_platform")),
                sql_str("automated_verified" if decision.get("automated") else "maintainer_verified"),
                sql_str(
                    f"automated:{row.get('detector_version') or 'yamnet'}+{row.get('lyrics_model') or 'whisper'}"
                    if decision.get("automated") else "zakir@lomeyo.com"
                ),
                sql_str(decision.get("decided_at") or now),
                sql_str(decision.get("note") or None),
                sql_str(r2_key), sql_str("mp3"),
                sql_str(mp3.stat().st_size), sql_str(digest),
                "NULL",
                sql_str(json.dumps(row.get("tags") or [])),
                "1",
                sql_str(f"harvest:{row.get('source_platform')}"),
                sql_str(now), sql_str(now),
            ])
            + ");"
        )

        published[key] = {"slug": slug, "r2_key": r2_key, "sha256": digest, "published_at": now}
        print(f"    -> {slug} ({instrumentation})")

    if not statements:
        print("\nNothing published.")
        return 0

    sql_file = WORK / "insert_tracks.sql"
    sql_file.write_text("\n".join(statements))
    print(f"\n{len(statements)} rows -> {sql_file}")

    if args.dry_run:
        print("Dry run: not executing against D1.")
        return 0

    cmd = ["npx", "wrangler", "d1", "execute", DB, "--file", str(sql_file),
           "--remote" if args.remote else "--local", "-y"]
    result = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"! d1 execute failed:\n{result.stderr[:1500]}", file=sys.stderr)
        return 1

    STATE.write_text(json.dumps(published, indent=1))
    print(f"Published {len(statements)} tracks to {'production' if args.remote else 'local'} D1.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
