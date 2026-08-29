import { CheckCircle2, Loader2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

export default function SubmitPage() {
  const [form, setForm] = useState({
    title: "",
    artist: "",
    source_url: "",
    claimed_license: "",
    claimed_instrumentation: "",
    notes: "",
    submitter_name: "",
    submitter_contact: "",
  });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set(field: keyof typeof form) {
    return (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm((previous) => ({ ...previous, [field]: event.target.value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/submissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(data.error ?? "Could not submit");
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="mx-auto max-w-xl px-5 py-24 text-center">
        <CheckCircle2 size={44} className="text-accent mx-auto mb-4" />
        <h1 className="text-2xl font-bold mb-3">Thank you</h1>
        <p className="text-muted leading-relaxed mb-6">
          A maintainer will listen to the whole track and check the licence before it enters the
          catalog. Nothing is published on a submitter's word — that is what keeps the catalog
          worth trusting.
        </p>
        <Link to="/" className="text-accent hover:underline">
          Back to the catalog
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-5 py-10">
      <h1 className="text-3xl font-bold mb-3">Submit a track</h1>
      <p className="text-muted leading-relaxed mb-8">
        Anyone can propose a track. Two things to check before you do, because they are what most
        submissions get wrong:
      </p>

      <ul className="space-y-3 mb-8 text-sm">
        <li className="bg-ink-2 border border-line rounded-xl p-4">
          <b className="block mb-1">The licence must come from the rights holder</b>
          <span className="text-muted">
            Someone re-uploading an album to a public archive and ticking a Creative Commons box
            does not make it freely licensed. Link to where the artist themselves released it.
          </span>
        </li>
        <li className="bg-ink-2 border border-line rounded-xl p-4">
          <b className="block mb-1">Voice and duff only</b>
          <span className="text-muted">
            No melodic instruments at all — see the{" "}
            <Link to="/rubric" className="text-accent hover:underline">
              rubric
            </Link>
            . If you are not sure whether that percussion is a duff, submit it anyway and say so
            in the notes.
          </span>
        </li>
      </ul>

      <form onSubmit={submit} className="space-y-4">
        <Field label="Title" required value={form.title} onChange={set("title")} />
        <Field label="Artist" value={form.artist} onChange={set("artist")} />
        <Field
          label="Source URL"
          required
          type="url"
          placeholder="Where the audio and its licence can be verified"
          value={form.source_url}
          onChange={set("source_url")}
        />

        <div className="grid sm:grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm font-medium block mb-1.5">Licence</span>
            <select
              value={form.claimed_license}
              onChange={set("claimed_license")}
              className="w-full bg-ink-2 border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent/60"
            >
              <option value="">Not sure</option>
              <option value="CC0">CC0</option>
              <option value="CC-BY">CC-BY</option>
              <option value="CC-BY-SA">CC-BY-SA</option>
              <option value="public-domain">Public domain</option>
              <option value="author-permission">The artist gave permission</option>
            </select>
          </label>

          <label className="block">
            <span className="text-sm font-medium block mb-1.5">What is in it</span>
            <select
              value={form.claimed_instrumentation}
              onChange={set("claimed_instrumentation")}
              className="w-full bg-ink-2 border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent/60"
            >
              <option value="">Not sure</option>
              <option value="voice_only">Voice only</option>
              <option value="voice_duff">Voice + duff</option>
              <option value="duff_only">Duff only</option>
            </select>
          </label>
        </div>

        <label className="block">
          <span className="text-sm font-medium block mb-1.5">Notes</span>
          <textarea
            rows={4}
            value={form.notes}
            onChange={set("notes")}
            placeholder="Anything a reviewer should know — where the percussion appears, what the lyrics say, how you know the licence is real."
            className="w-full bg-ink-2 border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent/60 resize-y"
          />
        </label>

        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Your name (optional)" value={form.submitter_name} onChange={set("submitter_name")} />
          <Field
            label="Contact (optional)"
            value={form.submitter_contact}
            onChange={set("submitter_contact")}
            placeholder="Only used if a reviewer has a question"
          />
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <button
          disabled={busy}
          className="bg-accent text-ink font-medium px-5 py-2.5 rounded-lg text-sm hover:bg-accent/90 disabled:opacity-60 flex items-center gap-2"
        >
          {busy && <Loader2 size={15} className="animate-spin" />}
          Submit for review
        </button>
      </form>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  required,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  required?: boolean;
  type?: string;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium block mb-1.5">
        {label}
        {required && <span className="text-accent ml-1">*</span>}
      </span>
      <input
        type={type}
        required={required}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className="w-full bg-ink-2 border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent/60"
      />
    </label>
  );
}
