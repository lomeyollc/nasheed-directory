import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getStats, getTrackBySlug, searchTracks } from "./query";

/**
 * The rights gate, tested against the REAL migrations.
 *
 * On 2026-11-25 all 110 published tracks were taken offline: their licences
 * were chosen by whoever uploaded the file to archive.org, and for almost all
 * of them that was not the artist or the label. These tests assert the rule
 * that replaced it, at the database, where an import script or an API bug
 * cannot route around it:
 *
 *   a track is published only when we recorded WHY the rights holder released
 *   it (`rights_basis`) and WHERE that can be checked (`rights_evidence_url`),
 *   and never when it matches a row in `blocked_sources`.
 */

const APP = "https://nasheed.lomeyo.com";

interface Row {
  slug: string;
  published?: number;
  instrumentation?: string;
  verification_status?: string;
  r2_key?: string | null;
  license?: string;
  artist?: string | null;
  source_url?: string;
  source_uploader?: string | null;
  rights_basis?: string | null;
  rights_evidence_url?: string | null;
  content_reviewed?: number;
}

const RIGHTS = {
  rights_basis: "artist_upload",
  rights_evidence_url: "https://archive.org/details/example-own-upload",
};

async function insert(row: Row): Promise<void> {
  const now = new Date().toISOString();
  const full = {
    published: 0,
    instrumentation: "voice_only",
    verification_status: "automated_verified",
    r2_key: `${row.slug}.mp3`,
    license: "CC-BY",
    artist: "Some Artist",
    source_url: `https://archive.org/details/${row.slug}`,
    source_uploader: null,
    rights_basis: null,
    rights_evidence_url: null,
    content_reviewed: 0,
    ...row,
  };
  await env.DB.prepare(
    `INSERT INTO tracks (id, slug, title, artist, instrumentation, duration_seconds, license,
       source_url, source_uploader, verification_status, content_reviewed, published, r2_key,
       file_format, rights_basis, rights_evidence_url, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      crypto.randomUUID(),
      full.slug,
      full.slug,
      full.artist,
      full.instrumentation,
      120,
      full.license,
      full.source_url,
      full.source_uploader,
      full.verification_status,
      full.content_reviewed,
      full.published,
      full.r2_key,
      "mp3",
      full.rights_basis,
      full.rights_evidence_url,
      now,
      now
    )
    .run();
}

async function publish(slug: string): Promise<void> {
  await env.DB.prepare("UPDATE tracks SET published = 1 WHERE slug = ?").bind(slug).run();
}

async function block(kind: string, value: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO blocked_sources (kind, value, reason, added_by, added_at) VALUES (?,?,?,?,?)"
  )
    .bind(kind, value, "test", "test", new Date().toISOString())
    .run();
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM blocked_sources").run();
  await env.DB.prepare("DELETE FROM tracks").run();
});

describe("publish guard: rights", () => {
  it("refuses to INSERT a published track with no rights basis", async () => {
    await expect(insert({ slug: "no-rights", published: 1 })).rejects.toThrow(/rights_basis/);
  });

  it("refuses to UPDATE a track to published when it has no rights basis", async () => {
    // This is the exact shape of the 2026-11-25 catalog: a CC licence typed
    // by an uploader, and nothing else.
    await insert({ slug: "uploader-licence-only", license: "CC-BY" });
    await expect(publish("uploader-licence-only")).rejects.toThrow(/rights_basis/);
  });

  it("refuses a rights basis with no evidence link", async () => {
    await insert({ slug: "no-evidence", rights_basis: "artist_upload" });
    await expect(publish("no-evidence")).rejects.toThrow(/rights_evidence_url/);
  });

  it("publishes a track with a rights basis and an evidence link", async () => {
    await insert({ slug: "own-upload", ...RIGHTS });
    await publish("own-upload");
    const row = await env.DB.prepare("SELECT published FROM tracks WHERE slug = 'own-upload'").first<{
      published: number;
    }>();
    expect(row?.published).toBe(1);
  });

  it("refuses a public-domain licence unless the basis is age", async () => {
    // A Public Domain Mark is for very old works. On a 2010s naat album it
    // is almost certainly false, so "public-domain" + "the uploader is the
    // artist" is a contradiction, not a basis.
    await insert({ slug: "pdm-modern", license: "public-domain", ...RIGHTS });
    await expect(publish("pdm-modern")).rejects.toThrow(/public_domain_by_age/);

    await insert({
      slug: "pdm-old",
      license: "public-domain",
      rights_basis: "public_domain_by_age",
      rights_evidence_url: "https://example.org/1931-recording",
    });
    await publish("pdm-old");
  });

  it("rejects an unknown rights basis at the column", async () => {
    await expect(insert({ slug: "made-up", rights_basis: "uploader_said_so" })).rejects.toThrow();
  });

  it("rejects an evidence link that is not http(s)", async () => {
    await expect(
      insert({ slug: "bad-link", rights_basis: "artist_upload", rights_evidence_url: "trust me" })
    ).rejects.toThrow();
  });
});

describe("publish guard: the 0002 conditions still hold", () => {
  it("refuses a melodic track even with full rights", async () => {
    await expect(
      insert({ slug: "guitar", instrumentation: "has_melodic", published: 1, ...RIGHTS })
    ).rejects.toThrow(/instrument-clean/);
  });

  it("refuses an unvetted community submission even with full rights", async () => {
    await insert({ slug: "unvetted", verification_status: "community_submitted", ...RIGHTS });
    await expect(publish("unvetted")).rejects.toThrow(/instrument-clean/);
  });

  it("refuses a track that is not mirrored to R2 even with full rights", async () => {
    await insert({ slug: "no-file", r2_key: null, ...RIGHTS });
    await expect(publish("no-file")).rejects.toThrow(/mirrored to R2/);
  });

  it("still refuses an automated row that claims a human read the lyrics", async () => {
    await expect(insert({ slug: "fake-human", content_reviewed: 1 })).rejects.toThrow(/no human/);
  });
});

describe("publish guard: blocked sources", () => {
  it("refuses a blocked artist, ignoring case and spaces", async () => {
    await block("artist", "Blocked Singer");
    await insert({ slug: "blocked-artist", artist: "  BLOCKED SINGER ", ...RIGHTS });
    await expect(publish("blocked-artist")).rejects.toThrow(/blocked_sources/);
  });

  it("refuses a blocked source URL", async () => {
    await block("source_url", "https://archive.org/details/militant-item");
    await insert({ slug: "blocked-url", source_url: "https://archive.org/details/militant-item", ...RIGHTS });
    await expect(publish("blocked-url")).rejects.toThrow(/blocked_sources/);
  });

  it("refuses a blocked uploader", async () => {
    await block("uploader", "reuploader@example.com");
    await insert({ slug: "blocked-uploader", source_uploader: "Reuploader@Example.com", ...RIGHTS });
    await expect(publish("blocked-uploader")).rejects.toThrow(/blocked_sources/);
  });

  it("refuses a blocked track at INSERT too", async () => {
    await block("artist", "Blocked Singer");
    await expect(
      insert({ slug: "blocked-insert", artist: "Blocked Singer", published: 1, ...RIGHTS })
    ).rejects.toThrow(/blocked_sources/);
  });

  it("does not block a different artist", async () => {
    await block("artist", "Blocked Singer");
    await insert({ slug: "fine", artist: "Abdul Haseeb Khan", ...RIGHTS });
    await publish("fine");
  });
});

describe("read path: the same rule, applied a second time", () => {
  it("hides a published track the moment its source is blocked", async () => {
    // The trigger only runs when a row is written. A source found to be bad
    // AFTER publication must disappear from every read without waiting for
    // someone to remember to unpublish it.
    await insert({ slug: "later-blocked", artist: "Later Found Militant", ...RIGHTS });
    await publish("later-blocked");
    expect((await searchTracks(env.DB, APP, {})).total).toBe(1);

    await block("artist", "later found militant");

    expect((await searchTracks(env.DB, APP, {})).total).toBe(0);
    expect(await getTrackBySlug(env.DB, APP, "later-blocked")).toBeNull();
    expect((await getStats(env.DB)).published_tracks).toBe(0);
  });

  it("returns the rights basis and evidence on every track record", async () => {
    await insert({ slug: "with-rights", source_uploader: "someone@example.com", ...RIGHTS });
    await publish("with-rights");
    const track = await getTrackBySlug(env.DB, APP, "with-rights");
    expect(track?.rights_basis).toBe("artist_upload");
    expect(track?.rights_evidence_url).toBe(RIGHTS.rights_evidence_url);
  });

  it("never exposes the uploader, which is often a personal email address", async () => {
    await insert({ slug: "private-uploader", source_uploader: "someone@example.com", ...RIGHTS });
    await publish("private-uploader");
    const track = await getTrackBySlug(env.DB, APP, "private-uploader");
    expect(JSON.stringify(track)).not.toContain("someone@example.com");
  });
});
