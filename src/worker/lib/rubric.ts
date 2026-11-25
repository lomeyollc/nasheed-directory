/**
 * The halal-audio rubric, as data.
 *
 * This is exported over the API (`GET /api/v1/rubric`, and the
 * `get_halal_rubric` MCP tool) rather than living only in a README, because
 * an AI agent picking background music needs to be able to read the rule it
 * is being held to — not just the verdict. If a consumer follows a stricter
 * or different opinion, they can read this, disagree with a specific clause,
 * and filter on the raw `instrumentation` / `lyrics_*` facts instead.
 *
 * Scope note, stated plainly: this directory follows the position that
 * musical instruments other than the duff (frame drum) are not permitted in
 * this context. That is a real position held by many scholars, and it is not
 * the only position held by Muslims. We apply it because it is the strictest
 * common denominator — audio that passes this rubric is acceptable to
 * someone following a more permissive view too, while the reverse is not
 * true. Nothing here is a fatwa.
 */

export const RUBRIC_VERSION = "1.1.0";

export interface RubricClause {
  id: string;
  rule: string;
  /** How this clause is actually checked, so the claim is auditable. */
  checked_by: "signal_analysis" | "human_review" | "license_document" | "rights_evidence";
  /** What makes a track FAIL this clause. */
  disqualifies: string[];
}

export const RUBRIC: {
  version: string;
  summary: string;
  position: string;
  clauses: RubricClause[];
  verification_tiers: Record<string, string>;
  rights_bases: Record<string, string>;
  accepted_licenses: Record<string, string>;
} = {
  version: RUBRIC_VERSION,
  summary:
    "Human voice only, or human voice with duff (frame drum) only. No melodic instruments. " +
    "No impermissible lyrical content. Published only when the artist or label released it under " +
    "an open commercial licence themselves, with the evidence linked.",
  position:
    "This directory applies the stricter scholarly position that melodic instruments are not " +
    "permitted, with the duff (frame drum) as the recognised exception. This is not the only " +
    "position among Muslims; it is used here because audio that passes it is also acceptable " +
    "to someone following a more permissive view. This catalog is a tool, not a fatwa.",

  clauses: [
    {
      id: "instrumentation",
      rule: "The only permitted sound sources are the unaccompanied human voice and the duff (frame drum / daff / bendir).",
      checked_by: "signal_analysis",
      disqualifies: [
        "Any pitched or melodic instrument: strings, wind, brass, piano, synthesiser, guitar, oud, ney, violin.",
        "Drum kits, tuned percussion, and electronic drum machines. The exception is the duff specifically, not percussion generally.",
        "Vocal-synth or vocoder layers that function as an instrumental pad rather than as a voice.",
      ],
    },
    {
      id: "lyrical-content",
      rule: "Lyrics must be free of impermissible content.",
      checked_by: "human_review",
      disqualifies: [
        "Romantic or sensual content.",
        "Shirk, or praise attributing divine qualities to a created being.",
        "Profanity, insult, or incitement.",
        "Glorification of alcohol, gambling, or other impermissible acts.",
        "Sectarian attack on other Muslims.",
      ],
    },
    {
      id: "extremist-content",
      rule: "No content promoting violence, armed struggle, martyrdom operations, or any extremist group.",
      checked_by: "human_review",
      disqualifies: [
        "Jihadi nasheeds. This genre is a real and large presence on public archives, it is very often unaccompanied vocal (so it passes every instrumentation check cleanly), and it is frequently re-uploaded with a Creative Commons licence attached by someone who had no right to attach one.",
        "Praise of any armed group, its leaders, or its fighters.",
        "Calls to violence, glorification of killing, or martyrdom-operation themes.",
        "Recordings distributed by, or produced by, a group under international sanction.",
        "Titles and refrains that are conventional markers of the genre — for example 'lions of' a group, 'the state', or 'clashing of swords'. A marker is a reason to check, not a verdict: the same words appear innocently in classical poetry.",
      ],
    },
    {
      id: "instrument-imitation",
      rule: "Vocal effects are permitted; vocal imitation of instruments is not.",
      checked_by: "human_review",
      disqualifies: [
        "Beatboxing used as a substitute drum track.",
        "Layered vocal pads pitched and sustained so as to function as an instrumental bed.",
      ],
    },
    {
      id: "license",
      rule: "The licence must permit commercial reuse and derivatives.",
      checked_by: "license_document",
      disqualifies: [
        "NonCommercial (NC) licenses — they break the promise that this audio is usable in monetised work.",
        "NoDerivatives (ND) licenses — they prevent trimming, looping, and mixing under a video.",
      ],
    },
    {
      id: "rights",
      rule:
        "A track is published only when the artist or label released it under an open commercial " +
        "licence themselves, with the evidence linked. Every track record carries `rights_basis` " +
        "(why we believe the rights holder chose the licence) and `rights_evidence_url` (where anyone " +
        "can check it). The database refuses to publish a track without both.",
      checked_by: "rights_evidence",
      disqualifies: [
        "A licence chosen by the person who uploaded the file, with no evidence they are the artist or label. On public archives anyone can upload anyone's album and tick a Creative Commons box, and this is the single biggest source of false 'copyright-free' claims. It is why every track was taken offline on 2026-11-25.",
        "A Public Domain Mark on a recording made after 1950, or with no date. The mark is for very old works; it is not a licence an owner gives (owners use CC0).",
        "Any recording from a source on our blocklist: militant distributors, and accounts that re-upload other people's albums.",
      ],
    },
  ],

  verification_tiers: {
    community_submitted:
      "Present in the database, not yet vetted by anyone. Never returned by default, and never publishable.",
    automated_verified:
      "NO HUMAN HAS LISTENED TO THIS TRACK. A machine checked it: signal analysis found no melodic " +
      "instrument and no percussion at all, the audio was transcribed and translated and its lyrics " +
      "tripped no content flag. The rights basis is a separate check, recorded in `rights_basis`. The detector and model " +
      "versions are recorded in `verified_by` and the evidence in `detector_evidence`. This tier is " +
      "held to a STRICTER instrumentation bar than a human reviewer applies, because a machine gets " +
      "no benefit of the doubt — but machine translation of sung poetry is rough, so treat it as a " +
      "strong signal rather than a certification. Exclude it with include_automated=false.",
    maintainer_verified:
      "A maintainer listened to the whole track and applied this rubric. Attributed and dated.",
    scholar_reviewed:
      "A named person with scholarly standing signed off. Attributed and dated.",
  },

  rights_bases: {
    artist_upload:
      "The artist or label uploaded the file themselves and chose the licence. The evidence link shows the account is theirs.",
    artist_channel_cc:
      "The artist's own channel publishes the recording under a Creative Commons licence, and the file we host was sent to us by the artist. We never download from a video platform.",
    artist_platform:
      "The artist's own website or label page offers the recording under the licence.",
    written_permission:
      "The rights holder gave written permission. `permission_evidence` records how.",
    public_domain_by_age:
      "The recording was made in 1950 or earlier and is out of copyright by age, shown by the evidence link.",
  },

  accepted_licenses: {
    CC0: "Public-domain dedication. No attribution required, though it is still good manners.",
    "CC-BY": "Free reuse including commercial, attribution required.",
    "CC-BY-SA": "As CC-BY, but derivative works must carry the same license. Note this before using it under a video you license differently.",
    "public-domain":
      "Out of copyright by age: recorded in 1950 or earlier, with rights_basis public_domain_by_age. A Public Domain Mark set by an uploader on a newer recording is not accepted.",
    "author-permission":
      "The rights holder gave explicit written permission. `permission_evidence` records how, so the claim stays auditable.",
  },
};

/** Instrumentation values that satisfy the instrumentation clause. */
export const CLEAN_INSTRUMENTATION = ["voice_only", "voice_duff", "duff_only"] as const;

/** Tiers involving a person. The strongest claim the catalog makes. */
export const HUMAN_TIERS = ["maintainer_verified", "scholar_reviewed"] as const;

/**
 * Tiers the API returns by default. `automated_verified` is included because
 * excluding it would leave the catalog empty until every track has been
 * listened to end to end, and a catalog nobody can use protects nobody. It is
 * labelled precisely on every record, and one parameter removes it.
 */
export const TRUSTED_TIERS = [
  "automated_verified",
  "maintainer_verified",
  "scholar_reviewed",
] as const;
