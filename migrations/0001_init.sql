-- Nasheed Directory — initial schema.
--
-- Design note on the central idea of this project:
--
-- "Halal" is a ruling, and this database is not a scholar. So the schema
-- deliberately separates three different kinds of claim, and never lets a
-- softer one masquerade as a harder one:
--
--   1. OBSERVABLE FACTS about the audio  -> the `audio_*` columns.
--      "There is a sustained pitched instrument between 0:12 and 0:31."
--      These come from signal analysis and are reproducible by anyone.
--
--   2. A LICENSE FACT about the recording -> the `license` columns.
--      "The rights holder released this under CC0." Checkable against a URL.
--
--   3. A HUMAN JUDGEMENT                  -> `verification_status`.
--      "A person listened and applied the rubric." Always attributed to
--      someone, always with a date, never inferred from (1) or (2).
--
-- A consumer that disagrees with our rubric can ignore column 3 entirely and
-- filter on the raw facts in column 1. That is why the facts are stored
-- separately instead of being collapsed into one `is_halal` boolean.

-- ---------------------------------------------------------------------------
-- tracks — the catalog itself
-- ---------------------------------------------------------------------------
CREATE TABLE tracks (
  id                   TEXT PRIMARY KEY,
  slug                 TEXT NOT NULL UNIQUE,

  -- Identity
  title                TEXT NOT NULL,
  title_original       TEXT,            -- Arabic/Urdu/Bangla script, if known
  artist               TEXT,            -- NULL for genuinely anonymous works
  artist_url           TEXT,
  description          TEXT,

  -- ── 1. OBSERVABLE AUDIO FACTS ──────────────────────────────────────────
  -- `instrumentation` is the single most important column in this table.
  --   'voice_only'   — unaccompanied human voice (solo or group)
  --   'voice_duff'   — voice plus frame drum (duff/daff) only
  --   'duff_only'    — frame drum with no vocal line
  --   'has_melodic'  — contains a pitched instrument. Kept in the DB on
  --                    purpose (rejections are evidence, not waste) but
  --                    never returned by default and never publishable.
  instrumentation      TEXT NOT NULL CHECK (instrumentation IN
                         ('voice_only','voice_duff','duff_only','has_melodic')),

  -- Raw detector output that produced the classification above, as JSON:
  -- {"model":"yamnet","top_labels":[["Singing",0.91],...],
  --  "melodic_segments":[[12.4,31.0]], "threshold":0.35}
  -- Stored so a maintainer can re-check WHY something was flagged, and so a
  -- better model later can be diffed against the old one.
  detector_evidence    TEXT,
  detector_version     TEXT,

  duration_seconds     REAL NOT NULL,
  sample_rate          INTEGER,
  channels             INTEGER,
  loudness_lufs        REAL,            -- for background use: pick quiet ones
  is_loopable          INTEGER NOT NULL DEFAULT 0 CHECK (is_loopable IN (0,1)),

  -- Lyric content. `lyrics_language` uses ISO 639-1 where possible.
  -- `lyrics_text` may be NULL — absence of lyrics text is NOT evidence of
  -- clean lyrics, and `content_reviewed` records whether anyone checked.
  lyrics_language      TEXT,
  lyrics_text          TEXT,
  lyrics_translation   TEXT,
  content_reviewed     INTEGER NOT NULL DEFAULT 0 CHECK (content_reviewed IN (0,1)),

  -- ── 2. LICENSE FACTS ───────────────────────────────────────────────────
  -- Only genuinely free licenses are publishable. NC and ND are rejected on
  -- purpose: this directory exists so people can use the audio in their own
  -- videos, including monetised ones, and "free for non-commercial" breaks
  -- that promise quietly rather than loudly.
  license              TEXT NOT NULL CHECK (license IN
                         ('CC0','CC-BY','CC-BY-SA','public-domain','author-permission')),
  license_url          TEXT,
  attribution_text     TEXT,            -- exact string a user must reproduce
  source_url           TEXT NOT NULL,   -- where we got it; provenance, always
  source_platform      TEXT,            -- archive.org | wikimedia | freesound | direct
  -- For 'author-permission': how permission was obtained, so the claim is
  -- auditable years later rather than resting on someone's memory.
  permission_evidence  TEXT,

  -- ── 3. HUMAN JUDGEMENT ─────────────────────────────────────────────────
  --   'community_submitted' — in the catalog, nobody has vetted it yet.
  --   'maintainer_verified' — a maintainer listened and applied the rubric.
  --   'scholar_reviewed'    — a named person with scholarly standing signed off.
  -- The API returns only 'maintainer_verified' and 'scholar_reviewed' unless
  -- the caller explicitly opts in to the rest. Defaulting to the safe subset
  -- is the point of having tiers at all.
  verification_status  TEXT NOT NULL DEFAULT 'community_submitted'
                         CHECK (verification_status IN
                         ('community_submitted','maintainer_verified','scholar_reviewed')),
  verified_by          TEXT,
  verified_at          TEXT,
  review_notes         TEXT,

  -- ── Storage ────────────────────────────────────────────────────────────
  r2_key               TEXT,            -- NULL until the audio is mirrored
  file_format          TEXT,            -- mp3 | ogg | opus | flac | wav
  file_size_bytes      INTEGER,
  sha256               TEXT,            -- of the bytes actually stored in R2

  -- ── Discovery ──────────────────────────────────────────────────────────
  mood                 TEXT,            -- calm | uplifting | solemn | joyful | reflective
  tags                 TEXT NOT NULL DEFAULT '[]',   -- JSON array of strings

  -- Only published rows are visible to the public API. Nothing is published
  -- automatically: publishing requires instrumentation != 'has_melodic',
  -- a free license, and a human verification tier. Enforced in code AND by
  -- the trigger below, because this is the one invariant the whole project
  -- rests on.
  published            INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0,1)),

  submitted_by         TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE INDEX idx_tracks_published    ON tracks(published, verification_status);
CREATE INDEX idx_tracks_instrument   ON tracks(instrumentation);
CREATE INDEX idx_tracks_license      ON tracks(license);
CREATE INDEX idx_tracks_duration     ON tracks(duration_seconds);
CREATE INDEX idx_tracks_mood         ON tracks(mood);

-- The invariant, enforced at the database rather than only in the handler:
-- a row can never be published while it contains a melodic instrument, while
-- its license is unfree, or while no human has verified it. A future bug in
-- an API route, an import script, or a migration cannot quietly publish a
-- track that fails the rubric.
CREATE TRIGGER trg_tracks_publish_guard_insert
BEFORE INSERT ON tracks
WHEN NEW.published = 1 AND (
     NEW.instrumentation = 'has_melodic'
  OR NEW.verification_status = 'community_submitted'
  OR NEW.r2_key IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'refused: a track may only be published when it is instrument-clean, human-verified, and mirrored to R2');
END;

CREATE TRIGGER trg_tracks_publish_guard_update
BEFORE UPDATE ON tracks
WHEN NEW.published = 1 AND (
     NEW.instrumentation = 'has_melodic'
  OR NEW.verification_status = 'community_submitted'
  OR NEW.r2_key IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'refused: a track may only be published when it is instrument-clean, human-verified, and mirrored to R2');
END;

-- ---------------------------------------------------------------------------
-- Full-text search over the human-readable fields.
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE tracks_fts USING fts5(
  title, title_original, artist, description, lyrics_text, tags,
  content='tracks', content_rowid='rowid'
);

CREATE TRIGGER trg_tracks_fts_insert AFTER INSERT ON tracks BEGIN
  INSERT INTO tracks_fts(rowid, title, title_original, artist, description, lyrics_text, tags)
  VALUES (new.rowid, new.title, new.title_original, new.artist, new.description, new.lyrics_text, new.tags);
END;

CREATE TRIGGER trg_tracks_fts_delete AFTER DELETE ON tracks BEGIN
  INSERT INTO tracks_fts(tracks_fts, rowid, title, title_original, artist, description, lyrics_text, tags)
  VALUES ('delete', old.rowid, old.title, old.title_original, old.artist, old.description, old.lyrics_text, old.tags);
END;

CREATE TRIGGER trg_tracks_fts_update AFTER UPDATE ON tracks BEGIN
  INSERT INTO tracks_fts(tracks_fts, rowid, title, title_original, artist, description, lyrics_text, tags)
  VALUES ('delete', old.rowid, old.title, old.title_original, old.artist, old.description, old.lyrics_text, old.tags);
  INSERT INTO tracks_fts(rowid, title, title_original, artist, description, lyrics_text, tags)
  VALUES (new.rowid, new.title, new.title_original, new.artist, new.description, new.lyrics_text, new.tags);
END;

-- ---------------------------------------------------------------------------
-- submissions — anyone may propose a track; nothing enters the catalog
-- unreviewed. Kept in its own table rather than as unpublished `tracks` rows
-- so that a submission carries the submitter's claims (which may be wrong)
-- without those claims ever sitting in the same columns the API reads from.
-- ---------------------------------------------------------------------------
CREATE TABLE submissions (
  id                   TEXT PRIMARY KEY,
  title                TEXT NOT NULL,
  artist               TEXT,
  source_url           TEXT NOT NULL,
  claimed_license      TEXT,
  claimed_instrumentation TEXT,
  notes                TEXT,
  submitter_name       TEXT,
  submitter_contact    TEXT,
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','accepted','rejected','duplicate')),
  review_notes         TEXT,
  reviewed_by          TEXT,
  reviewed_at          TEXT,
  accepted_track_id    TEXT REFERENCES tracks(id),
  created_at           TEXT NOT NULL
);

CREATE INDEX idx_submissions_status ON submissions(status, created_at);

-- ---------------------------------------------------------------------------
-- api_tokens — Bearer keys for the /api/v1 and /mcp surfaces.
-- Plaintext is never stored; `token_hash` is lowercase-hex SHA-256.
-- `scope` is 'read' for everyone; 'admin' additionally permits writes.
-- ---------------------------------------------------------------------------
CREATE TABLE api_tokens (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  name          TEXT,
  scope         TEXT NOT NULL DEFAULT 'read' CHECK (scope IN ('read','admin')),
  owner_email   TEXT,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  revoked_at    TEXT
);

CREATE INDEX idx_api_tokens_hash ON api_tokens(token_hash) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- download_events — one row per served file, no IP and no user agent.
-- Enough to tell an artist how often their work was used, and to spot a
-- scraper; not enough to profile a listener. Privacy is a design constraint
-- here, not an afterthought.
-- ---------------------------------------------------------------------------
CREATE TABLE download_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id   TEXT NOT NULL REFERENCES tracks(id),
  token_id   TEXT,
  day        TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_download_events_track ON download_events(track_id, day);
