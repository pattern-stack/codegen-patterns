/**
 * Canonical `calendar`-surface vocabulary (ADR-036 §7).
 *
 * `CanonicalMeeting` is the vendor-agnostic `T` a calendar provider adapter
 * reads into — the record that flows through the L1 change-source pipeline
 * (`IChangeSource<CanonicalMeeting>` → differ → sink). Every vendor adapter maps
 * its vendor DTO → External (Zod-validated) → this canonical shape; vendor
 * DTO/External shapes never cross the port boundary.
 *
 * Declared as `type` (not `interface`) so it satisfies the orchestrator's
 * `T extends Record<string, unknown>` constraint — interfaces lack the implicit
 * index signature that constraint needs.
 *
 * Lifted from the swe-brain `calendar-ports` prototype (the reference that
 * informed this package). This is surface-shaped vocabulary, so it lives in the
 * surface package, not in `@pattern-stack/codegen`.
 */
export type CanonicalMeeting = {
  /** Vendor-prefixed id at the port boundary, e.g. `google:abc123`. */
  externalId: string;
  title: string;
  description: string | null;
  startAt: Date;
  endAt: Date;
  organizerEmail: string | null;
  attendeeEmails: string[] | null;
  location: string | null;
  /** confirmed | tentative | cancelled — cancelled is preserved, never tombstoned. */
  status: string | null;
};
