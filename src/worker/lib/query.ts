import { CLEAN_INSTRUMENTATION, TRUSTED_TIERS } from "./rubric";
import { toTrack, type Track, type TrackRow } from "./types";

/**
 * The one place a catalog query is built.
 *
 * Both the REST surface (`/api/v1/tracks`) and the MCP surface
 * (`search_nasheeds`) call this. They must never grow their own SQL: the
 * default filters below — published only, instrument-clean only,
 * human-verified only — are a safety property, and a second query builder is
 * a second place for that property to be forgotten.
 */

export interface SearchParams {
  q?: string;
  instrumentation?: string[];
  license?: string[];
  mood?: string;
  language?: string;
  tags?: string[];
  min_duration?: number;
  max_duration?: number;
  loopable?: boolean;
  /**
   * Opt-in to unverified rows. Off by default and named to be uncomfortable
   * to type by accident — a caller asking for these is asking for entries no
   * human has checked, and should have had to mean it.
   */
  include_unverified?: boolean;
  limit?: number;
  offset?: number;
  sort?: "newest" | "duration" | "title" | "random";
}

export interface SearchResult {
  tracks: Track[];
  total: number;
  limit: number;
  offset: number;
}

const SORTABLE: Record<string, string> = {
  newest: "t.created_at DESC",
  duration: "t.duration_seconds ASC",
  title: "t.title COLLATE NOCASE ASC",
  random: "RANDOM()",
};

export async function searchTracks(
  db: D1Database,
  appUrl: string,
  params: SearchParams
): Promise<SearchResult> {
  const where: string[] = ["t.published = 1"];
  const binds: unknown[] = [];

  // Non-negotiable: a melodic instrument never leaves this function, no
  // matter what the caller passed. The publish trigger in 0001_init.sql
  // enforces the same thing from the other side.
  where.push(`t.instrumentation IN (${CLEAN_INSTRUMENTATION.map(() => "?").join(",")})`);
  binds.push(...CLEAN_INSTRUMENTATION);

  if (!params.include_unverified) {
    where.push(`t.verification_status IN (${TRUSTED_TIERS.map(() => "?").join(",")})`);
    binds.push(...TRUSTED_TIERS);
  }

  if (params.instrumentation?.length) {
    // Intersected with the clean set above rather than replacing it, so
    // passing instrumentation=has_melodic narrows to nothing instead of
    // widening to everything.
    where.push(`t.instrumentation IN (${params.instrumentation.map(() => "?").join(",")})`);
    binds.push(...params.instrumentation);
  }

  if (params.license?.length) {
    where.push(`t.license IN (${params.license.map(() => "?").join(",")})`);
    binds.push(...params.license);
  }

  if (params.mood) {
    where.push("t.mood = ?");
    binds.push(params.mood);
  }

  if (params.language) {
    where.push("t.lyrics_language = ?");
    binds.push(params.language);
  }

  if (typeof params.min_duration === "number") {
    where.push("t.duration_seconds >= ?");
    binds.push(params.min_duration);
  }

  if (typeof params.max_duration === "number") {
    where.push("t.duration_seconds <= ?");
    binds.push(params.max_duration);
  }

  if (params.loopable !== undefined) {
    where.push("t.is_loopable = ?");
    binds.push(params.loopable ? 1 : 0);
  }

  // Tags are a JSON array in one column. `json_each` keeps this a real
  // filter rather than a LIKE over the serialized text, which would match
  // "duff" inside "duff-free".
  for (const tag of params.tags ?? []) {
    where.push("EXISTS (SELECT 1 FROM json_each(t.tags) WHERE json_each.value = ?)");
    binds.push(tag);
  }

  let from = "tracks t";
  if (params.q?.trim()) {
    from = "tracks t JOIN tracks_fts f ON f.rowid = t.rowid";
    where.push("tracks_fts MATCH ?");
    binds.push(sanitizeFtsQuery(params.q));
  }

  const whereSql = where.join(" AND ");
  const limit = clamp(params.limit ?? 20, 1, 100);
  const offset = Math.max(0, params.offset ?? 0);
  const order = SORTABLE[params.sort ?? "newest"] ?? SORTABLE.newest;

  const countRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${from} WHERE ${whereSql}`)
    .bind(...binds)
    .first<{ n: number }>();

  const { results } = await db
    .prepare(`SELECT t.* FROM ${from} WHERE ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .bind(...binds, limit, offset)
    .all<TrackRow>();

  return {
    tracks: (results ?? []).map((r) => toTrack(r, appUrl)),
    total: countRow?.n ?? 0,
    limit,
    offset,
  };
}

export async function getTrackBySlug(
  db: D1Database,
  appUrl: string,
  slug: string
): Promise<Track | null> {
  const row = await db
    .prepare("SELECT * FROM tracks WHERE slug = ? AND published = 1 LIMIT 1")
    .bind(slug)
    .first<TrackRow>();
  return row ? toTrack(row, appUrl) : null;
}

export interface CatalogStats {
  published_tracks: number;
  total_duration_seconds: number;
  by_instrumentation: Record<string, number>;
  by_license: Record<string, number>;
  by_verification: Record<string, number>;
  by_language: Record<string, number>;
  pending_submissions: number;
}

export async function getStats(db: D1Database): Promise<CatalogStats> {
  const clean = `published = 1 AND instrumentation IN (${CLEAN_INSTRUMENTATION.map(() => "?").join(",")})`;
  const c = [...CLEAN_INSTRUMENTATION];

  const [totals, instr, lic, ver, lang, subs] = await db.batch<Record<string, unknown>>([
    db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(duration_seconds),0) AS d FROM tracks WHERE ${clean}`)
      .bind(...c),
    db.prepare(`SELECT instrumentation AS k, COUNT(*) AS n FROM tracks WHERE ${clean} GROUP BY 1`).bind(...c),
    db.prepare(`SELECT license AS k, COUNT(*) AS n FROM tracks WHERE ${clean} GROUP BY 1`).bind(...c),
    db.prepare(`SELECT verification_status AS k, COUNT(*) AS n FROM tracks WHERE ${clean} GROUP BY 1`).bind(...c),
    db
      .prepare(`SELECT COALESCE(lyrics_language,'unknown') AS k, COUNT(*) AS n FROM tracks WHERE ${clean} GROUP BY 1`)
      .bind(...c),
    db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE status = 'pending'"),
  ]);

  const first = totals.results?.[0] as { n?: number; d?: number } | undefined;
  return {
    published_tracks: Number(first?.n ?? 0),
    total_duration_seconds: Number(first?.d ?? 0),
    by_instrumentation: tally(instr.results),
    by_license: tally(lic.results),
    by_verification: tally(ver.results),
    by_language: tally(lang.results),
    pending_submissions: Number((subs.results?.[0] as { n?: number } | undefined)?.n ?? 0),
  };
}

function tally(rows: Record<string, unknown>[] | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows ?? []) {
    out[String(r.k)] = Number(r.n);
  }
  return out;
}

/**
 * FTS5 treats a bare apostrophe, quote, or `*` as syntax, so a user typing
 * `Allah's mercy` would get a "malformed MATCH expression" error rather than
 * results. Quote each word and OR them together: predictable, injection-free,
 * and it degrades to substring-ish behaviour rather than to an exception.
 */
function sanitizeFtsQuery(raw: string): string {
  const words = raw
    .replace(/["*()]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .slice(0, 12);
  if (words.length === 0) {
    return '""';
  }
  return words.map((w) => `"${w}"`).join(" OR ");
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
