import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { handleApiRequest } from "./routes";

/**
 * Route-level tests. The public mirror is the one that bit us: it 404'd in
 * production because rewriting the whole `/api/public/` prefix to `/api/v1/`
 * produced `/api/v1/v1/stats`. Nothing in the type system catches a wrong
 * string rewrite, so it needs a test.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
  title_original TEXT, artist TEXT, artist_url TEXT, description TEXT,
  instrumentation TEXT NOT NULL, detector_evidence TEXT, detector_version TEXT,
  duration_seconds REAL NOT NULL, sample_rate INTEGER, channels INTEGER,
  loudness_lufs REAL, is_loopable INTEGER NOT NULL DEFAULT 0, lyrics_language TEXT,
  lyrics_text TEXT, lyrics_translation TEXT, content_reviewed INTEGER NOT NULL DEFAULT 0,
  license TEXT NOT NULL, license_url TEXT, attribution_text TEXT, source_url TEXT NOT NULL,
  source_platform TEXT, permission_evidence TEXT,
  verification_status TEXT NOT NULL DEFAULT 'community_submitted',
  verified_by TEXT, verified_at TEXT, review_notes TEXT, r2_key TEXT, file_format TEXT,
  file_size_bytes INTEGER, sha256 TEXT, mood TEXT, tags TEXT NOT NULL DEFAULT '[]',
  published INTEGER NOT NULL DEFAULT 0, submitted_by TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
  title, title_original, artist, description, lyrics_text, tags,
  content='tracks', content_rowid='rowid');
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT, source_url TEXT NOT NULL,
  claimed_license TEXT, claimed_instrumentation TEXT, notes TEXT, submitter_name TEXT,
  submitter_contact TEXT, status TEXT NOT NULL DEFAULT 'pending', review_notes TEXT,
  reviewed_by TEXT, reviewed_at TEXT, accepted_track_id TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, name TEXT,
  scope TEXT NOT NULL DEFAULT 'read', owner_email TEXT, created_at TEXT NOT NULL,
  last_used_at TEXT, revoked_at TEXT);
`;

const ORIGIN = "https://nasheed.lomeyo.com";

function request(path: string, init?: RequestInit): Request {
  return new Request(`${ORIGIN}${path}`, init);
}

beforeAll(async () => {
  for (const statement of SCHEMA.split(";").filter((s) => s.trim())) {
    await env.DB.prepare(statement).run();
  }
});

describe("public mirror", () => {
  it("serves stats without a key", async () => {
    const response = await handleApiRequest(request("/api/public/v1/stats"), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("published_tracks");
  });

  it("serves the rubric without a key", async () => {
    const response = await handleApiRequest(request("/api/public/v1/rubric"), env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { clauses: unknown[] };
    expect(body.clauses.length).toBeGreaterThan(0);
  });

  it("serves tracks without a key", async () => {
    const response = await handleApiRequest(request("/api/public/v1/tracks"), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("tracks");
  });
});

describe("keyed surface", () => {
  it("rejects an unauthenticated read", async () => {
    const response = await handleApiRequest(request("/api/v1/tracks"), env);
    expect(response.status).toBe(401);
  });

  it("rejects a made-up key", async () => {
    const response = await handleApiRequest(
      request("/api/v1/tracks", { headers: { Authorization: "Bearer nsd_not_a_real_key" } }),
      env
    );
    expect(response.status).toBe(401);
  });

  it("issues a key that then works, over both header styles", async () => {
    const issued = await handleApiRequest(
      request("/api/v1/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test-agent" }),
      }),
      env
    );
    expect(issued.status).toBe(201);
    const { api_key } = (await issued.json()) as { api_key: string };
    expect(api_key).toMatch(/^nsd_/);

    const viaBearer = await handleApiRequest(
      request("/api/v1/tracks", { headers: { Authorization: `Bearer ${api_key}` } }),
      env
    );
    expect(viaBearer.status).toBe(200);

    // X-API-Key is supported because many HTTP clients make a custom header
    // easier to set than an Authorization header.
    const viaHeader = await handleApiRequest(
      request("/api/v1/tracks", { headers: { "X-API-Key": api_key } }),
      env
    );
    expect(viaHeader.status).toBe(200);
  });
});

describe("submissions", () => {
  it("accepts a submission without a key", async () => {
    const response = await handleApiRequest(
      request("/api/v1/submissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "A Test Nasheed", source_url: "https://example.org/one" }),
      }),
      env
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ status: "pending" });
  });

  it("requires title and source_url", async () => {
    const response = await handleApiRequest(
      request("/api/v1/submissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "No URL" }),
      }),
      env
    );
    expect(response.status).toBe(400);
  });

  it("rejects a non-http source_url", async () => {
    const response = await handleApiRequest(
      request("/api/v1/submissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Bad", source_url: "javascript:alert(1)" }),
      }),
      env
    );
    expect(response.status).toBe(400);
  });

  it("does not queue the same source twice", async () => {
    const body = JSON.stringify({ title: "Dup", source_url: "https://example.org/dup" });
    const headers = { "Content-Type": "application/json" };
    const first = await handleApiRequest(request("/api/v1/submissions", { method: "POST", headers, body }), env);
    expect(first.status).toBe(201);
    const second = await handleApiRequest(request("/api/v1/submissions", { method: "POST", headers, body }), env);
    expect(await second.json()).toMatchObject({ status: "already_pending" });
  });
});

describe("CORS", () => {
  it("answers preflight so a browser tool with no server can call the API", async () => {
    const response = await handleApiRequest(request("/api/v1/tracks", { method: "OPTIONS" }), env);
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
