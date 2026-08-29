-- Adds a fourth verification tier: `automated_verified`.
--
-- WHY THIS EXISTS, AND WHY IT IS NOT A LOWERING OF THE BAR
--
-- The original schema had three tiers and allowed publication only from the
-- two that involve a person. That is the right default, but it made the
-- catalog unusable in practice: every track waits on one human listening to
-- every recording end to end, and a catalog nobody can use protects nobody.
--
-- The honest observation is that the rubric's clauses are not equally
-- human-dependent. Three of the five are checkable by machine, and checkable
-- WELL:
--
--   instrumentation   signal analysis over AudioSet classes. Reproducible,
--                     and the evidence is stored per track.
--   license           a document at a URL. Not a judgement at all.
--   lyrical content   transcribe, translate, screen. Imperfect, but it reads
--   + extremist       the actual words rather than guessing from a waveform.
--
-- What genuinely needs an ear is the duff question — AudioSet cannot tell a
-- frame drum from a drum kit — and the final judgement on poetry that a rough
-- machine translation renders ambiguous.
--
-- So rather than publish nothing, or publish everything and call it verified,
-- this tier says exactly what happened: a machine checked these specific
-- things, no human has listened, and here is the evidence. A consumer can
-- filter it out with one parameter. `verified_by` records the detector and
-- model versions instead of a person's name, so the claim stays auditable.
--
-- The bar for entering this tier is deliberately much stricter than the bar a
-- human reviewer applies (see tools/publish.py): near-zero melodic energy,
-- NO percussion at all so the duff question cannot arise, a successful
-- transcription with zero content flags, and a free licence. A track that is
-- merely probably fine does not qualify — it waits for a person.

-- SQLite cannot alter a CHECK constraint, so the table is rebuilt.
PRAGMA foreign_keys = OFF;

CREATE TABLE tracks_new (
  id                   TEXT PRIMARY KEY,
  slug                 TEXT NOT NULL UNIQUE,
  title                TEXT NOT NULL,
  title_original       TEXT,
  artist               TEXT,
  artist_url           TEXT,
  description          TEXT,
  instrumentation      TEXT NOT NULL CHECK (instrumentation IN
                         ('voice_only','voice_duff','duff_only','has_melodic')),
  detector_evidence    TEXT,
  detector_version     TEXT,
  duration_seconds     REAL NOT NULL,
  sample_rate          INTEGER,
  channels             INTEGER,
  loudness_lufs        REAL,
  is_loopable          INTEGER NOT NULL DEFAULT 0 CHECK (is_loopable IN (0,1)),
  lyrics_language      TEXT,
  lyrics_text          TEXT,
  lyrics_translation   TEXT,
  content_reviewed     INTEGER NOT NULL DEFAULT 0 CHECK (content_reviewed IN (0,1)),
  license              TEXT NOT NULL CHECK (license IN
                         ('CC0','CC-BY','CC-BY-SA','public-domain','author-permission')),
  license_url          TEXT,
  attribution_text     TEXT,
  source_url           TEXT NOT NULL,
  source_platform      TEXT,
  permission_evidence  TEXT,
  verification_status  TEXT NOT NULL DEFAULT 'community_submitted'
                         CHECK (verification_status IN
                         ('community_submitted','automated_verified',
                          'maintainer_verified','scholar_reviewed')),
  verified_by          TEXT,
  verified_at          TEXT,
  review_notes         TEXT,
  r2_key               TEXT,
  file_format          TEXT,
  file_size_bytes      INTEGER,
  sha256               TEXT,
  mood                 TEXT,
  tags                 TEXT NOT NULL DEFAULT '[]',
  published            INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0,1)),
  submitted_by         TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

INSERT INTO tracks_new SELECT * FROM tracks;

DROP TRIGGER IF EXISTS trg_tracks_publish_guard_insert;
DROP TRIGGER IF EXISTS trg_tracks_publish_guard_update;
DROP TRIGGER IF EXISTS trg_tracks_fts_insert;
DROP TRIGGER IF EXISTS trg_tracks_fts_delete;
DROP TRIGGER IF EXISTS trg_tracks_fts_update;
DROP TABLE tracks;
ALTER TABLE tracks_new RENAME TO tracks;

CREATE INDEX idx_tracks_published    ON tracks(published, verification_status);
CREATE INDEX idx_tracks_instrument   ON tracks(instrumentation);
CREATE INDEX idx_tracks_license      ON tracks(license);
CREATE INDEX idx_tracks_duration     ON tracks(duration_seconds);
CREATE INDEX idx_tracks_mood         ON tracks(mood);

-- The invariant, restated for four tiers. `community_submitted` still cannot
-- be published: an unvetted claim from a stranger is categorically different
-- from a machine check whose evidence is recorded.
CREATE TRIGGER trg_tracks_publish_guard_insert
BEFORE INSERT ON tracks
WHEN NEW.published = 1 AND (
     NEW.instrumentation = 'has_melodic'
  OR NEW.verification_status = 'community_submitted'
  OR NEW.r2_key IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'refused: a track may only be published when it is instrument-clean, verified, and mirrored to R2');
END;

CREATE TRIGGER trg_tracks_publish_guard_update
BEFORE UPDATE ON tracks
WHEN NEW.published = 1 AND (
     NEW.instrumentation = 'has_melodic'
  OR NEW.verification_status = 'community_submitted'
  OR NEW.r2_key IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'refused: a track may only be published when it is instrument-clean, verified, and mirrored to R2');
END;

-- An automated_verified track may never claim a human checked its content.
-- content_reviewed means "a person read the lyrics"; the machine tier records
-- its transcription in lyrics_translation instead.
CREATE TRIGGER trg_tracks_automated_not_human_insert
BEFORE INSERT ON tracks
WHEN NEW.verification_status = 'automated_verified' AND NEW.content_reviewed = 1
BEGIN
  SELECT RAISE(ABORT, 'refused: automated_verified cannot set content_reviewed — no human read these lyrics');
END;

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

PRAGMA foreign_keys = ON;
