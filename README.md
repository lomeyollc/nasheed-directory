# Nasheed Directory

An open catalog of background audio that is halal by a strict rubric and freely licensed for
commercial reuse — built so an AI agent editing a video can pick music without having to verify
it by ear.

**https://nasheed.lomeyo.com** · [API docs](https://nasheed.lomeyo.com/docs) ·
[The rubric](https://nasheed.lomeyo.com/rubric) · [`llms.txt`](https://nasheed.lomeyo.com/llms.txt)

---

## The problem this solves

If you are making a video and you want background audio that is halal, you have to listen to
every candidate track and judge it yourself. There is no field in any music library that says
"contains no melodic instruments". Freesound will not tell you. YouTube's audio library will not
tell you. And an AI agent editing on your behalf cannot listen at all — it can only read
metadata, and no metadata exists.

So this catalog stores the fact that is missing: **what instruments are in the recording**, as a
first-class, queryable field, alongside a licence that actually permits commercial use.

## What "halal background audio" means here

| Rule | What fails it |
|---|---|
| **Voice only, or voice + duff** | Any melodic instrument — strings, wind, brass, piano, synth, oud, ney |
| **Duff is the only percussion** | Drum kits, drum machines, tuned percussion |
| **Clean lyrics** | Romance, shirk, profanity, glorification of the impermissible |
| **No instrument imitation** | Beatboxing as a drum track, vocal pads used as an instrumental bed |
| **Freely licensed** | NonCommercial (NC), NoDerivatives (ND), or a licence asserted by a re-uploader |

This applies the **stricter** scholarly position — that melodic instruments are not permitted,
with the duff as the recognised exception. That is not the only position among Muslims. It is
used here because audio that passes it is also acceptable to someone following a more permissive
view, while the reverse is not true.

**This is a tool, not a fatwa.** The rubric is published as data at `/api/v1/rubric` precisely so
you can read the rule, disagree with a clause, and filter on the raw facts instead.

### Three kinds of claim, kept separate

The schema deliberately never collapses these into one `is_halal` boolean:

1. **Observable facts** — `instrumentation`, `detector_evidence`. Reproducible by anyone.
2. **A licence fact** — `license`, `license_url`, `source_url`. Checkable against a document.
3. **A human judgement** — `verification_status`, always attributed and dated.

A consumer who distrusts our judgement can ignore (3) entirely and filter on (1).

| `verification_status` | Meaning |
|---|---|
| `scholar_reviewed` | A named person with scholarly standing signed off |
| `maintainer_verified` | A maintainer listened to the whole track and applied the rubric |
| `community_submitted` | In the database, vetted by nobody. **Never returned by default** |

## Using it

### REST

```bash
# Issue yourself a key
curl -X POST https://nasheed.lomeyo.com/api/v1/keys \
  -H "Content-Type: application/json" \
  -d '{"name":"my-video-agent","email":"you@example.com"}'

# Search
curl -H "Authorization: Bearer YOUR_KEY" \
  "https://nasheed.lomeyo.com/api/v1/tracks?max_duration=60&instrumentation=voice_only"
```

Filters: `q`, `instrumentation`, `license`, `mood`, `language`, `tags`, `min_duration`,
`max_duration`, `loopable`, `limit`, `offset`, `sort`.

The same reads are available **without a key** under `/api/public/`. The key exists so a heavy
consumer has an identity we can rate-limit and contact — not to gate freely-licensed audio.

### MCP

```bash
claude mcp add --transport http nasheed https://nasheed.lomeyo.com/mcp \
  --header "Authorization: Bearer YOUR_KEY"
```

| Tool | What it does |
|---|---|
| `pick_background_track` | Give a video length and a mood, get one track that fits plus the credit line and an ffmpeg command |
| `search_nasheeds` | Full search |
| `get_nasheed` | One track by slug |
| `get_halal_rubric` | The rules the catalog applies |
| `get_catalog_stats` | Counts by instrumentation, licence, tier, language |
| `submit_nasheed` | Propose a track for review |

### Attribution

CC-BY and CC-BY-SA tracks **require credit**. Every track record carries `attribution_text` with
the exact string to reproduce — use it rather than assembling your own.

## Contributing a track

Open [a submission](https://nasheed.lomeyo.com/submit), or `POST /api/v1/submissions`.

Two things most submissions get wrong:

- **The licence must come from the rights holder.** Someone re-uploading an album to a public
  archive and ticking a Creative Commons box does not make it freely licensed. This is the single
  most common way a "copyright-free" claim turns out to be false.
- **Voice and duff only.** If you are unsure whether that percussion is a duff, submit anyway and
  say so in the notes — that is exactly what review is for.

Nothing is published on a submitter's word.

## How the catalog is built

Four stages in `tools/`, each writing a file the next one reads, so any stage can be re-run
alone:

```
harvest.py     →  candidates.json  find freely-licensed candidates (archive.org, Wikimedia)
screen.py      →  screened.json    download, run YAMNet, flag melodic instruments
transcribe.py  →  screened.json    whisper: lyrics → English, flag content
review.py      →  decisions.json   a human listens and decides (local web UI, keyboard)
publish.py     →  D1 + R2          transcode, normalise loudness, upload, insert
```

**`screen.py` is a filter, not a verdict.** It is biased toward false positives on purpose: a
clean track wrongly flagged costs one human listen, while an instrumental track wrongly passed
ends up in a catalog that promises it is not there. Those errors are not symmetric.

**The duff problem.** AudioSet — and therefore YAMNet — has no class for a frame drum. A duff
registers as "Drum" or "Tabla", exactly like a drum machine. So percussion is **never**
auto-cleared: any percussive track is routed to a human with timestamps marked. Telling a duff
from a drum kit is a listening job, and pretending otherwise would be the one place this
pipeline could quietly put something wrong in the catalog.

**Why transcription is a required stage, not a nicety.** The instrument detector
is blind to the most dangerous content in this corpus. Jihadi nasheeds are
overwhelmingly *unaccompanied vocal*, so they pass every instrumentation check
looking exactly like the ideal catalog entry — measured on this project's own
harvest, ~9% of freely-licensed archive.org candidates carry markers of that
genre in the title alone, and titles undercount. Without translated lyrics the
only honest options were to reject every Arabic track, throwing away most of the
corpus, or to approve audio whose words nobody in the loop understood.

The strongest signal turned out to be one nobody planned for: **the producing
studio**. Whisper reliably picks up the spoken ident at the start of a track,
and a nasheed's producer identifies its politics far more reliably than its
words do — the words are poetry, the ident is a brand.

```bash
brew install whisper-cpp
python3.12 -m venv tools/.venv
tools/.venv/bin/pip install tensorflow tensorflow-hub soundfile numpy resampy "setuptools<81"

python3 tools/harvest.py
tools/.venv/bin/python tools/screen.py
python3 tools/transcribe.py      # lyrics → English, flags content
python3 tools/review.py          # http://127.0.0.1:8787 — A/S/D accept, R reject, U unsure
python3 tools/publish.py --remote
```

## Self-hosting

```bash
npm install
npx wrangler d1 create nasheed-directory     # put the id in wrangler.jsonc
npx wrangler r2 bucket create nasheed-audio
npx wrangler d1 execute nasheed-directory --remote --file migrations/0001_init.sql
npm run deploy
```

Stack: Cloudflare Workers + D1 + R2, React 19, Tailwind 4, TypeScript. No Durable Objects — the
catalog is small and read-heavy, so nothing needs durable per-entity coordination.

### The one invariant

A track can only be `published = 1` when it is instrument-clean, human-verified, and mirrored to
R2. This is enforced by a **database trigger** in `migrations/0001_init.sql`, not only in the
request handler — so a future bug in an API route, an import script, or a migration cannot
quietly publish something that fails the rubric.

## Licence

Code: MIT. **The audio is not MIT** — each track keeps its own licence, recorded per row. Check
`license` and reproduce `attribution_text` before you use anything.
