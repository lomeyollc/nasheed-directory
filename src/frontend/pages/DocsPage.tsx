import { Check, Copy, KeyRound, Loader2 } from "lucide-react";
import { useState } from "react";

function Code({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative group">
      <pre className="bg-ink-2 border border-line rounded-xl p-4 pr-12 overflow-x-auto text-[13px] leading-relaxed">
        <code>{children}</code>
      </pre>
      <button
        onClick={() => {
          void navigator.clipboard.writeText(children).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          });
        }}
        className="absolute top-3 right-3 p-1.5 rounded-lg text-muted hover:text-white hover:bg-line/60 transition"
        aria-label="Copy"
      >
        {copied ? <Check size={15} className="text-accent" /> : <Copy size={15} />}
      </button>
    </div>
  );
}

export default function DocsPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function requestKey(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email: email || undefined }),
      });
      const data = (await response.json()) as { api_key?: string; error?: string };
      if (!response.ok || !data.api_key) {
        throw new Error(data.error ?? "Could not issue a key");
      }
      setKey(data.api_key);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-5 py-10 space-y-10">
      <header>
        <h1 className="text-3xl font-bold mb-3">API</h1>
        <p className="text-muted leading-relaxed">
          Two surfaces over the same catalog: a REST API and an MCP server. Reads need an API
          key, which you can issue yourself below. The identical reads are available without a
          key under <code className="text-accent">/api/public</code> — the key exists so we can
          rate-limit and reach a heavy consumer, not to gate freely-licensed audio.
        </p>
      </header>

      <section>
        <h2 className="text-xl font-semibold mb-3 flex items-center gap-2">
          <KeyRound size={18} /> Get a key
        </h2>
        {key ? (
          <div className="space-y-3">
            <div className="bg-accent/10 border border-accent/40 rounded-xl p-4">
              <p className="text-sm mb-2 text-accent font-medium">
                Copy this now — it is shown once, and only its hash is stored.
              </p>
              <Code>{key}</Code>
            </div>
          </div>
        ) : (
          <form onSubmit={requestKey} className="space-y-3">
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="What will use this key? e.g. my-video-agent"
              className="w-full bg-ink-2 border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent/60"
            />
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email (optional — only used if something breaks)"
              className="w-full bg-ink-2 border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent/60"
            />
            {error && <p className="text-sm text-red-400">{error}</p>}
            <button
              disabled={busy}
              className="bg-accent text-ink font-medium px-4 py-2 rounded-lg text-sm hover:bg-accent/90 disabled:opacity-60 flex items-center gap-2"
            >
              {busy && <Loader2 size={15} className="animate-spin" />}
              Issue key
            </button>
          </form>
        )}
      </section>

      <section>
        <h2 className="text-xl font-semibold mb-3">Search</h2>
        <Code>{`curl -H "Authorization: Bearer YOUR_KEY" \\
  "https://nasheed.lomeyo.com/api/v1/tracks?max_duration=60&instrumentation=voice_only"`}</Code>
        <p className="text-sm text-muted mt-3 mb-2">Filters:</p>
        <ul className="text-sm text-muted space-y-1 list-disc pl-5">
          <li>
            <code className="text-accent">q</code> — free text over title, artist, description, lyrics
          </li>
          <li>
            <code className="text-accent">instrumentation</code> — voice_only, voice_duff, duff_only
          </li>
          <li>
            <code className="text-accent">min_duration</code> / <code className="text-accent">max_duration</code> — seconds
          </li>
          <li>
            <code className="text-accent">loopable</code> — true for tracks that loop cleanly
          </li>
          <li>
            <code className="text-accent">license</code>, <code className="text-accent">mood</code>,{" "}
            <code className="text-accent">language</code>, <code className="text-accent">tags</code>
          </li>
          <li>
            <code className="text-accent">sort</code> — newest, duration, title, random
          </li>
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-semibold mb-3">MCP server</h2>
        <p className="text-muted text-sm mb-3 leading-relaxed">
          Streamable HTTP with Bearer auth. Add it to Claude Code, Claude Desktop, or any MCP
          client.
        </p>
        <Code>{`claude mcp add --transport http nasheed \\
  https://nasheed.lomeyo.com/mcp \\
  --header "Authorization: Bearer YOUR_KEY"`}</Code>
        <p className="text-sm text-muted mt-4 mb-2">Tools:</p>
        <ul className="text-sm text-muted space-y-1.5 list-disc pl-5">
          <li>
            <code className="text-accent">pick_background_track</code> — give a video length and a
            mood, get one track that fits plus the credit line
          </li>
          <li>
            <code className="text-accent">search_nasheeds</code> — full search
          </li>
          <li>
            <code className="text-accent">get_nasheed</code> — one track by slug
          </li>
          <li>
            <code className="text-accent">get_halal_rubric</code> — the rules the catalog applies
          </li>
          <li>
            <code className="text-accent">get_catalog_stats</code>,{" "}
            <code className="text-accent">submit_nasheed</code>
          </li>
        </ul>
      </section>

      <section>
        <h2 className="text-xl font-semibold mb-3">Attribution</h2>
        <p className="text-muted text-sm leading-relaxed">
          CC-BY and CC-BY-SA tracks require credit. Every track record carries an{" "}
          <code className="text-accent">attribution_text</code> field with the exact string to
          reproduce — use it rather than assembling your own, which is how credit lines end up
          subtly wrong. CC0 and public-domain tracks need no credit, though giving it is still
          good manners.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold mb-3">Machine-readable</h2>
        <ul className="text-sm text-muted space-y-1.5 list-disc pl-5">
          <li>
            <a className="text-accent hover:underline" href="/llms.txt">/llms.txt</a> — orientation for an agent
          </li>
          <li>
            <a className="text-accent hover:underline" href="/openapi.json">/openapi.json</a> — the REST contract
          </li>
          <li>
            <a className="text-accent hover:underline" href="/api/public/v1/rubric">/api/v1/rubric</a> — the rubric as JSON
          </li>
        </ul>
      </section>
    </div>
  );
}
