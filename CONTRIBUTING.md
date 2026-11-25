# Contributing

## Adding a track

You do not need to write code. Open a [submission](https://nasheed.lomeyo.com/submit)
or `POST /api/v1/submissions`. You must be the artist, the label, or hold written
permission from them, and you must link the evidence (`relationship` and
`rights_evidence_url`).

Two things decide whether a submission is accepted, and most rejected ones fail on
the first:

**1. The licence must come from the rights holder.** A track is published only when
the artist or label released it under an open commercial licence themselves, with
the evidence linked. Somebody re-uploading an album to a public archive and ticking a
Creative Commons box does not make it freely licensed. Link to where the artist
themselves released it. This is the single most common way a "copyright-free" claim
turns out to be false; it took the whole catalog offline on 2026-11-25, and it is why
every track stores `rights_basis` and `rights_evidence_url`.

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
python3 -m unittest tools/test_rights.py   # the ingest's rights rules
```

Tests that assert the catalog's promise — that no melodic, unverified, rights-unchecked
or blocked track can be returned or published — live in `src/worker/lib/query.test.ts`
and `src/worker/lib/rights.test.ts`. **Do not weaken them.** If a change makes one fail,
the change is almost certainly wrong. The same invariant is enforced independently by
database triggers (`migrations/0003_rights_gate.sql`), on purpose: two mechanisms, so
one bug cannot break the promise alone.

## The harvesting pipeline

`tools/` holds four stages, each writing a file the next reads. See the README.
The important thing to understand before changing `screen.py`: the detector **ranks**
the review queue, it does not gate it. Making it authoritative would mean a
misclassification silently deletes a good track from the catalog, and no threshold
setting was ever good enough to earn that. Tracks a machine cleared are published as
`automated_verified`, which says plainly that no person has listened; everything else
waits for a person.
