export type Instrumentation = "voice_only" | "voice_duff" | "duff_only" | "has_melodic";

export type VerificationStatus =
  | "community_submitted"
  | "automated_verified"
  | "maintainer_verified"
  | "scholar_reviewed";

export type License = "CC0" | "CC-BY" | "CC-BY-SA" | "public-domain" | "author-permission";

/** A row of `tracks`, exactly as D1 returns it (0/1 for booleans, JSON as text). */
export interface TrackRow {
  id: string;
  slug: string;
  title: string;
  title_original: string | null;
  artist: string | null;
  artist_url: string | null;
  description: string | null;
  instrumentation: Instrumentation;
  detector_evidence: string | null;
  detector_version: string | null;
  duration_seconds: number;
  sample_rate: number | null;
  channels: number | null;
  loudness_lufs: number | null;
  is_loopable: number;
  lyrics_language: string | null;
  lyrics_text: string | null;
  lyrics_translation: string | null;
  content_reviewed: number;
  license: License;
  license_url: string | null;
  attribution_text: string | null;
  source_url: string;
  source_platform: string | null;
  permission_evidence: string | null;
  verification_status: VerificationStatus;
  verified_by: string | null;
  verified_at: string | null;
  review_notes: string | null;
  r2_key: string | null;
  file_format: string | null;
  file_size_bytes: number | null;
  sha256: string | null;
  mood: string | null;
  tags: string;
  published: number;
  submitted_by: string | null;
  created_at: string;
  updated_at: string;
}

/** The public shape. Booleans are booleans and tags is an array. */
export interface Track {
  id: string;
  slug: string;
  title: string;
  title_original: string | null;
  artist: string | null;
  artist_url: string | null;
  description: string | null;
  instrumentation: Instrumentation;
  duration_seconds: number;
  is_loopable: boolean;
  loudness_lufs: number | null;
  lyrics_language: string | null;
  lyrics_text: string | null;
  lyrics_translation: string | null;
  content_reviewed: boolean;
  license: License;
  license_url: string | null;
  attribution_text: string | null;
  source_url: string;
  source_platform: string | null;
  verification_status: VerificationStatus;
  verified_by: string | null;
  verified_at: string | null;
  mood: string | null;
  tags: string[];
  file_format: string | null;
  file_size_bytes: number | null;
  sha256: string | null;
  audio_url: string;
  detector_evidence: unknown;
}

export function toTrack(row: TrackRow, appUrl: string): Track {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    title_original: row.title_original,
    artist: row.artist,
    artist_url: row.artist_url,
    description: row.description,
    instrumentation: row.instrumentation,
    duration_seconds: row.duration_seconds,
    is_loopable: row.is_loopable === 1,
    loudness_lufs: row.loudness_lufs,
    lyrics_language: row.lyrics_language,
    lyrics_text: row.lyrics_text,
    lyrics_translation: row.lyrics_translation,
    content_reviewed: row.content_reviewed === 1,
    license: row.license,
    license_url: row.license_url,
    attribution_text: row.attribution_text,
    source_url: row.source_url,
    source_platform: row.source_platform,
    verification_status: row.verification_status,
    verified_by: row.verified_by,
    verified_at: row.verified_at,
    mood: row.mood,
    tags: safeJsonArray(row.tags),
    file_format: row.file_format,
    file_size_bytes: row.file_size_bytes,
    sha256: row.sha256,
    // Always our own R2 URL, never the upstream host. A consumer's build
    // must not break because archive.org rate-limited them.
    audio_url: `${appUrl}/audio/${row.slug}.${row.file_format ?? "mp3"}`,
    detector_evidence: row.detector_evidence ? safeJson(row.detector_evidence) : null,
  };
}

function safeJsonArray(raw: string): string[] {
  const parsed = safeJson(raw);
  return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
