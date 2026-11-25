/**
 * One place where a submission is validated and stored, used by both the
 * REST route and the MCP `submit_nasheed` tool. Two copies of this logic is
 * how one of them would quietly stop asking for rights evidence.
 *
 * The rights gate starts here. Only the people who can actually grant a
 * licence may submit: the artist, the label, or someone holding written
 * permission from one of them. "I found it online" is how the 2026-11-25
 * catalog was built, and it is not accepted. Submissions are never published
 * automatically; a maintainer checks the evidence link first.
 */

export const SUBMITTER_RELATIONSHIPS = ["artist", "label", "written_permission"] as const;
export type SubmitterRelationship = (typeof SUBMITTER_RELATIONSHIPS)[number];

export interface SubmissionInput {
  title: string | null;
  source_url: string | null;
  relationship: string | null;
  rights_evidence_url: string | null;
  artist?: string | null;
  claimed_license?: string | null;
  claimed_instrumentation?: string | null;
  notes?: string | null;
  submitter_name?: string | null;
  submitter_contact?: string | null;
}

export type SubmissionResult =
  | { ok: false; error: string }
  | { ok: true; status: "pending" | "already_pending"; id: string };

const HTTP_URL = /^https?:\/\//i;

export function validateSubmission(input: SubmissionInput): string | null {
  if (!input.title || !input.source_url) {
    return "title and source_url are required";
  }
  if (!HTTP_URL.test(input.source_url)) {
    return "source_url must be an http(s) URL";
  }
  if (!input.relationship || !SUBMITTER_RELATIONSHIPS.includes(input.relationship as SubmitterRelationship)) {
    return (
      "relationship is required: say whether you are the artist, the label, or hold written " +
      `permission (one of ${SUBMITTER_RELATIONSHIPS.join(", ")}). We only accept tracks from people ` +
      "who can grant the licence."
    );
  }
  if (!input.rights_evidence_url) {
    return (
      "rights_evidence_url is required: link to where the artist or label released this track under " +
      "the licence themselves, or to the written permission."
    );
  }
  if (!HTTP_URL.test(input.rights_evidence_url)) {
    return "rights_evidence_url must be an http(s) URL";
  }
  return null;
}

export async function createSubmission(db: D1Database, input: SubmissionInput): Promise<SubmissionResult> {
  const error = validateSubmission(input);
  if (error) {
    return { ok: false, error };
  }

  const existing = await db
    .prepare("SELECT id FROM submissions WHERE source_url = ? AND status = 'pending' LIMIT 1")
    .bind(input.source_url)
    .first<{ id: string }>();
  if (existing) {
    return { ok: true, status: "already_pending", id: existing.id };
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO submissions
         (id, title, artist, source_url, claimed_license, claimed_instrumentation, notes,
          submitter_name, submitter_contact, submitter_relationship, rights_evidence_url,
          status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, 'pending', ?)`
    )
    .bind(
      id,
      input.title,
      input.artist ?? null,
      input.source_url,
      input.claimed_license ?? null,
      input.claimed_instrumentation ?? null,
      input.notes ?? null,
      input.submitter_name ?? null,
      input.submitter_contact ?? null,
      input.relationship,
      input.rights_evidence_url,
      new Date().toISOString()
    )
    .run();

  return { ok: true, status: "pending", id };
}
