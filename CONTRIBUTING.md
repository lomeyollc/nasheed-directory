# Contributing

## Adding a track

You do not need to write code. Open a [submission](https://nasheed.lomeyo.com/submit)
or `POST /api/v1/submissions`.

Two things decide whether a submission is accepted, and most rejected ones fail on
the first:

**1. The licence must come from the rights holder.** Somebody re-uploading an album
to a public archive and ticking a Creative Commons box does not make it freely
licensed. Link to where the artist themselves released it. This is the single most
common way a "copyright-free" claim turns out to be false, and it is why every track
in the catalog stores its `source_url` permanently.

**2. Voice and duff only.** No melodic instruments at all — see
[the rubric](https://nasheed.lomeyo.com/rubric). If you are unsure whether that
percussion is a duff, submit anyway and say so in the notes. That uncertainty is
exactly what human review is for.

## Disagreeing with the rubric

The rubric applies the stricter position that melodic instruments are not permitted,
with the duff as the recognised exception. That is not the only position among
Muslims, and this project does not claim to issue rulings.

If you think a clause is wrong, open an issue. Quote the clause id from
`/api/v1/rubric` and say what you would change it to. Please argue about the clause
rather than about a particular track — a rubric change is reviewable by everyone,
whereas a one-off exception is not.

If you simply follow a different position, you do not have to argue at all: the raw
facts are stored separately from our judgement precisely so you can ignore
`verification_status` and filter on `instrumentation` yourself.

## Code

```bash
npm install
npm run check     # typecheck
npm test          # vitest
npm run build
```

Tests that assert the catalog's promise — that no melodic or unverified track can be
returned or published — live in `src/worker/lib/query.test.ts`. **Do not weaken them.**
If a change makes one fail, the change is almost certainly wrong. The same invariant
is enforced independently by a database trigger in `migrations/0001_init.sql`, on
purpose: two mechanisms, so one bug cannot break the promise alone.

## The harvesting pipeline

`tools/` holds four stages, each writing a file the next reads. See the README.
The important thing to understand before changing `screen.py`: the detector **ranks**
the review queue, it does not gate it. Making it authoritative would mean a
misclassification silently deletes a good track from the catalog, and no threshold
setting was ever good enough to earn that. Nothing enters the catalog without a
person listening to it.
