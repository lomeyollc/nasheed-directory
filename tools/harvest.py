#!/usr/bin/env python3
"""
Stage 1 of the pipeline: find candidate recordings.

Writes tools/work/candidates.json. Downloads nothing and judges nothing — it
only collects things that MIGHT belong in the catalog, so that the expensive
stages (download, analyse, listen) have a finite list to work from.

Sources, and why these three:

  archive.org   Enormous, and the only realistic source of older and
                anonymous recitation. Also the most dangerous: anyone can
                upload anyone's album and tick a Creative Commons box. We keep
                the uploader in the record precisely so that a human can
                notice "this is a commercial album re-uploaded by a stranger".

  Wikimedia     Small but the licence metadata is genuinely trustworthy,
                Commons     because Commons actively deletes files with bad provenance.

  Openverse     Aggregates Freesound, Jamendo and others behind one API with
                normalised licence fields. Saves integrating each separately.

Only licences that permit COMMERCIAL reuse and DERIVATIVES are collected. NC
and ND are dropped here rather than later, so nobody downstream has to
remember the rule. See LICENCE_ALLOW below.

Usage:
    python3 tools/harvest.py                 # all sources, default terms
    python3 tools/harvest.py --source archive --limit 500
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path
from typing import Any, Iterable

WORK = Path(__file__).parent / "work"
WORK.mkdir(exist_ok=True)
CANDIDATES = WORK / "candidates.json"

# Licence URL fragments that permit commercial use AND derivatives. Anything
# containing "-nc" or "-nd" is rejected: see the `license` clause of the
# rubric in src/worker/lib/rubric.ts for why those two break the promise this
# catalog makes.
LICENCE_ALLOW = {
    "creativecommons.org/publicdomain/zero": "CC0",
    "creativecommons.org/publicdomain/mark": "public-domain",
    "creativecommons.org/licenses/by/": "CC-BY",
    "creativecommons.org/licenses/by-sa/": "CC-BY-SA",
}

SEARCH_TERMS = [
    "nasheed", "anasheed", "nashid", "naat", "hamd", "qasida", "madih",
    "islamic vocal", "islamic a cappella", "acapella chant", "zikr", "dhikr",
    "takbir", "adhan", "tahmid", "salawat", "burda", "mawlid",
    "a cappella vocal", "vocal chant", "throat chant", "unaccompanied voice",
    "frame drum", "daf drum", "bendir", "duff",
]


def run_curl(url: str, timeout: int = 120, attempts: int = 4) -> dict[str, Any]:
    """
    All HTTP goes through curl rather than urllib.

    Not a style choice: the system Python on this machine fails TLS against
    archive.org with "EOF occurred in violation of protocol", and the failure
    looks like an empty result set rather than an error, which is exactly the
    kind of thing that makes you conclude "there is no free nasheed audio" when
    in fact you never made a successful request.

    Retries with backoff because archive.org throttles broad queries by
    dropping the connection or returning an HTML error page. A single attempt
    reports "0 results" for a term that actually has hundreds — the same
    false-negative failure, one layer up.
    """
    for attempt in range(attempts):
        result = subprocess.run(
            ["curl", "-sS", "-L", "-m", str(timeout), "-H", "User-Agent: nasheed-directory-harvester/0.1", url],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            try:
                return json.loads(result.stdout)
            except json.JSONDecodeError:
                pass  # Usually an HTML throttle page. Retry.
        if attempt < attempts - 1:
            time.sleep(10 * (attempt + 1))
    print(f"  ! gave up after {attempts} attempts: {url[:110]}", file=sys.stderr)
    return {}


def normalise_licence(url: str | None) -> str | None:
    """Maps a licence URL to one of our accepted names, or None to reject."""
    if not url:
        return None
    low = url.lower()
    # Check the rejects first: "by-nc-sa" contains "by-sa" as a substring in
    # some URL shapes, and matching the allow-list first would let an NC
    # licence through under a CC-BY-SA label.
    if "-nc" in low or "-nd" in low or "noncommercial" in low:
        return None
    for fragment, name in LICENCE_ALLOW.items():
        if fragment in low:
            return name
    return None


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug[:80] or "untitled"


# ---------------------------------------------------------------------------
# archive.org
# ---------------------------------------------------------------------------
def harvest_archive(terms: Iterable[str], per_term: int = 2000) -> list[dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for term in terms:
        print(f"[archive.org] {term}")
        cursor = None
        seen = 0
        while seen < per_term:
            params = {
                "q": f'({term}) AND mediatype:audio',
                "fields": "identifier,title,creator,licenseurl,uploader,date,subject",
                "count": "1000",
            }
            if cursor:
                params["cursor"] = cursor
            data = run_curl(
                "https://archive.org/services/search/v1/scrape?" + urllib.parse.urlencode(params),
                timeout=120,
            )
            items = data.get("items", [])
            if not items:
                break
            for item in items:
                licence = normalise_licence(item.get("licenseurl"))
                if not licence:
                    continue
                ident = item["identifier"]
                if ident in out:
                    continue
                out[ident] = {
                    "source_platform": "archive.org",
                    "source_id": ident,
                    "source_url": f"https://archive.org/details/{ident}",
                    "title": str(item.get("title") or ident)[:300],
                    "artist": first_str(item.get("creator")),
                    # Kept deliberately: on archive.org the uploader is very
                    # often NOT the rights holder, and that mismatch is the
                    # single most common way a "CC-BY" claim turns out to be
                    # someone re-uploading a commercial album.
                    "uploader": item.get("uploader"),
                    "license": licence,
                    "license_url": item.get("licenseurl"),
                    "matched_term": term,
                    "subjects": item.get("subject"),
                }
            seen += len(items)
            cursor = data.get("cursor")
            if not cursor:
                break
            time.sleep(0.3)
        print(f"  kept {len(out)} permissive so far", flush=True)
        time.sleep(4)  # archive.org throttles a fast term-by-term sweep
    return list(out.values())


def first_str(value: Any) -> str | None:
    if isinstance(value, list):
        return str(value[0])[:200] if value else None
    return str(value)[:200] if value else None


# ---------------------------------------------------------------------------
# Wikimedia Commons
# ---------------------------------------------------------------------------
def harvest_commons(terms: Iterable[str]) -> list[dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for term in terms:
        print(f"[commons] {term}")
        params = {
            "action": "query",
            "format": "json",
            "generator": "search",
            "gsrsearch": f"filetype:audio {term}",
            "gsrnamespace": "6",
            "gsrlimit": "100",
            "prop": "imageinfo",
            "iiprop": "url|extmetadata|mediatype|size",
        }
        data = run_curl("https://commons.wikimedia.org/w/api.php?" + urllib.parse.urlencode(params))
        pages = (data.get("query") or {}).get("pages") or {}
        for page in pages.values():
            info = (page.get("imageinfo") or [{}])[0]
            meta = info.get("extmetadata") or {}
            licence_url = (meta.get("LicenseUrl") or {}).get("value")
            short = (meta.get("LicenseShortName") or {}).get("value", "")
            licence = normalise_licence(licence_url) or normalise_short_name(short)
            if not licence or not info.get("url"):
                continue
            title = page.get("title", "").removeprefix("File:")
            out[title] = {
                "source_platform": "wikimedia",
                "source_id": title,
                "source_url": info.get("descriptionurl") or f"https://commons.wikimedia.org/wiki/{urllib.parse.quote(page.get('title',''))}",
                "download_url": info.get("url"),
                "title": strip_html(title.rsplit(".", 1)[0])[:300],
                "artist": strip_html((meta.get("Artist") or {}).get("value", "")) or None,
                "license": licence,
                "license_url": licence_url,
                "matched_term": term,
                "file_size_bytes": info.get("size"),
            }
        time.sleep(0.3)
    print(f"  kept {len(out)} permissive")
    return list(out.values())


def normalise_short_name(short: str) -> str | None:
    """Commons sometimes gives a short name but no licence URL."""
    low = short.lower()
    if "nc" in low or "nd" in low:
        return None
    if "cc0" in low or "public domain" in low:
        return "CC0"
    if "cc by-sa" in low:
        return "CC-BY-SA"
    if "cc by" in low:
        return "CC-BY"
    return None


def strip_html(raw: str) -> str:
    return re.sub(r"<[^>]+>", "", raw).strip()


# ---------------------------------------------------------------------------
# Openverse (aggregates Freesound, Jamendo, Wikimedia)
# ---------------------------------------------------------------------------
def harvest_openverse(terms: Iterable[str]) -> list[dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for term in terms:
        print(f"[openverse] {term}")
        for page in range(1, 4):
            params = {
                "q": term,
                "license": "cc0,by,by-sa",
                "page_size": "100",
                "page": str(page),
            }
            data = run_curl("https://api.openverse.org/v1/audio/?" + urllib.parse.urlencode(params))
            results = data.get("results") or []
            if not results:
                break
            for item in results:
                licence = {"cc0": "CC0", "by": "CC-BY", "by-sa": "CC-BY-SA", "pdm": "public-domain"}.get(
                    (item.get("license") or "").lower()
                )
                if not licence:
                    continue
                ident = item.get("id")
                if not ident or ident in out:
                    continue
                out[ident] = {
                    "source_platform": f"openverse:{item.get('source')}",
                    "source_id": ident,
                    "source_url": item.get("foreign_landing_url") or item.get("url"),
                    "download_url": item.get("url"),
                    "title": (item.get("title") or "untitled")[:300],
                    "artist": item.get("creator"),
                    "artist_url": item.get("creator_url"),
                    "license": licence,
                    "license_url": item.get("license_url"),
                    "duration_ms": item.get("duration"),
                    "matched_term": term,
                    "tags": [t.get("name") for t in (item.get("tags") or []) if t.get("name")],
                }
            time.sleep(0.4)
    print(f"  kept {len(out)} permissive")
    return list(out.values())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", choices=["all", "archive", "commons", "openverse"], default="all")
    parser.add_argument("--terms", nargs="*", default=None)
    args = parser.parse_args()

    terms = args.terms or SEARCH_TERMS
    candidates: list[dict[str, Any]] = []

    if args.source in ("all", "archive"):
        candidates += harvest_archive(terms)
    if args.source in ("all", "commons"):
        candidates += harvest_commons(terms)
    if args.source in ("all", "openverse"):
        candidates += harvest_openverse(terms)

    # Merge with anything harvested previously so re-running with new terms
    # adds rather than replaces.
    existing: dict[str, dict[str, Any]] = {}
    if CANDIDATES.exists():
        for row in json.loads(CANDIDATES.read_text()):
            existing[f"{row['source_platform']}:{row['source_id']}"] = row
    for row in candidates:
        existing[f"{row['source_platform']}:{row['source_id']}"] = row

    merged = list(existing.values())
    for row in merged:
        row.setdefault("slug", slugify(row["title"]))
    CANDIDATES.write_text(json.dumps(merged, indent=1, ensure_ascii=False))

    by_platform: dict[str, int] = {}
    for row in merged:
        key = row["source_platform"].split(":")[0]
        by_platform[key] = by_platform.get(key, 0) + 1

    print(f"\n{len(merged)} candidates -> {CANDIDATES}")
    for platform, count in sorted(by_platform.items(), key=lambda kv: -kv[1]):
        print(f"  {platform:20} {count}")
    print("\nNext: python3 tools/screen.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
