import { Check, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { getRubric } from "../lib/api";

interface Clause {
  id: string;
  rule: string;
  checked_by: string;
  disqualifies: string[];
}

interface Rubric {
  version: string;
  summary: string;
  position: string;
  clauses: Clause[];
  verification_tiers: Record<string, string>;
  accepted_licenses: Record<string, string>;
}

const CHECKED_BY_LABEL: Record<string, string> = {
  signal_analysis: "Checked by signal analysis",
  human_review: "Checked by a person listening",
  license_document: "Checked against the licence document",
};

export default function RubricPage() {
  const [rubric, setRubric] = useState<Rubric | null>(null);

  useEffect(() => {
    getRubric()
      .then((data) => setRubric(data as unknown as Rubric))
      .catch(() => setRubric(null));
  }, []);

  if (!rubric) {
    return (
      <div className="flex items-center gap-2 text-muted py-24 justify-center">
        <Loader2 className="animate-spin" size={18} /> Loading the rubric…
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-5 py-10">
      <h1 className="text-3xl font-bold mb-3">The rubric</h1>
      <p className="text-muted leading-relaxed mb-6">{rubric.summary}</p>

      <div className="bg-amber-950/30 border border-amber-900/60 rounded-xl p-4 mb-10 text-sm leading-relaxed">
        <p className="font-medium mb-1.5 text-amber-200">This is a position, not a fatwa</p>
        <p className="text-muted">{rubric.position}</p>
      </div>

      <h2 className="text-xl font-semibold mb-4">What every track is checked against</h2>
      <div className="space-y-4 mb-12">
        {rubric.clauses.map((clause) => (
          <section key={clause.id} className="bg-ink-2 border border-line rounded-xl p-5">
            <div className="flex items-start gap-3 mb-3">
              <Check size={18} className="text-accent shrink-0 mt-0.5" />
              <div>
                <p className="font-medium leading-snug">{clause.rule}</p>
                <p className="text-xs text-muted mt-1 uppercase tracking-wide">
                  {CHECKED_BY_LABEL[clause.checked_by] ?? clause.checked_by}
                </p>
              </div>
            </div>
            <ul className="space-y-1.5 pl-1">
              {clause.disqualifies.map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-sm text-muted">
                  <X size={14} className="text-red-400 shrink-0 mt-1" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <h2 className="text-xl font-semibold mb-4">Verification tiers</h2>
      <dl className="space-y-3 mb-12">
        {Object.entries(rubric.verification_tiers).map(([tier, meaning]) => (
          <div key={tier} className="bg-ink-2 border border-line rounded-xl p-4">
            <dt className="font-mono text-sm text-accent mb-1">{tier}</dt>
            <dd className="text-sm text-muted">{meaning}</dd>
          </div>
        ))}
      </dl>

      <h2 className="text-xl font-semibold mb-4">Accepted licences</h2>
      <dl className="space-y-3">
        {Object.entries(rubric.accepted_licenses).map(([name, meaning]) => (
          <div key={name} className="bg-ink-2 border border-line rounded-xl p-4">
            <dt className="font-mono text-sm text-accent mb-1">{name}</dt>
            <dd className="text-sm text-muted">{meaning}</dd>
          </div>
        ))}
      </dl>

      <p className="text-xs text-muted mt-10">
        Rubric version {rubric.version}. Machine-readable at{" "}
        <code className="text-accent">/api/v1/rubric</code>.
      </p>
    </div>
  );
}
