import { authenticate, generateApiKey, hashToken, json, unauthorized } from "../lib/auth";
import { getStats, getTrackBySlug, searchTracks, type SearchParams } from "../lib/query";
import { RUBRIC } from "../lib/rubric";

/**
 * REST surface, mounted at /api.
 *
 *   GET  /api/v1/tracks            search the catalog
 *   GET  /api/v1/tracks/:slug      one track
 *   GET  /api/v1/random            one random track, honouring the same filters
 *   GET  /api/v1/stats             catalog counts
 *   GET  /api/v1/rubric            the halal rubric, as data
 *   POST /api/v1/submissions       propose a track (no key needed)
 *   POST /api/v1/keys              issue a read key (no key needed, self-serve)
 *
 *   GET  /api/public/*             the same reads, unauthenticated, for the
 *                                  website's own browse UI
 *
 * Reads under /api/v1 require an API key; the identical data is available
 * unauthenticated under /api/public. That is deliberate: the key exists to
 * give machine consumers an identity we can rate-limit and contact, not to
 * put a catalog of freely-licensed audio behind a gate. Anyone who resents
 * the key can use /api/public and we lose nothing we actually wanted.
 */
export async function handleApiRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // ── Unauthenticated writes that create nothing privileged ───────────────
  if (path === "/api/v1/submissions" && request.method === "POST") {
    return createSubmission(request, env);
  }

  if (path === "/api/v1/keys" && request.method === "POST") {
    return issueKey(request, env);
  }

  // ── Public read mirror, used by this site's own UI ──────────────────────
  // `/api/public/v1/stats` -> `/api/v1/stats`. Drop only the `public`
  // segment: rewriting the whole `/api/public/` prefix to `/api/v1/` would
  // produce `/api/v1/v1/stats`, which 404s.
  if (path.startsWith("/api/public/")) {
    return handleReads(request, env, `/api${path.slice("/api/public".length)}`, url);
  }

  // ── Everything else under /api/v1 needs a key ──────────────────────────
  if (path.startsWith("/api/v1/")) {
    const key = await authenticate(request, env.DB);
    if (!key) {
      return unauthorized();
    }
    return handleReads(request, env, path, url);
  }

  return json({ error: "Not found" }, 404);
}

async function handleReads(
  request: Request,
  env: Env,
  path: string,
  url: URL
): Promise<Response> {
  if (request.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }

  if (path === "/api/v1/rubric") {
    return json(RUBRIC, 200, { "Cache-Control": "public, max-age=3600" });
  }

  if (path === "/api/v1/stats") {
    return json(await getStats(env.DB), 200, { "Cache-Control": "public, max-age=300" });
  }

  if (path === "/api/v1/tracks") {
    return json(await searchTracks(env.DB, env.APP_URL, parseSearchParams(url)));
  }

  if (path === "/api/v1/random") {
    const result = await searchTracks(env.DB, env.APP_URL, {
      ...parseSearchParams(url),
      sort: "random",
      limit: 1,
    });
    const track = result.tracks[0];
    return track ? json(track) : json({ error: "No track matches those filters" }, 404);
  }

  if (path.startsWith("/api/v1/tracks/")) {
    const slug = decodeURIComponent(path.slice("/api/v1/tracks/".length));
    const track = await getTrackBySlug(env.DB, env.APP_URL, slug);
    return track ? json(track) : json({ error: "Track not found" }, 404);
  }

  return json({ error: "Not found" }, 404);
}

function parseSearchParams(url: URL): SearchParams {
  const p = url.searchParams;
  const list = (name: string): string[] | undefined => {
    const raw = p.getAll(name).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
    return raw.length ? raw : undefined;
  };
  const num = (name: string): number | undefined => {
    const v = p.get(name);
    if (v === null || v.trim() === "") {
      return undefined;
    }
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const bool = (name: string): boolean | undefined => {
    const v = p.get(name);
    return v === null ? undefined : v === "true" || v === "1";
  };

  const sort = p.get("sort");
  return {
    q: p.get("q") ?? undefined,
    instrumentation: list("instrumentation"),
    license: list("license"),
    mood: p.get("mood") ?? undefined,
    language: p.get("language") ?? undefined,
    tags: list("tags"),
    min_duration: num("min_duration"),
    max_duration: num("max_duration"),
    loopable: bool("loopable"),
    include_unverified: bool("include_unverified") ?? false,
    limit: num("limit"),
    offset: num("offset"),
    sort:
      sort === "newest" || sort === "duration" || sort === "title" || sort === "random"
        ? sort
        : undefined,
  };
}

/**
 * Anyone may propose a track. Submissions land in their own table and are
 * never visible from the catalog until a maintainer reviews them, so an open
 * endpoint here cannot put an unvetted claim in front of a consumer.
 */
async function createSubmission(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }

  const title = str(body.title);
  const sourceUrl = str(body.source_url);
  if (!title || !sourceUrl) {
    return json({ error: "title and source_url are required" }, 400);
  }
  if (!/^https?:\/\//i.test(sourceUrl)) {
    return json({ error: "source_url must be an http(s) URL" }, 400);
  }

  const existing = await env.DB.prepare(
    "SELECT id FROM submissions WHERE source_url = ? AND status = 'pending' LIMIT 1"
  )
    .bind(sourceUrl)
    .first<{ id: string }>();
  if (existing) {
    return json(
      { status: "already_pending", id: existing.id, message: "That source URL is already queued for review." },
      200
    );
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO submissions
       (id, title, artist, source_url, claimed_license, claimed_instrumentation,
        notes, submitter_name, submitter_contact, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?, 'pending', ?)`
  )
    .bind(
      id,
      title,
      str(body.artist),
      sourceUrl,
      str(body.claimed_license),
      str(body.claimed_instrumentation),
      str(body.notes),
      str(body.submitter_name),
      str(body.submitter_contact),
      new Date().toISOString()
    )
    .run();

  return json(
    {
      status: "pending",
      id,
      message:
        "Thank you. A maintainer will listen to the whole track and check the licence before it enters the catalog.",
    },
    201
  );
}

/**
 * Self-serve read keys. The catalog is public and freely licensed, so there
 * is nothing to protect by making key issuance a manual favour — the key
 * exists to give a consumer an identity and a contact address, and a form
 * that a person has to wait on just pushes them to scrape the site instead.
 */
async function issueKey(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }

  const name = str(body.name);
  const email = str(body.email);
  if (!name) {
    return json({ error: "name is required — say what will use this key" }, 400);
  }

  const key = generateApiKey();
  await env.DB.prepare(
    `INSERT INTO api_tokens (id, token_hash, name, scope, owner_email, created_at)
     VALUES (?,?,?, 'read', ?, ?)`
  )
    .bind(crypto.randomUUID(), await hashToken(key), name, email, new Date().toISOString())
    .run();

  return json(
    {
      api_key: key,
      scope: "read",
      message: "Store this now — it is shown once and only its hash is kept.",
      usage: `curl -H "Authorization: Bearer ${key}" ${env.APP_URL}/api/v1/tracks`,
    },
    201
  );
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 2000) : null;
}
