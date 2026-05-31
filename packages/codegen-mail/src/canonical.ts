/**
 * Canonical `mail`-surface vocabulary (ADR-036 §7).
 *
 * `CanonicalEmail` is the vendor-agnostic `T` a mail provider adapter reads into
 * — the record that flows through the L1 change-source pipeline
 * (`IChangeSource<CanonicalEmail>` → differ → sink). Every vendor adapter maps
 * its vendor DTO → External (Zod-validated) → this canonical shape; vendor
 * DTO/External shapes never cross the port boundary.
 *
 * Declared as `type` (not `interface`) so it satisfies the orchestrator's
 * `T extends Record<string, unknown>` constraint — interfaces lack the implicit
 * index signature that constraint needs.
 *
 * Lifted from the swe-brain `mail-ports` prototype (the reference that informed
 * this package).
 */
export type CanonicalEmail = {
  /** Vendor-prefixed id at the port boundary, e.g. `google:18f...`. */
  externalId: string;
  /** Vendor thread/conversation id (groups a conversation). Vendor-raw, not prefixed. */
  threadId: string | null;
  /** RFC822 `Message-ID` header — distinct from the vendor message id in `externalId`. */
  messageId: string | null;
  fromEmail: string | null;
  fromName: string | null;
  /** Parsed recipient addresses. */
  toEmails: string[] | null;
  ccEmails: string[] | null;
  subject: string | null;
  /** Vendor's server-side preview line. */
  snippet: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  isRead: boolean | null;
  isStarred: boolean | null;
  /** Raw vendor label ids (e.g. `INBOX`, `UNREAD`, `TRASH`). Trash is preserved as signal. */
  labels: string[] | null;
  /** Vendor receive time (e.g. Gmail `internalDate`). */
  receivedAt: Date | null;
  /** Parsed `Date` header (sender's send time). */
  sentAt: Date | null;
};
