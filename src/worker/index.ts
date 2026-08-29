import { handleApiRequest } from "./api/routes";
import { json } from "./lib/auth";
import { handleMcpRequest } from "./mcp";
import { RUBRIC } from "./lib/rubric";
import type { TrackRow } from "./lib/types";

/**
 * Nasheed Directory Worker.
 *
 *   /api/*        REST catalog (src/worker/api/routes.ts)
 *   /mcp          MCP server for AI agents (src/worker/mcp)
 *   /audio/:file  streams the mirrored audio out of R2, with Range support
 *   /llms.txt     machine-readable orientation for an agent that lands here
 *   /openapi.json the REST contract
 *
 * Anything else falls through to the React SPA via the ASSETS binding.
 */
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApiRequest(request, env);
    }

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      return handleMcpRequest(request, env);
    }

    if (url.pathname.startsWith("/audio/")) {
      return serveAudio(request, env, url);
    }

    if (url.pathname === "/llms.txt") {
      return new Response(llmsTxt(env.APP_URL), {
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
      });
    }

    if (url.pathname === "/openapi.json") {
      return json(openApiSpec(env.APP_URL), 200, { "Cache-Control": "public, max-age=3600" });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

/**
 * Serves the audio from R2.
 *
 * Range requests are handled properly rather than always returning the whole
 * file, because the browse UI streams previews with a plain <audio> element
 * and a seek in that element is a Range request. Getting this wrong makes
 * seeking silently fail in Safari specifically, which is the kind of bug that
 * looks like "the player is broken" rather than "the server ignores Range".
 */
async function serveAudio(request: Request, env: Env, url: URL): Promise<Response> {
  const file = decodeURIComponent(url.pathname.slice("/audio/".length));
  if (!file || file.includes("..") || file.includes("/")) {
    return new Response("Not found", { status: 404 });
  }

  const slug = file.replace(/\.[a-z0-9]+$/i, "");
  const row = await env.DB.prepare(
    "SELECT r2_key, file_format, sha256, id FROM tracks WHERE slug = ? AND published = 1 LIMIT 1"
  )
    .bind(slug)
    .first<Pick<TrackRow, "r2_key" | "file_format" | "sha256" | "id">>();

  if (!row?.r2_key) {
    return new Response("Not found", { status: 404 });
  }

  const range = request.headers.get("Range");
  const object = await env.AUDIO.get(row.r2_key, {
    range: range ? parseRange(range) : undefined,
  });

  if (!object) {
    return new Response("Not found", { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", mimeFor(row.file_format));
  headers.set("Accept-Ranges", "bytes");
  headers.set("Access-Control-Allow-Origin", "*");
  // Freely-licensed audio that never changes for a given slug — cache it hard.
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  if (row.sha256) {
    headers.set("ETag", `"${row.sha256}"`);
  }

  if (object.range && "offset" in object.range) {
    const offset = object.range.offset ?? 0;
    const length = object.range.length ?? object.size - offset;
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("Content-Length", String(length));
    return new Response(object.body, { status: 206, headers });
  }

  headers.set("Content-Length", String(object.size));

  // Fire-and-forget usage counting. No IP, no user agent — enough to tell an
  // artist their work is being used, not enough to profile a listener.
  env.DB.prepare(
    "INSERT INTO download_events (track_id, day, created_at) VALUES (?,?,?)"
  )
    .bind(row.id, new Date().toISOString().slice(0, 10), new Date().toISOString())
    .run()
    .catch(() => {});

  return new Response(object.body, { headers });
}

function parseRange(header: string): R2Range | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) {
    return undefined;
  }
  const [, startRaw, endRaw] = match;
  if (startRaw === "" && endRaw !== "") {
    return { suffix: Number(endRaw) };
  }
  if (startRaw !== "" && endRaw === "") {
    return { offset: Number(startRaw) };
  }
  if (startRaw !== "" && endRaw !== "") {
    return { offset: Number(startRaw), length: Number(endRaw) - Number(startRaw) + 1 };
  }
  return undefined;
}

function mimeFor(format: string | null): string {
  switch (format) {
    case "ogg":
      return "audio/ogg";
    case "opus":
      return "audio/opus";
    case "flac":
      return "audio/flac";
    case "wav":
      return "audio/wav";
    case "m4a":
      return "audio/mp4";
    default:
      return "audio/mpeg";
  }
}

function llmsTxt(appUrl: string): string {
  return `# Nasheed Directory

An open catalog of background audio that is halal by a strict rubric and
freely licensed for commercial reuse. Built for AI agents that need music for
a video and cannot verify by ear whether a track contains instruments.

## What is in it

Every published track is one of:
  voice_only   unaccompanied human voice (solo or group)
  voice_duff   voice plus duff (frame drum) only
  duff_only    frame drum alone

No melodic instruments. No NonCommercial or NoDerivatives licences. Every
track has been listened to by a human before publication.

## The rubric

${RUBRIC.summary}

Position: ${RUBRIC.position}

Read it in full as JSON: ${appUrl}/api/v1/rubric

## Using it

Get a free API key:
  curl -X POST ${appUrl}/api/v1/keys -H "Content-Type: application/json" \\
    -d '{"name":"my-agent","email":"you@example.com"}'

Search:
  curl -H "Authorization: Bearer <key>" \\
    "${appUrl}/api/v1/tracks?max_duration=60&mood=calm&instrumentation=voice_only"

MCP endpoint (Streamable HTTP, Bearer auth): ${appUrl}/mcp
  Tools: search_nasheeds, get_nasheed, pick_background_track,
         get_halal_rubric, get_catalog_stats, submit_nasheed

The same reads are available without a key under /api/public/ if you would
rather not hold one.

## Attribution

CC-BY and CC-BY-SA tracks require credit. Every track record carries an
\`attribution_text\` field with the exact string to reproduce. Use it.

## Contributing

Submit a track: POST ${appUrl}/api/v1/submissions
Source and issues: https://github.com/lomeyollc/nasheed-directory
`;
}

function openApiSpec(appUrl: string): unknown {
  return {
    openapi: "3.1.0",
    info: {
      title: "Nasheed Directory API",
      version: "1.0.0",
      description:
        "Catalog of halal, freely-licensed background audio: voice-only and duff-only tracks, " +
        "human-verified, usable in commercial work.",
      license: { name: "MIT", url: "https://github.com/lomeyollc/nasheed-directory/blob/main/LICENSE" },
    },
    servers: [{ url: appUrl }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        apiKeyHeader: { type: "apiKey", in: "header", name: "X-API-Key" },
      },
    },
    security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
    paths: {
      "/api/v1/tracks": {
        get: {
          summary: "Search the catalog",
          parameters: [
            { name: "q", in: "query", schema: { type: "string" } },
            {
              name: "instrumentation",
              in: "query",
              schema: { type: "string", enum: ["voice_only", "voice_duff", "duff_only"] },
            },
            { name: "mood", in: "query", schema: { type: "string" } },
            { name: "language", in: "query", schema: { type: "string" } },
            { name: "license", in: "query", schema: { type: "string" } },
            { name: "tags", in: "query", schema: { type: "string" } },
            { name: "min_duration", in: "query", schema: { type: "number" } },
            { name: "max_duration", in: "query", schema: { type: "number" } },
            { name: "loopable", in: "query", schema: { type: "boolean" } },
            { name: "limit", in: "query", schema: { type: "integer", maximum: 100 } },
            { name: "offset", in: "query", schema: { type: "integer" } },
            { name: "sort", in: "query", schema: { type: "string", enum: ["newest", "duration", "title", "random"] } },
          ],
          responses: { "200": { description: "Matching tracks" } },
        },
      },
      "/api/v1/tracks/{slug}": {
        get: {
          summary: "Get one track",
          parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "The track" }, "404": { description: "Not found" } },
        },
      },
      "/api/v1/random": { get: { summary: "One random track matching the same filters" } },
      "/api/v1/rubric": { get: { summary: "The halal rubric this catalog applies" } },
      "/api/v1/stats": { get: { summary: "Catalog counts" } },
      "/api/v1/submissions": { post: { summary: "Propose a track for review", security: [] } },
      "/api/v1/keys": { post: { summary: "Issue a free read key", security: [] } },
      "/audio/{slug}.{ext}": { get: { summary: "Stream the audio (Range supported)", security: [] } },
    },
  };
}
