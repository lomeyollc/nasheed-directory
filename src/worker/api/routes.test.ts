import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { handleApiRequest } from "./routes";

/**
 * Route-level tests. The public mirror is the one that bit us: it 404'd in
 * production because rewriting the whole `/api/public/` prefix to `/api/v1/`
 * produced `/api/v1/v1/stats`. Nothing in the type system catches a wrong
 * string rewrite, so it needs a test.
 */


const ORIGIN = "https://nasheed.lomeyo.com";

function request(path: string, init?: RequestInit): Request {
  return new Request(`${ORIGIN}${path}`, init);
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
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

/** Every field the rights gate needs from a submitter, on top of a title. */
const RIGHTS = {
  relationship: "artist",
  rights_evidence_url: "https://example.org/my-own-channel/this-track",
};

function submit(body: Record<string, unknown>): Promise<Response> {
  return handleApiRequest(
    request("/api/v1/submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env
  );
}

describe("submissions", () => {
  it("accepts a submission without a key", async () => {
    const response = await submit({ title: "A Test Nasheed", source_url: "https://example.org/one", ...RIGHTS });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ status: "pending" });
  });

  it("requires title and source_url", async () => {
    const response = await submit({ title: "No URL", ...RIGHTS });
    expect(response.status).toBe(400);
  });

  it("rejects a non-http source_url", async () => {
    const response = await submit({ title: "Bad", source_url: "javascript:alert(1)", ...RIGHTS });
    expect(response.status).toBe(400);
  });

  it("does not queue the same source twice", async () => {
    const body = { title: "Dup", source_url: "https://example.org/dup", ...RIGHTS };
    const first = await submit(body);
    expect(first.status).toBe(201);
    const second = await submit(body);
    expect(await second.json()).toMatchObject({ status: "already_pending" });
  });
});

describe("submissions: the rights gate", () => {
  it("refuses a submission that does not say who the submitter is to the recording", async () => {
    // "I found it online" is how the 2026-11-25 catalog was built. Only the
    // artist, the label, or someone holding written permission may submit.
    const response = await submit({
      title: "Found it",
      source_url: "https://example.org/found",
      rights_evidence_url: RIGHTS.rights_evidence_url,
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/relationship/);
  });

  it("refuses a relationship outside artist, label or written permission", async () => {
    const response = await submit({
      title: "A fan",
      source_url: "https://example.org/fan",
      relationship: "fan",
      rights_evidence_url: RIGHTS.rights_evidence_url,
    });
    expect(response.status).toBe(400);
  });

  it("refuses a submission with no rights evidence link", async () => {
    const response = await submit({ title: "No proof", source_url: "https://example.org/no-proof", relationship: "label" });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/rights_evidence_url/);
  });

  it("refuses a rights evidence link that is not http(s)", async () => {
    const response = await submit({
      title: "Bad proof",
      source_url: "https://example.org/bad-proof",
      relationship: "artist",
      rights_evidence_url: "ask me",
    });
    expect(response.status).toBe(400);
  });

  it("stores the relationship and the evidence, and never publishes", async () => {
    const response = await submit({
      title: "Stored",
      source_url: "https://example.org/stored",
      relationship: "written_permission",
      rights_evidence_url: "https://example.org/permission-letter",
    });
    const { id } = (await response.json()) as { id: string };
    const row = await env.DB.prepare(
      "SELECT submitter_relationship, rights_evidence_url, status FROM submissions WHERE id = ?"
    )
      .bind(id)
      .first<{ submitter_relationship: string; rights_evidence_url: string; status: string }>();
    expect(row).toEqual({
      submitter_relationship: "written_permission",
      rights_evidence_url: "https://example.org/permission-letter",
      status: "pending",
    });
    const tracks = await env.DB.prepare("SELECT COUNT(*) AS n FROM tracks").first<{ n: number }>();
    expect(tracks?.n).toBe(0);
  });
});

describe("CORS", () => {
  it("answers preflight so a browser tool with no server can call the API", async () => {
    const response = await handleApiRequest(request("/api/v1/tracks", { method: "OPTIONS" }), env);
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
