import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { searchTracks } from "./query";

/**
 * These tests exist for one reason: the catalog makes a promise ("no melodic
 * instruments, human-verified") and a bug in a filter would break that promise
 * silently, with no error and no failing page. So the tests assert the
 * promise, not the implementation.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
  title_original TEXT, artist TEXT, artist_url TEXT, description TEXT,
  instrumentation TEXT NOT NULL CHECK (instrumentation IN ('voice_only','voice_duff','duff_only','has_melodic')),
  detector_evidence TEXT, detector_version TEXT, duration_seconds REAL NOT NULL,
  sample_rate INTEGER, channels INTEGER, loudness_lufs REAL,
  is_loopable INTEGER NOT NULL DEFAULT 0, lyrics_language TEXT, lyrics_text TEXT,
  lyrics_translation TEXT, content_reviewed INTEGER NOT NULL DEFAULT 0,
  license TEXT NOT NULL, license_url TEXT, attribution_text TEXT,
  source_url TEXT NOT NULL, source_platform TEXT, permission_evidence TEXT,
  verification_status TEXT NOT NULL DEFAULT 'community_submitted',
  verified_by TEXT, verified_at TEXT, review_notes TEXT, r2_key TEXT,
  file_format TEXT, file_size_bytes INTEGER, sha256 TEXT, mood TEXT,
  tags TEXT NOT NULL DEFAULT '[]', published INTEGER NOT NULL DEFAULT 0,
  submitted_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
  title, title_original, artist, description, lyrics_text, tags,
  content='tracks', content_rowid='rowid');
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT, source_url TEXT NOT NULL,
  claimed_license TEXT, claimed_instrumentation TEXT, notes TEXT,
  submitter_name TEXT, submitter_contact TEXT, status TEXT NOT NULL DEFAULT 'pending',
  review_notes TEXT, reviewed_by TEXT, reviewed_at TEXT, accepted_track_id TEXT,
  created_at TEXT NOT NULL);
`;

interface Seed {
  slug: string;
  instrumentation: string;
  verification_status: string;
  published: number;
  content_reviewed?: number;
  title?: string;
  duration?: number;
  license?: string;
}

async function seed(rows: Seed[]): Promise<void> {
  for (const statement of SCHEMA.split(";").filter((s) => s.trim())) {
    await env.DB.prepare(statement).run();
  }
  await env.DB.prepare("DELETE FROM tracks").run();
  await env.DB.prepare("DELETE FROM tracks_fts").run();

  const now = new Date().toISOString();
  for (const row of rows) {
    await env.DB.prepare(
      `INSERT INTO tracks (id, slug, title, instrumentation, duration_seconds, license,
        source_url, verification_status, published, r2_key, file_format, tags,
        created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, '[]', ?, ?)`
    )
      .bind(
        crypto.randomUUID(),
        row.slug,
        row.title ?? row.slug,
        row.instrumentation,
        row.duration ?? 90,
        row.license ?? "CC0",
        "https://example.org/source",
        row.verification_status,
        row.published,
        `${row.slug}.mp3`,
        "mp3",
        now,
        now
      )
      .run();
  }
}

const APP = "https://nasheed.lomeyo.com";

describe("searchTracks safety filters", () => {
  beforeEach(async () => {
    await seed([
      { slug: "clean-voice", instrumentation: "voice_only", verification_status: "maintainer_verified", published: 1 },
      { slug: "clean-duff", instrumentation: "voice_duff", verification_status: "scholar_reviewed", published: 1 },
      { slug: "guitar-track", instrumentation: "has_melodic", verification_status: "maintainer_verified", published: 1 },
      { slug: "unvetted", instrumentation: "voice_only", verification_status: "community_submitted", published: 1 },
      { slug: "draft", instrumentation: "voice_only", verification_status: "maintainer_verified", published: 0 },
    ]);
  });

  it("never returns a track containing a melodic instrument", async () => {
    const result = await searchTracks(env.DB, APP, {});
    expect(result.tracks.map((t) => t.slug)).not.toContain("guitar-track");
  });

  it("excludes melodic tracks even when the caller explicitly asks for them", async () => {
    // The filter must INTERSECT with the clean set, never replace it —
    // otherwise a crafted query re-opens exactly what the catalog promises.
    const result = await searchTracks(env.DB, APP, { instrumentation: ["has_melodic"] });
    expect(result.tracks).toHaveLength(0);
  });

  it("hides community submissions by default", async () => {
    const result = await searchTracks(env.DB, APP, {});
    expect(result.tracks.map((t) => t.slug)).not.toContain("unvetted");
  });

  it("returns community submissions only on explicit opt-in", async () => {
    const result = await searchTracks(env.DB, APP, { include_unverified: true });
    expect(result.tracks.map((t) => t.slug)).toContain("unvetted");
  });

  it("still hides melodic tracks when unverified ones are opted into", async () => {
    const result = await searchTracks(env.DB, APP, { include_unverified: true });
    expect(result.tracks.map((t) => t.slug)).not.toContain("guitar-track");
  });

  it("hides unpublished drafts", async () => {
    const result = await searchTracks(env.DB, APP, {});
    expect(result.tracks.map((t) => t.slug)).not.toContain("draft");
  });

  it("returns exactly the two clean, verified, published tracks", async () => {
    const result = await searchTracks(env.DB, APP, {});
    expect(result.tracks.map((t) => t.slug).sort()).toEqual(["clean-duff", "clean-voice"]);
    expect(result.total).toBe(2);
  });
});

describe("automated verification tier", () => {
  beforeEach(async () => {
    await seed([
      { slug: "by-machine", instrumentation: "voice_only", verification_status: "automated_verified", published: 1 },
      { slug: "by-human", instrumentation: "voice_only", verification_status: "maintainer_verified", published: 1 },
    ]);
  });

  it("returns machine-verified tracks by default", async () => {
    // The alternative was a catalog that stays empty until a person has
    // listened to every recording, which protects nobody.
    const result = await searchTracks(env.DB, APP, {});
    expect(result.tracks.map((t) => t.slug).sort()).toEqual(["by-human", "by-machine"]);
  });

  it("excludes them when a caller asks for human review only", async () => {
    const result = await searchTracks(env.DB, APP, { include_automated: false });
    expect(result.tracks.map((t) => t.slug)).toEqual(["by-human"]);
  });

  it("labels every track with the tier that actually checked it", async () => {
    const result = await searchTracks(env.DB, APP, {});
    const machine = result.tracks.find((t) => t.slug === "by-machine");
    expect(machine?.verification_status).toBe("automated_verified");
    // A consumer must be able to tell these apart without reading docs.
    expect(machine?.content_reviewed).toBe(false);
  });
});

describe("searchTracks filtering", () => {
  beforeEach(async () => {
    await seed([
      { slug: "short-one", instrumentation: "voice_only", verification_status: "maintainer_verified", published: 1, duration: 30, title: "Short Praise" },
      { slug: "long-one", instrumentation: "voice_only", verification_status: "maintainer_verified", published: 1, duration: 300, title: "Long Remembrance" },
    ]);
  });

  it("filters by maximum duration", async () => {
    const result = await searchTracks(env.DB, APP, { max_duration: 60 });
    expect(result.tracks.map((t) => t.slug)).toEqual(["short-one"]);
  });

  it("filters by minimum duration", async () => {
    const result = await searchTracks(env.DB, APP, { min_duration: 100 });
    expect(result.tracks.map((t) => t.slug)).toEqual(["long-one"]);
  });

  it("caps limit at 100 so one caller cannot pull the whole catalog in a request", async () => {
    const result = await searchTracks(env.DB, APP, { limit: 5000 });
    expect(result.limit).toBe(100);
  });

  it("survives punctuation in the search query", async () => {
    // A bare apostrophe or quote is FTS5 syntax. Unsanitised, this throws a
    // "malformed MATCH expression" and the search box looks broken.
    await expect(searchTracks(env.DB, APP, { q: `Allah's "mercy" *` })).resolves.toBeDefined();
  });

  it("builds the audio URL from our own host, not the upstream source", async () => {
    const result = await searchTracks(env.DB, APP, { max_duration: 60 });
    expect(result.tracks[0]?.audio_url).toBe(`${APP}/audio/short-one.mp3`);
  });
});
