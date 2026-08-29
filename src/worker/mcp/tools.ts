import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthedKey } from "../lib/auth";
import { getStats, getTrackBySlug, searchTracks } from "../lib/query";
import { RUBRIC } from "../lib/rubric";

/**
 * MCP tools.
 *
 * The audience here is an AI agent choosing background audio for a video it
 * is editing. That shapes two decisions:
 *
 *  - `search_nasheeds` takes `max_duration` and `loopable`, because the real
 *    question an editor has is "will this cover a 45-second clip", not "what
 *    is in your catalog".
 *  - Every result carries `attribution_text` and `license`. An agent that
 *    uses a CC-BY track without crediting it has broken the licence on the
 *    user's behalf, so the credit string travels with the audio URL rather
 *    than living one extra fetch away where it can be skipped.
 */

export interface McpEnv {
  DB: D1Database;
  APP_URL: string;
}

const asText = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

export function registerTools(server: McpServer, env: McpEnv, key: AuthedKey): void {
  server.registerTool(
    "search_nasheeds",
    {
      title: "Search halal background audio",
      description:
        "Search the catalog of vocals-only and duff-only tracks. Every result is instrument-free " +
        "(voice and duff only), freely licensed for commercial use, and human-verified. " +
        "Filter by duration when you need audio to fit a specific clip length.",
      inputSchema: {
        query: z.string().optional().describe("Free text over title, artist, description and lyrics"),
        instrumentation: z
          .array(z.enum(["voice_only", "voice_duff", "duff_only"]))
          .optional()
          .describe("voice_only = unaccompanied voice; voice_duff = voice with frame drum; duff_only = frame drum alone"),
        mood: z.enum(["calm", "uplifting", "solemn", "joyful", "reflective"]).optional(),
        language: z.string().optional().describe("ISO 639-1 code of the lyrics, e.g. ar, en, bn, ur"),
        license: z.array(z.enum(["CC0", "CC-BY", "CC-BY-SA", "public-domain", "author-permission"])).optional(),
        tags: z.array(z.string()).optional(),
        min_duration: z.number().optional().describe("Seconds"),
        max_duration: z.number().optional().describe("Seconds"),
        loopable: z.boolean().optional().describe("Only tracks that loop cleanly for a bed under a longer video"),
        limit: z.number().min(1).max(100).optional(),
        offset: z.number().min(0).optional(),
        sort: z.enum(["newest", "duration", "title", "random"]).optional(),
      },
    },
    async (args) => asText(await searchTracks(env.DB, env.APP_URL, args))
  );

  server.registerTool(
    "get_nasheed",
    {
      title: "Get one track",
      description:
        "Full record for one track by slug, including the direct audio URL, the exact attribution " +
        "string to reproduce, lyrics where known, and the detector evidence behind its classification.",
      inputSchema: { slug: z.string() },
    },
    async ({ slug }) => {
      const track = await getTrackBySlug(env.DB, env.APP_URL, slug);
      return track ? asText(track) : asText({ error: `No published track with slug '${slug}'` });
    }
  );

  server.registerTool(
    "pick_background_track",
    {
      title: "Pick a track for a video",
      description:
        "The one-shot tool for an editor: give the length of your video and the feel you want, and " +
        "get a single track that fits, with its audio URL and the credit line you must include. " +
        "Prefers a track long enough to cover the whole clip; falls back to a loopable one.",
      inputSchema: {
        video_duration_seconds: z.number().describe("How long the video is"),
        mood: z
          .enum(["calm", "uplifting", "solemn", "joyful", "reflective"])
          .optional()
          .describe("Sparsely populated. Treated as a preference, not a requirement — if no track carries it, it is relaxed and `relaxed_constraint` says so."),
        instrumentation: z.array(z.enum(["voice_only", "voice_duff", "duff_only"])).optional(),
        language: z.string().optional(),
        avoid_slugs: z.array(z.string()).optional().describe("Slugs already used, so you do not repeat yourself"),
      },
    },
    async ({ video_duration_seconds, mood, instrumentation, language, avoid_slugs }) => {
      // Relax one constraint at a time, and report which one was dropped.
      //
      // The first version kept `mood` in every fallback, so when no track had
      // a mood set the tool returned nothing at all for a perfectly ordinary
      // request — the caller could not tell "no calm track" from "the tool is
      // broken". Mood is the softest constraint and the sparsest field, so it
      // is the first thing to go.
      const attempts: { params: Parameters<typeof searchTracks>[2]; relaxed: string | null }[] = [
        { params: { mood, instrumentation, language, min_duration: video_duration_seconds }, relaxed: null },
        { params: { mood, instrumentation, language, loopable: true }, relaxed: "length (this track loops)" },
        { params: { mood, instrumentation, language }, relaxed: "length" },
        { params: { instrumentation, language }, relaxed: "mood" },
        { params: { language }, relaxed: "mood and instrumentation" },
        { params: {}, relaxed: "every optional filter" },
      ];

      let pool = { tracks: [] as Awaited<ReturnType<typeof searchTracks>>["tracks"] };
      let relaxed: string | null = null;
      const avoid = new Set(avoid_slugs ?? []);

      for (const attempt of attempts) {
        const result = await searchTracks(env.DB, env.APP_URL, {
          ...attempt.params,
          sort: "random",
          limit: 25,
        });
        const usable = result.tracks.filter((t) => !avoid.has(t.slug));
        if (usable.length > 0) {
          pool = { tracks: usable };
          relaxed = attempt.relaxed;
          break;
        }
        // Keep the last non-empty result so an avoid-list that excludes
        // everything still returns something rather than nothing.
        if (result.tracks.length > 0 && pool.tracks.length === 0) {
          pool = { tracks: result.tracks };
          relaxed = attempt.relaxed;
        }
      }

      const pick = pool.tracks[0];

      if (!pick) {
        return asText({ error: "No track in the catalog matches those constraints yet." });
      }

      return asText({
        track: pick,
        // Say plainly when the request could not be met exactly. Silently
        // returning a track that ignores the caller's mood is worse than
        // telling them it was dropped.
        relaxed_constraint: relaxed,
        fits_without_looping: pick.duration_seconds >= video_duration_seconds,
        needs_looping: pick.duration_seconds < video_duration_seconds,
        loops_cleanly: pick.is_loopable,
        credit_required: pick.license !== "CC0" && pick.license !== "public-domain",
        credit_line: pick.attribution_text ?? `${pick.title} — ${pick.artist ?? "unknown"} (${pick.license})`,
        ffmpeg_hint:
          `ffmpeg -i video.mp4 -i "${pick.audio_url}" -filter_complex ` +
          `"[1:a]volume=0.15[a]" -map 0:v -map "[a]" -shortest out.mp4`,
      });
    }
  );

  server.registerTool(
    "get_halal_rubric",
    {
      title: "Read the halal rubric",
      description:
        "The exact rules every track in this catalog was checked against, the scholarly position " +
        "behind them, what each verification tier means, and which licences are accepted. " +
        "Read this before telling a user a track is halal — the catalog states a position, not a fatwa.",
      inputSchema: {},
    },
    async () => asText(RUBRIC)
  );

  server.registerTool(
    "get_catalog_stats",
    {
      title: "Catalog statistics",
      description: "Counts by instrumentation, licence, verification tier and language.",
      inputSchema: {},
    },
    async () => asText(await getStats(env.DB))
  );

  server.registerTool(
    "submit_nasheed",
    {
      title: "Submit a track for review",
      description:
        "Propose a freely-licensed halal track. It enters a review queue and is NOT added to the " +
        "catalog until a maintainer has listened to it and checked the licence. Only submit audio " +
        "whose rights holder actually released it freely — a licence asserted by a re-uploader is " +
        "the most common way a 'copyright-free' claim turns out to be false.",
      inputSchema: {
        title: z.string(),
        source_url: z.string().url().describe("Where the audio and its licence can be verified"),
        artist: z.string().optional(),
        claimed_license: z.string().optional(),
        claimed_instrumentation: z.string().optional(),
        notes: z.string().optional(),
      },
    },
    async (args) => {
      const existing = await env.DB.prepare(
        "SELECT id FROM submissions WHERE source_url = ? AND status = 'pending' LIMIT 1"
      )
        .bind(args.source_url)
        .first<{ id: string }>();
      if (existing) {
        return asText({ status: "already_pending", id: existing.id });
      }

      const id = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO submissions
           (id, title, artist, source_url, claimed_license, claimed_instrumentation,
            notes, submitter_name, status, created_at)
         VALUES (?,?,?,?,?,?,?,?, 'pending', ?)`
      )
        .bind(
          id,
          args.title,
          args.artist ?? null,
          args.source_url,
          args.claimed_license ?? null,
          args.claimed_instrumentation ?? null,
          args.notes ?? null,
          key.name ? `api-key:${key.name}` : "api-key",
          new Date().toISOString()
        )
        .run();

      return asText({ status: "pending", id, message: "Queued for maintainer review." });
    }
  );
}
