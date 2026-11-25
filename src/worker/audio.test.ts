import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "./index";

/**
 * /audio/:file serves the R2 copy only for tracks every catalog read would
 * return, and answers a plain GET with 200 rather than 206.
 */

const ORIGIN = "https://nasheed.lomeyo.com";
const BYTES = new Uint8Array(4096).fill(7);

async function track(slug: string, published: number, rights: boolean): Promise<void> {
  const now = new Date().toISOString();
  await env.AUDIO.put(`${slug}.mp3`, BYTES);
  await env.DB.prepare(
    `INSERT INTO tracks (id, slug, title, instrumentation, duration_seconds, license, source_url,
       verification_status, published, r2_key, file_format, rights_basis, rights_evidence_url,
       created_at, updated_at)
     VALUES (?,?,?, 'voice_only', 60, 'CC-BY', ?, 'automated_verified', ?, ?, 'mp3', ?, ?, ?, ?)`
  )
    .bind(
      crypto.randomUUID(),
      slug,
      slug,
      `https://example.org/${slug}`,
      published,
      `${slug}.mp3`,
      rights ? "artist_upload" : null,
      rights ? "https://example.org/evidence" : null,
      now,
      now
    )
    .run();
}

function get(path: string, headers?: HeadersInit): Promise<Response> {
  return worker.fetch(new Request(`${ORIGIN}${path}`, { headers }), env, {} as ExecutionContext);
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await track("live", 1, true);
  await track("offline", 0, false);
});

describe("/audio", () => {
  it("answers a plain GET for a published track with 200 and the whole file", async () => {
    const response = await get("/audio/live.mp3");
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(BYTES.length);
  });

  it("answers a Range request with 206", async () => {
    const response = await get("/audio/live.mp3", { Range: "bytes=0-99" });
    expect(response.status).toBe(206);
    expect((await response.arrayBuffer()).byteLength).toBe(100);
  });

  it("404s an unpublished track even though its file is still in R2", async () => {
    const response = await get("/audio/offline.mp3");
    expect(response.status).toBe(404);
  });
});
