#!/usr/bin/env python3
"""
Stage 1b: expand archive.org album items into one candidate per track.

An archive.org "item" is a container, not a recording. Many of the nasheed
items in this harvest are whole albums or channel archives — one of them holds
87 separate MP3s. screen.py was taking the FIRST audio file from each item and
discarding the rest, so 381 items yielded 381 candidates when they actually
hold several thousand recordings.

That was the real ceiling on catalog size, and it was invisible: nothing
errored, the pipeline just quietly looked at 1% of what it had found.

Expanding is also cheap in exactly the way harvesting is not. Every track in an
item shares the item's licence, uploader and provenance — all the metadata the
rubric cares about — so one metadata request yields dozens of candidates
instead of one, with no extra rate-limit cost per track.

Each expanded candidate still goes through screening, transcription and
verification individually. Sharing a licence does not mean sharing a verdict:
an album can easily contain one instrumental track among vocal ones.

    python3 tools/expand.py                 # expand everything not yet expanded
    python3 tools/expand.py --max-per-item 40
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

WORK = Path(__file__).parent / "work"
WORK.mkdir(exist_ok=True)
CANDIDATES = WORK / "candidates.json"

USER_AGENT = (
    "nasheed-directory/0.1 (https://github.com/lomeyollc/nasheed-directory; zakir@lomeyo.com)"
)

# Formats worth taking, best first. A lossy derivative is what we would serve
# anyway, and the originals are often 300 MB FLACs we would only transcode down.
PREFERRED = ["VBR MP3", "128Kbps MP3", "MP3", "64Kbps MP3", "Ogg Vorbis", "Flac", "WAVE"]

# Files that are not music even when the format says audio.
SKIP_NAME = re.compile(
    r"(sample|preview|intro|outro|jingle|advert|promo|spectrogram|_itemimage)",
    re.IGNORECASE,
)


def fetch_metadata(identifier: str, attempts: int = 4) -> dict[str, Any] | None:
    for attempt in range(attempts):
        result = subprocess.run(
            ["curl", "-sS", "-L", "-m", "90", "-H", f"User-Agent: {USER_AGENT}",
             f"https://archive.org/metadata/{identifier}"],
            capture_output=True, text=True,
        )
        if result.returncode == 0:
            try:
                return json.loads(result.stdout)
            except json.JSONDecodeError:
                pass
        if attempt < attempts - 1:
            time.sleep(4 * (attempt + 1))
    return None


def pick_files(meta: dict[str, Any], max_per_item: int) -> list[dict[str, Any]]:
    """
    One entry per distinct recording, in the best available format.

    archive.org stores the same recording several times over — a VBR MP3, a
    128k MP3, an Ogg, a spectrogram PNG. Grouping by the name without its
    extension and then picking the best format per group is what stops one
    recording becoming four candidates.
    """
    by_recording: dict[str, dict[str, Any]] = {}
    for entry in meta.get("files") or []:
        name = entry.get("name") or ""
        fmt = entry.get("format") or ""
        if fmt not in PREFERRED or SKIP_NAME.search(name):
            continue
        stem = re.sub(r"\.[A-Za-z0-9]+$", "", name)
        rank = PREFERRED.index(fmt)
        current = by_recording.get(stem)
        if current is None or rank < current["_rank"]:
            by_recording[stem] = {**entry, "_rank": rank, "_stem": stem}

    files = sorted(by_recording.values(), key=lambda f: f["_stem"])
    return files[:max_per_item]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-per-item", type=int, default=40)
    parser.add_argument("--limit", type=int, default=0, help="items to expand this run")
    args = parser.parse_args()

    if not CANDIDATES.exists():
        print("No candidates.json — run harvest.py first.", file=sys.stderr)
        return 1

    rows = json.loads(CANDIDATES.read_text())
    by_key = {f"{r['source_platform']}:{r['source_id']}": r for r in rows}

    # Only original archive.org items, never something we already expanded.
    items = [
        r for r in rows
        if r["source_platform"] == "archive.org" and not r.get("expanded") and not r.get("parent_item")
    ]
    if args.limit:
        items = items[: args.limit]

    print(f"{len(items)} archive.org items to expand\n")

    added = 0
    for index, item in enumerate(items, 1):
        identifier = item["source_id"]
        meta = fetch_metadata(identifier)
        if meta is None:
            print(f"[{index}/{len(items)}] {identifier[:40]} — metadata unavailable, will retry next run")
            continue

        files = pick_files(meta, args.max_per_item)
        item["expanded"] = True

        if len(files) <= 1:
            # A single-recording item needs no expansion; screen.py already
            # handles it. Mark it so we do not fetch its metadata again.
            print(f"[{index}/{len(items)}] {identifier[:40]} — single track")
            continue

        server = meta.get("server") or "archive.org"
        directory = meta.get("dir", "")

        for entry in files:
            name = entry["name"]
            key = f"archive.org:{identifier}/{name}"
            if key in by_key:
                continue
            title = re.sub(r"\.[A-Za-z0-9]+$", "", name).replace("_", " ").strip()
            by_key[key] = {
                **{k: v for k, v in item.items() if k not in ("expanded", "slug")},
                "source_id": f"{identifier}/{name}",
                "parent_item": identifier,
                "title": (entry.get("title") or title)[:300],
                "download_url": f"https://{server}{directory}/{name.replace(' ', '%20')}",
                "source_url": f"https://archive.org/details/{identifier}",
            }
            added += 1

        print(f"[{index}/{len(items)}] {identifier[:40]} — {len(files)} tracks")

        # Checkpoint every item: expansion is slow and interruption is normal.
        tmp = CANDIDATES.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(list(by_key.values()), indent=1, ensure_ascii=False))
        tmp.replace(CANDIDATES)

    tmp = CANDIDATES.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(list(by_key.values()), indent=1, ensure_ascii=False))
    tmp.replace(CANDIDATES)

    print(f"\n+{added} track candidates ({len(by_key)} total)")
    print("Next: tools/.venv/bin/python tools/screen.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
