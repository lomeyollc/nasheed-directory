import { CLEAN_INSTRUMENTATION, HUMAN_TIERS, TRUSTED_TIERS } from "./rubric";
import { toTrack, type Track, type TrackRow } from "./types";

/**
 * The one place a catalog query is built.
 *
 * Both the REST surface (`/api/v1/tracks`) and the MCP surface
 * (`search_nasheeds`) call this. They must never grow their own SQL: the
 * default filters below — published only, instrument-clean only, verified
 * only, rights evidence only, no blocked source — are a safety property, and a
 * second query builder is a second place for that property to be forgotten.
 */

/**
 * The rule every public read applies, in one place: published, instrument-
 * clean, a recorded rights basis with evidence, and not from a blocked
 * source. The publish triggers in migrations/0003_rights_gate.sql enforce the
 * same rule on write; this is the second mechanism, so one bug cannot break
 * the promise alone.
 *
 * The blocklist check matters most here. A trigger only runs when a row is
 * written, so a source found to be militant AFTER its tracks were published
 * would stay live until someone remembered to unpublish them. Checked on
 * read, adding the block row is enough.
 *
 * Expects the tracks table to be aliased `t`.
 */
export const PUBLIC_TRACK_SQL = `t.published = 1
  AND t.instrumentation IN (${CLEAN_INSTRUMENTATION.map((v) => `'${v}'`).join(",")})
  AND t.rights_basis IS NOT NULL
  AND t.rights_evidence_url IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM blocked_sources b
    WHERE (b.kind = 'artist'     AND lower(trim(b.value)) = lower(trim(t.artist)))
       OR (b.kind = 'source_url' AND lower(trim(b.value)) = lower(trim(t.source_url)))
       OR (b.kind = 'uploader'   AND lower(trim(b.value)) = lower(trim(t.source_uploader)))
  )`;

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
  /**
   * Set false to require a human reviewer. Defaults to true: machine-verified
   * tracks are returned and labelled, so a caller who wants only
   * human-checked audio asks for it explicitly rather than the catalog
   * appearing empty to everyone by default.
   */
  include_automated?: boolean;
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
  // Non-negotiable: a melodic instrument, a track with no rights evidence,
  // or a blocked source never leaves this function, no matter what the
  // caller passed. The publish triggers enforce the same thing on write.
  const where: string[] = [PUBLIC_TRACK_SQL];
  const binds: unknown[] = [];

  if (!params.include_unverified) {
    const tiers = params.include_automated === false ? HUMAN_TIERS : TRUSTED_TIERS;
    where.push(`t.verification_status IN (${tiers.map(() => "?").join(",")})`);
    binds.push(...tiers);
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
    .prepare(`SELECT t.* FROM tracks t WHERE t.slug = ? AND ${PUBLIC_TRACK_SQL} LIMIT 1`)
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
  by_rights_basis: Record<string, number>;
  pending_submissions: number;
}

export async function getStats(db: D1Database): Promise<CatalogStats> {
  // The same rule the search uses, so `published_tracks` is exactly the
  // number of tracks anyone can actually fetch.
  const from = `FROM tracks t WHERE ${PUBLIC_TRACK_SQL}`;

  const [totals, instr, lic, ver, lang, rights, subs] = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(t.duration_seconds),0) AS d ${from}`),
    db.prepare(`SELECT t.instrumentation AS k, COUNT(*) AS n ${from} GROUP BY 1`),
    db.prepare(`SELECT t.license AS k, COUNT(*) AS n ${from} GROUP BY 1`),
    db.prepare(`SELECT t.verification_status AS k, COUNT(*) AS n ${from} GROUP BY 1`),
    db.prepare(`SELECT COALESCE(t.lyrics_language,'unknown') AS k, COUNT(*) AS n ${from} GROUP BY 1`),
    db.prepare(`SELECT t.rights_basis AS k, COUNT(*) AS n ${from} GROUP BY 1`),
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
    by_rights_basis: tally(rights.results),
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
