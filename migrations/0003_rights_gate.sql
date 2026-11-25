-- Adds the rights gate: a track is published only when the artist or label
-- released it under an open commercial licence themselves, with the evidence
-- linked.
--
-- WHY THIS EXISTS
--
-- On 2026-11-25 every published track was taken offline. The schema stored
-- `license` as a fact about the recording, but on archive.org the licence is
-- chosen by whoever uploads the file, and for almost every track that person
-- was not the rights holder. One account had uploaded 48 tracks from 14 labels
-- and artists and marked them all with the Public Domain Mark — a mark
-- meant for very old works, never a licence an owner gives. The pipeline read
-- that field as a licence and published it. Three Taliban taranas went live
-- the same way, because their uploader really was their singer.
--
-- So a licence string is now treated as what it is: a claim. Publication needs
-- a second, separate fact — WHY we believe the rights holder chose that
-- licence — and a link where anyone can check the reason:
--
--   rights_basis         one of:
--     artist_upload        the artist or label uploaded the file themselves and
--                          chose the licence (the account is shown to be theirs)
--     artist_channel_cc    the artist's own channel marks it Creative Commons,
--                          and the file we host was sent to us by the artist.
--                          We never download from a video platform.
--     artist_platform      the artist's own website or label page offers it
--                          under the licence
--     written_permission   the rights holder gave written permission;
--                          `permission_evidence` says how
--     public_domain_by_age the recording is old enough to be out of copyright
--                          (made before 1951), shown by the evidence
--   rights_evidence_url  where the basis can be checked
--   rights_checked_by    who checked it: a person, or an agent named as one
--   rights_checked_at    when
--
--   source_uploader      the account that uploaded the file to its source.
--                        Often a personal email address, so the API never
--                        returns it. Stored only so `blocked_sources` can
--                        match on it.
--
-- `blocked_sources` lists artists, source URLs and uploaders whose recordings
-- must never be published — militant distributors, and accounts that re-upload
-- other people's albums. Its ROWS are deliberately not in this file: this
-- repository is public, and the rows include personal email addresses.
-- Maintainers add them directly to the database.
--
-- No table rebuild this time. SQLite can add a column with a CHECK in place,
-- so `tracks` keeps its rowid and the full-text index stays valid.

ALTER TABLE tracks ADD COLUMN rights_basis TEXT CHECK (rights_basis IS NULL OR rights_basis IN
  ('artist_upload','artist_channel_cc','artist_platform','written_permission','public_domain_by_age'));
ALTER TABLE tracks ADD COLUMN rights_evidence_url TEXT CHECK (rights_evidence_url IS NULL
  OR rights_evidence_url LIKE 'https://%' OR rights_evidence_url LIKE 'http://%');
ALTER TABLE tracks ADD COLUMN rights_checked_by TEXT;
ALTER TABLE tracks ADD COLUMN rights_checked_at TEXT;
ALTER TABLE tracks ADD COLUMN source_uploader TEXT;

-- A submitter must now say who they are to the recording, and link proof.
-- Nullable only because the column is added to an existing table; the API
-- refuses a submission without both.
ALTER TABLE submissions ADD COLUMN submitter_relationship TEXT CHECK (submitter_relationship IS NULL
  OR submitter_relationship IN ('artist','label','written_permission'));
ALTER TABLE submissions ADD COLUMN rights_evidence_url TEXT;

-- One row per thing we refuse. Matching ignores case and surrounding spaces:
-- archive.org often shows one singer as both "Some Singer" and "SOME SINGER".
CREATE TABLE blocked_sources (
  id        INTEGER PRIMARY KEY,
  kind      TEXT NOT NULL CHECK (kind IN ('artist','source_url','uploader')),
  value     TEXT NOT NULL CHECK (length(trim(value)) > 0),
  reason    TEXT NOT NULL,
  added_by  TEXT NOT NULL,
  added_at  TEXT NOT NULL,
  UNIQUE (kind, value)
);

-- The invariant, restated. Every condition from 0002 is kept word for word,
-- and three are added. Each failure raises its own message, so a refused
-- publish says which rule it broke rather than leaving someone to guess.
DROP TRIGGER IF EXISTS trg_tracks_publish_guard_insert;
DROP TRIGGER IF EXISTS trg_tracks_publish_guard_update;

CREATE TRIGGER trg_tracks_publish_guard_insert
BEFORE INSERT ON tracks
WHEN NEW.published = 1
BEGIN
  SELECT RAISE(ABORT, 'refused: a track may only be published when it is instrument-clean, verified, and mirrored to R2')
  WHERE NEW.instrumentation = 'has_melodic'
     OR NEW.verification_status = 'community_submitted'
     OR NEW.r2_key IS NULL;
  SELECT RAISE(ABORT, 'refused: a track may only be published with a rights_basis and a rights_evidence_url; a licence chosen by an uploader is not evidence')
  WHERE NEW.rights_basis IS NULL
     OR NEW.rights_evidence_url IS NULL;
  SELECT RAISE(ABORT, 'refused: a public-domain track may only be published with rights_basis public_domain_by_age')
  WHERE NEW.license = 'public-domain'
    AND NEW.rights_basis <> 'public_domain_by_age';
  SELECT RAISE(ABORT, 'refused: this track matches a row in blocked_sources (artist, source URL or uploader)')
  WHERE EXISTS (
    SELECT 1 FROM blocked_sources b
    WHERE (b.kind = 'artist'     AND lower(trim(b.value)) = lower(trim(NEW.artist)))
       OR (b.kind = 'source_url' AND lower(trim(b.value)) = lower(trim(NEW.source_url)))
       OR (b.kind = 'uploader'   AND lower(trim(b.value)) = lower(trim(NEW.source_uploader)))
  );
END;

CREATE TRIGGER trg_tracks_publish_guard_update
BEFORE UPDATE ON tracks
WHEN NEW.published = 1
BEGIN
  SELECT RAISE(ABORT, 'refused: a track may only be published when it is instrument-clean, verified, and mirrored to R2')
  WHERE NEW.instrumentation = 'has_melodic'
     OR NEW.verification_status = 'community_submitted'
     OR NEW.r2_key IS NULL;
  SELECT RAISE(ABORT, 'refused: a track may only be published with a rights_basis and a rights_evidence_url; a licence chosen by an uploader is not evidence')
  WHERE NEW.rights_basis IS NULL
     OR NEW.rights_evidence_url IS NULL;
  SELECT RAISE(ABORT, 'refused: a public-domain track may only be published with rights_basis public_domain_by_age')
  WHERE NEW.license = 'public-domain'
    AND NEW.rights_basis <> 'public_domain_by_age';
  SELECT RAISE(ABORT, 'refused: this track matches a row in blocked_sources (artist, source URL or uploader)')
  WHERE EXISTS (
    SELECT 1 FROM blocked_sources b
    WHERE (b.kind = 'artist'     AND lower(trim(b.value)) = lower(trim(NEW.artist)))
       OR (b.kind = 'source_url' AND lower(trim(b.value)) = lower(trim(NEW.source_url)))
       OR (b.kind = 'uploader'   AND lower(trim(b.value)) = lower(trim(NEW.source_uploader)))
  );
END;
