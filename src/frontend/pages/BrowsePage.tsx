import { AlertCircle, Check, Copy, Download, Loader2, Pause, Play, Search, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  formatDuration,
  getStats,
  INSTRUMENTATION_LABEL,
  searchTracks,
  type Stats,
  type Track,
} from "../lib/api";

const INSTRUMENTATION_FILTERS = [
  { value: "", label: "All" },
  { value: "voice_only", label: "Voice only" },
  { value: "voice_duff", label: "Voice + duff" },
  { value: "duff_only", label: "Duff only" },
];

const LENGTH_FILTERS = [
  { value: "", label: "Any length", min: undefined, max: undefined },
  { value: "short", label: "Under 1 min", min: undefined, max: 60 },
  { value: "medium", label: "1–3 min", min: 60, max: 180 },
  { value: "long", label: "Over 3 min", min: 180, max: undefined },
];

export default function BrowsePage() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [instrumentation, setInstrumentation] = useState("");
  const [length, setLength] = useState("");
  const [playing, setPlaying] = useState<string | null>(null);

  // One shared <audio> for the whole page. A per-card element means two
  // tracks can play over each other, which on a page about listening
  // carefully is a genuinely bad bug rather than a cosmetic one.
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const lengthFilter = LENGTH_FILTERS.find((f) => f.value === length);
    try {
      const response = await searchTracks({
        q: query || undefined,
        instrumentation: instrumentation || undefined,
        min_duration: lengthFilter?.min,
        max_duration: lengthFilter?.max,
        limit: 60,
      });
      setTracks(response.tracks);
      setTotal(response.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }, [query, instrumentation, length]);

  // Debounced so typing in the search box does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(load, 250);
    return () => clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    getStats().then(setStats).catch(() => setStats(null));
  }, []);

  function toggle(track: Track) {
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.addEventListener("ended", () => setPlaying(null));
    }
    const audio = audioRef.current;
    if (playing === track.slug) {
      audio.pause();
      setPlaying(null);
      return;
    }
    audio.src = track.audio_url;
    void audio.play();
    setPlaying(track.slug);
  }

  useEffect(() => () => audioRef.current?.pause(), []);

  return (
    <div className="mx-auto max-w-6xl px-5 py-10">
      <section className="mb-10">
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight mb-3">
          Background audio you don't have to verify by ear
        </h1>
        <p className="text-muted max-w-2xl leading-relaxed">
          Every track here is human voice only, or voice with duff — no melodic instruments — and
          freely licensed for commercial use. A person listened to each one before it was
          published. Built so an AI agent editing a video can pick music without guessing.
        </p>

        {stats && (
          <div className="flex flex-wrap gap-x-8 gap-y-2 mt-6 text-sm">
            <Stat value={stats.published_tracks} label="tracks" />
            <Stat
              value={Math.round(stats.total_duration_seconds / 60)}
              label="minutes of audio"
            />
            <Stat value={Object.keys(stats.by_language).length} label="languages" />
            <Stat value={0} label="melodic instruments" highlight />
          </div>
        )}
      </section>

      <section className="flex flex-wrap gap-3 mb-6 sticky top-16 bg-ink/95 backdrop-blur py-3 z-10">
        <div className="relative flex-1 min-w-[220px]">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search title, artist, lyrics…"
            className="w-full bg-ink-2 border border-line rounded-lg pl-9 pr-3 py-2 text-sm outline-none focus:border-accent/60"
          />
        </div>

        <Select value={instrumentation} onChange={setInstrumentation} options={INSTRUMENTATION_FILTERS} />
        <Select value={length} onChange={setLength} options={LENGTH_FILTERS} />
      </section>

      {loading && (
        <div className="flex items-center gap-2 text-muted py-16 justify-center">
          <Loader2 className="animate-spin" size={18} /> Loading…
        </div>
      )}

      {error && (
        <div className="flex items-start gap-3 bg-red-950/40 border border-red-900 rounded-xl p-4 text-sm">
          <AlertCircle size={18} className="text-red-400 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium mb-1">Could not load the catalog</p>
            <p className="text-muted">{error}</p>
          </div>
        </div>
      )}

      {!loading && !error && tracks.length === 0 && (
        <div className="text-center py-20 text-muted">
          <p className="mb-2">Nothing matches those filters yet.</p>
          <p className="text-sm">
            The catalog only holds tracks a human has listened to, so it grows slowly on purpose.
          </p>
        </div>
      )}

      {!loading && tracks.length > 0 && (
        <>
          <p className="text-sm text-muted mb-4">
            {total} track{total === 1 ? "" : "s"}
          </p>
          <div className="grid gap-3">
            {tracks.map((track) => (
              <TrackCard
                key={track.id}
                track={track}
                playing={playing === track.slug}
                onToggle={() => toggle(track)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ value, label, highlight }: { value: number; label: string; highlight?: boolean }) {
  return (
    <div>
      <div className={`text-2xl font-semibold ${highlight ? "text-accent" : ""}`}>{value}</div>
      <div className="text-muted text-xs uppercase tracking-wide">{label}</div>
    </div>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="bg-ink-2 border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent/60"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function TrackCard({
  track,
  playing,
  onToggle,
}: {
  track: Track;
  playing: boolean;
  onToggle: () => void;
}) {
  const [copied, setCopied] = useState(false);

  // Attribution is the thing users most often get wrong, so it is one click
  // away on every card rather than buried in a detail page.
  function copyAttribution() {
    const text =
      track.attribution_text ?? `${track.title}${track.artist ? ` — ${track.artist}` : ""} (${track.license})`;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }

  return (
    <article className="bg-ink-2 border border-line rounded-xl p-4 flex items-center gap-4 hover:border-line/80 transition">
      <button
        onClick={onToggle}
        className="shrink-0 w-11 h-11 rounded-full bg-accent/15 text-accent grid place-items-center hover:bg-accent/25 transition"
        aria-label={playing ? `Pause ${track.title}` : `Play ${track.title}`}
      >
        {playing ? <Pause size={18} /> : <Play size={18} className="ml-0.5" />}
      </button>

      <div className="min-w-0 flex-1">
        <h3 className="font-medium truncate">{track.title}</h3>
        <p className="text-sm text-muted truncate">
          {track.artist ?? "Unknown artist"} · {formatDuration(track.duration_seconds)}
          {track.lyrics_language ? ` · ${track.lyrics_language}` : ""}
        </p>
        <div className="flex flex-wrap gap-1.5 mt-2">
          <Badge tone="accent">{INSTRUMENTATION_LABEL[track.instrumentation]}</Badge>
          <Badge>{track.license}</Badge>
          {track.is_loopable && <Badge>loops</Badge>}
          {track.verification_status === "scholar_reviewed" && (
            <Badge tone="accent">
              <ShieldCheck size={11} className="inline mr-1" />
              scholar reviewed
            </Badge>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={copyAttribution}
          title="Copy the attribution line"
          className="p-2 rounded-lg text-muted hover:text-white hover:bg-line/60 transition"
        >
          {copied ? <Check size={16} className="text-accent" /> : <Copy size={16} />}
        </button>
        <a
          href={track.audio_url}
          download
          title="Download"
          className="p-2 rounded-lg text-muted hover:text-white hover:bg-line/60 transition"
        >
          <Download size={16} />
        </a>
      </div>
    </article>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone?: "accent" }) {
  return (
    <span
      className={`text-[11px] px-2 py-0.5 rounded-md border ${
        tone === "accent"
          ? "border-accent/40 text-accent bg-accent/10"
          : "border-line text-muted bg-ink/60"
      }`}
    >
      {children}
    </span>
  );
}
