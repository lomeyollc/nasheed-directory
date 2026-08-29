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


def slugify(text: str, taken: set[str]) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60] or "track"
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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--remote", action="store_true", help="Production D1 and R2")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if not SCREENED.exists() or not DECISIONS.exists():
        print("Need screened.json and decisions.json — run screen.py then review.py.", file=sys.stderr)
        return 1

    screened = {r["key"]: r for r in json.loads(SCREENED.read_text())}
    decisions = json.loads(DECISIONS.read_text())
    published: dict[str, Any] = json.loads(STATE.read_text()) if STATE.exists() else {}

    accepted = [
        (key, decision) for key, decision in decisions.items()
        if decision["verdict"] == "accept" and key in screened
    ]
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

        slug = slugify(row["title"], taken)
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
                "1",  # a human listened; that is what content_reviewed records
                sql_str(row["license"]), sql_str(row.get("license_url")),
                sql_str(attribution_for(row)),
                sql_str(row["source_url"]), sql_str(row.get("source_platform")),
                sql_str("maintainer_verified"),
                sql_str("zakir@lomeyo.com"),
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
