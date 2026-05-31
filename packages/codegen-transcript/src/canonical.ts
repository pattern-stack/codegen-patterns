/**
 * Canonical `transcript`-surface vocabulary (ADR-036 §7).
 *
 * `CanonicalTranscript` is the vendor-agnostic `T` a transcript provider adapter
 * reads into — the record that flows through the L1 change-source pipeline
 * (`IChangeSource<CanonicalTranscript>` → differ → sink). Every vendor adapter
 * maps its vendor DTO → External (Zod-validated) → this canonical shape; vendor
 * DTO/External shapes never cross the port boundary.
 *
 * Modeled from swe-brain ADR-0007 (TranscriptDomain design, Google Meet first) —
 * the transcript context had no port prototype yet (Phase 2), so this lifts the
 * decision-ready canonical field set directly from the ADR, trimmed to the
 * cross-provider load-bearing core (sales/CRM product columns dropped).
 *
 * Declared as `type` (not `interface`) so it satisfies the orchestrator's
 * `T extends Record<string, unknown>` constraint — interfaces lack the implicit
 * index signature that constraint needs.
 */

/**
 * One utterance in a transcript — the load-bearing primitive every provider can
 * fill. `speakerEmail` stays nullable; it's populated when resolvable (routed
 * through an `ExactEmailMatch` identity matcher, not an ad-hoc display-name map).
 */
export type TranscriptSegment = {
  speaker: string;
  speakerEmail?: string | null;
  text: string;
  startMs?: number;
  endMs?: number;
};

export type CanonicalTranscript = {
  /** Vendor-prefixed id at the port boundary, e.g. `google:conferenceRecord:transcript`. */
  externalId: string;
  /**
   * The Calendar/conference link this transcript belongs to (vendor-prefixed).
   * A cross-context reference, resolved read-only by the sink — never a DB FK.
   */
  meetingExternalId: string | null;
  title: string;
  /** Recording/conference start (distinct from a meeting's `startAt`). */
  occurredAt: Date;
  /** Duration in seconds. */
  duration: number | null;
  /** BCP-47 language tag. */
  language: string | null;
  /** Time-ordered utterances. JSONB at rest; promoted to child rows only if the query surface needs per-utterance retrieval. */
  segments: TranscriptSegment[];
  /** Flat fallback when a provider yields no structured segments. */
  fullText: string | null;
  /** Populated only if notes/summary are fetched (optional path). */
  summary: string | null;
  /** Seeds Person conformance + the consent lattice. */
  attendeeEmails: string[] | null;
  organizerEmail: string | null;
  /** Deep-link back to the source artifact. */
  externalLink: string | null;
};
