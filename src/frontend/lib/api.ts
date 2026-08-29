export interface Track {
  id: string;
  slug: string;
  title: string;
  title_original: string | null;
  artist: string | null;
  artist_url: string | null;
  description: string | null;
  instrumentation: "voice_only" | "voice_duff" | "duff_only";
  duration_seconds: number;
  is_loopable: boolean;
  loudness_lufs: number | null;
  lyrics_language: string | null;
  lyrics_text: string | null;
  content_reviewed: boolean;
  license: string;
  license_url: string | null;
  attribution_text: string | null;
  source_url: string;
  source_platform: string | null;
  verification_status: "maintainer_verified" | "scholar_reviewed" | "community_submitted";
  verified_by: string | null;
  verified_at: string | null;
  mood: string | null;
  tags: string[];
  file_format: string | null;
  file_size_bytes: number | null;
  audio_url: string;
}

export interface SearchResponse {
  tracks: Track[];
  total: number;
  limit: number;
  offset: number;
}

export interface Stats {
  published_tracks: number;
  total_duration_seconds: number;
  by_instrumentation: Record<string, number>;
  by_license: Record<string, number>;
  by_verification: Record<string, number>;
  by_language: Record<string, number>;
  pending_submissions: number;
}

/**
 * The site reads its own catalog through /api/public — the same handlers the
 * keyed /api/v1 routes use, minus the key. Shipping a key in frontend
 * JavaScript would be shipping it to everyone anyway, so the honest thing is
 * an unauthenticated read path rather than a fake secret.
 */
const BASE = "/api/public";

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export function searchTracks(params: Record<string, string | number | boolean | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "" && value !== false) {
      query.set(key, String(value));
    }
  }
  return get<SearchResponse>(`/v1/tracks?${query.toString()}`);
}

export const getStats = () => get<Stats>("/v1/stats");
export const getRubric = () => get<Record<string, unknown>>("/v1/rubric");

export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

export const INSTRUMENTATION_LABEL: Record<string, string> = {
  voice_only: "Voice only",
  voice_duff: "Voice + duff",
  duff_only: "Duff only",
};
